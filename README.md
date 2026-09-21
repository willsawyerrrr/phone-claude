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

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
