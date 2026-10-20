FROM python:3.14.8-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS base
ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"
COPY --from=ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM base AS models
ADD --chmod=0644 --checksum=sha256:2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f \
    https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx \
    /models/silero_vad.onnx
ADD --checksum=sha256:2f3b88823cbbb9bf0b2477ec8ae7b3fec417b3a87b6bb5f256dba66f2ad967cb \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2 \
    /tmp/pocket.tar.bz2
ARG KYUTAI_VOICES_REV=323332d33f997de8394f24a193e1a76df720e01a
ADD --chmod=0644 --checksum=sha256:46264e83cb99115c3d210260e029117566d9c64f20266d10daa78107759ede3e \
    https://huggingface.co/kyutai/tts-voices/resolve/${KYUTAI_VOICES_REV}/alba-mackenna/casual.wav \
    /models/pocket/voices/alba-casual.wav
ADD --chmod=0644 --checksum=sha256:e8b55193435db043833dda62fb759ee2779ace195811340ee8d28c7c4a4ccc24 \
    https://huggingface.co/kyutai/tts-voices/resolve/${KYUTAI_VOICES_REV}/alba-mackenna/announcer.wav \
    /models/pocket/voices/alba-announcer.wav
# Only the files Pocket TTS reads: the archive also carries other languages.
RUN python - <<'PY'
import tarfile

prefix = "sherpa-onnx-pocket-tts-int8-2026-01-26/"
wanted = ("lm_flow.int8.onnx", "lm_main.int8.onnx", "encoder.onnx", "decoder.int8.onnx",
          "text_conditioner.onnx", "vocab.json", "token_scores.json")
with tarfile.open("/tmp/pocket.tar.bz2") as tar:
    members = [
        m for m in tar.getmembers()
        if m.isfile() and m.name.removeprefix(prefix).startswith(wanted)
    ]
    for m in members:
        m.name = m.name.removeprefix(prefix)
    tar.extractall("/models/pocket", members, filter="data")
PY
RUN find /models -type d -exec chmod 0755 {} + && rm /tmp/*.tar.bz2
RUN python -c "from faster_whisper import download_model; download_model('base.en', output_dir='/models/whisper-base.en', revision='3d3d5dee26484f91867d81cb899cfcf72b96be6c')"

FROM base AS test
RUN uv sync --locked --no-editable
COPY tests ./tests
CMD ["sh", "-c", "ruff check . && ruff format --check . && pytest"]

FROM base AS runtime
COPY --from=models /models /models
RUN useradd --system --no-create-home pipeline \
    && mkdir /data && chown pipeline /data
USER pipeline
EXPOSE 8080 8081 9092
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"
CMD ["python", "-m", "voice_pipeline"]
