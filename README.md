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

Deploy the `web/` package to Vercel (set its root directory to `web`). Add a Redis integration from the Vercel Marketplace (Upstash Redis), giving it the custom prefix `UPSTASH_REDIS_REST` — this sets `UPSTASH_REDIS_REST_KV_REST_API_URL` / `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` automatically. Then set the remaining env vars from `web/.env.example` in the Vercel project settings.

### 2. Create a Vapi webhook credential

Sign up at [vapi.ai](https://vapi.ai). Create a `webhook` credential (`POST /credential`) with a `bearer` authentication plan: `token` set to a generated secret (this becomes `VAPI_WEBHOOK_SECRET`), `headerName: "x-vapi-secret"`, `bearerPrefixEnabled: false`. Note the credential's `id`.

### 3. Create the assistant

Create an assistant (`POST /assistant`) with:

- A system prompt along these lines:

  > You are calling on behalf of Claude Code, an AI coding assistant, because it needs input from the user to continue a task. Ask exactly this question: {{question}}. Context: {{context}}. Once you have a clear answer, call `record_answer` with it, thank them, then end the call.

- A `record_answer` function tool (`type: "function"`, sync): one string parameter, `answer`.
- `server`: `{ url: "<your-deployment>/api/webhooks/vapi", credentialId: "<credential id from step 2>" }`.

`end-of-call-report` is included in `serverMessages` by default — no extra config needed; the webhook uses it only as a fallback to mark a call `failed` if it ends before `record_answer` is called.

Note the assistant ID, and your Vapi API key, into `web`'s Vercel env vars (`VAPI_ASSISTANT_ID`, `VAPI_API_KEY`).

### 4. Create a phone number

Create a phone number (`POST /phone-number`, `provider: "vapi"` for a free Vapi-hosted number, or import a Twilio/Vonage/Telnyx number). Note its ID into `VAPI_PHONE_NUMBER_ID`.

### 5. Run `mcp-server` locally

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
