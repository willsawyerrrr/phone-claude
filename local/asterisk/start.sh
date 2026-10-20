#!/bin/bash
# Starts Asterisk. With `PUBLIC_HOSTNAME` set, first waits for Caddy to issue
# that host's certificate, installs a copy Asterisk can read, and stops Asterisk
# when the certificate is renewed so the container's restart policy reloads it.
set -euo pipefail

if [ -n "${PUBLIC_HOSTNAME:-}" ]; then
  CERT_DIR=${CERT_DIR:-/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$PUBLIC_HOSTNAME}
  CONFIG_DIR=${CONFIG_DIR:-/etc/asterisk}
  export TLS_DIR=${TLS_DIR:-$CONFIG_DIR/keys}
  cert=$CERT_DIR/$PUBLIC_HOSTNAME.crt
  key=$CERT_DIR/$PUBLIC_HOSTNAME.key

  until [ -s "$cert" ] && [ -s "$key" ]; do
    echo "Waiting for the certificate for $PUBLIC_HOSTNAME in $CERT_DIR" >&2
    sleep 5
  done

  # Caddy writes the key as root with mode 0600; Asterisk runs as `asterisk`.
  install -d -m 700 -o asterisk -g asterisk "$TLS_DIR"
  install -m 600 -o asterisk -g asterisk "$cert" "$TLS_DIR/cert.pem"
  install -m 600 -o asterisk -g asterisk "$key" "$TLS_DIR/key.pem"

  (
    fingerprint=$(sha256sum <"$cert")
    while sleep "${CERT_CHECK_INTERVAL_S:-3600}"; do
      [ "$(sha256sum <"$cert" 2>/dev/null)" = "$fingerprint" ] && continue
      echo "Certificate renewed; stopping Asterisk to load it" >&2
      asterisk -rx 'core stop when convenient' || true
    done
  ) &
fi

/usr/local/bin/render-config.sh
exec /usr/local/bin/entrypoint.sh "$@"
