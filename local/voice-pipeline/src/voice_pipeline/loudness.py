from collections import deque

import numpy as np

from voice_pipeline.config import FRAME_BYTES, SAMPLE_RATE

FRAME_S = FRAME_BYTES / (SAMPLE_RATE * 2)
# Frames averaged for the level compared against the loudest speech (200 ms).
LEVEL_FRAMES = 10
FLOOR_DB = -120.0


class RelativeLoudnessGate:
    """Discards speech much quieter than the loudest speech so far.

    The caller is close to the phone, so a talker in the background (a TV, other
    people) is quieter than they are. Counting only speech within `margin_db` of
    the loudest lets a reply end promptly after the caller stops, instead of
    running on for as long as the background talks. The loudest level fades by
    `decay_db_per_s`, so one loud outburst doesn't mute the rest of the reply.
    A `margin_db` of zero or less admits all speech.
    """

    def __init__(self, margin_db: float, decay_db_per_s: float = 1.0) -> None:
        self._margin_db = margin_db
        self._decay_db = decay_db_per_s * FRAME_S
        self.reset()

    def reset(self) -> None:
        self._powers: deque[float] = deque(maxlen=LEVEL_FRAMES)
        self._loudest = FLOOR_DB

    def admits(self, pcm: bytes, speech: bool) -> bool:
        """Whether a 20 ms frame, which the VAD calls speech or not, counts as
        speech."""
        if self._margin_db <= 0:
            return speech
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768.0
        self._powers.append(float(np.mean(samples**2)))
        level = 10 * np.log10(np.mean(self._powers) + 1e-12)
        self._loudest = max(self._loudest - self._decay_db, FLOOR_DB)
        if not speech:
            return False
        self._loudest = max(self._loudest, level)
        return bool(level >= self._loudest - self._margin_db)
