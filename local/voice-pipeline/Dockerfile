FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install .

FROM base AS models
ADD --chmod=0644 --checksum=sha256:2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f \
    https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx \
    /models/silero_vad.onnx
RUN python -m piper.download_voices --download-dir /models en_US-lessac-medium
RUN python -c "from faster_whisper import download_model; download_model('base.en', output_dir='/models/whisper-base.en')"

FROM base AS test
RUN pip install ".[dev]"
COPY tests ./tests
CMD ["sh", "-c", "ruff check . && ruff format --check . && pytest"]

FROM base AS runtime
COPY --from=models /models /models
RUN useradd --system --no-create-home pipeline
USER pipeline
EXPOSE 8080 9092
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"
CMD ["python", "-m", "voice_pipeline"]
