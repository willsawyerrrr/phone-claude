# phone-claude

Lets Claude Code call you by phone to ask a question when it's blocked, then resumes once you answer.

## How it works

Claude Code is running a task and hits a decision only you can make, while you're away from the keyboard. It calls the `ask_by_phone` MCP tool with the question. That triggers an actual outbound phone call to your number; you answer, say your decision, and hang up. Claude Code gets your spoken answer back as the tool result and keeps working.

```
Claude Code ──ask_by_phone──▶ mcp-server ──POST /api/calls──▶ web ──startCall──▶ Vapi ──▶ your phone
                                   │                                                        │
                                   └──────────────── poll GET /api/calls/:id ◀───────────────┘
                                                    (web updated by Vapi's webhook)
```

- **`mcp-server/`** — an MCP server run locally by Claude Code (stdio transport). Exposes one tool, `ask_by_phone`, which starts a call and polls for the answer.
- **`web/`** — a Next.js app deployed to Vercel. Starts calls via a pluggable `VoiceProvider`, and receives the voice platform's end-of-call webhook to record the answer. State (`CallRecord`s, keyed by call ID) lives in Redis with a 1 hour TTL.
- **Vapi** is the reference voice platform, behind a `VoiceProvider` interface (`web/src/lib/providers/`) so another platform (Retell, Bland, ...) can be swapped in by adding one file.

## Setup

### 1. Deploy `web/`

Deploy the `web/` package to Vercel (set its root directory to `web`). Add a Redis integration from the Vercel Marketplace (Upstash Redis) — this sets `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` automatically. Then set the remaining env vars from `web/.env.example` in the Vercel project settings.

### 2. Create a Vapi assistant

Sign up at [vapi.ai](https://vapi.ai) and create:

- An **assistant**, with a system prompt along these lines:

  > You are calling on behalf of Claude Code, an AI coding assistant, because it needs input from the user to continue a task. Ask exactly this question: {{question}}. Context: {{context}}. Get their answer, briefly confirm you understood it, then end the call politely.

  Enable `end-of-call-report` as a server message so Vapi posts a webhook when the call ends.

- An **outbound phone number** for the assistant to call from.

Note the assistant ID, phone number ID, and your Vapi API key into `web`'s Vercel env vars (`VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_API_KEY`).

### 3. Wire up the webhook

Generate a secret for `VAPI_WEBHOOK_SECRET` and set it in `web`'s env vars. Point Vapi's server URL at `<your-deployment>/api/webhooks/vapi` — either as a per-call override (see `web/src/lib/providers/vapi.ts`) or as the assistant's default server URL in the Vapi dashboard. Configure the same secret there so Vapi signs its webhook requests; confirm the exact header/payload format configured against the [Vapi server authentication docs](https://docs.vapi.ai/server-url/server-authentication) and `web/src/lib/verify-vapi-signature.ts`.

### 4. Run `mcp-server` locally

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
