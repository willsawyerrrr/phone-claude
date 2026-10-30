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

- **`mcp-server/`** — an MCP server exposing one tool, `ask_by_phone`, which registers the question with the voice pipeline, has Asterisk originate the call over ARI, and polls the pipeline for the answer. Deployed alongside the stack and reached over Streamable HTTP.
- **The stack** — Asterisk (SIP) and the voice pipeline (speaks the question, captures the spoken reply), run as a Docker Compose stack on a cloud VM. Your phone rings through a SIP soft-phone registered to Asterisk.
- **`ios/`** — a SwiftUI SIP soft-phone for iOS that registers to Asterisk and answers the call. It rings from the lock screen through CallKit, woken by a VoIP push. See [`ios/README.md`](ios/README.md).

## Setup

This runs entirely on a cloud VM, reached over Tailscale — see [`docs/cloud-deploy.md`](docs/cloud-deploy.md) for the full setup. Once deployed, the repo's `.mcp.json` registers `ask_by_phone` for any Claude Code session started in this checkout; no local setup is needed.

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
