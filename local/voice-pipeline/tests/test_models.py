import numpy as np
import pytest

from voice_pipeline.config import FRAME_BYTES, Settings
from voice_pipeline.models import (
    VAD_CONTEXT,
    VAD_WINDOW,
    SileroVad,
    SpeakerBank,
    UnknownVoice,
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


def test_the_bank_lists_the_voices_whose_models_are_installed(tmp_path):
    (tmp_path / "silero_vad.onnx").touch()
    (tmp_path / "en_US-lessac-medium.onnx").touch()
    (tmp_path / "pocket" / "voices").mkdir(parents=True)
    (tmp_path / "pocket" / "voices" / "alba-casual.wav").touch()

    available = SpeakerBank(tmp_path).available()

    assert available == ["piper:en_US-lessac-medium", "pocket:alba-casual"]


def test_the_bank_lists_every_kokoro_voice_once_its_model_is_installed(tmp_path):
    (tmp_path / "kokoro").mkdir()
    (tmp_path / "kokoro" / "model.onnx").touch()

    available = SpeakerBank(tmp_path).available()

    assert "kokoro:af_heart" in available
    assert "kokoro:am_michael" in available


def test_the_bank_refuses_a_voice_that_is_not_installed(tmp_path):
    with pytest.raises(UnknownVoice):
        SpeakerBank(tmp_path).get("piper:missing")


@pytest.mark.parametrize(
    ("engine", "voice", "name"),
    [
        ("piper", "", "piper:en_US-lessac-medium"),
        ("kokoro", "", "kokoro:af_heart"),
        ("pocket", "", "pocket:alba-casual"),
        ("kokoro", "am_michael", "kokoro:am_michael"),
    ],
)
def test_the_default_voice_follows_the_engine(engine, voice, name):
    assert Settings(tts_engine=engine, tts_voice=voice).tts_voice_name == name
