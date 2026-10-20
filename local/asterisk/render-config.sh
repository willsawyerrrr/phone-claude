#!/bin/bash
# Renders the config templates into the config directory from the environment.
# With `PUBLIC_HOSTNAME` set, SIP is TLS-only with mandatory SDES SRTP; without
# it, SIP is plain UDP/TCP with plain RTP.
set -euo pipefail

TEMPLATES_DIR=${TEMPLATES_DIR:-/opt/asterisk-templates}
CONFIG_DIR=${CONFIG_DIR:-/etc/asterisk}
TLS_DIR=${TLS_DIR:-$CONFIG_DIR/keys}
export TLS_DIR
TLS_PORT=${TLS_PORT:-5061}
export TLS_PORT

for var in HOST_LAN_IP SIP_PORT RTP_START RTP_END LOCAL_NET \
  SOFTPHONE_USERNAME SOFTPHONE_PASSWORD ARI_USERNAME ARI_PASSWORD; do
  [ -n "${!var:-}" ] || { echo "$var is required" >&2; exit 1; }
done

# `;` starts a comment in Asterisk config and a newline ends the value, so either would truncate the password.
for var in SOFTPHONE_PASSWORD ARI_PASSWORD; do
  case "${!var}" in
    *\;* | *$'\n'* | *$'\r'*)
      echo "$var must not contain ';' or newlines" >&2
      exit 1
      ;;
  esac
done

LOCAL_NET_LINES=""
for net in $LOCAL_NET; do
  LOCAL_NET_LINES+="local_net=${net}"$'\n'
done
export LOCAL_NET_LINES

if [ -n "${PUBLIC_HOSTNAME:-}" ]; then
  transports=tls
  MEDIA_ENCRYPTION_LINE="media_encryption=sdes"
else
  transports=lan
  MEDIA_ENCRYPTION_LINE=""
fi
export MEDIA_ENCRYPTION_LINE

# Only these are substituted, so dialplan variables like `${CALL_ID}` survive.
vars='${HOST_LAN_IP} ${SIP_PORT} ${RTP_START} ${RTP_END} ${LOCAL_NET_LINES}
${SOFTPHONE_USERNAME} ${SOFTPHONE_PASSWORD} ${ARI_USERNAME} ${ARI_PASSWORD}
${TLS_DIR} ${TLS_PORT} ${MEDIA_ENCRYPTION_LINE}'

for template in "$TEMPLATES_DIR"/*.conf; do
  envsubst "$vars" <"$template" >"$CONFIG_DIR/$(basename "$template")"
done
envsubst "$vars" <"$TEMPLATES_DIR/transports/$transports.conf" >"$CONFIG_DIR/pjsip_transports.conf"
