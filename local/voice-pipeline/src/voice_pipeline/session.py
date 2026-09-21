import asyncio
import logging
import re
from collections import deque
from collections.abc import Awaitable, Callable
from enum import Enum

from voice_pipeline.audiosocket import KIND_AUDIO, Channel
from voice_pipeline.config import BYTES_PER_SECOND, FRAME_BYTES, Settings
from voice_pipeline.engines import Speaker, Transcriber, VoiceActivityDetector
from voice_pipeline.store import CallRecord, CallStore

log = logging.getLogger(__name__)

FRAME_S = FRAME_BYTES / BYTES_PER_SECOND
SILENCE = bytes(FRAME_BYTES)
# Audio kept from just before the VAD first fires, so the start of a word
# isn't clipped.
PREROLL_FRAMES = 10

GOODBYE = "Got it, thanks. Goodbye."
NO_INPUT_GOODBYE = "Sorry, I didn't catch that. Goodbye."
NO_INPUT_ERROR = "No reply was heard"
HANGUP_ERROR = "The call ended before an answer was captured"

# Heuristic match for "please repeat that" rather than an actual answer. The
# questions are short and answer-oriented (yes/no, a pick from a few
# options), so a real answer containing these words is unlikely enough that a
# keyword match beats real NLU.
REPEAT_PATTERN = re.compile(
    r"\b(repeat|again|come again|one more time|say (that|it) once more|"
    r"what was that|didn'?t (catch|hear|get) that|pardon)\b",
    re.IGNORECASE,
)

Pace = Callable[[float], Awaitable[None]]


class _RealtimePacer:
    """Sleeps to a fixed schedule, so per-frame overhead doesn't accumulate
    into audio underruns."""

    def __init__(self) -> None:
        self._next: float | None = None

    async def __call__(self, seconds: float) -> None:
        now = asyncio.get_running_loop().time()
        if self._next is None or now - self._next > 1.0:
            self._next = now
        self._next += seconds
        await asyncio.sleep(max(0.0, self._next - now))


class _NoInput(Enum):
    TIMED_OUT = "timed out"
    HUNG_UP = "hung up"


class CallSession:
    """Drives one call: speaks the prompt, listens for the caller's reply,
    and records the outcome.

    Asterisk drops a connection that goes quiet, so audio (the prompt, or
    silence between prompts) is sent at real-time pace from the moment the
    call connects until it ends, including while speech models are busy.

    Time is measured in received audio rather than wall-clock time, so the
    no-input and quiet-period waits track what the caller actually heard and
    said. Cancelling the task running `run` hangs the call up.
    """

    def __init__(
        self,
        record: CallRecord,
        channel: Channel,
        vad: VoiceActivityDetector,
        stt: Transcriber,
        tts: Speaker,
        store: CallStore,
        settings: Settings,
        pace: Pace | None = None,
    ) -> None:
        self._record = record
        self._channel = channel
        self._vad = vad
        self._stt = stt
        self._tts = tts
        self._store = store
        self._settings = settings
        self._pace = pace or _RealtimePacer()
        self._inbox: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._outbound = bytearray()
        self._outbound_flushed = asyncio.Event()
        self._hung_up = asyncio.Event()

    async def run(self) -> None:
        call_id = self._record.call_id
        background = [
            asyncio.create_task(self._pump()),
            asyncio.create_task(self._stream_outbound()),
        ]
        try:
            if self._record.status == "pending":
                await self._converse()
        finally:
            for task in background:
                task.cancel()
            await asyncio.gather(*background, return_exceptions=True)
            await asyncio.shield(self._end_call())
        log.info("call %s ended: %s", call_id, self._record.status)

    async def _converse(self) -> None:
        call_id = self._record.call_id
        prompt = self._record.prompt
        repeats = 0
        while True:
            await self._speak(prompt)
            outcome = await self._listen()

            if outcome is _NoInput.HUNG_UP:
                self._store.fail(call_id, HANGUP_ERROR)
                return
            if outcome is _NoInput.TIMED_OUT:
                if self._store.fail(call_id, NO_INPUT_ERROR):
                    await self._speak(NO_INPUT_GOODBYE)
                return

            log.info("call %s heard %r", call_id, outcome)
            if REPEAT_PATTERN.search(outcome) and repeats < self._settings.max_repeats:
                repeats += 1
                prompt = f"One more time. {self._record.prompt}"
                continue
            if self._store.answer(call_id, outcome):
                await self._speak(GOODBYE)
            return

    async def _pump(self) -> None:
        """Feeds inbound audio to the inbox and notes when the caller leaves."""
        while True:
            frame = await self._channel.recv()
            if frame is None or frame.kind != KIND_AUDIO:
                if frame is None or frame.kind in (0x00, 0xFF):
                    self._hung_up.set()
                    self._outbound_flushed.set()
                    self._inbox.put_nowait(None)
                    return
                continue
            self._inbox.put_nowait(frame.payload)

    async def _speak(self, text: str) -> None:
        pcm = await asyncio.to_thread(self._tts.synthesize, text)
        if self._hung_up.is_set():
            return
        self._outbound_flushed.clear()
        self._outbound.extend(pcm)
        await self._outbound_flushed.wait()

    async def _stream_outbound(self) -> None:
        """Sends one frame per tick: queued speech, else silence."""
        while True:
            if self._outbound:
                frame = bytes(self._outbound[:FRAME_BYTES]).ljust(FRAME_BYTES, b"\0")
                del self._outbound[:FRAME_BYTES]
                # The caller isn't listened to while the prompt plays.
                while not self._inbox.empty():
                    self._inbox.get_nowait()
            else:
                frame = SILENCE
                self._outbound_flushed.set()
            await self._channel.send_audio(frame)
            await self._pace(FRAME_S)

    async def _listen(self) -> str | _NoInput:
        """Waits for the caller's complete reply and transcribes it.

        A reply is complete once `quiet_period_s` passes with no further
        speech — a reply often has pauses, so the first stretch of speech
        isn't taken as the whole thing.
        """
        settings = self._settings
        self._vad.reset()
        clock = 0.0
        speech_started: float | None = None
        last_speech = 0.0
        preroll: deque[bytes] = deque(maxlen=PREROLL_FRAMES)
        audio = bytearray()

        while True:
            if self._hung_up.is_set():
                return _NoInput.HUNG_UP
            frame = await self._inbox.get()
            if frame is None:
                return _NoInput.HUNG_UP
            clock += len(frame) / BYTES_PER_SECOND

            if self._vad.is_speech(frame):
                if speech_started is None:
                    speech_started = clock
                    audio.extend(b"".join(preroll))
                audio.extend(frame)
                last_speech = clock
            elif speech_started is None:
                preroll.append(frame)
            else:
                audio.extend(frame)

            if speech_started is None:
                if clock >= settings.no_input_timeout_s:
                    return _NoInput.TIMED_OUT
                continue

            if (
                clock - last_speech >= settings.quiet_period_s
                or clock - speech_started >= settings.max_reply_s
            ):
                text = await asyncio.to_thread(self._stt.transcribe, bytes(audio))
                text = text.strip()
                if text:
                    return text
                # Nothing intelligible (e.g. a cough): keep waiting for a
                # reply, still within the original no-input window.
                speech_started = None
                audio.clear()
                preroll.clear()
                self._vad.reset()

    async def _end_call(self) -> None:
        await self._channel.send_hangup()
        await self._channel.close()
