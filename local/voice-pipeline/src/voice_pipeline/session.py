import asyncio
import logging
import re
from collections import deque
from collections.abc import Awaitable, Callable
from enum import Enum
from pathlib import Path

from voice_pipeline.audiosocket import KIND_AUDIO, KIND_ERROR, KIND_HANGUP, Channel
from voice_pipeline.capture import ListenCapture
from voice_pipeline.config import BYTES_PER_SECOND, FRAME_BYTES, Settings
from voice_pipeline.engines import Speaker, Transcriber, VoiceActivityDetector
from voice_pipeline.loudness import RelativeLoudnessGate
from voice_pipeline.store import CallRecord, CallStore, Segment

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
SESSION_ERROR = "The call failed unexpectedly"

# Heuristic match for "please repeat that" rather than an actual answer. A
# bare keyword only counts when it is the whole reply, since replies such as
# "yes, run it again" or "don't repeat the migration" are real answers; longer
# replies must contain a phrase that asks for the question.
REPEAT_PATTERN = re.compile(
    r"^\W*(please\s+)?(repeat(\s+(that|it))?|again|pardon(\s+me)?|sorry|what|"
    r"come\s+again|one\s+more\s+time|say\s+(that|it)\s+again)(\s+please)?\W*$"
    r"|\b((can|could|would|will)\s+you\s+(please\s+)?(repeat|say\s+(that|it)\s+again)|"
    r"say\s+(that|it)\s+(again|once\s+more)|repeat\s+the\s+question|"
    r"what\s+(was|is)\s+(that|the\s+question)|"
    r"didn'?t\s+(catch|hear|get)\s+that)\b",
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
        voices: Callable[[str], Speaker] | None = None,
    ) -> None:
        self._record = record
        self._channel = channel
        self._vad = vad
        self._stt = stt
        self._tts = tts
        self._voices = voices
        self._store = store
        self._settings = settings
        self._pace = pace or _RealtimePacer()
        self._inbox: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._outbound = bytearray()
        self._outbound_flushed = asyncio.Event()
        self._hung_up = asyncio.Event()
        self._gate = RelativeLoudnessGate(settings.loudness_margin_db)
        self._listens = 0
        self._capture: ListenCapture | None = None

    async def run(self) -> None:
        call_id = self._record.call_id
        background = [
            asyncio.create_task(self._pump()),
            asyncio.create_task(self._stream_outbound()),
        ]
        for task in background:
            task.add_done_callback(self._on_background_done)
        try:
            if self._record.status == "pending":
                await self._converse()
        except Exception:
            log.exception("call %s crashed", call_id)
            self._store.fail(call_id, SESSION_ERROR)
        finally:
            for task in background:
                task.cancel()
            await asyncio.gather(*background, return_exceptions=True)
            await asyncio.shield(self._end_call())
        log.info("call %s ended: %s", call_id, self._record.status)

    def _on_background_done(self, task: asyncio.Task) -> None:
        """Fails the call and stops waiting on the caller if a background task
        crashes."""
        if task.cancelled() or task.exception() is None:
            return
        call_id = self._record.call_id
        log.error("call %s crashed", call_id, exc_info=task.exception())
        self._store.fail(call_id, SESSION_ERROR)
        self._hung_up.set()
        self._outbound_flushed.set()
        self._inbox.put_nowait(None)

    async def _converse(self) -> None:
        call_id = self._record.call_id
        script = self._record.script
        repeats = 0
        while True:
            await self._speak(script)
            outcome = await self._listen()

            if outcome is _NoInput.HUNG_UP:
                self._store.fail(call_id, HANGUP_ERROR)
                return
            if outcome is _NoInput.TIMED_OUT:
                if self._store.fail(call_id, NO_INPUT_ERROR):
                    await self._speak((Segment(NO_INPUT_GOODBYE),))
                return

            log.info("call %s heard %r", call_id, outcome)
            if REPEAT_PATTERN.search(outcome) and repeats < self._settings.max_repeats:
                repeats += 1
                first, *rest = self._record.script
                script = (Segment(f"One more time. {first.text}", first.voice), *rest)
                continue
            if self._store.answer(call_id, outcome):
                await self._speak((Segment(GOODBYE),))
            return

    async def _pump(self) -> None:
        """Feeds inbound audio to the inbox and notes when the caller leaves."""
        while True:
            frame = await self._channel.recv()
            if frame is None or frame.kind in (KIND_HANGUP, KIND_ERROR):
                self._hung_up.set()
                self._outbound_flushed.set()
                self._inbox.put_nowait(None)
                return
            if frame.kind == KIND_AUDIO:
                self._inbox.put_nowait(frame.payload)

    async def _speak(self, script: tuple[Segment, ...]) -> None:
        for segment in script:
            pcm = await asyncio.to_thread(self._synthesize, segment)
            if self._hung_up.is_set():
                return
            self._outbound_flushed.clear()
            self._outbound.extend(pcm)
            await self._outbound_flushed.wait()

    def _synthesize(self, segment: Segment) -> bytes:
        if segment.voice is None or self._voices is None:
            return self._tts.synthesize(segment.text)
        return self._voices(segment.voice).synthesize(segment.text)

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
        """Listens for the caller's reply, recording it if `capture_dir` is set."""
        if not self._settings.capture_dir:
            return await self._await_reply()
        self._listens += 1
        self._capture = ListenCapture(
            Path(self._settings.capture_dir),
            self._record.call_id,
            self._listens,
            self._settings,
        )
        outcome = "cancelled"
        try:
            result = await self._await_reply()
            outcome = result.value if isinstance(result, _NoInput) else result
            return result
        finally:
            self._capture.save(outcome)
            self._capture = None

    async def _await_reply(self) -> str | _NoInput:
        """Waits for the caller's complete reply and transcribes it.

        A reply is complete once `quiet_period_s` passes with no further
        speech — a reply often has pauses, so the first stretch of speech
        isn't taken as the whole thing.

        Timing follows the received audio, so it only advances while frames
        arrive. If none arrive at all, the wait is bounded in wall-clock time
        instead: `no_input_timeout_s` before any speech, `quiet_period_s`
        once the caller has started (the same silence that ends a reply).

        If the caller hangs up after speaking, what they said is transcribed
        rather than discarded.
        """
        settings = self._settings
        self._vad.reset()
        self._gate.reset()
        clock = 0.0
        speech_started: float | None = None
        last_speech = 0.0
        preroll: deque[bytes] = deque(maxlen=PREROLL_FRAMES)
        audio = bytearray()

        while True:
            # Audio queued before the hangup is consumed first; the pump
            # queues the end-of-call sentinel after it.
            if self._hung_up.is_set() and self._inbox.empty():
                return await self._reply_at_hangup(audio, speech_started)
            stall_limit = (
                settings.no_input_timeout_s
                if speech_started is None
                else settings.quiet_period_s
            )
            stalled = False
            try:
                frame = await asyncio.wait_for(self._inbox.get(), stall_limit)
            except TimeoutError:
                stalled = True
            else:
                if frame is None:
                    return await self._reply_at_hangup(audio, speech_started)
                clock += len(frame) / BYTES_PER_SECOND

                speech = self._gate.admits(frame, self._vad.is_speech(frame))
                if self._capture:
                    self._capture.frame(
                        frame, getattr(self._vad, "probability", None), speech
                    )
                if speech:
                    if speech_started is None:
                        speech_started = clock
                        if self._capture:
                            self._capture.event("speech_start")
                        audio.extend(b"".join(preroll))
                    audio.extend(frame)
                    last_speech = clock
                elif speech_started is None:
                    preroll.append(frame)
                else:
                    audio.extend(frame)

            if speech_started is None:
                if stalled or clock >= settings.no_input_timeout_s:
                    return _NoInput.TIMED_OUT
                continue

            if (
                stalled
                or clock - last_speech >= settings.quiet_period_s
                or clock - speech_started >= settings.max_reply_s
            ):
                if self._capture:
                    self._capture.event("reply_end")
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
                self._gate.reset()

    async def _reply_at_hangup(
        self, audio: bytearray, speech_started: float | None
    ) -> str | _NoInput:
        """Transcribes the speech captured before the caller hung up, so a
        reply isn't lost to a hangup that follows it closely. Returns
        `_NoInput.HUNG_UP` if there was no intelligible speech."""
        if speech_started is not None:
            text = await asyncio.to_thread(self._stt.transcribe, bytes(audio))
            if text.strip():
                return text.strip()
        return _NoInput.HUNG_UP

    async def _end_call(self) -> None:
        await self._channel.send_hangup()
        await self._channel.close()
