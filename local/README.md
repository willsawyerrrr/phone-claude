# Local voice stack

A Docker Compose stack that rings a SIP soft-phone on the local network, with no carrier involved. It runs on any machine with Docker; everything host-specific comes from `.env` or, for `HOST_LAN_IP`, `up.sh`.

Services:

- **`asterisk`** — the PBX. One PJSIP endpoint (the soft-phone, offering G.722 first, then `ulaw,alaw`), ARI on port 8088, and an `ask-by-phone` dialplan context. An ARI-originated call rings the soft-phone; once answered, extension `700` streams the call's audio over AudioSocket (16 kHz `slin16`) to `voice-pipeline:9092`, keyed by the `CALL_ID` channel variable. `CALL_ID` must be a UUID, and is the connection's ID verbatim.
- **`voice-pipeline`** — speaks the question and captures the spoken reply, using local VAD, speech-to-text, and text-to-speech models. Its HTTP API (`:8080`, loopback only) is what `mcp-server` registers prompts with and polls; AudioSocket (`:9092`) is reachable only inside the Docker network. See [`voice-pipeline/README.md`](voice-pipeline/README.md).

The AudioSocket connection is made only once the phone answers.

## Setup

```sh
cp .env.example .env   # set SOFTPHONE_PASSWORD, ARI_PASSWORD
./up.sh                # the first build downloads the speech models (~2.8 GB image)
docker compose ps      # asterisk and voice-pipeline should report "healthy"
```

`up.sh` detects this machine's current LAN IPv4 (the default-route interface, else `en0`/`en1`; never a tunnel, VPN or Docker interface), prints it, exports it as `HOST_LAN_IP`, and runs `docker compose up -d --build "$@"`. Re-run it after the IP changes: Compose recreates the containers whose configuration changed. `./up.sh --print` only prints the IP. `HOST_LAN_IP=<ip> ./up.sh` overrides detection; it fails if no IP is found.

`HOST_LAN_IP` is this machine's LAN address as the phone reaches it. Asterisk advertises it in SIP and SDP, so the phone sends signalling and RTP back to the published ports on this machine, and the device-registration port (`DEVICE_PORT`) is published on it. An exported `HOST_LAN_IP` takes precedence over `.env`, so leave it out of `.env`; a bare `docker compose` command reads only `.env` and fails without it.

`./test-up.sh` tests the detection against stubbed `route` and `ipconfig`.

Published ports: SIP `SIP_PORT` (UDP and TCP), RTP `RTP_START`–`RTP_END` (UDP, 1:1), and ARI `ARI_PORT` on `ARI_BIND_ADDRESS` (loopback by default). Open the SIP and RTP ports to the LAN if a host firewall is on.

`LOCAL_NET` lists the networks Asterisk treats as local (loopback by default). Docker presents LAN peers from a gateway address in a private Docker range (`192.168.65.1` or a `172.x` address on Docker Desktop for macOS), so no private range may be listed, or the phone is given the container's internal address in SIP. The soft-phone endpoint's `media_address` is `HOST_LAN_IP`, so SDP always advertises the host for RTP.

## Pairing the soft-phone

Install a SIP app on the phone (Groundwire, Linphone, Zoiper, or the [`ios/`](../ios/README.md) app) and add an account:

- **Username / auth username:** `SOFTPHONE_USERNAME` (default `phone`)
- **Password:** `SOFTPHONE_PASSWORD`
- **Domain / server:** the IP `up.sh` prints (`HOST_LAN_IP`), port `SIP_PORT`
- **Transport:** UDP (TCP also works)

`mcp-server`'s `SIP_ENDPOINT` must equal `SOFTPHONE_USERNAME`, and its `ARI_USERNAME`/`ARI_PASSWORD` the stack's.

Confirm registration with:

```sh
docker compose exec asterisk asterisk -rx 'pjsip show contacts'
```

The contact should be `Avail`. The `ios/` app unregisters when backgrounded, so the contact is `Unavail` or absent until a VoIP push wakes it. For a third-party app, a locked or backgrounded phone only rings if the app has working push notifications; test that on the actual phone before relying on it.

### Surviving IP changes

The Mac's Bonjour name (`scutil --get LocalHostName`, resolved as `<LocalHostName>.local`) does not change with DHCP, so it can be entered in the app's host field instead of the IP. Not verified: that the app's SIP registration and token upload resolve a `.local` name. Whatever the app uses, `./up.sh` must still be re-run after an IP change, because Asterisk advertises and Docker binds the IP.

## Ringing a locked phone

`mcp-server` pushes only when ARI reports the endpoint offline. The push wakes the `ios/` app, which re-registers over the LAN (Asterisk stays LAN-only) and answers the INVITE once the user accepts in the native call UI.

- **Token delivery.** The app `PUT`s its PushKit token to `http://HOST_LAN_IP:DEVICE_PORT/device` with `Authorization: Bearer <SOFTPHONE_PASSWORD>`. The pipeline already runs as a long-lived LAN service with a volume, so the token endpoint and the sender live there rather than in the per-session `mcp-server`, and the key stays out of Claude Code's config. The token is kept in the `pipeline-data` volume and survives restarts.
- **Sender.** `POST /push` on the pipeline (loopback) sends an APNs HTTP/2 VoIP push (topic `APNS_TOPIC`, priority 10, 30 s expiry) with token-based auth. It returns `404` with no registered device, `503` if APNs is not configured, and `502` if APNs rejects it; a rejected token is forgotten.
- **Registration.** The app un-registers (`Expires: 0`) before it stops in the background, so the endpoint goes offline at once. The endpoint's AOR expires registrations in 120 s by default (30–300 s) and qualifies every 5 s with a 2 s timeout, so a contact that vanishes without un-registering (a crash, a lost network) goes unavailable within about 7 s and the next `ask_by_phone` pushes instead of dialling a dead contact. The qualify `OPTIONS` is one small packet per 5 s to a single contact, which a live phone answers well within 2 s.

Set `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_KEY_PATH` (host path to the `.p8` key, see [`../ios/README.md`](../ios/README.md#apple-setup)). The key is mounted read-only into the container as the `pipeline` user, so it must be readable by others (`chmod 644`). Never commit it.

## Auditioning voices

The image carries several text-to-speech voices (see [`voice-pipeline/README.md`](voice-pipeline/README.md#voices)); `TTS_ENGINE` and `TTS_VOICE` in `.env` choose the one that speaks on calls.

```sh
./audition.sh render                  # WAVs in ./audition/, and each voice's real-time factor
./audition.sh call                    # rings the phone; plays every candidate blind, then prints the mapping
./audition.sh call --prompts all --voices kokoro:af_heart,kokoro:am_michael,pocket:alba-casual
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
