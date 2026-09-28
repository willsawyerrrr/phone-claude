# CLAUDE.md

## Architecture

pnpm workspace with one package:

- `mcp-server/` — standalone MCP server (stdio transport) run locally by
  Claude Code. Exposes one tool, `ask_by_phone`, backed by the local
  Asterisk + voice-pipeline stack.

`local/` is that stack's Docker Compose definition (not a pnpm package). The
`asterisk` service renders its config from env at container start
(`local/asterisk/render-config.sh`), so it runs unchanged on any host. It has
one PJSIP endpoint (the soft-phone, named `SOFTPHONE_USERNAME`, which is
`mcp-server`'s `SIP_ENDPOINT`), ARI on port 8088, and the `ask-by-phone`
context whose extension `700` streams the answered call to AudioSocket at
`voice-pipeline:9092`, keyed by the `CALL_ID` channel variable. The
`voice-pipeline` service (`local/voice-pipeline/`, Python) speaks the question
with local TTS, listens with local VAD + STT, and exposes the `/calls` HTTP
API; it streams a frame to Asterisk every 20 ms for the whole call because
Asterisk drops a quiet AudioSocket connection. See `local/README.md` and
`local/voice-pipeline/README.md`.

`ios/` is a SwiftUI soft-phone (not a pnpm package; the Xcode project is
generated from `ios/project.yml` with XcodeGen) that registers to `asterisk`
as the `SOFTPHONE_USERNAME` endpoint and answers calls, using the Linphone SDK
for SIP and media. It is foreground only (no CallKit/PushKit). See
`ios/README.md`.

## Local call round-trip

1. Claude Code calls the `ask_by_phone` MCP tool with a question (and
   optional context).
2. `mcp-server` generates a UUID `callId` (AudioSocket keys the audio stream
   by a UUID), POSTs `{callId, question, context}` to the voice pipeline's
   `/calls`, then originates the call through Asterisk's ARI
   (`POST /ari/channels`, endpoint `PJSIP/$SIP_ENDPOINT`, dialplan
   `$DIALPLAN_CONTEXT`/`$DIALPLAN_EXTENSION`, `channelId=callId`, channel
   variable `CALL_ID=callId`). The prompt is registered first so it's in
   place when the phone answers.
3. `mcp-server` polls the pipeline's `GET /calls/:id` every few seconds (see
   `mcp-server/src/client.ts` for why polling rather than a long-lived
   connection) until the status is `answered` or `failed`.
4. If the poll times out, or the process is interrupted
   (`SIGINT`/`SIGTERM`) while a call is in flight, `mcp-server` hangs up the
   ARI channel (`DELETE /ari/channels/:callId`) and POSTs the pipeline's
   `/calls/:id/cancel`. Both are best-effort.

`mcp-server` is configured by env vars (`mcp-server/src/config.ts`):
`ARI_USERNAME` and `ARI_PASSWORD` (required), `ARI_URL` (default
`http://localhost:8088`), `PIPELINE_URL` (default `http://localhost:8080`),
`SIP_ENDPOINT` (default `phone`), `DIALPLAN_CONTEXT` (default `ask-by-phone`),
`DIALPLAN_EXTENSION` (default `700`), `POLL_INTERVAL_MS` and `MAX_WAIT_MS`.
