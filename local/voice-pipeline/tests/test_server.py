import asyncio
import uuid

import pytest
from aiohttp.test_utils import TestClient, TestServer

from tests.conftest import (
    SILENCE,
    SPEECH,
    FakeStt,
    FakeTts,
    FakeVad,
    no_pace,
    quiet,
    talk,
)
from voice_pipeline.audiosocket import (
    KIND_AUDIO,
    KIND_HANGUP,
    KIND_UUID,
    encode_frame,
    read_frame,
)
from voice_pipeline.server import Pipeline

CALL_ID = "8d1f4c2e-7a3b-4c55-9f0e-2b6a1d3c4e5f"


@pytest.fixture
async def pipeline(settings):
    return Pipeline(settings, FakeVad, FakeStt("yes ship it"), FakeTts(), no_pace)


@pytest.fixture
async def http(pipeline):
    async with TestClient(TestServer(pipeline.app())) as client:
        yield client
    await pipeline.shutdown()


@pytest.fixture
async def audiosocket_port(pipeline):
    server = await asyncio.start_server(pipeline.handle_audiosocket, "127.0.0.1", 0)
    yield server.sockets[0].getsockname()[1]
    server.close()
    await pipeline.shutdown()


async def register(http, call_id=CALL_ID, **body):
    return await http.post(
        "/calls", json={"callId": call_id, "question": "Ship it?", **body}
    )


class FakeAsterisk:
    """Plays Asterisk's side of an AudioSocket connection."""

    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer

    @classmethod
    async def connect(cls, port, call_id=CALL_ID):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(encode_frame(KIND_UUID, uuid.UUID(call_id).bytes))
        return cls(reader, writer)

    async def send_audio(self, frames):
        for frame in frames:
            self.writer.write(encode_frame(KIND_AUDIO, frame))
        await self.writer.drain()

    async def wait_for_prompt_to_finish(self):
        """Reads until the pipeline has spoken and gone back to silence."""
        heard_speech = False
        while (frame := await read_frame(self.reader)) is not None:
            if frame.kind != KIND_AUDIO:
                continue
            if any(frame.payload):
                heard_speech = True
            elif heard_speech:
                return

    async def read_until_hangup(self):
        audio = []
        while (frame := await read_frame(self.reader)) is not None:
            if frame.kind == KIND_HANGUP:
                break
            audio.append(frame.payload)
        return audio


async def test_registering_a_call_returns_it_pending(http):
    response = await register(http, context="Tests pass.")

    assert response.status == 201
    assert await response.json() == {"callId": CALL_ID, "status": "pending"}
    status = await http.get(f"/calls/{CALL_ID}")
    assert await status.json() == {"callId": CALL_ID, "status": "pending"}


@pytest.mark.parametrize(
    "body",
    [
        {"callId": "not-a-uuid", "question": "q"},
        {"callId": CALL_ID},
        {"callId": CALL_ID, "question": "  "},
        {"callId": CALL_ID, "question": "q", "context": 5},
    ],
)
async def test_rejects_an_invalid_registration(http, body):
    response = await http.post("/calls", json=body)

    assert response.status == 400


async def test_rejects_a_duplicate_call_id(http):
    await register(http)

    assert (await register(http)).status == 409


async def test_unknown_calls_are_not_found(http):
    assert (await http.get(f"/calls/{CALL_ID}")).status == 404
    assert (await http.post(f"/calls/{CALL_ID}/cancel")).status == 404


async def test_a_call_is_answered_end_to_end(http, audiosocket_port):
    await register(http)
    asterisk = await FakeAsterisk.connect(audiosocket_port)

    await asterisk.wait_for_prompt_to_finish()
    await asterisk.send_audio(talk(0.4) + quiet(1.0))
    audio = await asterisk.read_until_hangup()

    assert any(any(frame) for frame in audio)  # the caller was spoken to
    body = await (await http.get(f"/calls/{CALL_ID}")).json()
    assert body == {"callId": CALL_ID, "status": "answered", "answer": "yes ship it"}


async def test_cancelling_hangs_up_a_call_in_progress(http, audiosocket_port):
    await register(http)
    asterisk = await FakeAsterisk.connect(audiosocket_port)
    await asterisk.send_audio([SILENCE])
    await asyncio.sleep(0.05)

    response = await http.post(f"/calls/{CALL_ID}/cancel")

    assert (await response.json())["status"] == "failed"
    await asyncio.wait_for(asterisk.read_until_hangup(), 2)
    body = await (await http.get(f"/calls/{CALL_ID}")).json()
    assert body == {"callId": CALL_ID, "status": "failed", "error": "Cancelled"}


async def test_a_call_cancelled_before_it_connects_is_hung_up_on_arrival(
    http, audiosocket_port
):
    await register(http)
    await http.post(f"/calls/{CALL_ID}/cancel")

    asterisk = await FakeAsterisk.connect(audiosocket_port)

    assert await asyncio.wait_for(asterisk.read_until_hangup(), 2) == []


async def test_an_unregistered_connection_is_hung_up_on(audiosocket_port):
    asterisk = await FakeAsterisk.connect(audiosocket_port)

    assert await asyncio.wait_for(asterisk.read_until_hangup(), 2) == []


async def test_the_caller_hanging_up_fails_the_call(http, audiosocket_port):
    await register(http)
    asterisk = await FakeAsterisk.connect(audiosocket_port)
    await asterisk.send_audio([SPEECH] * 5)

    asterisk.writer.write(encode_frame(KIND_HANGUP))
    await asterisk.writer.drain()
    await asterisk.read_until_hangup()

    body = await (await http.get(f"/calls/{CALL_ID}")).json()
    assert body["status"] == "failed"
    assert body["error"] == "The call ended before an answer was captured"
