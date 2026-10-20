# voice-pipeline

Speaks a question over an Asterisk AudioSocket call and captures the spoken reply. Runs as the `voice-pipeline` service of the [local stack](../README.md); everything runs on CPU and offline, with the models baked into the image.

## Interface

**AudioSocket** (`:9092`, inside the Docker network only). Asterisk connects when the call is answered. Audio is 16 kHz, 16-bit signed linear PCM (kind `0x12`), mono, 20 ms (640-byte) frames; the connection's UUID is the call ID. A UUID with no pending prompt is rejected: the pipeline hangs up the connection.

**HTTP** (`:8080`, published to loopback):

| Request                  | Behaviour                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /calls`            | `{callId, question, context?, segments?}` registers a prompt. `callId` must be a UUID. `segments` (`[{text, voice?}]`, `voice` an installed `engine:voice`) is spoken in place of the question and context. `201`; `400` if invalid; `409` if the ID exists. |
| `GET /audition`          | The default voice, the installed audition candidates and the audition prompts, for `local/audition.sh call`.                                                                                                                                                 |
| `GET /calls/:id`         | `{callId, status: "pending" \| "answered" \| "failed", answer?, error?}`; `404` if unknown.                                                                                                                                                                  |
| `POST /calls/:id/cancel` | Hangs up the call if in flight and marks it `failed` (`error: "Cancelled"`). Idempotent; `404` if unknown. A call that already has an outcome is left to finish.                                                                                             |
| `GET /healthz`           | `{ok: true}`.                                                                                                                                                                                                                                                |
| `POST /push`             | Sends the VoIP push to the registered phone. `204`; `404` if no device; `503` if APNs is not configured; `502` if APNs rejects it.                                                                                                                           |
| `GET /device`            | `{registered, environment?}`; never the token.                                                                                                                                                                                                               |

**Device HTTP** (`:8081`, `DEVICE_PORT`, published on `HOST_LAN_IP`): `PUT /device` with `{token, environment: "sandbox" \| "production"}` and `Authorization: Bearer <DEVICE_SECRET>` (the soft-phone password) stores the phone's PushKit token in `DEVICE_FILE` (`/data/device.json`, the `pipeline-data` volume). `204`; `400` if invalid; `401` if unauthorised.

Call state is held in memory and dropped after `CALL_TTL_S` (1 hour); an expired call is `404`. The first terminal status is kept: a cancel that races a just-captured answer doesn't overwrite it.

## Call behaviour

1. **Keep-alive.** Asterisk drops an AudioSocket connection that goes quiet, so a frame is sent every 20 ms from the moment the call connects until it ends: speech when there is some, silence otherwise, including while a model is running.
2. **Speak.** TTS says `Context: <context> <question>` (or just the question). The caller isn't listened to while it plays.
3. **Listen.** Silero VAD detects speech. A reply is complete once `QUIET_PERIOD_S` passes with no further speech, so a reply with pauses is captured whole; it is then transcribed in one pass. Replies are cut off after `MAX_REPLY_S`. If the caller hangs up after speaking, what they said is transcribed at once rather than waiting out the quiet period. Timing is measured in received audio, not wall-clock time; if no audio arrives at all, the wait is bounded by wall-clock time instead (`NO_INPUT_TIMEOUT_S` before the caller speaks, `QUIET_PERIOD_S` after), so the call still ends.
4. **Repeat.** A reply that is just `again`, `pardon`, `repeat`, or similar, or that asks for the question (`can you repeat that`, `say that again`, `what was the question`), is not recorded; the question is spoken again as `One more time. …`, up to `MAX_REPEATS` times.
5. **Outcome.** A reply sets `answered` and the pipeline says goodbye. Nothing said within `NO_INPUT_TIMEOUT_S` of a prompt, or the caller hanging up without having said anything intelligible, sets `failed`. So does an unexpected error in the call (`error: "The call failed unexpectedly"`). A second audio connection for a call already in progress is hung up on.

On `SIGTERM` or `SIGINT` the pipeline stops accepting audio connections, hangs up every call in progress and sets every `pending` call to `failed` (`error: "The pipeline shut down"`). The compose service runs with `init: true` so the signal reaches it.

## Models

| Stage | Model                                                                       | Why                                                                                                                |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| VAD   | [Silero VAD](https://github.com/snakers4/silero-vad) v5 (ONNX)              | Runs natively at 16 kHz on `onnxruntime`, with no torch. Pinned by checksum in the `Dockerfile`.                   |
| STT   | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) `base.en`, int8 | About 150 MB and around a second for a short reply on CPU; noticeably more accurate than `tiny.en` on phone audio. |
| TTS   | Selectable, see [Voices](#voices); default Piper `en_US-lessac-medium`      | About 60 MB and 20x faster than real time on CPU.                                                                  |

Builds are reproducible: the `Dockerfile` pins the base image by digest, the Whisper model by Hugging Face revision, and the TTS models and voice recordings by revision or release URL and checksum, and `uv.lock` pins every Python dependency (installed with `uv sync --locked`) and the `uv` binary is pinned by image digest. The Python version is 3.14 everywhere (`Dockerfile` base image, `requires-python`, `.python-version`, so `uv sync` and `uv run pytest` use it locally and CI builds the same image). Dependabot updates these pins, except Python major and minor bumps of the base image and major bumps of `multidict` and `huggingface-hub` (which the latest `aiohttp` and `tokenizers` do not yet allow).

All three fit in the 4 GB Docker Desktop VM on arm64 and amd64, with every TTS voice loaded at once (about 2.5 GB resident). Swap a model by changing `WHISPER_MODEL` and the download step in the `Dockerfile`.

## Voices

`TTS_ENGINE` and `TTS_VOICE` choose the voice that speaks on calls. A voice is named `engine:voice`; the image carries these (other voices of an engine need only their model files added to the `Dockerfile` and `SpeakerBank`):

| Name                                                                    | Engine                                                                                                                                             | Licence (code / model)                                                                                           | Added to image | RTF, arm64 (22 and 57 words) |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------- |
| `piper:en_US-lessac-medium` (default)                                   | [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`, GPL-3.0; the earlier `rhasspy/piper` was MIT and is archived)                       | Voice: [Blizzard 2013 Lessac](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html) | 63 MB          | 0.05 / 0.06                  |
| `piper:en_US-lessac-high`                                               | Piper                                                                                                                                              | as above                                                                                                         | 114 MB         | 0.34 / 0.32                  |
| `piper:en_US-ryan-high`                                                 | Piper                                                                                                                                              | Voice: RyanSpeech, CC BY-NC-SA 4.0 (non-commercial)                                                              | 121 MB         | 0.34 / 0.33                  |
| `kokoro:af_heart`, `af_bella`, `am_michael`, and 25 more English voices | [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) v1.0 (ONNX, 24 kHz) run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)            | sherpa-onnx Apache-2.0; model Apache-2.0                                                                         | 160 MB         | 0.59 / 0.58 (fp32)           |
| `pocket:alba-casual`, `alba-announcer`                                  | [Kyutai Pocket TTS](https://huggingface.co/kyutai/pocket-tts) (100M parameters, int8 ONNX export run by sherpa-onnx) cloning a reference recording | Model CC BY 4.0 (the ONNX export's README says non-commercial); voices: Alba MacKenna, CC BY 4.0                 | 190 MB         | 0.48 / 0.37                  |

RTF is synthesis time over audio duration (below 1 keeps up with a call), measured with `./audition.sh render` inside the arm64 container on a 6-core Docker Desktop VM; the 22-word prompt is `context` and the 57-word prompt is `long`. Kokoro int8 ran at about 1.3 on arm64 and so is not used. The Python packages are `piper-tts` and `sherpa-onnx`, both with CPython 3.14 wheels for `manylinux` arm64 and amd64. The `kokoro-onnx` and `pocket-tts` packages are not used: the first requires Python below 3.14 and the second pulls in torch. All voices are resampled to 16 kHz with `soxr`.

Kokoro loads one model shared by all its voices (about 650 MB resident); each Piper high voice is about 300 MB.

### Auditioning

`local/audition.sh render` writes a 16 kHz WAV per prompt and voice to `local/audition/` and prints the RTFs. `local/audition.sh call` rings the phone and reads the same prompts in each candidate voice in a random order, introducing each as "Voice one", "Voice two" and so on; after the call it prints which voice was which. Pass `--prompts plain,context,numbers,technical,long` (or `all`), `--voices piper:en_US-lessac-high,kokoro:af_heart` and `--no-shuffle` to change what is played. See [`../README.md`](../README.md#auditioning-voices).

## Configuration

Environment variables, all optional (`docker-compose.yml` passes through all except `AUDIOSOCKET_PORT`, `HTTP_PORT`, `MODELS_DIR`, `WHISPER_MODEL`): `NO_INPUT_TIMEOUT_S` (15), `QUIET_PERIOD_S` (1.5), `MAX_REPLY_S` (60), `MAX_REPEATS` (3), `CALL_TTL_S` (3600), `VAD_THRESHOLD` (0.5), `AUDIOSOCKET_PORT` (9092), `HTTP_PORT` (8080), `MODELS_DIR` (`/models`), `WHISPER_MODEL` (`whisper-base.en`), `TTS_ENGINE` (`piper`; or `kokoro`, `pocket`), `TTS_VOICE` (empty: the engine's default, below).

Push: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE` (`/run/secrets/apns_key`), `APNS_TOPIC` (`dev.willsawyerrrr.phone-claude.voip`), `DEVICE_FILE` (`/data/device.json`), `DEVICE_PORT` (8081), `DEVICE_SECRET`.

## Tests

```sh
docker build --target test -t voice-pipeline-test .
docker run --rm voice-pipeline-test
```

Runs `ruff` and the unit tests, which use fake VAD, STT, and TTS engines and a fake AudioSocket client. `tests/test_models_smoke.py` round-trips speech through the real models and runs only where they are installed (the `runtime` image).
