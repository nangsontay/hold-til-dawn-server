#!/bin/sh
set -eu
[ "$#" = 1 ] || { echo 'Usage: deploy/build-docker.sh IMAGE:TAG' >&2; exit 2; }
root=$(cd "$(dirname "$0")/../.." && pwd)
server=$root/multiplayer-server
godot=${GODOT_BIN:-godot}
[ "$("$godot" --version)" = '4.7.2.stable.official.ed1daf0bf' ] || { echo 'Godot 4.7.2 stable official ed1daf0bf required' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/htd-docker.XXXXXX")
context=$(mktemp -d "$server/.docker-build.XXXXXX")
trap 'rm -rf "$work" "$context"' EXIT
mkdir -p "$work/project/addons/colyseus"
project=$work/project
cp -R "$root"/art "$root"/fonts "$root"/maps "$root"/config "$root"/multiplayer "$root"/src "$project/"
cp "$root"/project.godot "$root"/main.tscn "$root"/icon.svg "$root"/icon.svg.import "$root"/*.gd "$root"/*.gd.uid "$project/"
cp "$root"/addons/colyseus/colyseus.gd "$project/addons/colyseus/"
(cd "$root/addons/colyseus" && shasum -a 256 -c SHA256SUMS)
cp "$server/deploy/worker-export.cfg" "$project/export_presets.cfg"
"$godot" --headless --path "$project" --log-file "$work/import.log" --import
"$godot" --headless --path "$project" --log-file "$work/export.log" --export-pack 'Linux Headless Worker' "$context/Hold-til-Dawn-Server.pck"
test -s "$context/Hold-til-Dawn-Server.pck"
docker build --platform linux/amd64 --build-arg "WORKER_PACK=$(basename "$context")/Hold-til-Dawn-Server.pck" -t "$1" "$server"
