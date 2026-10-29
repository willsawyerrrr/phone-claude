# Cloud deploy

Runs the `local/` stack on one cloud VM for one phone, using DigitalOcean in Sydney (`syd1`) as the example. SIP (TLS), RTP and the HTTPS device endpoint are public; ARI (`8088`), the pipeline API (`8080`) and `mcp-server` (`8090`) are reachable only over Tailscale. `mcp-server` itself runs on the VM, next to Asterisk and the voice pipeline (reaching them over the Compose network, not Tailscale); Claude Code connects to it remotely instead of running it locally.

## VM

- x86 Ubuntu LTS droplet in `syd1`, 4 GB RAM minimum (Whisper `base.en`, Piper and Asterisk), e.g. `s-2vcpu-4gb`.
- Assign a reserved IP to the droplet; it is the stable public address (`HOST_LAN_IP`).
- Point an `A` record for `phone-claude.willsawyerrrr.dev` at the reserved IP, and one for `mcp.phone-claude.willsawyerrrr.dev` at the VM's tailnet IP — a friendlier name for `mcp-server`'s Tailscale-only endpoint than the generated `<tailnet name>.ts.net`. Publishing it doesn't expose anything: the tailnet IP it points at isn't routable off the tailnet.
- Install Docker Engine and the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/ubuntu/)).

## Tailscale

Install `tailscaled` on the host, not in Compose:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key=<tagged key> --ssh
tailscale ip -4   # the VM's tailnet IP
```

- Create the auth key in the Tailscale admin console with tag `tag:phone-claude-vps` (add the tag to `tagOwners`).
- The tailnet is `tail8e5593.ts.net`. Its policy is this repo's own [`policy.hujson`](../policy.hujson), synced by `.github/workflows/tailscale-policy.yml` (GitOps; [setup guide](https://tailscale.com/docs/integrations/github/gitops)) — propose a policy change the same way as any other change here, by editing that file and opening a PR. It validates and test-checks the policy on the PR, and applies it on merge to `main`; the admin console's editor is locked (Access controls → "Prevent edits in the admin console"), pointed at this repo. It is not part of `CI Status`.
- `tag:ci` is the tag `.github/workflows/deploy-vps.yml` advertises when it joins the tailnet (via `tailscale/github-action`, scope `auth_keys`); add the tag to `tagOwners` alongside `tag:phone-claude-vps`.

One Tailscale OAuth client, scoped to both `auth_keys` and `policy_file`, backs both workflows: its ID and secret are `TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET` in the Phone Claude 1Password Environment, loaded the same way `deploy-vps.yml` already does (`willsawyerrrr/platform/.github/actions/load-op-environment@main`, the repository secret `OP_SERVICE_ACCOUNT_TOKEN` and variable `OP_ENVIRONMENT_IDS`) — no separate credential to create or store for the policy sync.

`policy.hujson`'s `ssh` section alone isn't enough for `tag:ci`: without a matching `grants` entry too, the node can't even resolve `phone-claude-vps.tail8e5593.ts.net` — the `ssh` rule only governs access once a connection reaches the host, while `grants` governs whether the node can see and reach it at all. A deploy failing with `ssh: Could not resolve hostname` points at this.

## Firewall

DigitalOcean Cloud Firewall attached to the droplet, inbound only:

| Protocol | Port        | Purpose                     |
| -------- | ----------- | --------------------------- |
| UDP, TCP | 5060        | SIP (`SIP_PORT`)            |
| TCP      | 5061        | SIP over TLS                |
| UDP      | 10000-10100 | RTP (`RTP_START`-`RTP_END`) |
| TCP      | 443         | Device endpoint over HTTPS  |

Do not open `22`, `8080`, `8081`, `8088` or `8090`; SSH goes through Tailscale (`ssh root@<tailnet name>`). Docker publishes ports around the host firewall, so rely on this cloud firewall, and bind ARI, the pipeline and `mcp-server` to the tailnet IP as below.

## Stack

The VM has no 1Password, so it keeps its configuration in `.env` (leave `OP_ENVIRONMENT_ID` unset). Clone the repo on the VM, then in `local/`:

```sh
cp .env.example .env
```

Set in `.env`:

```sh
SOFTPHONE_PASSWORD=<long random>
ARI_PASSWORD=<long random>
ARI_BIND_ADDRESS=<tailnet IP>
PIPELINE_BIND_ADDRESS=<tailnet IP>
MCP_BIND_ADDRESS=<tailnet IP>
DEVICE_BIND_ADDRESS=127.0.0.1
COMPOSE_PROFILES=public
PUBLIC_HOSTNAME=phone-claude.willsawyerrrr.dev
LOCAL_NET=127.0.0.0/8
# APNS_* as in local/README.md; copy the .p8 key to ~/.config/phone-claude/apns_key.p8 on
# the VM and chmod 644 it, so the container's non-root `pipeline` user can read the secret
```

Start it with the reserved IP as `HOST_LAN_IP`:

```sh
HOST_LAN_IP=<reserved IP> ./up.sh
```

The override skips `up.sh`'s macOS `route`/`ipconfig` detection, so it works on Linux. Re-run it with the same value to apply `.env` changes. Start Tailscale first so the tailnet IP exists to bind to.

Running this from a script with no login shell (e.g. a cloud-init `user_data` script) leaves `HOME` unset, so Compose resolves the `apns_key` secret's `${HOME}/.config/phone-claude/apns_key.p8` to the wrong path and the `voice-pipeline` container fails to start. Export `HOME=/root` (or the invoking user's home) before calling `up.sh` in that case.

`LOCAL_NET` stays loopback only. On a public host every peer is non-local, so Asterisk gives the phone `HOST_LAN_IP` in SIP and SDP; listing a private range would hand it a container address.

Create the `PUBLIC_HOSTNAME` `A` record before starting; `caddy` obtains its Let's Encrypt certificate on first start (see [`local/README.md`](../local/README.md#public-https-cloud-host)). In the phone app, use TLS mode with host `phone-claude.willsawyerrrr.dev` and SIP port `5061`; the app uploads its token to `https://phone-claude.willsawyerrrr.dev/device`; see [`local/README.md`](../local/README.md#pairing-the-soft-phone).

## Claude Code

`mcp-server` runs on the VM as part of the stack (see [`local/README.md`](../local/README.md)), so Claude Code reaches it over HTTP instead of launching it locally. Register it as a remote MCP server at user scope, alongside (or instead of) the project's local stdio entry in `.mcp.json`:

```sh
claude mcp add --scope user --transport http phone-claude-cloud http://mcp.phone-claude.willsawyerrrr.dev:8090/mcp
```

Use a different name from the project's own `phone-claude` entry if both are ever registered at once.
