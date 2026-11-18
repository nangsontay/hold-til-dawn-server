#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
    echo 'Usage: activate-release.sh RELEASE_ID' >&2
    exit 2
fi
printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'
target=/opt/hold-til-dawn-releases/$1
active=/opt/hold-til-dawn
grep -qx 'package=linux-x86_64' "$target/RELEASE"
(cd "$target" && awk 'length($1) == 64 && $1 ~ /^[a-f0-9]+$/ { print }' RELEASE | shasum -a 256 -c -)
grep -qx 'node=v26.13.0' "$target/RELEASE"
grep -qx 'godot=4.7.2.stable.official.ed1daf0bf' "$target/RELEASE"
[ "$(timeout 5s runuser -u htd -- "$target/node/bin/node" --version)" = 'v26.13.0' ]
[ "$(timeout 5s runuser -u htd -- "$target/game/Hold-til-Dawn-Server.x86_64" --headless --version)" = \
    '4.7.2.stable.official.ed1daf0bf' ]
lock=$(mktemp -d /opt/.htd-release.XXXXXX)
restoring=false

switch_to() {
    ln -s "$1" "$lock/active"
    mv -Tf "$lock/active" "$active"
}

healthy() {
    attempts=0
    while [ "$attempts" -lt 20 ]; do
        if curl -fsS --max-time 1 "http://127.0.0.1:${LOBBY_PORT:-2567}/health" | grep -Fq '"draining":true'; then
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 1
    done
    return 1
}

rehearse() {
    timeout 12s runuser -u htd -- "$active/node/bin/node" \
        "$active/multiplayer-server/dist/src/check-directory-compatibility.js" "${LOBBY_PORT:-2567}" || return 1
    systemctl kill --kill-who=main --signal=SIGUSR2 hold-til-dawn-multiplayer.service || return 1
    attempts=0
    while [ "$attempts" -lt 20 ]; do
        check=$(curl -fsS --max-time 1 "http://127.0.0.1:${LOBBY_PORT:-2567}/health") || return 1
        case "$check" in
            *'"releaseCheck":"failed"'*) return 1 ;;
            *'"draining":true'*'"releaseCheck":"passed"'*) return 0 ;;
        esac
        attempts=$((attempts + 1))
        sleep 1
    done
    return 1
}

cleanup() {
    status=$?
    if "$restoring"; then
        if systemctl stop hold-til-dawn-multiplayer.service &&
            { [ "$(readlink "$active")" = "$previous" ] || switch_to "$previous"; } &&
            systemctl start hold-til-dawn-multiplayer.service && healthy; then
            if rehearse; then
                echo 'The previous release passed rehearsal with admissions drained.' >&2
            else
                echo 'The previous release restarted with admissions drained and needs compatibility and worker verification.' >&2
            fi
        else
            echo "Could not restore the previous release. Check systemd and the current release symlink." >&2
        fi
    fi
    rm -rf "$lock"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

exec 9>/run/lock/hold-til-dawn-release.lock
flock -n 9 || exit 1
test -L "$active"
previous=$(readlink "$active")
"$active/deploy/drain.sh" wait 0
restoring=true
if systemctl stop hold-til-dawn-multiplayer.service && switch_to "$target" &&
    systemctl start hold-til-dawn-multiplayer.service && healthy && rehearse; then
    restoring=false
    echo 'Directory compatibility and authenticated worker launch and exit passed. Admissions are drained.'
    exit 0
fi
echo 'Release activation failed.' >&2
exit 1
