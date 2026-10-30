#!/bin/sh
# Starts the stack. HOST_LAN_IP must already be set to the public IP of this
# host (see docs/cloud-deploy.md); an exported value takes precedence over .env.
set -eu

: "${HOST_LAN_IP:?Set HOST_LAN_IP to the public IP of this host}"
cd "$(dirname "$0")"
exec docker compose up -d --build "$@"
