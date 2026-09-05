# CLAUDE.md

## Architecture

pnpm workspace with two packages:

- `web/` — Next.js app deployed to Vercel. Exposes the call API and the
  Vapi webhook. State lives in Redis (`web/src/lib/store.ts`), keyed by
  `callId`, with a 1 hour TTL.
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
4. The voice platform calls the user, asks the question, and posts an
   end-of-call report to `web`'s `/api/webhooks/vapi`, which extracts the
   answer and updates the `CallRecord` to `answered` (or `failed`).
5. The next poll from `mcp-server` observes the terminal status and returns
   the answer (or a clear failure message) as the tool result.

## The `VoiceProvider` seam

`web/src/lib/providers/types.ts` defines `VoiceProvider`, the only place the
call API depends on a specific voice platform. `vapi.ts` is the only
implementation; `index.ts` selects an implementation via `VOICE_PROVIDER`.
Adding another platform (Retell, Bland, ...) means adding one file under
`web/src/lib/providers/` and a case in `index.ts` — nothing else in `web`
needs to change.
