# Cloud deploy

Runs the `local/` stack on one Hetzner Cloud VM for one phone. SIP, RTP and the device endpoint are public; ARI (`8088`) and the pipeline API (`8080`) are reachable only over Tailscale, from the Mac running `mcp-server`.

## VM

- Hetzner CAX11 (arm64) or CPX21 (x86), Ubuntu LTS, with a public IPv4.
- CAX11 needs arm64-capable Asterisk and Python images and `onnxruntime`/`faster-whisper` wheels; build the stack once to confirm, else use CPX21.
- Install Docker Engine and the Compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/ubuntu/)).

## Tailscale

Install `tailscaled` on the host, not in Compose:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key=<tagged key> --ssh
tailscale ip -4   # the VM's tailnet IP
```

- Create the auth key in the Tailscale admin console with tag `tag:phone-claude-vps` (add the tag to `tagOwners`).
- Tag the Mac `tag:phone-claude-mac`. ACL granting only the Mac access to the two ports:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:phone-claude-mac"],
      "dst": ["tag:phone-claude-vps:8080,8088"]
    }
  ],
  "ssh": [
    {
      "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["tag:phone-claude-vps"],
      "users": ["root", "autogroup:nonroot"]
    }
  ]
}
```

## Firewall

Hetzner Cloud Firewall, inbound only:

| Protocol | Port        | Purpose                         |
| -------- | ----------- | ------------------------------- |
| UDP, TCP | 5060        | SIP (`SIP_PORT`)                |
| UDP      | 10000-10100 | RTP (`RTP_START`-`RTP_END`)     |
| TCP      | 8081        | Device endpoint (`DEVICE_PORT`) |
| TCP      | 443         | HTTPS                           |

Do not open `22`, `8080` or `8088`; SSH goes through Tailscale (`ssh root@<tailnet name>`). Docker publishes ports around the host firewall, so rely on this cloud firewall, and bind ARI and the pipeline to the tailnet IP as below.

## Stack

Clone the repo on the VM, then in `local/`:

```sh
cp .env.example .env
```

Set in `.env`:

```sh
SOFTPHONE_PASSWORD=<long random>
ARI_PASSWORD=<long random>
ARI_BIND_ADDRESS=<tailnet IP>
PIPELINE_BIND_ADDRESS=<tailnet IP>
LOCAL_NET=127.0.0.0/8
# APNS_* as in local/README.md; copy the .p8 key to the VM and set APNS_KEY_PATH
```

Start it with the VM's public IP as `HOST_LAN_IP`:

```sh
HOST_LAN_IP=<public IP> ./up.sh
```

The override skips `up.sh`'s macOS `route`/`ipconfig` detection, so it works on Linux. Re-run it with the same value to apply `.env` changes. Start Tailscale first so the tailnet IP exists to bind to.

`LOCAL_NET` stays loopback only. On a public host every peer is non-local, so Asterisk gives the phone `HOST_LAN_IP` in SIP and SDP; listing a private range would hand it a container address.

The phone's SIP account and device endpoint use the public IP as server (`SIP_PORT`, `DEVICE_PORT`); see [`local/README.md`](../local/README.md#pairing-the-soft-phone).

## Mac

Point `mcp-server` at the VM's tailnet name:

```sh
export ARI_URL=http://<tailnet name>:8088
export PIPELINE_URL=http://<tailnet name>:8080
export ARI_USERNAME=phone-claude ARI_PASSWORD=<ARI_PASSWORD>
```

`SIP_ENDPOINT` must equal `SOFTPHONE_USERNAME`.
