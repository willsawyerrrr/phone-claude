#!/bin/bash
# Renders /opt/asterisk-templates into /etc/asterisk from the environment, then
# hands off to the base image's entrypoint.
set -euo pipefail

for var in HOST_LAN_IP SIP_PORT RTP_START RTP_END LOCAL_NET \
  SOFTPHONE_USERNAME SOFTPHONE_PASSWORD ARI_USERNAME ARI_PASSWORD; do
  [ -n "${!var:-}" ] || { echo "$var is required" >&2; exit 1; }
done

LOCAL_NET_LINES=""
for net in $LOCAL_NET; do
  LOCAL_NET_LINES+="local_net=${net}"$'\n'
done
export LOCAL_NET_LINES

# Only these are substituted, so dialplan variables like `${CALL_ID}` survive.
vars='${HOST_LAN_IP} ${SIP_PORT} ${RTP_START} ${RTP_END} ${LOCAL_NET_LINES}
${SOFTPHONE_USERNAME} ${SOFTPHONE_PASSWORD} ${ARI_USERNAME} ${ARI_PASSWORD}'

for template in /opt/asterisk-templates/*.conf; do
  envsubst "$vars" <"$template" >"/etc/asterisk/$(basename "$template")"
done

exec /usr/local/bin/entrypoint.sh "$@"
