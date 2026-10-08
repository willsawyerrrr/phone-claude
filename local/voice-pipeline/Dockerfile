FROM python:3.14.7-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d AS base
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt pyproject.toml ./
COPY src ./src
RUN pip install -c requirements.txt .

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
RUN python -c "from faster_whisper import download_model; download_model('base.en', output_dir='/models/whisper-base.en', revision='3d3d5dee26484f91867d81cb899cfcf72b96be6c')"

FROM base AS test
RUN pip install -c requirements.txt ".[dev]"
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
