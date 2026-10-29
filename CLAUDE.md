# CLAUDE.md

## Architecture

pnpm workspace with one package:

- `mcp-server/` — standalone MCP server. Exposes one tool, `ask_by_phone`,
  backed by the Asterisk + voice-pipeline stack. `src/server.ts` registers
  the tool and the `SIGINT`/`SIGTERM` shutdown handling shared by its two
  entrypoints: `src/index.ts` (stdio transport, run locally by Claude Code)
  and `src/http.ts` (Streamable HTTP, stateless — one `McpServer` per
  request, since `ask_by_phone` has no use for session resumability; built
  and run from `mcp-server/Dockerfile`, as the `mcp-server` Compose service,
  for the cloud-deploy stack). The root `bin/phone-claude-mcp-server.js`
  shim (builds `mcp-server` when `dist` is missing or stale, build output on
  stderr, then imports `dist/index.js`) is what the root `.mcp.json` and the
  root `bin` entry launch; `mcp-server/src/shim.test.ts` exercises it.

`local/` is that stack's Docker Compose definition (not a pnpm package). Start
it with `local/up.sh`, which detects the Mac's LAN IP and exports it as
`HOST_LAN_IP` (it overrides the Environment and `.env`); with `OP_ENVIRONMENT_ID`
set it runs Compose under `op run --environment`, and a host with no 1Password
(the cloud VM) leaves it unset and uses `.env`. `.mcp.json` launches the shim
through `op run --environment "${OP_ENVIRONMENT_ID}" --no-masking` (stdout
carries MCP traffic), so secrets come from the 1Password Environment, not a
`.env` file. `local/test-up.sh` tests the detection. The
`asterisk` service renders its config from env at container start
(`local/asterisk/render-config.sh`), so it runs unchanged on any host. It has
one PJSIP endpoint (the soft-phone, named `SOFTPHONE_USERNAME`, which is
`mcp-server`'s `SIP_ENDPOINT`), ARI on port 8088, and the `ask-by-phone`
context whose extension `700` streams the answered call to AudioSocket at
`voice-pipeline:9092` (`Dial(AudioSocket/...)` with `c(slin16)`), keyed by the
`CALL_ID` channel variable. Calls are 16 kHz wideband end to end: the endpoint
prefers G.722 (falling back to `ulaw,alaw`; `mcp-server` passes
`formats=g722,ulaw,alaw` to ARI so the offer leads with it) and the pipeline
works in 16 kHz slin. The
`voice-pipeline` service (`local/voice-pipeline/`, Python) also stores the
phone's push token (`PUT /device` on the LAN port `DEVICE_PORT`, or over HTTPS at
`PUBLIC_HOSTNAME` through the optional `caddy` service, enabled by
`COMPOSE_PROFILES=public`; bearer
`SOFTPHONE_PASSWORD`, persisted in the `pipeline-data` volume) and sends the
APNs VoIP push (`POST /push`, loopback). It speaks the question
with local Kyutai Pocket TTS (`alba-casual` by default; `TTS_VOICE` selects
`alba-announcer`, and `local/audition.sh` compares the voices), listens with local VAD + STT, and exposes the `/calls` HTTP
API; it streams a frame to Asterisk every 20 ms for the whole call because
Asterisk drops a quiet AudioSocket connection. `ARI_BIND_ADDRESS` and
`PIPELINE_BIND_ADDRESS` (both loopback by default) set the addresses of the
ARI and pipeline API ports; `MCP_BIND_ADDRESS` (also loopback by default) sets `mcp-server`'s. Setting `CAPTURE_DIR` records each listening phase's inbound audio and speech detection under `local/captures/` for
tuning with `local/voice-pipeline/scripts/analyze_capture.py` (off by default; it is the caller's room audio). Speech more than `LOUDNESS_MARGIN_DB` (12) quieter than the loudest in a reply counts as background and doesn't hold the reply open. The same stack runs on a single cloud VM
(`docs/cloud-deploy.md`): `HOST_LAN_IP` is the VM's public IP, those three ports
bind to its Tailscale IP, and Claude Code reaches `mcp-server` over the
tailnet instead of running it locally. With `PUBLIC_HOSTNAME` set, `asterisk` instead serves SIP over TLS on
`TLS_PORT` (5061) with Caddy's certificate (read from the `caddy-data` volume by
`local/asterisk/start.sh`, which waits for it, copies it readable by `asterisk`
and restarts Asterisk on renewal) and the endpoint requires SDES SRTP; plain
SIP and RTP are served only when it is unset. See `local/README.md` and `local/voice-pipeline/README.md`.

`ios/` is a SwiftUI soft-phone (not a pnpm package; the Xcode project is
generated from `ios/project.yml` with XcodeGen) that registers to `asterisk`
as the `SOFTPHONE_USERNAME` endpoint and answers calls, using the Linphone SDK
for SIP and media. It rings from the lock screen: the app un-registers and stops its SIP client in
the background, so Asterisk sees the endpoint offline, and a PushKit VoIP
push wakes it; every push is reported to CallKit at once, then the app
re-registers and answers the INVITE when the user accepts. The user picks the
connection: plain UDP on the LAN (port 5060, device endpoint `http://<ip>:8081/device`),
or SIP TLS on 5061 with mandatory SDES SRTP and `https://<host>/device`
for the cloud-hosted stack. It sends its PushKit token to the pipeline's
device endpoint. See `ios/README.md`.

## Build and test

