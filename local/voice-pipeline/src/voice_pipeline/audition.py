"""Renders the audition prompts in each installed voice and times synthesis.

    python -m voice_pipeline.audition OUT_DIR [voice ...]

Writes one 16 kHz WAV per prompt and voice, and prints the real-time factor
(synthesis time over audio duration; below 1 keeps up with a call).
"""

import sys
import time
import wave
from pathlib import Path

from voice_pipeline.config import BYTES_PER_SECOND, SAMPLE_RATE, Settings
from voice_pipeline.models import SpeakerBank

# What `ask_by_phone` speaks: a question, preceded by "Context: ..." when the
# caller supplies context.
PROMPTS = {
    "plain": "Should I delete the old feature branch, or keep it around for a "
    "few more days?",
    "context": "Context: I finished the database migration on staging and every "
    "test passes. Should I go ahead and run it on production now?",
    "numbers": "Context: The build took 3 minutes and 42 seconds, and 17 of 2,450 "
    "tests failed. Do you want me to retry, or investigate first?",
    "technical": "Context: The Kubernetes deployment for the API gateway is "
    "failing its readiness probe because the Postgres connection pool is "
    "exhausted. Should I roll back to version 2.14.3, or raise max connections "
    "to 200?",
    "long": "Context: I refactored the authentication middleware to use JSON web "
    "tokens instead of server-side sessions. It passes the unit tests, but the "
    "integration suite is flaky on two endpoints, and the staging deploy is "
    "currently blocked on a certificate renewal. Should I merge the refactor "
    "now, wait for staging, or split it into two smaller pull requests?",
}


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)


def main(argv: list[str]) -> None:
    out = Path(argv[0])
    bank = SpeakerBank(Path(Settings.from_env().models_dir))
    installed = bank.available()
    names = [n for n in (argv[1:] or installed) if n in installed]
    out.mkdir(parents=True, exist_ok=True)

    print(f"{'voice':28} " + " ".join(f"{p:>9}" for p in PROMPTS))
    for name in names:
        speaker = bank.get(name)
        speaker.synthesize("Warming up.")
        factors = []
        for prompt_id, text in PROMPTS.items():
            start = time.perf_counter()
            pcm = speaker.synthesize(text)
            elapsed = time.perf_counter() - start
            factors.append(elapsed / (len(pcm) / BYTES_PER_SECOND))
            write_wav(out / f"{prompt_id}--{name}.wav", pcm)
        print(f"{name:28} " + " ".join(f"{f:9.2f}" for f in factors), flush=True)
    print("words:", {p: len(t.split()) for p, t in PROMPTS.items()})


if __name__ == "__main__":
    main(sys.argv[1:])
