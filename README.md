# phone-claude

Lets Claude Code call you by phone to ask a question when it's blocked, then resumes once you answer.

## How it works

Claude Code is running a task and hits a decision only you can make, while you're away from the keyboard. It calls the `ask_by_phone` MCP tool with the question. That rings your phone, waking it with a VoIP push if the app is closed or the phone is locked; you answer, say your decision, and hang up. Claude Code gets your spoken answer back as the tool result and keeps working. If you don't pick up before the wait times out, or Claude Code is interrupted while waiting, the call is hung up rather than left ringing.

```
                                  ┌── POST /calls ─────────▶ voice pipeline ◀──AudioSocket──┐
Claude Code ──ask_by_phone──▶ mcp-server                        ▲                          │
                                  │                     GET /calls/:id (poll)              │
                                  └── POST /ari/channels ────▶ Asterisk ──SIP──▶ your phone
```

- **`mcp-server/`** — an MCP server run locally by Claude Code (stdio transport). Exposes one tool, `ask_by_phone`, which registers the question with the voice pipeline, has Asterisk originate the call over ARI, and polls the pipeline for the answer.
- **Local stack** — Asterisk (SIP) and the voice pipeline (speaks the question, captures the spoken reply), run as a Docker Compose stack. Your phone rings through a SIP soft-phone registered to Asterisk. See [`local/README.md`](local/README.md) for running the stack, or [`docs/cloud-deploy.md`](docs/cloud-deploy.md) to run it on a cloud VM that `mcp-server` reaches over Tailscale.
- **`ios/`** — a SwiftUI SIP soft-phone for iOS that registers to Asterisk and answers the call. It rings from the lock screen through CallKit, woken by a VoIP push. See [`ios/README.md`](ios/README.md).

## Setup

### 1. Start the local stack

Run the Asterisk + voice-pipeline Docker Compose stack (`local/`, started with the same Environment) and pair your phone's SIP soft-phone (any SIP app, or the [`ios/`](ios/README.md) app) with it. Note the ARI credentials, the soft-phone's PJSIP endpoint name, and the ports the stack publishes.

### 2. Run `mcp-server` locally

Run `pnpm install` once. The repo's `.mcp.json` registers `mcp-server` for Claude Code sessions started in the checkout, launching it through `bin/phone-claude-mcp-server.js`. The shim builds `mcp-server` on first launch and whenever its sources change (build output goes to stderr), so there is no build step and no absolute path.

Configuration lives in a [1Password Environment](https://developer.1password.com/docs/environments) read by the [`op` CLI](https://developer.1password.com/docs/cli); no `.env` file is used locally. It holds `SOFTPHONE_PASSWORD`, `ARI_USERNAME`, `ARI_PASSWORD`, and optionally `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_PATH` and any variable below or in [`local/.env.example`](local/.env.example). Copy its ID from the 1Password app (Developer > View Environments > Manage environment > Copy environment ID) and export it where Claude Code starts, since `.mcp.json` launches the shim through `op run --environment "${OP_ENVIRONMENT_ID}"`:

```sh
export OP_ENVIRONMENT_ID=<environment id>
```

To use it from other projects, register the shim at user scope instead:

```sh
claude mcp add --scope user phone-claude \
  -- op run --environment <environment id> --no-masking -- \
  node /absolute/path/to/phone-claude/bin/phone-claude-mcp-server.js
```

The shim path stays valid across `pnpm install` and rebuilds; only moving the checkout changes it.

| Env var              | Default                 | Meaning                                                                                    |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `ARI_USERNAME`       | required                | Asterisk ARI user                                                                          |
| `ARI_PASSWORD`       | required                | Asterisk ARI password                                                                      |
| `ARI_URL`            | `http://localhost:8088` | Asterisk ARI base URL (the tailnet name of a cloud VM)                                     |
| `PIPELINE_URL`       | `http://localhost:8080` | Voice pipeline base URL                                                                    |
| `SIP_ENDPOINT`       | `phone`                 | PJSIP endpoint name of the soft-phone to ring                                              |
| `DIALPLAN_CONTEXT`   | `ask-by-phone`          | Dialplan context the answered call continues in                                            |
| `DIALPLAN_EXTENSION` | `700`                   | Dialplan extension that hands the call to AudioSocket                                      |
| `POLL_INTERVAL_MS`   | `3000`                  | How often to poll the pipeline (positive number)                                           |
| `MAX_WAIT_MS`        | `600000`                | How long to wait before giving up (positive number)                                        |
| `PUSH_WAIT_MS`       | `20000`                 | How long to wait for an offline phone to come online after the VoIP push (positive number) |
| `RING_TIMEOUT_S`     | `60`                    | How long Asterisk rings the phone (positive number)                                        |

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Voice pipeline tests (`ruff` and `pytest`, run in Docker):

```sh
docker build --target test -t voice-pipeline-test local/voice-pipeline
docker run --rm voice-pipeline-test
```

iOS tests (requires Xcode and XcodeGen; see [`ios/README.md`](ios/README.md)):

```sh
cd ios
xcodegen generate
xcodebuild test -project PhoneClaude.xcodeproj -scheme PhoneClaude \
  -destination 'platform=iOS Simulator,name=<simulator>,OS=latest'
```
