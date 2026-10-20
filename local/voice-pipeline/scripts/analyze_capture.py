"""Replays a captured listening phase through candidate speech-detection
policies and shows when each would have ended the reply and what Whisper hears
in the audio it would send.

Run in the pipeline image, which has the models:

    docker compose run --rm --no-deps -v ./voice-pipeline/scripts:/scripts \\
        -v ./captures:/captures voice-pipeline \\
        python /scripts/analyze_capture.py /captures/<call>-1.wav [--policy SPEC ...]

A policy is `name=key:value,...` with keys `on` (speech probability to start
speech, default 0.5), `off` (to stay in speech, default `on`), `min` (seconds
of speech before a reply counts as started, default 0), `smooth` (frames in the
probability moving average, default 1), `gate` (dBFS below which a frame is
never speech, default none), `rel` (dB below the loudest speech so far under
which a frame is never speech, default none; the pipeline's
`LOUDNESS_MARGIN_DB`), `decay` (dB per second the loudest level fades, default
1) and `quiet` (seconds of quiet that end the reply,
default 1.5).
"""

import argparse
import json
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from voice_pipeline.config import FRAME_BYTES, SAMPLE_RATE, Settings
from voice_pipeline.loudness import RelativeLoudnessGate
from voice_pipeline.models import SileroVad, WhisperTranscriber

FRAME_S = FRAME_BYTES / (SAMPLE_RATE * 2)
PREROLL_S = 0.2

DEFAULT_POLICIES = [
    "baseline=on:0.5",
    "on0.7=on:0.7",
    "hyst=on:0.7,off:0.4",
    "hyst+min=on:0.7,off:0.4,min:0.3",
    "smooth=on:0.7,off:0.4,min:0.3,smooth:5",
    "rel8=rel:8",
    "rel10=rel:10",
    "rel12=rel:12",
    "rel15=rel:15",
]


@dataclass
class Policy:
    name: str
    on: float = 0.5
    off: float | None = None
    min: float = 0.0
    smooth: int = 1
    gate: float | None = None
    rel: float | None = None
    decay: float = 1.0
    quiet: float = 1.5


def parse_policy(spec: str) -> Policy:
    name, _, params = spec.partition("=")
    values = dict(item.split(":") for item in params.split(",") if item)
    kwargs = {key: float(value) for key, value in values.items()}
    if "smooth" in kwargs:
        kwargs["smooth"] = int(kwargs["smooth"])
    return Policy(name, **kwargs)


def frame_features(pcm: np.ndarray, vad: SileroVad) -> tuple[np.ndarray, np.ndarray]:
    """Per-frame Silero probability and level in dBFS."""
    samples = FRAME_BYTES // 2
    probs, levels = [], []
    for i in range(len(pcm) // samples):
        frame = pcm[i * samples : (i + 1) * samples]
        vad.is_speech(frame.tobytes())
        probs.append(vad.probability)
        rms = float(np.sqrt(np.mean((frame / 32768.0) ** 2)))
        levels.append(20 * np.log10(max(rms, 1e-6)))
    return np.array(probs), np.array(levels)


def replay(policy: Policy, probs, levels, pcm) -> tuple[float | None, float | None]:
    """Returns when speech started and when the reply would have ended
    (`None` if the audio ran out first)."""
    p = np.convolve(probs, np.ones(policy.smooth) / policy.smooth)[: len(probs)]
    off = policy.on if policy.off is None else policy.off
    gate = RelativeLoudnessGate(policy.rel or 0, policy.decay)
    samples = FRAME_BYTES // 2
    active = False
    run_start: int | None = None
    started: int | None = None
    last = 0
    for i, value in enumerate(p):
        candidate = value >= (off if active else policy.on)
        if policy.gate is not None and levels[i] < policy.gate:
            candidate = False
        frame = pcm[i * samples : (i + 1) * samples].tobytes()
        active = gate.admits(frame, bool(candidate))
        if active:
            if started is None:
                run_start = i if run_start is None else run_start
                if (i - run_start + 1) * FRAME_S >= policy.min:
                    started = run_start
            last = i
        else:
            run_start = None
            if started is not None and (i - last) * FRAME_S >= policy.quiet:
                return started * FRAME_S, (i + 1) * FRAME_S
    return (None if started is None else started * FRAME_S), None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("wav", type=Path)
    parser.add_argument("--policy", action="append", help="see module docstring")
    parser.add_argument("--no-transcribe", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    models = Path(settings.models_dir)

    with wave.open(str(args.wav)) as wav:
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16)
    probs, levels = frame_features(pcm, SileroVad.load(models / "silero_vad.onnx", 0))
    total = len(probs) * FRAME_S
    print(f"{args.wav.name}: {total:.1f} s")
    print(
        f"level dBFS p10/p50/p90: {np.percentile(levels, 10):.0f}/"
        f"{np.percentile(levels, 50):.0f}/{np.percentile(levels, 90):.0f}; "
        f"frames with p>=0.5: {np.mean(probs >= 0.5):.0%}"
    )
    sidecar = args.wav.with_suffix(".json")
    if sidecar.exists():
        data = json.loads(sidecar.read_text())
        print(f"live events: {data['events']}; outcome: {data['outcome']!r}")

    stt = (
        None
        if args.no_transcribe
        else WhisperTranscriber(models / settings.whisper_model)
    )
    cache: dict[tuple[int, int], str] = {}
    for spec in args.policy or DEFAULT_POLICIES:
        policy = parse_policy(spec)
        start, end = replay(policy, probs, levels, pcm)
        if start is None:
            print(f"\n{policy.name}: no speech")
            continue
        end_s = total if end is None else end
        first = max(0, int((start - PREROLL_S) / FRAME_S))
        last = int(end_s / FRAME_S)
        text = ""
        if stt:
            key = (first, last)
            if key not in cache:
                segment = pcm[first * FRAME_BYTES // 2 : last * FRAME_BYTES // 2]
                cache[key] = stt.transcribe(segment.tobytes())
            text = cache[key]
        ended = f"{end:.2f} s" if end is not None else "never (audio ran out)"
        print(
            f"\n{policy.name}: speech {start:.2f} s, reply ends {ended}, "
            f"sends {end_s - start:.1f} s\n  {text!r}"
        )


if __name__ == "__main__":
    main()
