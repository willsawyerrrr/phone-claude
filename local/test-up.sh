#!/bin/sh
# Tests `up.sh` IP detection with stubbed `route` and `ipconfig`.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -r "$tmp"' EXIT
fail=0

# Stubs: `route` reports $STUB_IFACE; `ipconfig getifaddr <if>` reads $STUB_<if>.
cat >"$tmp/route" <<'STUB'
#!/bin/sh
[ -n "${STUB_IFACE:-}" ] && echo "   interface: $STUB_IFACE"
exit 0
STUB
cat >"$tmp/ipconfig" <<'STUB'
#!/bin/sh
eval "ip=\${STUB_$2:-}"
[ -n "$ip" ] && echo "$ip" && exit 0
exit 1
STUB
chmod +x "$tmp/route" "$tmp/ipconfig"

# check <name> <expected stdout> <expected exit> [VAR=value ...]
check() {
  name=$1 want=$2 code=$3
  shift 3
  set +e
  got=$(env -i PATH="$tmp:/usr/bin:/bin" "$@" "$here/up.sh" --print 2>/dev/null)
  rc=$?
  set -e
  if [ "$got" != "$want" ] || [ "$rc" -ne "$code" ]; then
    echo "FAIL $name: got '$got' (exit $rc), want '$want' (exit $code)"
    fail=1
  else
    echo "ok   $name"
  fi
}

check default-route "HOST_LAN_IP=10.0.0.5" 0 STUB_IFACE=en5 STUB_en5=10.0.0.5 STUB_en0=192.168.1.2
check fallback-en0 "HOST_LAN_IP=192.168.1.2" 0 STUB_en0=192.168.1.2
check fallback-en1 "HOST_LAN_IP=192.168.1.3" 0 STUB_en1=192.168.1.3
check skips-vpn-default "HOST_LAN_IP=192.168.1.2" 0 STUB_IFACE=utun4 STUB_utun4=100.64.0.1 STUB_en0=192.168.1.2
check skips-docker-default "HOST_LAN_IP=192.168.1.2" 0 STUB_IFACE=bridge100 STUB_bridge100=192.168.64.1 STUB_en0=192.168.1.2
check override "HOST_LAN_IP=1.2.3.4" 0 HOST_LAN_IP=1.2.3.4 STUB_en0=192.168.1.2
check none-found "" 1 STUB_IFACE=utun4 STUB_utun4=100.64.0.1

exit "$fail"
