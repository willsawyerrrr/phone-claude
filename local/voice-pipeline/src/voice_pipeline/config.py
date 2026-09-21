import os
from dataclasses import dataclass

SAMPLE_RATE = 8000
BYTES_PER_SECOND = SAMPLE_RATE * 2
FRAME_BYTES = 320  # 20 ms of 8 kHz, 16-bit mono


@dataclass(frozen=True)
class Settings:
    audiosocket_port: int = 9092
    http_port: int = 8080
    # How long to wait for the caller to say anything at all after a prompt.
    no_input_timeout_s: float = 15.0
    # Silence after speech that marks the caller's reply as complete.
    quiet_period_s: float = 3.0
    # Upper bound on one reply, so a caller who never stops can't hold a call.
    max_reply_s: float = 60.0
    # How many times the caller can ask to hear the question again.
    max_repeats: int = 3
    call_ttl_s: float = 3600.0
    vad_threshold: float = 0.5
    models_dir: str = "/models"
    whisper_model: str = "whisper-base.en"
    piper_voice: str = "en_US-lessac-medium"

    @classmethod
    def from_env(cls) -> "Settings":
        d = cls()
        env = os.environ.get
        return cls(
            audiosocket_port=int(env("AUDIOSOCKET_PORT", d.audiosocket_port)),
            http_port=int(env("HTTP_PORT", d.http_port)),
            no_input_timeout_s=float(env("NO_INPUT_TIMEOUT_S", d.no_input_timeout_s)),
            quiet_period_s=float(env("QUIET_PERIOD_S", d.quiet_period_s)),
            max_reply_s=float(env("MAX_REPLY_S", d.max_reply_s)),
            max_repeats=int(env("MAX_REPEATS", d.max_repeats)),
            call_ttl_s=float(env("CALL_TTL_S", d.call_ttl_s)),
            vad_threshold=float(env("VAD_THRESHOLD", d.vad_threshold)),
            models_dir=env("MODELS_DIR", d.models_dir),
            whisper_model=env("WHISPER_MODEL", d.whisper_model),
            piper_voice=env("PIPER_VOICE", d.piper_voice),
        )
