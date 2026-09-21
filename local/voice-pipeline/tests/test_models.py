import numpy as np

from voice_pipeline.config import FRAME_BYTES
from voice_pipeline.models import VAD_CONTEXT, VAD_WINDOW, SileroVad


class FakeSession:
    def __init__(self, *probabilities: float) -> None:
        self._probabilities = list(probabilities)
        self.inputs: list[dict] = []

    def run(self, _names, feed):
        self.inputs.append(feed)
        state = np.ones((2, 1, 128), dtype=np.float32)
        return np.array([[self._probabilities.pop(0)]]), state


FRAME = (np.arange(FRAME_BYTES // 2, dtype=np.int16)).tobytes()


def test_windows_are_run_as_enough_audio_arrives():
    session = FakeSession(0.9)
    vad = SileroVad(session, threshold=0.5)

    # 160 samples per frame: the first frame is short of a 256-sample window.
    assert not vad.is_speech(FRAME)
    assert session.inputs == []
    assert vad.is_speech(FRAME)
    assert session.inputs[0]["input"].shape == (1, VAD_CONTEXT + VAD_WINDOW)


def test_verdict_holds_until_the_next_window_completes():
    session = FakeSession(0.9, 0.1)
    vad = SileroVad(session, threshold=0.5)

    vad.is_speech(FRAME)
    assert vad.is_speech(FRAME)
    assert vad.is_speech(FRAME)  # 64 samples pending; still the last verdict
    assert not vad.is_speech(FRAME)  # completes a second window


def test_context_and_state_carry_between_windows():
    session = FakeSession(0.9, 0.9)
    vad = SileroVad(session, threshold=0.5)

    for _ in range(4):
        vad.is_speech(FRAME)

    first, second = session.inputs
    assert np.all(first["state"] == 0)
    assert np.all(second["state"] == 1)
    assert np.array_equal(
        second["input"][0, :VAD_CONTEXT], first["input"][0, -VAD_CONTEXT:]
    )


def test_reset_clears_the_verdict_and_state():
    session = FakeSession(0.9)
    vad = SileroVad(session, threshold=0.5)
    vad.is_speech(FRAME)
    vad.is_speech(FRAME)

    vad.reset()

    assert not vad.is_speech(FRAME)
