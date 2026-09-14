# CLAUDE.md

## Architecture

pnpm workspace with two packages:

- `web/` — Next.js app deployed to Vercel. Exposes the call API and the
  webhook route(s) the voice platform posts call events/callbacks to. State
  lives in Redis (`web/src/lib/store.ts`), keyed by `callId`, with a 1 hour
  TTL.
- `mcp-server/` — standalone MCP server (stdio transport) run locally by
  Claude Code. Exposes one tool, `ask_by_phone`.

## Call round-trip

1. Claude Code calls the `ask_by_phone` MCP tool with a question (and
   optional context).
2. `mcp-server` POSTs to `web`'s `/api/calls`, which creates a pending
   `CallRecord` and calls `VoiceProvider.startCall(...)` to place the call.
3. `mcp-server` polls `GET /api/calls/:id` every few seconds (see
   `mcp-server/src/client.ts` for why polling rather than a long-lived
   connection).
4. The voice platform calls the user and reports back to `web`, driven by
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
     finishes (`call.speak.ended`) it issues `transcription_start` and
     waits for a final result on a `call.transcription` event, which
     updates the `CallRecord` to `answered`. If nothing is said within the
     no-input timeout, or the call ends first (`call.hangup`) while the
     record is still `pending`, the route marks it `failed`.
5. The next poll from `mcp-server` observes the terminal status and returns
   the answer (or a clear failure message) as the tool result.
6. If the poll times out, or the `mcp-server` process is interrupted
   (`SIGINT`/`SIGTERM`) while a call is in flight, `mcp-server` POSTs to
   `web`'s `/api/calls/:id/cancel`, which calls `VoiceProvider.endCall(...)`
   to hang up the call and marks the `CallRecord` `failed`.

## The `VoiceProvider` seam

`web/src/lib/providers/types.ts` defines `VoiceProvider` (`startCall` and
`endCall`), the only place the call API depends on a specific voice
platform. `twilio.ts` and `telnyx.ts` are its implementations; `index.ts`
selects one via `VOICE_PROVIDER`. Adding another platform (Retell, Bland,
...) means adding one file under `web/src/lib/providers/` and a case in
`index.ts` — nothing else in `web` needs to change.
