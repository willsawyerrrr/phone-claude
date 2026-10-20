# voice-pipeline

Speaks a question over an Asterisk AudioSocket call and captures the spoken reply. Runs as the `voice-pipeline` service of the [local stack](../README.md); everything runs on CPU and offline, with the models baked into the image.

## Interface

**AudioSocket** (`:9092`, inside the Docker network only). Asterisk connects when the call is answered. Audio is 16 kHz, 16-bit signed linear PCM (kind `0x12`), mono, 20 ms (640-byte) frames; the connection's UUID is the call ID. A UUID with no pending prompt is rejected: the pipeline hangs up the connection.

**HTTP** (`:8080`, published to loopback):

| Request                  | Behaviour                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /calls`            | `{callId, question, context?, segments?}` registers a prompt. `callId` must be a UUID. `segments` (`[{text, voice?}]`, `voice` an installed voice) is spoken in place of the question and context. `201`; `400` if invalid; `409` if the ID exists. |
| `GET /audition`          | The default voice, the installed audition candidates and the audition prompts, for `local/audition.sh call`.                                                                                                                                        |
| `GET /calls/:id`         | `{callId, status: "pending" \| "answered" \| "failed", answer?, error?}`; `404` if unknown.                                                                                                                                                         |
| `POST /calls/:id/cancel` | Hangs up the call if in flight and marks it `failed` (`error: "Cancelled"`). Idempotent; `404` if unknown. A call that already has an outcome is left to finish.                                                                                    |
| `GET /healthz`           | `{ok: true}`.                                                                                                                                                                                                                                       |
| `POST /push`             | Sends the VoIP push to the registered phone. `204`; `404` if no device; `503` if APNs is not configured; `502` if APNs rejects it.                                                                                                                  |
| `GET /device`            | `{registered, environment?}`; never the token.                                                                                                                                                                                                      |

**Device HTTP** (`:8081`, `DEVICE_PORT`, published on `DEVICE_BIND_ADDRESS`, default `HOST_LAN_IP`; over the internet it is reached through the `caddy` service, which serves it as `https://PUBLIC_HOSTNAME/device`): `PUT /device` with `{token, environment: "sandbox" \| "production"}` and `Authorization: Bearer <DEVICE_SECRET>` (the soft-phone password) stores the phone's PushKit token in `DEVICE_FILE` (`/data/device.json`, the `pipeline-data` volume). `204`; `400` if invalid; `401` if unauthorised.

Call state is held in memory and dropped after `CALL_TTL_S` (1 hour); an expired call is `404`. The first terminal status is kept: a cancel that races a just-captured answer doesn't overwrite it.

## Call behaviour

1. **Keep-alive.** Asterisk drops an AudioSocket connection that goes quiet, so a frame is sent every 20 ms from the moment the call connects until it ends: speech when there is some, silence otherwise, including while a model is running.
2. **Speak.** TTS says `Context: <context> <question>` (or just the question). The caller isn't listened to while it plays.
3. **Listen.** Silero VAD detects speech. A reply is complete once `QUIET_PERIOD_S` passes with no further speech, so a reply with pauses is captured whole; it is then transcribed in one pass. Replies are cut off after `MAX_REPLY_S`. If the caller hangs up after speaking, what they said is transcribed at once rather than waiting out the quiet period. Timing is measured in received audio, not wall-clock time; if no audio arrives at all, the wait is bounded by wall-clock time instead (`NO_INPUT_TIMEOUT_S` before the caller speaks, `QUIET_PERIOD_S` after), so the call still ends.
4. **Repeat.** A reply that is just `again`, `pardon`, `repeat`, or similar, or that asks for the question (`can you repeat that`, `say that again`, `what was the question`), is not recorded; the question is spoken again as `One more time. …`, up to `MAX_REPEATS` times.
5. **Outcome.** A reply sets `answered` and the pipeline says goodbye. Nothing said within `NO_INPUT_TIMEOUT_S` of a prompt, or the caller hanging up without having said anything intelligible, sets `failed`. So does an unexpected error in the call (`error: "The call failed unexpectedly"`). A second audio connection for a call already in progress is hung up on.

On `SIGTERM` or `SIGINT` the pipeline stops accepting audio connections, hangs up every call in progress and sets every `pending` call to `failed` (`error: "The pipeline shut down"`). The compose service runs with `init: true` so the signal reaches it.

## Models

