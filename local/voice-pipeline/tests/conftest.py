import asyncio
from collections import deque

import pytest

from voice_pipeline.audiosocket import KIND_AUDIO, KIND_HANGUP, Frame
from voice_pipeline.config import FRAME_BYTES, Settings

SPEECH = b"\x01" * FRAME_BYTES
SILENCE = b"\x00" * FRAME_BYTES
FRAME_S = 0.02


class FakeVad:
    """Treats any non-zero frame as speech."""

    def reset(self) -> None:
        pass

    def is_speech(self, pcm: bytes) -> bool:
        return any(pcm)


class FakeStt:
    """Returns scripted transcripts in order, recording each utterance."""

    def __init__(self, *transcripts: str) -> None:
        self._transcripts = deque(transcripts)
        self.utterances: list[bytes] = []

    def transcribe(self, pcm: bytes) -> str:
        self.utterances.append(pcm)
        return self._transcripts.popleft()


class FakeTts:
    """Renders each text as `frames` frames of audio and records what was
    spoken."""

    def __init__(self, frames: int = 1) -> None:
        self.spoken: list[str] = []
        self._frames = frames

    def synthesize(self, text: str) -> bytes:
        self.spoken.append(text)
        return b"\x02" * FRAME_BYTES * self._frames


class FakeChannel:
    """A scripted call: each turn of caller audio is released once the
    pipeline finishes an utterance, i.e. sends silence after speech."""

    def __init__(self, *turns: list[bytes]) -> None:
        self._turns = deque(turns)
        self._inbox: asyncio.Queue[Frame | None] = asyncio.Queue()
        self.sent_audio: list[bytes] = []
        self._was_speaking = False
        self.hung_up = False
        self.closed = False

    async def recv(self) -> Frame | None:
        return await self._inbox.get()

    async def send_audio(self, pcm: bytes) -> None:
        self.sent_audio.append(pcm)
        speaking = any(pcm)
        if self._was_speaking and not speaking and self._turns:
            for frame in self._turns.popleft():
                self._inbox.put_nowait(Frame(KIND_AUDIO, frame))
        self._was_speaking = speaking

    @property
    def speech_frames(self) -> list[bytes]:
        return [frame for frame in self.sent_audio if any(frame)]

    async def send_hangup(self) -> None:
        self.hung_up = True

    async def close(self) -> None:
        self.closed = True

    def caller_hangs_up(self) -> None:
        self._inbox.put_nowait(Frame(KIND_HANGUP))


def talk(seconds: float) -> list[bytes]:
    return [SPEECH] * round(seconds / FRAME_S)


def quiet(seconds: float) -> list[bytes]:
    return [SILENCE] * round(seconds / FRAME_S)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        no_input_timeout_s=1.0, quiet_period_s=0.5, max_reply_s=5.0, max_repeats=2
    )


async def eventually(check, within: float = 2.0) -> None:
    async with asyncio.timeout(within):
        while True:
            if check():
                return
            await asyncio.sleep(0.005)


async def no_pace(_seconds: float) -> None:
    await asyncio.sleep(0.0002)
