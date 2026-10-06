# Local voice-call design

`ask_by_phone` places a call to a SIP soft-phone on the user's phone over the
local network, speaks the question, captures the spoken reply, and returns it
as the tool result. No carrier, cloud service, or per-call cost is involved.

## Architecture

```
Claude Code ──stdio──▶ mcp-server
                         │  ├─ ARI (HTTP :8088) ───────▶ asterisk ◀── SIP/RTP ──▶ soft-phone
                         │  │                              │
                         │  │                    AudioSocket (TCP :9092)
                         │  │                              ▼
                         └──┴─ pipeline API (HTTP :8080) ▶ voice-pipeline
                                 └───────── Docker Compose stack ─────────┘
```

1. Claude Code calls `ask_by_phone` (`question`, optional `context`).
2. `mcp-server` registers the prompt with `voice-pipeline`, then originates a
   call to the soft-phone through Asterisk's ARI.
3. When the phone answers, the dialplan hands the call's audio to
   `voice-pipeline` over AudioSocket.
4. `voice-pipeline` speaks the question, listens for the reply, and stores the
   transcript.
5. `mcp-server` polls `voice-pipeline`, sees the terminal status, and returns
   the answer (or a failure message) as the tool result. While the status is
   `pending` it also checks the ARI channel; a missing channel (busy,
   declined, or unreachable phone) fails the call without waiting out
   `MAX_WAIT_MS`.
6. If starting or polling the call fails (including a request timing out),
   on timeout, or on `SIGINT`/`SIGTERM`, `mcp-server` hangs up via ARI and
   cancels the call in `voice-pipeline`.

`mcp-server` runs as the plain local Node process Claude Code spawns over
stdio; it is not part of the stack and reaches it over `localhost` ports.

The soft-phone is any SIP app or the SwiftUI app in `ios/`, which registers as
the same PJSIP endpoint and answers calls while foregrounded.

## The Compose stack

Lives under `local/`. Two services on one Docker network:

- `asterisk` — PJSIP endpoint for the soft-phone, ARI, and the dialplan.
- `voice-pipeline` — Python: AudioSocket server, VAD, STT, TTS, and the HTTP
  API.

`docker compose up` is the whole install. Every host-specific value comes from
env (`local/.env`, template in `.env.example`), so the same stack runs on any
machine: `HOST_LAN_IP`, the soft-phone's SIP credentials, ARI credentials, and
published ports. Nothing in the images or committed config names a machine.

### Host

The stack runs on the development machine (macOS, Apple silicon, Docker
Desktop with a 4 GB VM). It is also expected to run on Linux, where
`network_mode: host` is available as an optional override but not required.

Docker Desktop runs containers in a Linux VM, so host networking does not
expose them to the LAN. Instead the stack uses published ports and tells
Asterisk which address to advertise:

- Publish SIP (`SIP_PORT`, default `5060`, UDP and TCP), ARI (`8088/tcp`), and a bounded RTP range
  (`10000-10099/udp`, matching `rtp.conf`).
- Set `external_signaling_address` and `external_media_address` to
  `HOST_LAN_IP`, and `local_net` to loopback only (Docker presents LAN peers
  from a private gateway address), so SIP advertises the host's LAN address
  rather than the container's. Set `media_address` to `HOST_LAN_IP` on the
  endpoint, because the transport's `external_media_address` does not rewrite
  the SDP connection address.
- Set `rtp_symmetric`, `force_rport`, and `direct_media=no` on the endpoint so
  audio flows back to whatever source address the phone's packets arrive from.
- `HOST_LAN_IP` is the host's current LAN address; it is updated when DHCP
  reassigns it (or reserved on the router).
- `voice-pipeline`'s ports (`8080`) are published to `localhost` only;
  AudioSocket (`9092`) is reachable only inside the Docker network.

The soft-phone registers to `HOST_LAN_IP:SIP_PORT` over Wi-Fi.

## Interface contract

### Originate and hang up (ARI)

`mcp-server` originates with `POST /ari/channels`:

| Parameter   | Value                                 |
| ----------- | ------------------------------------- |
| `endpoint`  | `PJSIP/<phone endpoint>`              |
| `context`   | `ask-by-phone`                        |
| `extension` | `700`                                 |
| `channelId` | the call ID                           |
| `variables` | `{"CALL_ID": "<call ID>"}`            |
| `timeout`   | seconds Asterisk rings before failing |

The call ID is a UUID (AudioSocket keys the stream by UUID). Hang up with
`DELETE /ari/channels/<call ID>`. ARI carries control only, never audio.

