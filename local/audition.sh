#!/bin/sh
# Compares text-to-speech voices on the same prompts.
#
# Usage:
#   ./audition.sh render [engine:voice ...]   write 16 kHz WAVs to ./audition/
#                                             and print each voice's real-time factor
#   ./audition.sh call [--prompts a,b|all] [--voices engine:voice,...] [--no-shuffle]
#                                             ring the phone and play the voices
#                                             blind, then print which was which
#
# `call` needs the stack up (`./up.sh`) and `pnpm install` run at the repo root.
set -eu
cd "$(dirname "$0")"

case "${1:-}" in
  render)
    shift
    mkdir -p audition
    HOST_LAN_IP="${HOST_LAN_IP:-127.0.0.1}" exec docker compose run --rm --no-deps \
      -v "$PWD/audition:/out" voice-pipeline python -m voice_pipeline.audition /out "$@"
    ;;
  call)
    shift
    set -a
    # shellcheck source=/dev/null
    . ./.env
    set +a
    exec pnpm --dir ../mcp-server audition "$@"
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
