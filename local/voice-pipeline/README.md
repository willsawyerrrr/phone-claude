# voice-pipeline

Speaks a question over an Asterisk AudioSocket call and captures the spoken reply. Runs as the `voice-pipeline` service of the [local stack](../README.md); everything runs on CPU and offline, with the models baked into the image.

## Interface

**AudioSocket** (`:9092`, inside the Docker network only). Asterisk connects when the call is answered. Audio is 8 kHz, 16-bit signed linear PCM, mono, 20 ms frames; the connection's UUID is the call ID. A UUID with no pending prompt is hung up on.

**HTTP** (`:8080`, published to loopback):

| Request                  | Behaviour                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /calls`            | `{callId, question, context?}` registers a prompt. `callId` must be a UUID. `201`; `400` if invalid; `409` if the ID exists. |
| `GET /calls/:id`         | `{callId, status: "pending" \| "answered" \| "failed", answer?, error?}`; `404` if unknown.                                  |
| `POST /calls/:id/cancel` | Hangs up the call if in flight and marks it `failed` (`error: "Cancelled"`). Idempotent; `404` if unknown.                   |
| `GET /healthz`           | `{ok: true}`.                                                                                                                |

Call state is held in memory and dropped after `CALL_TTL_S` (1 hour). The first terminal status is kept: a cancel that races a just-captured answer doesn't overwrite it.

## Call behaviour

1. **Keep-alive.** Asterisk drops an AudioSocket connection that goes quiet, so a frame is sent every 20 ms from the moment the call connects until it ends: speech when there is some, silence otherwise, including while a model is running.
2. **Speak.** TTS says `Context: <context> <question>` (or just the question). The caller isn't listened to while it plays.
3. **Listen.** Silero VAD detects speech. A reply is complete once `QUIET_PERIOD_S` passes with no further speech, so a reply with pauses is captured whole; it is then transcribed in one pass. Replies are cut off after `MAX_REPLY_S`. Timing is measured in received audio, not wall-clock time.
4. **Repeat.** A reply matching `repeat`, `again`, `pardon`, and similar phrases is not recorded; the question is spoken again as `One more time. …`, up to `MAX_REPEATS` times.
5. **Outcome.** A reply sets `answered` and the pipeline says goodbye. Nothing said within `NO_INPUT_TIMEOUT_S` of a prompt, or the caller hanging up first, sets `failed`.

## Models

| Stage | Model                                                                       | Why                                                                                                                |
| ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| VAD   | [Silero VAD](https://github.com/snakers4/silero-vad) v5 (ONNX)              | Runs natively at 8 kHz on `onnxruntime`, with no torch. Pinned by checksum in the `Dockerfile`.                    |
| STT   | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) `base.en`, int8 | About 150 MB and around a second for a short reply on CPU; noticeably more accurate than `tiny.en` on phone audio. |
| TTS   | [Piper](https://github.com/OHF-Voice/piper1-gpl) `en_US-lessac-medium`      | About 60 MB and faster than real time on CPU; Kokoro sounds more natural but is heavier.                           |

All three fit in the 4 GB Docker Desktop VM on arm64 and amd64. Swap a model by changing `WHISPER_MODEL` / `PIPER_VOICE` and the download step in the `Dockerfile`.

## Configuration

Environment variables, all optional: `NO_INPUT_TIMEOUT_S` (15), `QUIET_PERIOD_S` (3), `MAX_REPLY_S` (60), `MAX_REPEATS` (3), `CALL_TTL_S` (3600), `VAD_THRESHOLD` (0.5), `AUDIOSOCKET_PORT` (9092), `HTTP_PORT` (8080), `MODELS_DIR` (`/models`), `WHISPER_MODEL` (`whisper-base.en`), `PIPER_VOICE` (`en_US-lessac-medium`).

## Tests

```sh
docker build --target test -t voice-pipeline-test .
docker run --rm voice-pipeline-test
```

Runs `ruff` and the unit tests, which use fake VAD, STT, and TTS engines and a fake AudioSocket client. `tests/test_models_smoke.py` round-trips speech through the real models and runs only where they are installed (the `runtime` image).
