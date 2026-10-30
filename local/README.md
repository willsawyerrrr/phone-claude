# Voice stack

A Docker Compose stack that rings a SIP soft-phone over cellular, with no
local network involved — it runs on a cloud VM (see
[`../docs/cloud-deploy.md`](../docs/cloud-deploy.md)). Everything
host-specific comes from `.env`, and `HOST_LAN_IP` is the VM's public
(reserved) IP.

Services:

- **`asterisk`** — the PBX. One PJSIP endpoint (the soft-phone, offering G.722 first, then `ulaw,alaw`), ARI on port 8088, and an `ask-by-phone` dialplan context. An ARI-originated call rings the soft-phone; once answered, extension `700` streams the call's audio over AudioSocket (16 kHz `slin16`) to `voice-pipeline:9092`, keyed by the `CALL_ID` channel variable. `CALL_ID` must be a UUID, and is the connection's ID verbatim. SIP is TLS-only on `TLS_PORT` (5061) and calls require SDES SRTP, so the SIP password and audio are encrypted. See [Encrypted calls](#encrypted-calls).
- **`caddy`** — terminates HTTPS for `PUBLIC_HOSTNAME` with an automatic Let's Encrypt certificate and proxies only `PUT /device` to `voice-pipeline:8081`; every other path is `404`.
- **`voice-pipeline`** — speaks the question and captures the spoken reply, using local VAD, speech-to-text, and text-to-speech models. Its HTTP API (`:8080`, on `PIPELINE_BIND_ADDRESS`, loopback by default) is what `mcp-server` registers prompts with and polls; AudioSocket (`:9092`) is reachable only inside the Docker network. See [`voice-pipeline/README.md`](voice-pipeline/README.md).
- **`mcp-server`** — the MCP server itself, over Streamable HTTP (`:80`, on `MCP_BIND_ADDRESS`, loopback by default), that Claude Code connects to remotely over Tailscale. Reaches `asterisk`/`voice-pipeline` by their Compose service names. See [`../docs/cloud-deploy.md`](../docs/cloud-deploy.md).

The AudioSocket connection is made only once the phone answers.

## Setup

```sh
cp .env.example .env   # fill in SOFTPHONE_PASSWORD, ARI_PASSWORD, PUBLIC_HOSTNAME, ...
HOST_LAN_IP=<reserved IP> ./up.sh   # the first build downloads the speech models (~2.8 GB image)
docker compose ps                  # asterisk and voice-pipeline should report "healthy"
```

`HOST_LAN_IP` must be set — it's the VM's public address as the phone reaches it; Asterisk advertises it in SIP and SDP, so the phone sends signalling and RTP back to the published ports on this host. `up.sh` just runs `docker compose up -d --build`; re-run it after `.env` or `HOST_LAN_IP` changes (Compose recreates the containers whose configuration changed).

The variables are listed in `.env.example`; only `SOFTPHONE_PASSWORD`, `ARI_PASSWORD` and `PUBLIC_HOSTNAME` are required, and the rest default as documented there.

Published ports: SIP `TLS_PORT` (TCP, TLS), RTP `RTP_START`–`RTP_END` (UDP, 1:1), the device endpoint over HTTPS (443), ARI `ARI_PORT` on `ARI_BIND_ADDRESS`, the pipeline API `PIPELINE_PORT` on `PIPELINE_BIND_ADDRESS`, and `mcp-server`'s `MCP_PORT` on `MCP_BIND_ADDRESS` (all three loopback by default — see [`../docs/cloud-deploy.md`](../docs/cloud-deploy.md) for reaching them over Tailscale instead).

`LOCAL_NET` lists the networks Asterisk treats as local (loopback by default — see [`../docs/cloud-deploy.md`](../docs/cloud-deploy.md) for why).

## Encrypted calls

`asterisk` serves SIP over TLS (TLS 1.2 or newer) on `TLS_PORT` (default 5061, TCP) with Caddy's certificate for `PUBLIC_HOSTNAME`, and its endpoint requires SDES SRTP (`media_encryption=sdes`); a client offering plain RTP is refused.

`asterisk` mounts `caddy-data` read-only and waits at start until the certificate exists. Caddy writes the key as `root` with mode `0600`, so the entrypoint copies the certificate and key into `/etc/asterisk/keys`, owned by `asterisk`. It checks the certificate hourly (`CERT_CHECK_INTERVAL_S`) and, when Caddy renews it, stops Asterisk so the container's restart policy starts it with the new one; an active call ends. Open `TLS_PORT` (TCP) alongside the RTP range.

Check the transport and the handshake with:

```sh
docker compose exec asterisk asterisk -rx 'pjsip show transports'
openssl s_client -connect "$PUBLIC_HOSTNAME:5061" -servername "$PUBLIC_HOSTNAME"
```

`./test-render-config.sh` tests the Asterisk config rendering.

Caddy keeps its data in the `caddy-data` volume (`phone-claude-local_caddy-data` on the host), mounted at `/data`. The certificate and key are at `caddy/certificates/acme-v02.api.letsencrypt.org-directory/<PUBLIC_HOSTNAME>/<PUBLIC_HOSTNAME>.crt` and `.key` within it; mount the volume read-only to share them with another service.

## Pairing the soft-phone

Install a SIP app on the phone (Groundwire, Linphone, Zoiper, or the [`ios/`](../ios/README.md) app) and add an account:

- **Username / auth username:** `SOFTPHONE_USERNAME` (default `phone`)
- **Password:** `SOFTPHONE_PASSWORD`
- **Domain / server:** `PUBLIC_HOSTNAME`, port `TLS_PORT` (5061)
- **Transport:** TLS, with SDES SRTP

`mcp-server`'s `SIP_ENDPOINT` must equal `SOFTPHONE_USERNAME`, and its `ARI_USERNAME`/`ARI_PASSWORD` the stack's.

Confirm registration with:

```sh
docker compose exec asterisk asterisk -rx 'pjsip show contacts'
```

The contact should be `Avail`. The `ios/` app unregisters when backgrounded, so the contact is `Unavail` or absent until a VoIP push wakes it. For a third-party app, a locked or backgrounded phone only rings if the app has working push notifications; test that on the actual phone before relying on it.

## Ringing a locked phone

`mcp-server` pushes only when ARI reports the endpoint offline. The push wakes the `ios/` app, which re-registers over cellular and answers the INVITE once the user accepts in the native call UI.

- **Token delivery.** The app `PUT`s its PushKit token to `https://PUBLIC_HOSTNAME/device` (via `caddy`) with `Authorization: Bearer <SOFTPHONE_PASSWORD>`. The pipeline already runs as a long-lived cloud service with a volume, so the token endpoint and the sender live there rather than in the per-session `mcp-server`, and the key stays out of Claude Code's config. The token is kept in the `pipeline-data` volume and survives restarts.
- **Sender.** `POST /push` on the pipeline (loopback) sends an APNs HTTP/2 VoIP push (topic `APNS_TOPIC`, priority 10, 30 s expiry) with token-based auth. It returns `404` with no registered device, `503` if APNs is not configured, and `502` if APNs rejects it; a rejected token is forgotten.
- **Registration.** The app un-registers (`Expires: 0`) before it stops in the background, so the endpoint goes offline at once. The endpoint's AOR expires registrations in 120 s by default (30–300 s) and qualifies every 5 s with a 2 s timeout, so a contact that vanishes without un-registering (a crash, a lost network) goes unavailable within about 7 s and the next `ask_by_phone` pushes instead of dialling a dead contact. The qualify `OPTIONS` is one small packet per 5 s to a single contact, which a live phone answers well within 2 s.

Set `APNS_KEY_ID` and `APNS_TEAM_ID`, and save the `.p8` key at `~/.config/phone-claude/apns_key.p8` (see [`../ios/README.md`](../ios/README.md#apple-setup)). The key is mounted read-only into the container as the `pipeline` user, so it must be readable by others (`chmod 644`). Never commit it.

## Auditioning voices

The image carries two text-to-speech voices (see [`voice-pipeline/README.md`](voice-pipeline/README.md#voices)); `TTS_VOICE` chooses the one that speaks on calls (`alba-casual` by default).

```sh
./audition.sh render                  # WAVs in ./audition/, and each voice's real-time factor
./audition.sh call                    # rings the phone; plays every voice blind, then prints the mapping
./audition.sh call --prompts all --voices alba-casual,alba-announcer
```

`call` needs the stack up and `pnpm install` run at the repo root. Say "repeat" to hear it all again; any other reply ends the call and is printed with the mapping from "Voice one", "Voice two", … to voices.

## Placing a test call

```sh
curl -u "$ARI_USERNAME:$ARI_PASSWORD" -X POST \
  "http://127.0.0.1:8088/ari/channels?endpoint=PJSIP/phone&extension=700&context=ask-by-phone&priority=1&timeout=30" \
  -H 'Content-Type: application/json' \
  -d "{\"variables\":{\"CALL_ID\":\"$(uuidgen)\"}}"
```

Hang up with `DELETE /ari/channels/<id>`.
