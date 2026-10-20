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
ARG PIPER_VOICES_REV=c10ece1aade47bb51c153c893d14e5bf8e5b7117
ADD --chmod=0644 --checksum=sha256:5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f \
    https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REV}/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
    /models/en_US-lessac-medium.onnx
ADD --chmod=0644 --checksum=sha256:efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0 \
    https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REV}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json \
    /models/en_US-lessac-medium.onnx.json
ADD --chmod=0644 --checksum=sha256:4cabf7c3a638017137f34a1516522032d4fe3f38228a843cc9b764ddcbcd9e09 \
    https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REV}/en/en_US/lessac/high/en_US-lessac-high.onnx \
    /models/en_US-lessac-high.onnx
ADD --chmod=0644 --checksum=sha256:db42b97d9859f257bc1561b8ed980e7fb2398402050a74ddd6cbec931a92412f \
    https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REV}/en/en_US/lessac/high/en_US-lessac-high.onnx.json \
    /models/en_US-lessac-high.onnx.json
ADD --chmod=0644 --checksum=sha256:b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca \
    https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REV}/en/en_US/ryan/high/en_US-ryan-high.onnx \
    /models/en_US-ryan-high.onnx
ADD --chmod=0644 --checksum=sha256:c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011 \
    https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_REV}/en/en_US/ryan/high/en_US-ryan-high.onnx.json \
    /models/en_US-ryan-high.onnx.json
ADD --checksum=sha256:c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 \
    /tmp/kokoro.tar.bz2
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
# Only the files the English engines read: the archives also carry other languages.
RUN python - <<'PY'
import tarfile

def extract(archive, prefix, wanted, dest):
    with tarfile.open(archive) as tar:
        members = [
            m for m in tar.getmembers()
            if m.isfile() and m.name.removeprefix(prefix + "/").startswith(wanted)
        ]
        for m in members:
            m.name = m.name.removeprefix(prefix + "/")
        tar.extractall(dest, members, filter="data")

extract(
    "/tmp/kokoro.tar.bz2", "kokoro-multi-lang-v1_0",
    ("model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "espeak-ng-data/"),
    "/models/kokoro",
)
extract(
    "/tmp/pocket.tar.bz2", "sherpa-onnx-pocket-tts-int8-2026-01-26",
    ("lm_flow.int8.onnx", "lm_main.int8.onnx", "encoder.onnx", "decoder.int8.onnx",
     "text_conditioner.onnx", "vocab.json", "token_scores.json"),
    "/models/pocket",
)
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
