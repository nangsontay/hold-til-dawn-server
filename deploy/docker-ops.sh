#!/bin/sh
set -eu
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
cd "$(dirname "$self")/.."
export COMPOSE_PROFILES=${COMPOSE_PROFILES:-production}
if [ "$COMPOSE_PROFILES" = local ]; then
  export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-hold-til-dawn-local}
  export HTD_IMAGE=${HTD_IMAGE:-hold-til-dawn:local} GAME_HOST=${GAME_HOST:-127.0.0.1}
fi
case "${1:-}" in
  on) docker compose exec -T directory sh -c 'umask 077; touch /state/drain' ;;
  off) docker compose exec -T directory rm -f /state/drain ;;
  wait|shutdown)
    remaining=${2:-3600}
    case "$remaining" in ''|*[!0-9]*) exit 2 ;; esac
    while :; do
      if docker compose exec -T directory sh -c 'test -f /state/drain && test ! -e /state/worker-7778.json && test ! -e /state/worker-7779.json && test ! -e /state/worker-7780.json && curl -fsS http://127.0.0.1:2567/health | grep -Fq '"'"'"draining":true'"'"''; then
        if [ "$1" = shutdown ]; then docker compose stop directory; fi
        exit 0
      fi
      [ "$remaining" -gt 0 ] || { echo 'Drain incomplete; keep the service running.' >&2; exit 1; }
      remaining=$((remaining - 1)); sleep 1
    done ;;
  check)
    "$self" wait 0
    docker compose exec -T directory node dist/src/check-directory-compatibility.js
    docker compose exec -T directory sh -c 'kill -USR2 "$(pgrep -f "^node .*dist/src/server.js$")"'
    seen=0
    for attempt in $(seq 1 60); do
      health=$(docker compose exec -T directory curl -fsS http://127.0.0.1:2567/health)
      case "$health" in
        *'"releaseCheck":"running"'*) seen=1 ;;
        *'"releaseCheck":"failed"'*) echo 'Release check failed.' >&2; exit 1 ;;
        *'"releaseCheck":"passed"'*) if [ "$seen" = 1 ]; then echo 'Release check passed; admissions remain drained.'; exit 0; fi ;;
      esac
      sleep 1
    done
    echo 'Release check did not complete; keep admissions drained.' >&2; exit 1 ;;
  *) echo 'Usage: docker-ops.sh on|off|wait [SECONDS]|shutdown [SECONDS]|check' >&2; exit 2 ;;
esac
