#!/bin/sh
# Starts the stack on this machine's current LAN IPv4.
#
# Usage: ./up.sh [--print] [docker compose up args...]
#   --print  print the detected IP and exit.
#
# `HOST_LAN_IP` in the environment overrides detection. Either way it is
# exported, and an exported variable takes precedence over `.env` in Compose.
set -eu

# Prints the IPv4 of the default-route interface, else of `en0`/`en1`. Skips
# tunnel, VPN and Docker interfaces. Prints nothing if none has an address.
detect_lan_ip() {
  iface=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2; exit}')
  for candidate in "$iface" en0 en1; do
    case "$candidate" in
      '' | lo* | utun* | ipsec* | ppp* | gif* | stf* | awdl* | llw* | bridge* | vmenet* | docker* | veth* | br-*) continue ;;
    esac
    ip=$(ipconfig getifaddr "$candidate" 2>/dev/null || true)
    if [ -n "$ip" ]; then
      printf '%s\n' "$ip"
      return 0
    fi
  done
  return 1
}

main() {
  print_only=0
  if [ "${1:-}" = "--print" ]; then
    print_only=1
    shift
  fi

  if [ -z "${HOST_LAN_IP:-}" ]; then
    HOST_LAN_IP=$(detect_lan_ip) || {
      echo "up.sh: no LAN IPv4 found; connect to the network or run HOST_LAN_IP=<ip> $0" >&2
      exit 1
    }
  fi
  export HOST_LAN_IP
  echo "HOST_LAN_IP=$HOST_LAN_IP"

  if [ "$print_only" -eq 1 ]; then
    return 0
  fi
  cd "$(dirname "$0")"
  exec docker compose up -d --build "$@"
}

# Sourcing with `UP_SH_SOURCE_ONLY=1` loads the functions without running.
if [ -z "${UP_SH_SOURCE_ONLY:-}" ]; then
  main "$@"
fi
