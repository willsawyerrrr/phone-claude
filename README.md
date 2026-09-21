# phone-claude

Lets Claude Code call you by phone to ask a question when it's blocked, then resumes once you answer.

## How it works

Claude Code is running a task and hits a decision only you can make, while you're away from the keyboard. It calls the `ask_by_phone` MCP tool with the question. That triggers an actual outbound phone call to your number; you answer, say your decision, and hang up. Claude Code gets your spoken answer back as the tool result and keeps working. If you don't pick up before the wait times out, or Claude Code is interrupted while waiting, the call is hung up rather than left ringing.

```
                                  ┌── POST /calls ─────────▶ voice pipeline ◀──AudioSocket──┐
Claude Code ──ask_by_phone──▶ mcp-server                        ▲                          │
                                  │                     GET /calls/:id (poll)              │
                                  └── POST /ari/channels ────▶ Asterisk ──SIP──▶ your phone
```

- **`mcp-server/`** — an MCP server run locally by Claude Code (stdio transport). Exposes one tool, `ask_by_phone`, which registers the question with the voice pipeline, has Asterisk originate the call over ARI, and polls the pipeline for the answer.
- **Local stack** — Asterisk (SIP) and the voice pipeline (speaks the question, captures the spoken reply), run as a Docker Compose stack. Your phone rings through a SIP soft-phone registered to Asterisk. See [`local/README.md`](local/README.md) for running the stack.
- **`web/`** — a Next.js app deployed to Vercel that exposes a cloud call API backed by a pluggable `VoiceProvider` (`web/src/lib/providers/`, selected via `VOICE_PROVIDER`; **Twilio** and **Telnyx** are supported). `mcp-server` does not call it; see [Cloud path](#cloud-path-web) below.

## Setup

### 1. Start the local stack

Run the Asterisk + voice-pipeline Docker Compose stack (`local/`) and pair your phone's SIP soft-phone with it. Note the ARI credentials, the soft-phone's PJSIP endpoint name, and the ports the stack publishes.

### 2. Run `mcp-server` locally

Build it once:

```sh
pnpm --filter mcp-server build
```

Then register it with Claude Code. Either:

```sh
claude mcp add phone-claude \
  --env ARI_USERNAME=<ARI user> --env ARI_PASSWORD=<ARI password> \
  -- node /absolute/path/to/phone-claude/mcp-server/dist/index.js
```

or via a project `.mcp.json`:

```json
{
  "mcpServers": {
    "phone-claude": {
      "command": "node",
      "args": ["/absolute/path/to/phone-claude/mcp-server/dist/index.js"],
      "env": {
        "ARI_USERNAME": "<ARI user>",
        "ARI_PASSWORD": "<ARI password>"
      }
    }
  }
}
```

| Env var              | Default                 | Meaning                                               |
| -------------------- | ----------------------- | ----------------------------------------------------- |
| `ARI_USERNAME`       | required                | Asterisk ARI user                                     |
| `ARI_PASSWORD`       | required                | Asterisk ARI password                                 |
| `ARI_URL`            | `http://localhost:8088` | Asterisk ARI base URL                                 |
| `PIPELINE_URL`       | `http://localhost:8080` | Voice pipeline base URL                               |
| `SIP_ENDPOINT`       | `phone`                 | PJSIP endpoint name of the soft-phone to ring         |
| `DIALPLAN_CONTEXT`   | `ask-by-phone`          | Dialplan context the answered call continues in       |
| `DIALPLAN_EXTENSION` | `700`                   | Dialplan extension that hands the call to AudioSocket |
| `POLL_INTERVAL_MS`   | `3000`                  | How often to poll the pipeline for the answer         |
| `MAX_WAIT_MS`        | `600000`                | How long to wait before hanging up and giving up      |

## Cloud path (`web/`)

Not used by `mcp-server`. Deploys the cloud call API and its voice-platform integrations.

### Deploy `web/`

Deploy the `web/` package to Vercel (set its root directory to `web`). Add a Redis integration from the Vercel Marketplace (Upstash Redis), giving it the custom prefix `UPSTASH_REDIS_REST` — this sets `UPSTASH_REDIS_REST_KV_REST_API_URL` / `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` automatically. Then set the remaining env vars from `web/.env.example` in the Vercel project settings, including `PUBLIC_BASE_URL` (this deployment's URL, e.g. `https://your-app.vercel.app`) and `VOICE_PROVIDER` (`twilio` or `telnyx`).

### Set up a voice platform

Set up whichever platform matches `VOICE_PROVIDER`.

#### Twilio

Sign up at [twilio.com](https://www.twilio.com). Note the account's SID and auth token into `web`'s Vercel env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`). Buy or import a phone number capable of voice calls and note it (E.164 format) into `TWILIO_PHONE_NUMBER`.

No assistant, webhook credential, or dashboard configuration is needed beyond that — `web` builds the TwiML per call (`/api/twiml/:callId`) and Twilio's `<Gather>` result is posted straight back to `web` (`/api/webhooks/twilio/:callId`), both authenticated via Twilio's `X-Twilio-Signature` request signing. The call uses only Twilio's `<Say>` (text-to-speech) and `<Gather input="speech">` (speech capture) primitives — no conversational voice-AI layer.

#### Telnyx

Sign up at [telnyx.com](https://telnyx.com). Create a Call Control App (Mission Control > Call Control > Applications) and note its ID into `TELNYX_CONNECTION_ID`. Buy or port a phone number capable of voice calls, assign it to that Call Control App, and note the number (E.164 format) into `TELNYX_PHONE_NUMBER`. Create an API key (Mission Control > Account Settings > API Keys) into `TELNYX_API_KEY`, and copy the account's public key (Mission Control > Account Settings > Keys & Credentials > Public Key) into `TELNYX_PUBLIC_KEY`.

No further webhook configuration is needed — `web` points Telnyx at a per-call webhook (`/api/webhooks/telnyx/:callId`) when it places the call, authenticated via Telnyx's `Telnyx-Signature-Ed25519` request signing. Telnyx's Call Control API has no TwiML-style declarative speech gather, so `web` drives the call step by step from that one webhook: it speaks the question via the `speak` command, then captures the reply via real-time transcription (`transcription_start`), reacting to each event (`call.answered`, `call.speak.ended`, `call.transcription`, `call.hangup`) as Telnyx posts it.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
