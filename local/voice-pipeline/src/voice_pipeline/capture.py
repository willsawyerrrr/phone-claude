"""Opt-in recording of the caller's audio while listening, for tuning speech
detection offline."""

import json
import wave
from pathlib import Path

from voice_pipeline.config import FRAME_BYTES, SAMPLE_RATE, Settings

FRAME_S = FRAME_BYTES / (SAMPLE_RATE * 2)


class ListenCapture:
    """Records one listening phase as `<call id>-<n>.wav` (the inbound 16 kHz
    audio) and `<call id>-<n>.json`.

    The JSON holds the settings, a `frames` list of `[time, speech probability,
    speech]` per 20 ms frame, the session's `events` as `[time, name, detail]`,
    and the `outcome`. Times are seconds from the start of the phase.
    """

    def __init__(
        self, directory: Path, call_id: str, index: int, settings: Settings
    ) -> None:
        self._stem = directory / f"{call_id}-{index}"
        self._settings = settings
        self._pcm = bytearray()
        self._frames: list[list] = []
        self._events: list[list] = []

    def frame(self, pcm: bytes, probability: float | None, speech: bool) -> None:
        self._frames.append(
            [round(len(self._frames) * FRAME_S, 3), probability, speech]
        )
        self._pcm.extend(pcm)

    def event(self, name: str, detail: str = "") -> None:
        self._events.append([round(len(self._frames) * FRAME_S, 3), name, detail])

    def save(self, outcome: str) -> None:
        self._stem.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(self._stem.with_suffix(".wav")), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(bytes(self._pcm))
        sidecar = {
            "settings": {
                "vad_threshold": self._settings.vad_threshold,
                "quiet_period_s": self._settings.quiet_period_s,
                "max_reply_s": self._settings.max_reply_s,
            },
            "frames": self._frames,
            "events": self._events,
            "outcome": outcome,
        }
        self._stem.with_suffix(".json").write_text(json.dumps(sidecar))
