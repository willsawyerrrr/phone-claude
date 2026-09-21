# CLAUDE.md

## Architecture

pnpm workspace with two packages:

- `web/` — Next.js app deployed to Vercel. Exposes the cloud call API and
  the webhook route(s) the voice platform posts call events/callbacks to.
  State lives in Redis (`web/src/lib/store.ts`), keyed by `callId`, with a 1
  hour TTL. `mcp-server` does not call it.
- `mcp-server/` — standalone MCP server (stdio transport) run locally by
  Claude Code. Exposes one tool, `ask_by_phone`, backed by the local
  Asterisk + voice-pipeline stack.

`local/` is that stack's Docker Compose definition (not a pnpm package). The
`asterisk` service renders its config from env at container start
(`local/asterisk/render-config.sh`), so it runs unchanged on any host. It has
one PJSIP endpoint (the soft-phone, named `SOFTPHONE_USERNAME`, which is
`mcp-server`'s `SIP_ENDPOINT`), ARI on port 8088, and the `ask-by-phone`
context whose extension `700` streams the answered call to AudioSocket at
`voice-pipeline:9092`, keyed by the `CALL_ID` channel variable. See
`local/README.md`.

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

## Cloud call round-trip (`web/`)

A client of `web`'s API (`mcp-server` is not one) drives this flow.

1. The client POSTs to `web`'s `/api/calls` with a question (and optional
   context), which creates a pending `CallRecord` and calls
   `VoiceProvider.startCall(...)` to place the call.
2. The client polls `GET /api/calls/:id` every few seconds.
3. The voice platform calls the user and reports back to `web`, driven by
   whichever `VoiceProvider` is selected:
   - **Twilio** requests TwiML from `web`'s `/api/twiml/:callId`, which
     `<Say>`s the question (and context) and `<Gather input="speech">`s the
     spoken reply. Twilio posts the `Gather` result to `web`'s
     `/api/webhooks/twilio/:callId`, which updates the `CallRecord` to
     `answered`; a call-status callback to the same route marks it `failed`
     if the call ends before an answer is captured.
   - **Telnyx** posts call events to `web`'s `/api/webhooks/telnyx/:callId`
     as the call progresses; there's no TwiML-fetch equivalent, so that one
     route drives the whole call. On `call.answered` it issues a `speak`
     Call Control command with the question (and context); once that
     finishes (`call.speak.ended`) it issues `transcription_start`. A
     `call.transcription` event's `is_final: true` means only that segment
     of text is stable, not that the caller has finished talking — a reply
     often arrives as several final segments in a row — so segments are
     accumulated onto the `CallRecord` (`pendingTranscript`), and only
     once a short quiet period passes with no further segment is the
     accumulated text treated as the caller's complete reply. If that
     reply looks like a request to hear the question again (a keyword
     match, up to a small repeat limit — useful when the caller is
     somewhere noisy, like mid-run), it speaks the question again instead
     of recording it as the answer; otherwise it updates the `CallRecord`
     to `answered`. The `CallRecord`'s `promptAttempt` and `transcriptSeq`
     fields let a stale no-input or quiet-period timer — scheduled before
     a repeat, or before a later segment arrived — tell that a newer one
     has since taken over, and no-op instead of wrongly ending the call or
     acting on stale text. Both timers run via `after()` rather than
     blocking the webhook response, since Telnyx's webhook delivery has
     its own timeout and a slow response risked it retrying the same
     event. If nothing is ever said, or the call ends first
     (`call.hangup`) while the record is still `pending`, the route marks
     it `failed`.
4. The next poll observes the terminal status and returns the answer (or a
   failure).
5. If the client stops waiting, it POSTs to `web`'s
   `/api/calls/:id/cancel`, which calls `VoiceProvider.endCall(...)`
   to hang up the call and marks the `CallRecord` `failed`.

## The `VoiceProvider` seam

`web/src/lib/providers/types.ts` defines `VoiceProvider` (`startCall` and
`endCall`), the only place the call API depends on a specific voice
platform. `twilio.ts` and `telnyx.ts` are its implementations; `index.ts`
selects one via `VOICE_PROVIDER`. Adding another platform (Retell, Bland,
...) means adding one file under `web/src/lib/providers/` and a case in
`index.ts` — nothing else in `web` needs to change.