### Dialplan

```
[ask-by-phone]
exten => 700,1,NoOp(ask_by_phone ${CALL_ID})
 same => n,AudioSocket(${CALL_ID},voice-pipeline:9092)
 same => n,Hangup()
```

The extension runs when the originated leg answers.

### AudioSocket

`voice-pipeline` accepts Asterisk's AudioSocket TCP connection on `9092`.
Audio is 8 kHz, 16-bit signed linear PCM, mono, in 20 ms frames. The
connection's UUID is the call ID; a UUID with no registered prompt is
rejected: the pipeline hangs up the connection.

### Pipeline HTTP API (`:8080`)

| Request                  | Body / response                                                   |
| ------------------------ | ----------------------------------------------------------------- |
| `POST /calls`            | `{callId, question, context?}` registers a prompt; `201`.         |
| `GET /calls/:id`         | `{status: "pending" \| "answered" \| "failed", answer?, error?}`. |
| `POST /calls/:id/cancel` | Ends the call if in flight and marks it `failed`; idempotent.     |
| `GET /healthz`           | `{ok: true}`.                                                     |

Call state is held in memory for the life of the process; a call is dropped
after a TTL.

## Voice pipeline behaviour

- **Keep-alive:** Asterisk drops an AudioSocket connection that goes quiet, so
  a frame (speech, else silence) is sent every 20 ms from connect until the
  call ends, including while a model is running.
- **Speak:** TTS says the context (if any), then the question.
- **Listen:** VAD detects speech; STT transcribes it. A reply is complete only
  after a quiet period with no further speech, so a reply spoken as several
  segments is captured whole.
- **Repeat:** if the reply is a request to hear the question again (a bare
  `again` or `pardon`, or a phrase such as `can you repeat that`, up to a small
  repeat limit; an answer that merely contains `again` is recorded), the
  question is spoken again rather than recorded as the answer.
- **No input:** if nothing is said within the no-input window, or the caller
  hangs up while the call is `pending`, the call is `failed`.
- **Shutdown:** on `SIGTERM`/`SIGINT` the pipeline hangs up calls in progress
  and fails every `pending` call.
- **Errors:** an unexpected error during a call fails it and hangs up. A second
  AudioSocket connection for a call already in progress is rejected, and a
  cancel does not cut off a call that already has an outcome.
- **Status:** the terminal status is written once; a cancel that races a
  just-completed answer does not overwrite it.

STT and TTS run on CPU inside the 4 GB Docker VM, on arm64 and amd64. Model
choice is documented in `local/voice-pipeline/README.md`. There is
no LLM stage: a call is one question and one reply.

## `mcp-server`

The tool takes `question` and optional `context`, and waits up to
`MAX_WAIT_MS`, polling every `POLL_INTERVAL_MS`; on timeout or
`SIGINT`/`SIGTERM` it cancels the call. `src/client.ts` implements its three
operations against the stack. Every request carries a timeout, and a failure
in `startCall` or `pollForAnswer` cancels the call before it is thrown.
`src/index.ts` generates each call ID before the first request and tracks all
in-flight calls, so concurrent calls and an interrupt during `startCall` are
all hung up on shutdown.

- `startCall` — `POST /calls` to the pipeline, then originate via ARI.
- `pollForAnswer` — `GET /calls/:id` on the pipeline, plus
  `GET /ari/channels/<call ID>` while `pending`; a 404 there (confirmed by a
  second status read) fails the call.
- `cancelCall` — hang up the ARI channel and `POST /calls/:id/cancel`.

Configuration is env; names and defaults are in `src/config.ts`.

## Decisions and open items

- **Components.** `mcp-server`, the local stack, and the `ios/` soft-phone.
- **Machine-agnostic.** Host-specific values are env, not code; the stack is
  not tied to the current development machine.
- **Soft-phone.** The `ios/` app (Linphone SDK) is the soft-phone. It has no
  CallKit or PushKit, so it rings only while foregrounded; background ringing
  needs a VoIP push and a paid Apple Developer account. Third-party SIP apps
  also work. SIP and RTP are unencrypted (no TLS or SRTP), so the phone and
  stack stay on a trusted LAN.
- **Off-network reach.** LAN-only. A VPN (Tailscale or WireGuard) can bridge
  the phone when it is away from the home network without changing the design.
- **Always-on host.** The stack needs a machine that is running when Claude
  Code asks; which machine is open.
- **Multi-turn dialogue.** Out of scope. A local LLM between STT and the reply
  is the natural extension point if it is wanted.
