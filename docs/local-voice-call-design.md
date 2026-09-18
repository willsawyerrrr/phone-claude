# Local Voice-Call MCP Tool — Design Document

> **Note on this copy:** This document was originally written outside this
> repo, without visibility into how `phone-claude` is actually built today.
> It's reproduced below with its original content intact, plus callouts
> (blockquoted, marked like this one) wherever it makes an assumption about
> the current system that doesn't match reality. See
> [Corrections summary](#corrections-summary) at the end for the short
> version.

## Goal

Replace the current Telnyx-based "ask by phone" MCP tool with a fully
local, free alternative: Claude Code places a voice call to Will's phone
over the local Wi-Fi network, asks a question via a speech-to-speech AI
pipeline, and returns the spoken answer as tool output — no per-minute
carrier costs, no injected boilerplate.

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
> falls back to `"twilio"` when `VOICE_PROVIDER` is unset). If the
> boilerplate-audio complaint is specific to Telnyx's call setup, simply
> switching `VOICE_PROVIDER=twilio` may address that specific pain point
> today, independent of this whole rebuild — worth confirming before
> investing in the full local pipeline.
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

> **This skips over `web` entirely, and that's a bigger decision than it
> looks.** Today the round trip is `mcp-server` (local, stdio, run by
> Claude Code) → `web` (a Next.js app **deployed to Vercel**, i.e. in the
> cloud) → voice provider → phone, with call state held in **Upstash
> Redis** (`web/src/lib/store.ts`, 1 hour TTL) and `mcp-server` polling
> `GET /api/calls/:id` every few seconds (`mcp-server/src/client.ts`).
> This doc's flow has the **MCP tool server talk directly to a local
> Asterisk box**, with no mention of `web`, Vercel, or Redis at all.
>
> That's actually the architecturally sound move — `mcp-server` already
> runs on Will's own machine (per `CLAUDE.md`: "standalone MCP server
> (stdio transport) run locally by Claude Code"), so it's the one process
> already positioned on the same network as a home Asterisk PBX. `web`
> being Vercel-hosted is precisely the problem a "fully local" design is
> trying to get away from: **a cloud-hosted `web` cannot reach an
> Asterisk AMI/ARI endpoint sitting on a home LAN** without exposing that
> endpoint to the public internet (a tunnel or the VPN mentioned in Open
> Question 4) — which reintroduces the "wider network" this doc is
> otherwise trying to avoid, and adds a real attack surface (an
> internet-reachable PBX control interface) that doesn't exist today.
>
> So this needs an explicit decision, not just an implied one:
> - **Option A** — a new `VoiceProvider` implementation added to `web`
>   (matching the extension point `CLAUDE.md` describes: "Adding another
>   platform ... means adding one file under `web/src/lib/providers/`
>   ... nothing else in `web` needs to change"), where `web` (still on
>   Vercel) talks to Asterisk's AMI/ARI over a tunnel/VPN. Keeps the
>   existing polling contract, Redis-backed `CallRecord`, and
>   `mcp-server` completely unchanged, at the cost of needing that
>   tunnel even when Will is on the home network Vercel can't reach.
>   - Note that Asterisk's own call flow (steps 2–7 above) doesn't fit
>     the request/webhook shape `VoiceProvider` was designed around
>     (`startCall`/`endCall` plus async callbacks) — an AMI/ARI
>     originate call, an AudioSocket session, and a transcript result
>     would need to be wrapped to fit that seam, or the seam extended.
> - **Option B** — `mcp-server` bypasses `web`/Vercel/Redis entirely for
>   this provider and talks to the local Asterisk box directly (matching
>   what this doc actually describes), with `web` no longer in the path
>   at all for local calls. This is simpler for the local case but is a
>   bigger structural change than "swap the provider" — it means
>   `mcp-server` picking up call-placement and polling logic that
>   currently lives in `web`, and the two entry points (`web`'s HTTP API
>   vs. a local Asterisk client) no longer sharing a `VoiceProvider`
>   contract at all.
>
> Worth resolving which of these (or a third option) is intended before
> writing code, since it changes what "swap in a provider" even means for
> this case.

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

> As covered above, this last point undercounts where a wider network is
> needed: if `web` stays on Vercel and Asterisk lives on the home LAN
> (Option A above), reaching Asterisk's control interface from Vercel
> requires exposing it beyond the LAN *even when Will is home* — the VPN
> stops being a "future, off-network" nice-to-have and becomes a day-one
> requirement for that option. Only if `mcp-server` talks to Asterisk
> directly (Option B), with `web` out of the loop, does the "local Wi-Fi
> only, VPN is optional" framing hold as written.

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
   > sizing models, and factors into the Option A/B decision above (an
   > always-on home machine is required either way, to host Asterisk).

3. Soft-phone app choice for Will's phone (Linphone vs. alternatives).

4. Off-network reachability: is VPN bridging (Tailscale/WireGuard) in
   scope for v1, or LAN-only for now?

   > See the note above `What Runs Fully Local and Free` — if `web`
   > stays on Vercel (Option A), this isn't purely an off-network
   > concern; it may be needed for on-network calls too.

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
- **The biggest gap: this doc doesn't say what happens to `web`.**
  `web` is deployed to Vercel and can't reach a home-LAN Asterisk box
  without exposing it publicly. Either (a) add Asterisk as a new
  `VoiceProvider` in `web` and accept that a tunnel/VPN is needed
  day one, or (b) have the already-local `mcp-server` talk to Asterisk
  directly and drop `web`/Redis from this call path entirely. This
  needs to be decided before implementation starts.
- Consequently, **the VPN (Open Question 4) may not be a "future,
  off-network only" concern** — it can be a v1 requirement depending on
  which option above is chosen.
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
