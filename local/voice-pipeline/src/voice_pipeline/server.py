import asyncio
import logging
import uuid
from collections.abc import Callable

from aiohttp import web

from voice_pipeline.audiosocket import KIND_UUID, StreamChannel, read_frame
from voice_pipeline.config import Settings
from voice_pipeline.engines import Speaker, Transcriber, VoiceActivityDetector
from voice_pipeline.session import CallSession, Pace
from voice_pipeline.store import CallStore

log = logging.getLogger(__name__)

# How long Asterisk has to identify the call after connecting.
HANDSHAKE_TIMEOUT_S = 5.0


class Pipeline:
    """Wires the call store to the AudioSocket listener and the HTTP API."""

    def __init__(
        self,
        settings: Settings,
        vad_factory: Callable[[], VoiceActivityDetector],
        stt: Transcriber,
        tts: Speaker,
        pace: Pace = asyncio.sleep,
    ) -> None:
        self.settings = settings
        self.store = CallStore(settings.call_ttl_s)
        self._vad_factory = vad_factory
        self._stt = stt
        self._tts = tts
        self._pace = pace
        self._sessions: dict[str, asyncio.Task] = {}

    def cancel(self, call_id: str) -> bool:
        """Marks a pending call failed and hangs up its audio connection."""
        cancelled = self.store.fail(call_id, "Cancelled")
        task = self._sessions.get(call_id)
        if task is not None:
            task.cancel()
        return cancelled

    async def shutdown(self) -> None:
        """Hangs up every call in progress."""
        tasks = list(self._sessions.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def handle_audiosocket(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        channel = StreamChannel(reader, writer)
        try:
            call_id = await asyncio.wait_for(_read_call_id(reader), HANDSHAKE_TIMEOUT_S)
        except TimeoutError:
            call_id = None
        record = self.store.get(call_id) if call_id else None
        if record is None or record.status != "pending":
            log.warning("rejecting audio connection for call %s", call_id)
            await channel.send_hangup()
            await channel.close()
            return

        session = CallSession(
            record,
            channel,
            self._vad_factory(),
            self._stt,
            self._tts,
            self.store,
            self.settings,
            self._pace,
        )
        self._sessions[record.call_id] = task = asyncio.current_task()
        try:
            await session.run()
        except asyncio.CancelledError:
            pass
        finally:
            if self._sessions.get(record.call_id) is task:
                del self._sessions[record.call_id]
            # Cancellation was consumed above; don't let it leak to the server.
            if task is not None:
                while task.uncancel():
                    pass

    def app(self) -> web.Application:
        app = web.Application()
        app.add_routes(
            [
                web.get("/healthz", self._healthz),
                web.post("/calls", self._register),
                web.get("/calls/{call_id}", self._status),
                web.post("/calls/{call_id}/cancel", self._cancel),
            ]
        )
        return app

    async def _healthz(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    async def _register(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            call_id = str(uuid.UUID(body["callId"]))
            question = body["question"]
            context = body.get("context")
            if not isinstance(question, str) or not question.strip():
                raise ValueError("question")
            if context is not None and not isinstance(context, str):
                raise ValueError("context")
        except (ValueError, KeyError, TypeError, AttributeError):
            return web.json_response(
                {
                    "error": "Body must be {callId: uuid, question: string, "
                    "context?: string}"
                },
                status=400,
            )
        record = self.store.register(call_id, question, context or None)
        if record is None:
            return web.json_response({"error": "callId already exists"}, status=409)
        return web.json_response(record.to_json(), status=201)

    async def _status(self, request: web.Request) -> web.Response:
        record = self.store.get(_normalise(request.match_info["call_id"]))
        if record is None:
            return web.json_response({"error": "Call not found"}, status=404)
        return web.json_response(record.to_json())

    async def _cancel(self, request: web.Request) -> web.Response:
        call_id = _normalise(request.match_info["call_id"])
        record = self.store.get(call_id)
        if record is None:
            return web.json_response({"error": "Call not found"}, status=404)
        self.cancel(call_id)
        return web.json_response(record.to_json())


async def _read_call_id(reader: asyncio.StreamReader) -> str | None:
    frame = await read_frame(reader)
    if frame is None or frame.kind != KIND_UUID or len(frame.payload) != 16:
        return None
    return str(uuid.UUID(bytes=frame.payload))


def _normalise(call_id: str) -> str:
    try:
        return str(uuid.UUID(call_id))
    except ValueError:
        return call_id
