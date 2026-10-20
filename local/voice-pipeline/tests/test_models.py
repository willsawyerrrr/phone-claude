import numpy as np
import pytest

from voice_pipeline.config import FRAME_BYTES
from voice_pipeline.models import (
    VAD_CONTEXT,
    VAD_WINDOW,
    SileroVad,
    SpeakerBank,
    UnknownVoice,
    _to_slin,
)


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

    # 320 samples per frame: the first frame is short of a 512-sample window.
    assert not vad.is_speech(FRAME)
    assert session.inputs == []
    assert vad.is_speech(FRAME)
    assert session.inputs[0]["input"].shape == (1, VAD_CONTEXT + VAD_WINDOW)


def test_verdict_holds_until_the_next_window_completes():
    session = FakeSession(0.9, 0.1)
    vad = SileroVad(session, threshold=0.5)

    vad.is_speech(FRAME)
    assert vad.is_speech(FRAME)
    assert vad.is_speech(FRAME)  # 448 samples pending; still the last verdict
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


def test_the_bank_lists_the_installed_voices(tmp_path):
    voices = tmp_path / "pocket" / "voices"
    voices.mkdir(parents=True)
    (voices / "alba-casual.wav").touch()
    (voices / "alba-announcer.wav").touch()

    assert SpeakerBank(tmp_path).available() == ["alba-announcer", "alba-casual"]


def test_the_bank_refuses_a_voice_that_is_not_installed(tmp_path):
    with pytest.raises(UnknownVoice):
        SpeakerBank(tmp_path).get("missing")


def test_a_whole_utterance_is_resampled_to_16khz_in_one_pass():
    tone = np.sin(np.linspace(0, 2 * np.pi * 440, 24000, endpoint=False))

    pcm = _to_slin(tone.astype(np.float32), 24000)

    assert len(pcm) == 16000 * 2
    assert np.abs(np.frombuffer(pcm, dtype=np.int16)).max() > 30000
