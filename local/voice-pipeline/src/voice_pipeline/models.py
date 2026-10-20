"""CPU-only speech models behind the `engines` interfaces."""

import threading
import wave
from pathlib import Path
from typing import Protocol

import numpy as np
import soxr

from voice_pipeline.config import SAMPLE_RATE
from voice_pipeline.engines import Speaker

# Silero VAD's fixed window at 16 kHz, and the trailing samples of the
# previous window it expects prepended to each one.
VAD_WINDOW = 512
VAD_CONTEXT = 64


class _OnnxSession(Protocol):
    def run(self, output_names, input_feed): ...


class SileroVad:
    """Silero VAD (ONNX, no torch), run natively at 16 kHz.

    Audio arrives in 20 ms frames but the model takes 32 ms windows, so
    samples are buffered and `is_speech` reports the latest window's verdict.
    """

    def __init__(self, session: _OnnxSession, threshold: float) -> None:
        self._session = session
        self._threshold = threshold
        self.reset()

    @classmethod
    def load(cls, path: Path, threshold: float) -> SileroVad:
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
        audio = samples.astype(np.float32) / 32768.0
        segments, _ = self._model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


# Flow-matching steps per Pocket TTS frame; more steps are cleaner and, at this
# model size, barely slower.
POCKET_STEPS = 5
# ONNX Runtime threads for the sherpa-onnx engines.
SHERPA_THREADS = 4


def _sherpa_tts(model: object):
    import sherpa_onnx

    model.num_threads = SHERPA_THREADS
    model.provider = "cpu"
    config = sherpa_onnx.OfflineTtsConfig(model=model)
    if not config.validate():
        raise ValueError("invalid sherpa-onnx TTS configuration")
    return sherpa_onnx.OfflineTts(config)


class UnknownVoice(ValueError):
    pass


def _to_slin(samples: np.ndarray, rate: int) -> bytes:
    """Resamples mono audio (int16 or float in [-1, 1]) to 16 kHz slin."""
    if samples.dtype != np.int16:
        samples = np.clip(samples, -1.0, 1.0) * 32767.0
    resampled = soxr.resample(samples.astype(np.float32), rate, SAMPLE_RATE)
    return np.clip(np.rint(resampled), -32768, 32767).astype(np.int16).tobytes()


class PiperSpeaker:
    def __init__(self, voice_path: Path) -> None:
        from piper import PiperVoice

        self._voice = PiperVoice.load(voice_path)

    def synthesize(self, text: str) -> bytes:
        chunks = [chunk.audio_int16_array for chunk in self._voice.synthesize(text)]
        speech = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
        return _to_slin(speech, self._voice.config.sample_rate)


class KokoroSpeaker:
    """Kokoro-82M (ONNX, run by sherpa-onnx) speaking as one of its voices.

    The voices share one loaded model, which `load_model` returns.
    """

    # The release's voices.bin lists its English voices in this order.
    VOICES = (
        "af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova "
        "af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam "
        "am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily "
        "bm_daniel bm_fable bm_george bm_lewis"
    ).split()

    def __init__(self, model: object, voice: str) -> None:
        if voice not in self.VOICES:
            raise UnknownVoice(f"kokoro:{voice}")
        self._tts = model
        self._sid = self.VOICES.index(voice)

    @staticmethod
    def load_model(model_dir: Path) -> object:
        import sherpa_onnx

        kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=str(model_dir / "model.onnx"),
            voices=str(model_dir / "voices.bin"),
            tokens=str(model_dir / "tokens.txt"),
            lexicon=str(model_dir / "lexicon-us-en.txt"),
            data_dir=str(model_dir / "espeak-ng-data"),
        )
        return _sherpa_tts(sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro))

    def synthesize(self, text: str) -> bytes:
        audio = self._tts.generate(text, sid=self._sid)
        return _to_slin(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)


class PocketSpeaker:
    """Kyutai Pocket TTS (int8 ONNX, run by sherpa-onnx), cloning the voice in a
    mono 16-bit WAV reference recording."""

    def __init__(self, model_dir: Path, reference: Path) -> None:
        import sherpa_onnx

        pocket = sherpa_onnx.OfflineTtsPocketModelConfig(
            lm_flow=str(model_dir / "lm_flow.int8.onnx"),
            lm_main=str(model_dir / "lm_main.int8.onnx"),
            encoder=str(model_dir / "encoder.onnx"),
            decoder=str(model_dir / "decoder.int8.onnx"),
            text_conditioner=str(model_dir / "text_conditioner.onnx"),
            vocab_json=str(model_dir / "vocab.json"),
            token_scores_json=str(model_dir / "token_scores.json"),
        )
        self._tts = _sherpa_tts(sherpa_onnx.OfflineTtsModelConfig(pocket=pocket))
        with wave.open(str(reference)) as wav:
            pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
            self._reference_rate = wav.getframerate()
        self._reference = pcm.astype(np.float32) / 32768.0

    def synthesize(self, text: str) -> bytes:
        import sherpa_onnx

        config = sherpa_onnx.GenerationConfig()
        config.reference_audio = self._reference
        config.reference_sample_rate = self._reference_rate
        config.num_steps = POCKET_STEPS
        audio = self._tts.generate(text, config)
        return _to_slin(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)


class SpeakerBank:
    """Loads speakers on first use, named `engine:voice` (`piper:en_US-lessac-medium`,
    `kokoro:af_heart`, `pocket:alba-casual`)."""

    def __init__(self, models_dir: Path) -> None:
        self._dir = models_dir
        self._speakers: dict[str, Speaker] = {}
        self._kokoro: object | None = None
        self._lock = threading.Lock()

    def available(self) -> list[str]:
        """The `engine:voice` names whose model files are installed."""
        names = [
            f"piper:{path.name.removesuffix('.onnx')}"
            for path in sorted(self._dir.glob("*.onnx"))
            if path.name != "silero_vad.onnx"
        ]
        if (self._dir / "kokoro" / "model.onnx").exists():
            names += [f"kokoro:{voice}" for voice in KokoroSpeaker.VOICES]
        names += [
            f"pocket:{path.stem}"
            for path in sorted((self._dir / "pocket" / "voices").glob("*.wav"))
        ]
        return names

    def get(self, name: str) -> Speaker:
        """Returns the speaker, loading it on first use. Raises `UnknownVoice`
        if it isn't installed."""
        with self._lock:
            if name not in self._speakers:
                if name not in self.available():
                    raise UnknownVoice(name)
                engine, _, voice = name.partition(":")
                self._speakers[name] = self._load(engine, voice)
            return self._speakers[name]

    def _load(self, engine: str, voice: str) -> Speaker:
        if engine == "piper":
            return PiperSpeaker(self._dir / f"{voice}.onnx")
        if engine == "kokoro":
            if self._kokoro is None:
                self._kokoro = KokoroSpeaker.load_model(self._dir / "kokoro")
            return KokoroSpeaker(self._kokoro, voice)
        return PocketSpeaker(
            self._dir / "pocket", self._dir / "pocket" / "voices" / f"{voice}.wav"
        )
