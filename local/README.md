# Local voice stack

A Docker Compose stack that rings a SIP soft-phone on the local network, with no carrier involved. It runs on any machine with Docker; everything host-specific comes from `.env`.

Services:

- **`asterisk`** — the PBX. One PJSIP endpoint (the soft-phone), ARI on port 8088, and an `ask-by-phone` dialplan context. An ARI-originated call rings the soft-phone; once answered, extension `700` streams the call's audio over AudioSocket to `voice-pipeline:9092`, keyed by the `CALL_ID` channel variable. `CALL_ID` must be a UUID, and is the connection's ID verbatim.
- **`voice-pipeline`** — speaks the question and captures the spoken reply, using local VAD, speech-to-text, and text-to-speech models. Its HTTP API (`:8080`, loopback only) is what `mcp-server` registers prompts with and polls; AudioSocket (`:9092`) is reachable only inside the Docker network. See [`voice-pipeline/README.md`](voice-pipeline/README.md).

The AudioSocket connection is made only once the phone answers.

## Setup

```sh
cp .env.example .env   # set HOST_LAN_IP, SOFTPHONE_PASSWORD, ARI_PASSWORD
docker compose up -d --build   # the first build downloads the speech models (~1.2 GB image)
docker compose ps      # asterisk and voice-pipeline should report "healthy"
```

`HOST_LAN_IP` is this machine's LAN address as the phone reaches it (`ipconfig getifaddr en0` on macOS, `hostname -I` on Linux). Asterisk advertises it in SIP and SDP, so the phone sends signalling and RTP back to the published ports on this machine.

Published ports: SIP `SIP_PORT` (UDP and TCP), RTP `RTP_START`–`RTP_END` (UDP, 1:1), and ARI `ARI_PORT` on `ARI_BIND_ADDRESS` (loopback by default). Open the SIP and RTP ports to the LAN if a host firewall is on.

`LOCAL_NET` lists the networks Asterisk treats as local (loopback by default). Docker presents LAN peers from a gateway address in a private Docker range (`192.168.65.1` or a `172.x` address on Docker Desktop for macOS), so no private range may be listed, or the phone is given the container's internal address in SIP. The soft-phone endpoint's `media_address` is `HOST_LAN_IP`, so SDP always advertises the host for RTP.

## Pairing the soft-phone

Install a SIP app on the phone (Groundwire, Linphone, Zoiper, or the [`ios/`](../ios/README.md) app) and add an account:

- **Username / auth username:** `SOFTPHONE_USERNAME` (default `phone`)
- **Password:** `SOFTPHONE_PASSWORD`
- **Domain / server:** `HOST_LAN_IP`, port `SIP_PORT`
- **Transport:** UDP (TCP also works)

`mcp-server`'s `SIP_ENDPOINT` must equal `SOFTPHONE_USERNAME`, and its `ARI_USERNAME`/`ARI_PASSWORD` the stack's.

Confirm registration with:

```sh
docker compose exec asterisk asterisk -rx 'pjsip show contacts'
```

The contact should be `Avail`. The `ios/` app unregisters when backgrounded, so the contact is `Unavail` or absent until a VoIP push wakes it. For a third-party app, a locked or backgrounded phone only rings if the app has working push notifications; test that on the actual phone before relying on it.

## Ringing a locked phone

`mcp-server` pushes only when ARI reports the endpoint offline. The push wakes the `ios/` app, which re-registers over the LAN (Asterisk stays LAN-only) and answers the INVITE once the user accepts in the native call UI.

- **Token delivery.** The app `PUT`s its PushKit token to `http://HOST_LAN_IP:DEVICE_PORT/device` with `Authorization: Bearer <SOFTPHONE_PASSWORD>`. The pipeline already runs as a long-lived LAN service with a volume, so the token endpoint and the sender live there rather than in the per-session `mcp-server`, and the key stays out of Claude Code's config. The token is kept in the `pipeline-data` volume and survives restarts.
- **Sender.** `POST /push` on the pipeline (loopback) sends an APNs HTTP/2 VoIP push (topic `APNS_TOPIC`, priority 10, 30 s expiry) with token-based auth. It returns `404` with no registered device, `503` if APNs is not configured, and `502` if APNs rejects it; a rejected token is forgotten.
- **Registration.** The endpoint's AOR expires registrations in 120 s by default (30–300 s) and qualifies every 15 s, so a phone that stopped refreshing shows offline within a couple of minutes.

Set `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_KEY_PATH` (host path to the `.p8` key, see [`../ios/README.md`](../ios/README.md#apple-setup)). The key is mounted read-only into the container as the `pipeline` user, so it must be readable by others (`chmod 644`). Never commit it.

## Placing a test call

```sh
curl -u "$ARI_USERNAME:$ARI_PASSWORD" -X POST \
  "http://127.0.0.1:8088/ari/channels?endpoint=PJSIP/phone&extension=700&context=ask-by-phone&priority=1&timeout=30" \
  -H 'Content-Type: application/json' \
  -d "{\"variables\":{\"CALL_ID\":\"$(uuidgen)\"}}"
```

Hang up with `DELETE /ari/channels/<id>`.