| Stage | Model                                                                                | Why                                                                                                                |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| VAD   | [Silero VAD](https://github.com/snakers4/silero-vad) v5 (ONNX)                       | Runs natively at 16 kHz on `onnxruntime`, with no torch. Pinned by checksum in the `Dockerfile`.                   |
| STT   | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) `base.en`, int8          | About 150 MB and around a second for a short reply on CPU; noticeably more accurate than `tiny.en` on phone audio. |
| TTS   | [Kyutai Pocket TTS](https://huggingface.co/kyutai/pocket-tts), see [Voices](#voices) | 100M parameters, int8 ONNX; about 190 MB with the voices, and faster than real time on CPU.                        |

Builds are reproducible: the `Dockerfile` pins the base image by digest, the Whisper model by Hugging Face revision, and the TTS models and voice recordings by revision or release URL and checksum, and `uv.lock` pins every Python dependency (installed with `uv sync --locked`) and the `uv` binary is pinned by image digest. The Python version is 3.14 everywhere (`Dockerfile` base image, `requires-python`, `.python-version`, so `uv sync` and `uv run pytest` use it locally and CI builds the same image). Dependabot updates these pins, except Python major and minor bumps of the base image and major bumps of `multidict` and `huggingface-hub` (which the latest `aiohttp` and `tokenizers` do not yet allow).

All three fit in the 4 GB Docker Desktop VM on arm64 and amd64, with both TTS voices loaded at once. Swap a model by changing `WHISPER_MODEL` and the download step in the `Dockerfile`.

## Voices

`TTS_VOICE` chooses the voice that speaks on calls; the default is `alba-casual`. The speaker is [Kyutai Pocket TTS](https://huggingface.co/kyutai/pocket-tts) (100M parameters), an int8 ONNX export run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), cloning a reference recording. The image carries two voices, both by Alba MacKenna from [`kyutai/tts-voices`](https://huggingface.co/kyutai/tts-voices): `alba-casual` and `alba-announcer`. Another voice needs only its mono 16-bit WAV added to `/models/pocket/voices/` in the `Dockerfile`.

RTF (synthesis time over audio duration; below 1 keeps up with a call) is 0.48 for a 22-word prompt and 0.37 for a 57-word one, measured with `./audition.sh render` inside the arm64 container on a 6-core Docker Desktop VM. Pocket TTS synthesises at 24 kHz; each utterance is resampled to 16 kHz in one `soxr` pass. The `pocket-tts` package is not used because it pulls in torch; `sherpa-onnx` has CPython 3.14 wheels for `manylinux` arm64 and amd64.

### Licences

- Model: CC BY 4.0 ([`kyutai/pocket-tts`](https://huggingface.co/kyutai/pocket-tts)).
- ONNX export: the [`sherpa-onnx-pocket-tts-int8`](https://huggingface.co/csukuangfj2/sherpa-onnx-pocket-tts-int8-2026-01-26) README calls it non-commercial, deferring to the licence of the [`pocket-tts-onnx`](https://huggingface.co/KevinAHM/pocket-tts-onnx/blob/main/onnx/LICENSE) export it derives from. This stack is for personal use; check that licence before any commercial use.
- Voices: Alba MacKenna recordings, CC BY 4.0.

### Auditioning

`local/audition.sh render` writes a 16 kHz WAV per prompt and voice to `local/audition/` and prints the RTFs. `local/audition.sh call` rings the phone and reads the same prompts in each installed voice in a random order, introducing each as "Voice one", "Voice two" and so on; after the call it prints which voice was which. Pass `--prompts plain,context,numbers,technical,long` (or `all`), `--voices alba-casual,alba-announcer` and `--no-shuffle` to change what is played. See [`../README.md`](../README.md#auditioning-voices).

## Configuration

Environment variables, all optional (`docker-compose.yml` passes through all except `AUDIOSOCKET_PORT`, `HTTP_PORT`, `MODELS_DIR`, `WHISPER_MODEL`): `NO_INPUT_TIMEOUT_S` (15), `QUIET_PERIOD_S` (1.5), `MAX_REPLY_S` (60), `MAX_REPEATS` (3), `CALL_TTL_S` (3600), `VAD_THRESHOLD` (0.5), `AUDIOSOCKET_PORT` (9092), `HTTP_PORT` (8080), `MODELS_DIR` (`/models`), `WHISPER_MODEL` (`whisper-base.en`), `TTS_VOICE` (`alba-casual`; or `alba-announcer`).

Push: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE` (`/run/secrets/apns_key`), `APNS_TOPIC` (`dev.willsawyerrrr.phone-claude.voip`), `DEVICE_FILE` (`/data/device.json`), `DEVICE_PORT` (8081), `DEVICE_SECRET`.

## Tests

```sh
docker build --target test -t voice-pipeline-test .
docker run --rm voice-pipeline-test
```

Runs `ruff` and the unit tests, which use fake VAD, STT, and TTS engines and a fake AudioSocket client. `tests/test_models_smoke.py` round-trips speech through the real models and runs only where they are installed (the `runtime` image).
