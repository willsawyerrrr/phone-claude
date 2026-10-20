#!/bin/bash
# Tests asterisk/render-config.sh in LAN mode and with PUBLIC_HOSTNAME set.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -r "$work"' EXIT

export TEMPLATES_DIR=$here/asterisk/templates
export HOST_LAN_IP=203.0.113.7 SIP_PORT=5060 RTP_START=10000 RTP_END=10100
export LOCAL_NET=127.0.0.0/8 SOFTPHONE_USERNAME=phone SOFTPHONE_PASSWORD=pw
export ARI_USERNAME=ari ARI_PASSWORD=pw

fail() { echo "FAIL: $*" >&2; exit 1; }
render() { # dir [env...]
  local dir=$1; shift
  mkdir "$dir"
  env CONFIG_DIR="$dir" "$@" "$here/asterisk/render-config.sh"
}

render "$work/lan"
grep -q 'protocol=udp' "$work/lan/pjsip_transports.conf" || fail "LAN has no UDP transport"
grep -q 'protocol=tcp' "$work/lan/pjsip_transports.conf" || fail "LAN has no TCP transport"
! grep -q 'protocol=tls' "$work/lan/pjsip_transports.conf" || fail "LAN has a TLS transport"
! grep -q media_encryption "$work/lan/pjsip.conf" || fail "LAN requires SRTP"

render "$work/tls" PUBLIC_HOSTNAME=phone.example.com TLS_PORT=5099
t=$work/tls/pjsip_transports.conf
grep -q 'protocol=tls' "$t" || fail "no TLS transport"
grep -q 'bind=0.0.0.0:5061' "$t" || fail "TLS transport not on 5061"
grep -q 'external_signaling_port=5099' "$t" || fail "TLS external port"
grep -q "cert_file=$work/tls/keys/cert.pem" "$t" || fail "cert_file"
! grep -q 'protocol=udp\|protocol=tcp' "$t" || fail "plain transport in TLS mode"
grep -q '^media_encryption=sdes$' "$work/tls/pjsip.conf" || fail "SRTP not required"

echo "ok"
