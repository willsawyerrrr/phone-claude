"""CPU-only speech models behind the `engines` interfaces."""

from pathlib import Path
from typing import Protocol

import numpy as np
import soxr

from voice_pipeline.config import SAMPLE_RATE

WHISPER_RATE = 16000
# Silero VAD's fixed window at 8 kHz, and the trailing samples of the
# previous window it expects prepended to each one.
VAD_WINDOW = 256
VAD_CONTEXT = 32


class _OnnxSession(Protocol):
    def run(self, output_names, input_feed): ...


class SileroVad:
    """Silero VAD (ONNX, no torch), run natively at 8 kHz.

    Audio arrives in 20 ms frames but the model takes 32 ms windows, so
    samples are buffered and `is_speech` reports the latest window's verdict.
    """

    def __init__(self, session: _OnnxSession, threshold: float) -> None:
        self._session = session
        self._threshold = threshold
        self.reset()

    @classmethod
    def load(cls, path: Path, threshold: float) -> "SileroVad":
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        return cls(
            onnxruntime.InferenceSession(
                str(path), sess_options=options, providers=["CPUExecutionProvider"]
            ),
            threshold,
        )

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(VAD_CONTEXT, dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)
        self._probability = 0.0

    def is_speech(self, pcm: bytes) -> bool:
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        self._pending = np.concatenate([self._pending, samples])
        while len(self._pending) >= VAD_WINDOW:
            window, self._pending = (
                self._pending[:VAD_WINDOW],
                self._pending[VAD_WINDOW:],
            )
            model_input = np.concatenate([self._context, window])[np.newaxis, :]
            output, self._state = self._session.run(
                None,
                {
                    "input": model_input,
                    "state": self._state,
                    "sr": np.array(SAMPLE_RATE, dtype=np.int64),
                },
            )
            self._context = model_input[0, -VAD_CONTEXT:]
            self._probability = float(output[0][0])
        return self._probability >= self._threshold


class WhisperTranscriber:
    def __init__(self, model_dir: Path) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(str(model_dir), device="cpu", compute_type="int8")

    def transcribe(self, pcm: bytes) -> str:
        samples = np.frombuffer(pcm, dtype=np.int16)
        audio = soxr.resample(samples, SAMPLE_RATE, WHISPER_RATE).astype(np.float32)
        audio /= 32768.0
        segments, _ = self._model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


class PiperSpeaker:
    def __init__(self, voice_path: Path) -> None:
        from piper import PiperVoice

        self._voice = PiperVoice.load(voice_path)

    def synthesize(self, text: str) -> bytes:
        chunks = [chunk.audio_int16_array for chunk in self._voice.synthesize(text)]
        rate = self._voice.config.sample_rate
        speech = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
        return soxr.resample(speech, rate, SAMPLE_RATE).astype(np.int16).tobytes()
