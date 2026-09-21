"""Round-trips speech through the real models. Runs only where they're installed."""

from pathlib import Path

import numpy as np
import pytest

from voice_pipeline.config import FRAME_BYTES, Settings
from voice_pipeline.models import PiperSpeaker, SileroVad, WhisperTranscriber

MODELS = Path(Settings.from_env().models_dir)
SETTINGS = Settings.from_env()

pytestmark = pytest.mark.skipif(
    not (MODELS / "silero_vad.onnx").exists(), reason="models not installed"
)


@pytest.fixture(scope="module")
def spoken() -> bytes:
    speaker = PiperSpeaker(MODELS / f"{SETTINGS.piper_voice}.onnx")
    return speaker.synthesize("Yes, go ahead and ship it.")


def frames(pcm: bytes) -> list[bytes]:
    return [pcm[i : i + FRAME_BYTES] for i in range(0, len(pcm), FRAME_BYTES)]


def test_synthesised_speech_is_8khz_audio(spoken):
    assert 1.0 < len(spoken) / 16000 < 5.0
    assert np.abs(np.frombuffer(spoken, dtype=np.int16)).max() > 1000


def test_vad_tells_speech_from_silence(spoken):
    vad = SileroVad.load(MODELS / "silero_vad.onnx", SETTINGS.vad_threshold)

    heard = [vad.is_speech(frame) for frame in frames(spoken)]
    vad.reset()
    silent = [vad.is_speech(bytes(FRAME_BYTES)) for _ in range(50)]

    assert sum(heard) > len(heard) / 2
    assert not any(silent)


def test_transcriber_recovers_synthesised_speech(spoken):
    stt = WhisperTranscriber(MODELS / SETTINGS.whisper_model)

    text = stt.transcribe(spoken).lower()

    assert "ship" in text
