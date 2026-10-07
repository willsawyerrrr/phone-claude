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
`voice-pipeline` service (`local/voice-pipeline/`, Python) also stores the
phone's push token (`PUT /device` on the LAN port `DEVICE_PORT`, bearer
`SOFTPHONE_PASSWORD`, persisted in the `pipeline-data` volume) and sends the
APNs VoIP push (`POST /push`, loopback). It speaks the question
with local TTS, listens with local VAD + STT, and exposes the `/calls` HTTP
API; it streams a frame to Asterisk every 20 ms for the whole call because
Asterisk drops a quiet AudioSocket connection. See `local/README.md` and
`local/voice-pipeline/README.md`.

`ios/` is a SwiftUI soft-phone (not a pnpm package; the Xcode project is
generated from `ios/project.yml` with XcodeGen) that registers to `asterisk`
as the `SOFTPHONE_USERNAME` endpoint and answers calls, using the Linphone SDK
for SIP and media. It rings from the lock screen: the app stops its SIP client in
the background, so Asterisk sees the endpoint offline, and a PushKit VoIP
push wakes it; every push is reported to CallKit at once, then the app
re-registers over the LAN and answers the INVITE when the user accepts. It
sends its PushKit token to the pipeline's device endpoint. See `ios/README.md`.

## Build and test

- TypeScript: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm format:check`.
- Voice pipeline (`ruff` + `pytest`):
  `docker build --target test -t voice-pipeline-test local/voice-pipeline &&
docker run --rm voice-pipeline-test`.
- iOS: in `ios/`, `xcodegen generate`, then
  `xcodebuild test -project PhoneClaude.xcodeproj -scheme PhoneClaude
-destination 'platform=iOS Simulator,name=<simulator>,OS=latest'`.

## CI

- `.github/workflows/ci.yml` runs on every pull request and push to `main`.
  Its `CI Status` job needs every other job; it is the only check the `main`
  ruleset requires, so any new job must be added to its `needs:`.

## Local call round-trip

1. Claude Code calls the `ask_by_phone` MCP tool with a question (and
   optional context).
2. `mcp-server` generates a UUID `callId` (AudioSocket keys the audio stream
   by a UUID) and POSTs `{callId, question, context}` to the voice pipeline's
   `/calls`. If ARI reports the endpoint (`GET /ari/endpoints/PJSIP/$SIP_ENDPOINT`)
   not `online`, it POSTs the pipeline's `/push` and polls the endpoint for up
   to `PUSH_WAIT_MS`; if it never comes online the call fails. It then
   originates the call through Asterisk's ARI
   (`POST /ari/channels`, endpoint `PJSIP/$SIP_ENDPOINT`, dialplan
   `$DIALPLAN_CONTEXT`/`$DIALPLAN_EXTENSION`, `channelId=callId`, `timeout=$RING_TIMEOUT_S`, channel
   variable `CALL_ID=callId`). The prompt is registered first so it's in
   place when the phone answers.
3. `mcp-server` polls the pipeline's `GET /calls/:id` every few seconds (see
   `mcp-server/src/client.ts` for why polling rather than a long-lived
   connection) until the status is `answered` or `failed`. While the status is `pending`
   it also checks `GET /ari/channels/:callId`; a 404 means the dial ended
   (busy, declined, unreachable) and fails the call immediately.
4. If starting or polling the call fails (every request has a timeout), the
   poll times out, or the process is interrupted (`SIGINT`/`SIGTERM`) while
   any call is in flight (including one still starting), `mcp-server` hangs up the
   ARI channel (`DELETE /ari/channels/:callId`) and POSTs the pipeline's
   `/calls/:id/cancel`. Both are best-effort.

`mcp-server` is configured by env vars; names and defaults are in
`mcp-server/src/config.ts`. The config is loaded and validated once at
startup; an invalid one is reported to the caller through each `ask_by_phone`
call's ask-in-chat fallback.
