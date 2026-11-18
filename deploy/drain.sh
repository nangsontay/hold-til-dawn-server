#!/bin/sh
set -eu

state=${WORKER_STATE_DIR:-/var/lib/hold-til-dawn/workers}
health=http://127.0.0.1:${LOBBY_PORT:-2567}/health
test -d "$state"
case "${1:-}" in
    on) (umask 077; touch "$state/drain") ;;
    off) rm -f "$state/drain" ;;
    wait|shutdown)
        remaining=${2:-3600}
        case "$remaining" in ''|*[!0-9]*) exit 2 ;; esac
        while [ -f "$state/drain" ]; do
            if curl -fsS --max-time 2 "$health" | grep -Fq '"draining":true' &&
                [ ! -e "$state/worker-7778.json" ] && [ ! -e "$state/worker-7779.json" ] &&
                [ ! -e "$state/worker-7780.json" ]; then
                if [ "$1" = shutdown ]; then
                    systemctl stop hold-til-dawn-multiplayer.service
                fi
                exit 0
            fi
            [ "$remaining" -gt 0 ] || break
            remaining=$((remaining - 1))
            sleep 1
        done
        echo 'Drain is incomplete. Keep the current service running.' >&2
        exit 1
        ;;
    *) echo 'Usage: drain.sh on|off|wait [SECONDS]|shutdown [SECONDS]' >&2; exit 2 ;;
esac
