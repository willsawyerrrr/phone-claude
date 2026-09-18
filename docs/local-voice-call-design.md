# Local Voice-Call MCP Tool — Design Document

> **Note on this copy:** This document was originally written outside this
> repo, without visibility into how `phone-claude` is actually built today.
> It's reproduced below with its original content intact, plus callouts
> (blockquoted, marked like this one) wherever it makes an assumption about
> the current system that doesn't match reality. See
> [Corrections summary](#corrections-summary) at the end for the short
> version.
>
> **Decision (superseding "Open Question" below on this point):** this is
> a **full replacement** of the current cloud-hosted system, going all
> in on the local/on-device path. Twilio, Telnyx, `web`'s Vercel
> deployment, and its Upstash Redis store are all removed — the local
> Asterisk-based pipeline is the only way `ask_by_phone` works going
> forward, not one of two supported paths. `mcp-server` talks to Asterisk
> directly; `web` isn't kept around in any form. See
> [Revised architecture: full local replacement](#revised-architecture-full-local-replacement)
> for what that means concretely.

## Goal

Replace the current Telnyx-based "ask by phone" MCP tool with a fully
local, free alternative: Claude Code places a voice call to Will's phone
over the local Wi-Fi network, asks a question via a speech-to-speech AI
pipeline, and returns the spoken answer as tool output — no per-minute
carrier costs, no injected boilerplate.

> **Scope, made explicit:** "replace" means Twilio, Telnyx, `web`'s
> Vercel deployment, and its Redis-backed `CallRecord` store are all
> retired — not kept around as a secondary/fallback path. `mcp-server` is
> the only thing Claude Code talks to, and it becomes self-sufficient:
> home Wi-Fi (optionally bridged by a VPN, see Open Question 4) is the
> only network this system depends on going forward, with no cloud
> component of any kind in the call path.

## Current State

- MCP tool "ask by phone" triggers an outbound call via Telnyx (paid,
  third party PSTN provider).
- Telnyx injects boilerplate audio on calls.
- Cost scales per call/minute — not viable for frequent use.

> **This undersells what's already in the repo.** `phone-claude` already
> has two interchangeable PSTN providers behind a `VoiceProvider`
> interface (`web/src/lib/providers/`) — **Twilio and Telnyx are both
> fully supported today**, selected via a `VOICE_PROVIDER` env var, and
> **Twilio is the default**, not Telnyx (`web/src/lib/providers/index.ts`
> falls back to `"twilio"` when `VOICE_PROVIDER` is unset). Both are being
> retired outright under the full-replacement decision above, so this is
> noted for accuracy rather than as an argument for keeping either one.
>
> More importantly: **neither provider runs a "speech-to-speech AI
> pipeline" today.** Both are intentionally dumb — Twilio's route
> (`/api/twiml/:callId`) uses only `<Say>` (TTS) and
> `<Gather input="speech">` (speech-to-text capture); Telnyx's webhook
> route drives the call step-by-step with a `speak` Call Control command
> and `transcription_start`, no LLM in the loop. There is no
> conversational AI, no follow-up handling, and no local or hosted LLM
> anywhere in the current call flow — it's a single question, a single
> captured reply, full stop. That directly answers **Open Question 1**
> below: the tool has never needed multi-turn dialogue, so the local LLM
> stage this doc treats as optional can likely be dropped entirely rather
> than built and then disabled.

## Target Architecture

### High-level flow

1. Claude Code invokes the MCP tool with a question string.
2. MCP tool server sends a call request to a local Asterisk PBX (SIP
   server).
3. Asterisk rings a soft-phone app on Will's phone (registered over
   Wi-Fi — no cellular/PSTN involved).
4. On answer, Asterisk bridges the call audio to a local AudioSocket
   connection — a raw audio stream to a Python service.
5. The Python service runs a speech-to-speech pipeline: it speaks the
   question (TTS), listens to Will's spoken answer (VAD + STT), and
   captures the transcript.
6. Transcript is returned to Claude Code as the MCP tool result.
7. Call is torn down.

> This matches the full-replacement decision above: `mcp-server` — which
> already runs locally on Will's own machine per `CLAUDE.md` ("standalone
> MCP server (stdio transport) run locally by Claude Code") — talks to
> Asterisk directly, rather than the current round trip through `web`
> (Vercel-hosted) and its Redis-backed call state
> (`web/src/lib/store.ts`). `web`, Vercel, and Redis aren't part of this
> flow at all. See
> [Revised architecture: full local replacement](#revised-architecture-full-local-replacement)
> below for what that means for the existing code.

### Components

**1. SIP server / PBX — Asterisk** - Runs locally (spare machine,
always-on mini PC, or Raspberry Pi). - Handles SIP registration and call
setup/teardown only — no cloud dependency, no trunk provider needed for
this use case. - Config: PJSIP for endpoint registration, a dialplan
extension dedicated to the MCP tool (e.g. extension 700 = "ask-by-phone"),
routed straight to the `app_audiosocket` application rather than a human
extension. - Reference: `app_audiosocket` module, Asterisk 18+.

**2. Phone-side client — SIP soft-phone app** - Any SIP client on Will's
phone (e.g. Linphone, or another SIP-capable app) registered to the local
Asterisk server over Wi-Fi. - Free, no cellular number involved, works
anywhere on the home network. - Future option: expose Asterisk over a VPN
(e.g. Tailscale/WireGuard) to reach the phone off the local network
without any carrier involvement.

**3. Audio bridge — AudioSocket** - Asterisk's `app_audiosocket` streams
raw call audio to a local TCP service in real time. - Audio format: 8kHz,
16-bit signed linear PCM, mono, 20ms frames — standard telephony audio,
compatible with most STT/TTS engines directly or with a simple resample
step. - Reference implementation to adapt:
`github.com/glmck13/Asterisk-to-Voice-LLMs` (existing Asterisk <->
AudioSocket <-> voice-AI glue code, currently wired for AWS Nova Sonic and
Google Gemini — useful as a structural reference even though we are
swapping in a fully local model stack).

**4. Voice AI pipeline — fully local, free stack** Modeled on Hugging
Face's `speech-to-speech` project (VAD -> STT -> LLM -> TTS, modular,
exposed over an OpenAI-Realtime-compatible WebSocket/event format):
- VAD (voice activity detection): Silero VAD.
- STT (speech to text): NVIDIA Parakeet (fast, accurate) or whisper.cpp /
  faster-whisper as a fallback (MIT licensed, runs down to
  Raspberry-Pi-class hardware).
- LLM: small local model served via llama.cpp (only needed if the tool
  should handle follow-up/clarifying dialogue locally — for a single
  question/answer round-trip this may be skippable, see Open Questions).
- TTS (text to speech): Kokoro-82M — small, CPU-friendly, actively
  developed, good default. Piper is a lighter/faster alternative if
  latency matters more than voice quality.

> As noted above, the current implementation never puts an LLM in the
> call loop — it speaks a fixed question and captures one reply. That
> makes the "LLM" row here dead weight for parity with today's behavior:
> the local pipeline only needs VAD + STT (to detect and transcribe
> Will's answer) and TTS (to speak the question), matching Twilio's
> `<Say>`/`<Gather>` and Telnyx's `speak`/`transcription_start` pairing
> one-for-one, with no llama.cpp stage at all unless multi-turn dialogue
> is a new requirement being introduced by this rebuild rather than
> carried over from it.
>
> Also worth carrying over from the existing Telnyx integration: it
> doesn't treat "transcript received" as "caller is done talking" —
> `web/src/lib/store.ts`'s `pendingTranscript`/`transcriptSeq` fields
> exist because Telnyx's real-time transcription reports a reply as
> several `is_final: true` segments in a row, and only a quiet period
> with no further segment means the caller has actually finished. Silero
> VAD's job is exactly this (end-of-utterance detection), so a
> well-configured VAD stage should make that segment-accumulation
> machinery unnecessary here — but if the STT engine chosen streams
> partial/final segments similarly to Telnyx, the same "don't finalize on
> the first final segment" lesson applies.

**5. MCP tool server** - Thin wrapper exposing an "ask_by_phone" tool to
Claude Code. - On invocation: originates the Asterisk call (via
Asterisk's AMI/ARI — Asterisk Manager Interface / REST Interface), waits
for the AudioSocket session to complete, collects the final transcript,
returns it as the tool result. - Should handle: no-answer timeout,
call-in-progress state, and graceful hangup once an answer is captured.

> The existing `mcp-server` (`mcp-server/src/index.ts`) already registers
> a tool named exactly `ask_by_phone`, with a `question` and optional
> `context` input and the "ask the user in chat instead" fallback message
> on failure — that tool's name, shape, and Claude Code-facing contract
> should stay as-is regardless of which backend answers it, so Claude
> Code's usage of the tool doesn't need to change. The
> "no-answer timeout / call-in-progress / graceful hangup" behaviors this
> bullet calls for already exist too: `mcp-server/src/client.ts` polls
> with configurable `POLL_INTERVAL_MS`/`MAX_WAIT_MS` (defaults 3s / 10
> min), tracks one `activeCall` at a time, and cancels it on timeout or
> on `SIGINT`/`SIGTERM`. Whatever backs the call (Asterisk or otherwise),
> reusing this timeout/cancel logic — rather than re-implementing it
> against AMI/ARI — avoids duplicating behavior that's already been
> debugged (including the race described in `store.ts`'s
> `CallStore.update`, between a timeout-driven cancellation and a
> just-arrived answer).

## What Runs Fully Local and Free

- Call setup/signaling (SIP via Asterisk) — no carrier involved.
- Call audio transport (AudioSocket over LAN) — no carrier involved.
- STT, TTS, and (optionally) the LLM — self-hosted, no per-call API cost.
- The only place a wider network is needed at all is if Will's phone is
  off the home Wi-Fi, which the future VPN option addresses without
  reintroducing a telco.

> With `web`/Vercel retired (per the decision above), this framing holds
> as written: since `mcp-server` talks to Asterisk directly and nothing
> in the call path is cloud-hosted, the VPN really is only needed for the
> off-network case (Will's phone away from home Wi-Fi) — it's not a
> day-one requirement the way it would have been had `web` stayed on
> Vercel.

## Open Questions for Claude Code to Resolve During Build

1. Does the tool need multi-turn dialogue (LLM in the loop) or is it a
   single question -> single answer capture? This determines whether the
   local LLM stage is required at all.

   > Answered by the current codebase: it's single question → single
   > answer, with no LLM in the loop today on either provider. Absent a
   > new requirement to add follow-up dialogue, skip the LLM stage.

2. Hardware target: what machine will run Asterisk + the voice pipeline?
   (Determines model size choices — e.g. Parakeet vs. whisper.cpp, Kokoro
   vs. Piper.)

   > Not something the current repo has an answer for — there's no
   > existing "always-on local machine" in this project today (`web`
   > runs on Vercel, `mcp-server` runs wherever Claude Code runs, which
   > may not be an always-on box). This needs an answer from Will before
   > sizing models — an always-on home machine to host Asterisk and the
   > voice pipeline is new infrastructure this design requires.

3. Soft-phone app choice for Will's phone (Linphone vs. alternatives).

4. Off-network reachability: is VPN bridging (Tailscale/WireGuard) in
   scope for v1, or LAN-only for now?

   > With the full-replacement decision above, this stays a genuinely
   > optional, off-network-only concern — `mcp-server` reaching Asterisk
   > is always a local/LAN call, so a VPN is only needed if Will's phone
   > itself is expected to ring while off the home Wi-Fi. Fine to start
   > LAN-only and add VPN bridging later without touching the core design.

5. Silence/timeout handling: how long to wait for a spoken answer before
   giving up, and what the MCP tool should return in that case.

   > The existing `mcp-server`/`web` split already has answers here worth
   > reusing rather than re-deriving: `mcp-server`'s overall wait is
   > bounded by `MAX_WAIT_MS` (default 10 minutes) before it cancels and
   > reports a timeout error back to Claude Code as tool output ("Could
   > not get a phone answer ... Ask the user in chat instead."); within a
   > call, Telnyx's webhook route separately handles no-input timeouts
   > and a bounded number of "repeat the question" attempts
   > (`promptAttempt` in `CallRecord`). Both concerns — an overall
   > deadline, and a per-call no-input/repeat policy — will still be
   > needed with a local pipeline; only the mechanism changes.

## Revised architecture: full local replacement

This section is new (not part of the original document) and spells out
what "full replacement" means concretely for this repo, now that `web`
is being retired entirely rather than kept alongside the local path.

**Removed:**
- The `web` package's Vercel deployment.
- Both `VoiceProvider` implementations (`twilio.ts`, `telnyx.ts`) and
  their env vars (`TWILIO_*`, `TELNYX_*`, `PUBLIC_BASE_URL`).
- The `/api/calls*`, `/api/twiml/:callId`, and `/api/webhooks/*` routes.
- The Upstash Redis `CallStore` and its `CallRecord` TTL/persistence
  logic (`web/src/lib/store.ts`) — that existed to give a stateless,
  horizontally-scaled serverless deployment somewhere to keep call state
  between requests. `mcp-server` is a single long-running local process
  per invocation, so it can just hold call state in memory for the
  duration of one `ask_by_phone` call, the way it already tracks
  `activeCall` today — no external store needed.

**Kept, unchanged:** the `ask_by_phone` tool's name, input schema
(`question`/`context`), and chat-fallback error message
(`mcp-server/src/index.ts`); the overall wait/timeout/cancel behavior
(`POLL_INTERVAL_MS`/`MAX_WAIT_MS`, `SIGINT`/`SIGTERM` handling). None of
that is specific to Twilio/Telnyx/`web` — it's the shape Claude Code
already depends on and should stay put.

**Changed:** `mcp-server/src/client.ts`'s three functions
(`startCall`, `pollForAnswer`, `cancelCall`) currently do their work via
`fetch` calls to `web`. They get reimplemented against the local stack
instead:
- `startCall` → originate the call via Asterisk's AMI or ARI (pick one;
  ARI's REST/WebSocket model maps more naturally onto a Node client than
  AMI's line-based protocol) instead of `POST /api/calls`.
- `pollForAnswer` → since everything is now local and nothing needs to
  survive a serverless cold start, this doesn't need to stay an
  HTTP-polling loop against a remote service. It becomes waiting on the
  local voice pipeline to report a finished transcript for this call —
  whether that's a promise resolved by a WebSocket/local-socket message
  from the Python VAD/STT/TTS service, or a short local poll against it,
  is an implementation detail now, not a constraint imposed by Vercel's
  request/response model the way it was for `web`.
- `cancelCall` → hang up via the same AMI/ARI connection instead of
  `POST /api/calls/:id/cancel`.

**New local components** `mcp-server` now depends on, all running on the
same home network (per Open Question 2, likely the same always-on
machine): the Asterisk PBX itself, the Python speech pipeline service
bridged to it via AudioSocket, and the SIP soft-phone app on Will's
phone. `mcp-server` talks to Asterisk (AMI/ARI) and to the Python
pipeline service (whatever local IPC/HTTP/WebSocket mechanism is chosen
to hand it a call and get a transcript back) — it does not talk to the
phone or to AudioSocket directly; those stay inside the
Asterisk/Python side of the bridge.

**Docs to update once this is built:** `README.md`'s "How it works"
diagram and "Setup" section (currently: deploy `web` to Vercel, set up
Twilio or Telnyx, run `mcp-server` pointed at the deployed URL) and
`CLAUDE.md`'s architecture section both describe the current
`web`-in-the-middle design and will need rewriting to describe
`mcp-server` + the local Asterisk/voice-pipeline stack instead.

## Reference Material

- Asterisk + AudioSocket + voice-AI glue code (structural reference):
  `github.com/glmck13/Asterisk-to-Voice-LLMs`
- Hugging Face speech-to-speech pipeline (pipeline structure reference):
  `github.com/huggingface/speech-to-speech`
- Asterisk on Raspberry Pi setup guides (multiple, for base PBX install).

## Corrections summary

Quick reference for what changed relative to the original document:

- **Both Twilio and Telnyx are supported today**, not just Telnyx, and
  Twilio (not Telnyx) is the default `VOICE_PROVIDER`. If Telnyx's
  boilerplate audio is the actual complaint, switching providers today
  may be a much smaller fix than this whole proposal.
- **No LLM is in the call loop today** on either provider — the current
  system is already single-question/single-answer via TTS + speech
  capture, which answers Open Question 1: the local LLM/llama.cpp stage
  is very likely unnecessary.
- **The biggest gap: this doc didn't originally say what happens to
  `web`.** `web` is deployed to Vercel and can't reach a home-LAN
  Asterisk box without exposing it publicly. **Decided:** this is a full
  replacement — `web`, Vercel, Redis, Twilio, and Telnyx are all retired,
  and the already-local `mcp-server` absorbs call-placement and
  orchestration, talking to Asterisk directly. See
  [Revised architecture: full local replacement](#revised-architecture-full-local-replacement)
  for what that changes concretely in `mcp-server/src/client.ts`.
- Consequently, **the VPN (Open Question 4) stays a genuine
  off-network-only concern** — with `web` gone, nothing in the call path
  is cloud-hosted, so a VPN is only needed if Will's phone should be
  reachable while off the home Wi-Fi, not for `mcp-server` to reach
  Asterisk.
- **Reuse, don't re-derive, existing timeout/cancel and
  segment-accumulation logic**: `mcp-server`'s poll/timeout/cancel flow
  and `web`'s lesson about not finalizing a reply on the first
  transcription segment both encode debugged behavior worth carrying
  forward rather than rebuilding from scratch.
- **Keep the `ask_by_phone` MCP tool contract unchanged** — its name,
  inputs, and chat-fallback error behavior already exist and Claude Code
  already depends on them; this rebuild only needs to change what's
  behind that tool, not the tool itself.
- **No hardware currently runs 24/7 for this project** — `web` is
  serverless (Vercel) and `mcp-server` runs wherever Claude Code runs.
  An always-on local machine for Asterisk is a new piece of
  infrastructure this proposal introduces, not something being repurposed.
- **`README.md` and `CLAUDE.md` both describe the current
  `web`-in-the-middle architecture** and will need rewriting once this
  ships, since they document a Vercel deployment step, Twilio/Telnyx
  setup, and a `PUBLIC_BASE_URL`/webhook flow that no longer exist under
  the full-replacement decision.
