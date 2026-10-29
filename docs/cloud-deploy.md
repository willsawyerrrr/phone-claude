# Cloud deploy

Runs the `local/` stack on one cloud VM for one phone, using DigitalOcean in Sydney (`syd1`) as the example. SIP (TLS), RTP and the HTTPS device endpoint are public; ARI (`8088`) and the pipeline API (`8080`) are reachable only over Tailscale, from the Mac running `mcp-server`.

## VM

- x86 Ubuntu LTS droplet in `syd1`, 4 GB RAM minimum (Whisper `base.en`, Piper and Asterisk), e.g. `s-2vcpu-4gb`.
- Assign a reserved IP to the droplet; it is the stable public address (`HOST_LAN_IP`).
- Point an `A` record for `phone-claude.willsawyerrrr.dev` at the reserved IP.
- Install Docker Engine and the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/ubuntu/)).

## Tailscale

Install `tailscaled` on the host, not in Compose:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key=<tagged key> --ssh
tailscale ip -4   # the VM's tailnet IP
```

- Create the auth key in the Tailscale admin console with tag `tag:phone-claude-vps` (add the tag to `tagOwners`).
- The tailnet is `tail8e5593.ts.net`. ACL granting only the Mac user access to the two ports:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["wmsawyer2609@gmail.com"],
      "dst": ["tag:phone-claude-vps:8080,8088"]
    }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["tag:phone-claude-vps"],
      "users": ["root", "autogroup:nonroot"]
    },
    {
      "action": "accept",
      "src": ["tag:ci"],
      "dst": ["tag:phone-claude-vps"],
      "users": ["root"]
    }
  ]
}
```

`tag:ci` is the tag `.github/workflows/deploy-vps.yml` advertises when it joins the tailnet via a Tailscale OAuth client scoped to `auth_keys` and that tag; add the tag to `tagOwners` alongside `tag:phone-claude-vps`. Store the client's ID and secret as `TAILSCALE_OAUTH_CLIENT_ID`/`TAILSCALE_OAUTH_CLIENT_SECRET` in the Phone Claude 1Password Environment.

## Firewall

DigitalOcean Cloud Firewall attached to the droplet, inbound only:

| Protocol | Port        | Purpose                     |
| -------- | ----------- | --------------------------- |
| UDP, TCP | 5060        | SIP (`SIP_PORT`)            |
| TCP      | 5061        | SIP over TLS                |
| UDP      | 10000-10100 | RTP (`RTP_START`-`RTP_END`) |
| TCP      | 443         | Device endpoint over HTTPS  |

Do not open `22`, `8080`, `8081` or `8088`; SSH goes through Tailscale (`ssh root@<tailnet name>`). Docker publishes ports around the host firewall, so rely on this cloud firewall, and bind ARI and the pipeline to the tailnet IP as below.

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
DEVICE_BIND_ADDRESS=127.0.0.1
COMPOSE_PROFILES=public
PUBLIC_HOSTNAME=phone-claude.willsawyerrrr.dev
LOCAL_NET=127.0.0.0/8
# APNS_* as in local/README.md; copy the .p8 key to ~/.config/phone-claude/apns_key.p8 on the VM
```

Start it with the reserved IP as `HOST_LAN_IP`:

```sh
HOST_LAN_IP=<reserved IP> ./up.sh
```

The override skips `up.sh`'s macOS `route`/`ipconfig` detection, so it works on Linux. Re-run it with the same value to apply `.env` changes. Start Tailscale first so the tailnet IP exists to bind to.

Running this from a script with no login shell (e.g. a cloud-init `user_data` script) leaves `HOME` unset, so Compose resolves the `apns_key` secret's `${HOME}/.config/phone-claude/apns_key.p8` to the wrong path and the `voice-pipeline` container fails to start. Export `HOME=/root` (or the invoking user's home) before calling `up.sh` in that case.

`LOCAL_NET` stays loopback only. On a public host every peer is non-local, so Asterisk gives the phone `HOST_LAN_IP` in SIP and SDP; listing a private range would hand it a container address.

Create the `PUBLIC_HOSTNAME` `A` record before starting; `caddy` obtains its Let's Encrypt certificate on first start (see [`local/README.md`](../local/README.md#public-https-cloud-host)). In the phone app, use TLS mode with host `phone-claude.willsawyerrrr.dev` and SIP port `5061`; the app uploads its token to `https://phone-claude.willsawyerrrr.dev/device`; see [`local/README.md`](../local/README.md#pairing-the-soft-phone).

## Mac

Point `mcp-server` at the VM's tailnet name:

```sh
export ARI_URL=http://<tailnet name>:8088
export PIPELINE_URL=http://<tailnet name>:8080
export ARI_USERNAME=phone-claude ARI_PASSWORD=<ARI_PASSWORD>
```

`SIP_ENDPOINT` must equal `SOFTPHONE_USERNAME`.