- TypeScript: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm format:check`. CI and the MCP server on the user's machine run Node 26
  (`.nvmrc`, `engines` `26.x`, `@types/node` `^26`); Dependabot ignores
  `@types/node` major bumps.
- `mcp-server/Dockerfile` (built from the repo root, a pnpm workspace):
  `docker build -f mcp-server/Dockerfile -t mcp-server-test .`.
- Voice pipeline (`ruff` + `pytest`; Python 3.14 in the Docker image,
  `requires-python` and `.python-version`; Dependabot ignores Python major and
  minor bumps of the base image):
  `docker build --target test -t voice-pipeline-test local/voice-pipeline &&
docker run --rm voice-pipeline-test`.
- Stack start script: `shellcheck local/up.sh local/test-up.sh local/audition.sh local/test-render-config.sh && local/test-up.sh && local/test-render-config.sh`.
- iOS (CI and the TestFlight deploy both pin `macos-26` and Xcode 26.6, the
  newest GA Xcode on GitHub's runners): in `ios/`, `xcodegen generate`, then
  `xcodebuild test -project PhoneClaude.xcodeproj -scheme PhoneClaude
-destination 'platform=iOS Simulator,name=<simulator>,OS=latest'`.

## CI

- `.github/workflows/ci.yml` runs on every pull request and push to `main`.
  Its `CI Status` job needs every other job; it is the only check the `main`
  ruleset requires, so any new job must be added to its `needs:`. The ruleset
  also requires a pull request (squash merges only) and blocks force pushes and
  deletion.

- `.github/workflows/deploy-ios.yml` runs on pushes to `main` that touch
  `ios/`. It calls platform's reusable `ios-testflight.yml`, which archives
  the `PhoneClaude` scheme and uploads it to TestFlight; the build number is
  the run number. It needs the repository secret
  `OP_SERVICE_ACCOUNT_TOKEN` (a service account scoped to the Environments) and
  the repository variable `OP_ENVIRONMENT_IDS`
  (`b5zkkwxuutlttwbrv5xhgojye4 ufudw2eopg5tmebz6ptldpitki`: Apple Development
  for `ASC_*` and `DEVELOPMENT_TEAM`, then Phone Claude); see platform's
  `docs/1password-environments.md`. It is not part of `CI Status`.

- `.github/workflows/deploy-vps.yml` runs on pushes to `main` that touch
  `local/`. It joins the tailnet as `tag:ci` (via `tailscale/github-action`,
  using `TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET` from the
  Phone Claude Environment), then SSHes to `phone-claude-vps` (the repository
  variables `VPS_TAILNET_HOST` and `VPS_RESERVED_IP`), resets it to
  `origin/main`, and re-runs `./up.sh`. The tailnet policy needs both a
  `grants` entry (not just the `ssh` section — see `docs/cloud-deploy.md`)
  granting `tag:ci` access to `tag:phone-claude-vps`, and the `ssh` rule
  granting it root. Rebuilding briefly interrupts any in-progress call; it is
  not part of `CI Status`.

- `.github/workflows/tailscale-policy.yml` runs on changes to `policy.hujson`
  (pull request: `tailscale/gitops-acl-action` `test`; push to `main`:
  `apply`). It owns the tailnet's policy (GitOps; the admin console's editor
  is locked, pointed at this repo — see `docs/cloud-deploy.md`), loading
  `TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET` the same way
  `deploy-vps.yml` does — one OAuth client, scoped to both `auth_keys` and
  `policy_file`, backs both workflows. It is not part of `CI Status`.

## Local call round-trip

1. Claude Code calls the `ask_by_phone` MCP tool with a question (and
   optional context).
2. `mcp-server` generates a UUID `callId` (AudioSocket keys the audio stream
   by a UUID) and POSTs `{callId, question, context}` to the voice pipeline's
   `/calls`. If ARI reports the endpoint (`GET /ari/endpoints/PJSIP/$SIP_ENDPOINT`)
   not `online`, it POSTs the pipeline's `/push` and polls the endpoint for up
   to `PUSH_WAIT_MS`; if it never comes online the call fails. It then
   originates the call through Asterisk's ARI
   (`POST /ari/channels`, endpoint `PJSIP/$SIP_ENDPOINT`, dialplan
   `$DIALPLAN_CONTEXT`/`$DIALPLAN_EXTENSION`, `channelId=callId`, `timeout=$RING_TIMEOUT_S`, channel
   variable `CALL_ID=callId`). The prompt is registered first so it's in
   place when the phone answers.
3. `mcp-server` polls the pipeline's `GET /calls/:id` every few seconds (see
   `mcp-server/src/client.ts` for why polling rather than a long-lived
   connection) until the status is `answered` or `failed`. While the status is `pending`
   it also checks `GET /ari/channels/:callId`; a 404 means the dial ended
   (busy, declined, unreachable) and fails the call immediately.
4. If starting or polling the call fails (every request has a timeout), the
   poll times out, or the process is interrupted (`SIGINT`/`SIGTERM`) while
   any call is in flight (including one still starting), `mcp-server` hangs up the
   ARI channel (`DELETE /ari/channels/:callId`) and POSTs the pipeline's
   `/calls/:id/cancel`. Both are best-effort.

`mcp-server` is configured by env vars; names and defaults are in
`mcp-server/src/config.ts`. The config is loaded and validated once at
startup; an invalid one is reported to the caller through each `ask_by_phone`
call's ask-in-chat fallback.
