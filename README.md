# phone-claude

Lets Claude Code call you by phone to ask a question when it's blocked, then resumes once you answer.

## How it works

Claude Code is running a task and hits a decision only you can make, while you're away from the keyboard. It calls the `ask_by_phone` MCP tool with the question. That triggers an actual outbound phone call to your number; you answer, say your decision, and hang up. Claude Code gets your spoken answer back as the tool result and keeps working.

```
Claude Code ──ask_by_phone──▶ mcp-server ──POST /api/calls──▶ web ──calls.create──▶ Twilio ──▶ your phone
                                   │                                                              │
                                   └────────────────── poll GET /api/calls/:id ◀───────────────────┘
                                              (web updated by Twilio's TwiML callbacks)
```

- **`mcp-server/`** — an MCP server run locally by Claude Code (stdio transport). Exposes one tool, `ask_by_phone`, which starts a call and polls for the answer.
- **`web/`** — a Next.js app deployed to Vercel. Starts calls via a pluggable `VoiceProvider`, serves the TwiML Twilio requests when the call connects, and receives Twilio's callbacks to record the answer. State (`CallRecord`s, keyed by call ID) lives in Redis with a 1 hour TTL.
- **Twilio** is the voice platform, behind a `VoiceProvider` interface (`web/src/lib/providers/`) so another platform (Retell, Bland, ...) can be swapped in by adding one file. The call itself uses only Twilio's `<Say>` (text-to-speech) and `<Gather input="speech">` (speech capture) primitives — no conversational voice-AI layer.

## Setup

### 1. Deploy `web/`

Deploy the `web/` package to Vercel (set its root directory to `web`). Add a Redis integration from the Vercel Marketplace (Upstash Redis), giving it the custom prefix `UPSTASH_REDIS_REST` — this sets `UPSTASH_REDIS_REST_KV_REST_API_URL` / `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` automatically. Then set the remaining env vars from `web/.env.example` in the Vercel project settings, including `PUBLIC_BASE_URL` (this deployment's URL, e.g. `https://your-app.vercel.app`).

### 2. Create a Twilio account and phone number

Sign up at [twilio.com](https://www.twilio.com). Note the account's SID and auth token into `web`'s Vercel env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`). Buy or import a phone number capable of voice calls and note it (E.164 format) into `TWILIO_PHONE_NUMBER`.

No assistant, webhook credential, or dashboard configuration is needed beyond that — `web` builds the TwiML per call (`/api/twiml/:callId`) and Twilio's `<Gather>` result is posted straight back to `web` (`/api/webhooks/twilio/:callId`), both authenticated via Twilio's `X-Twilio-Signature` request signing.

### 3. Run `mcp-server` locally

Build it once:

```sh
pnpm --filter mcp-server build
```

Then register it with Claude Code, pointing at your deployed `web` app. Either:

```sh
claude mcp add phone-claude -- node /absolute/path/to/phone-claude/mcp-server/dist/index.js
```

or via a project `.mcp.json`:

```json
{
  "mcpServers": {
    "phone-claude": {
      "command": "node",
      "args": ["/absolute/path/to/phone-claude/mcp-server/dist/index.js"],
      "env": {
        "PHONE_CLAUDE_API_URL": "https://your-app.vercel.app",
        "PHONE_CLAUDE_API_SECRET": "<same value as web's API_SECRET>",
        "USER_PHONE_NUMBER": "+15551234567"
      }
    }
  }
}
```

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
