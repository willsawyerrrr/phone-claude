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
    apns_key_id: str = ""
    apns_team_id: str = ""
    apns_key_file: str = "/run/secrets/apns_key"
    apns_topic: str = "dev.willsawyerrrr.phone-claude.voip"
    device_file: str = "/data/device.json"
    device_port: int = 8081
    # Bearer token the soft-phone presents to register its push token.
    device_secret: str = ""

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
            apns_key_id=env("APNS_KEY_ID", d.apns_key_id),
            apns_team_id=env("APNS_TEAM_ID", d.apns_team_id),
            apns_key_file=env("APNS_KEY_FILE", d.apns_key_file),
            apns_topic=env("APNS_TOPIC", d.apns_topic) or d.apns_topic,
            device_file=env("DEVICE_FILE", d.device_file),
            device_port=int(env("DEVICE_PORT", d.device_port)),
            device_secret=env("DEVICE_SECRET", d.device_secret),
        )
