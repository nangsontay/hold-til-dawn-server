#!/bin/sh
set -eu

if [ "$#" -ne 3 ] && [ "$#" -ne 5 ]; then
    echo 'Usage: package-release.sh OUTPUT RELEASE_ID LOBBY_FQDN [LINUX_GODOT_TEMPLATE LINUX_NODE_DIR]' >&2
    exit 2
fi
output=$1
release=$2
host=$3
printf '%s\n' "$release" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'
printf '%s\n' "$host" | LC_ALL=C grep -Eq '^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$'
if [ -e "$output" ] || [ -L "$output" ]; then
    echo "Output path already exists: $output" >&2
    exit 1
fi
output=$(cd "$(dirname "$output")" && pwd)/$(basename "$output")
root=$(cd "$(dirname "$0")/../.." && pwd)
deploy=$root/multiplayer-server/deploy
godot=${GODOT_BIN:-godot}
[ "$(node --version)" = "v$(cat "$root/multiplayer-server/.nvmrc")" ]
godot_version=$("$godot" --version)
godot_commit=ed1daf0bf001b61586d9930840f2f1394092c079
test "$godot_version" = '4.7.2.stable.official.ed1daf0bf' ||
    { echo 'Godot 4.7.2 stable official build ed1daf0bf is required.' >&2; exit 1; }

if [ "$#" -eq 5 ]; then
    file -b "$4" | grep -Eq 'ELF 64-bit.*x86-64'
    file -b "$5/bin/node" | grep -Eq 'ELF 64-bit.*x86-64'
    # Validate embedded build metadata when staging Linux binaries on macOS.
    LC_ALL=C strings -a "$4" | awk -v commit="$godot_commit" '
        $0 == "4.7.2.stable.official" { version = 1 }
        $0 == commit { revision = 1 }
        END { exit !(version && revision) }
    ' || { echo 'Linux Godot template does not match the pinned 4.7.2 official build.' >&2; exit 1; }
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/htd-package.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bundle=$work/release
project=$work/project
server=$bundle/multiplayer-server
mkdir -p "$project/addons/colyseus" "$server" "$bundle/game" "$bundle/deploy" "$bundle/notices"
cp -R "$root"/art "$root"/fonts "$root"/maps "$root"/config "$root"/multiplayer "$project/"
cp "$root"/project.godot "$root"/main.tscn "$root"/icon.svg "$root"/*.gd "$project/"
cp "$root"/addons/colyseus/colyseus.gd "$project/addons/colyseus/"
cp "$root"/addons/colyseus/LICENSE "$bundle/notices/colyseus-sdk.LICENSE"
(cd "$root/addons/colyseus" && shasum -a 256 -c SHA256SUMS) || {
    echo 'Colyseus SDK binaries are missing or mismatched. Run python3 tools/fetch-colyseus-sdk.py from the repository root.' >&2
    exit 1
}
cp "$root"/addons/colyseus/SHA256SUMS "$bundle/notices/colyseus-sdk.SHA256SUMS"
find "$root/art" "$root/fonts" -type f \( -iname 'credits.txt' -o -iname '*ofl*' -o -iname '*license*' \) -print |
while IFS= read -r notice; do
    path=${notice#"$root"/}
    mkdir -p "$bundle/notices/$(dirname "$path")"
    cp "$notice" "$bundle/notices/$path"
done
cp "$deploy/worker-export.cfg" "$project/export_presets.cfg"
"$godot" --headless --path "$project" --log-file "$work/worker-import.log" --import
"$godot" --headless --path "$project" --log-file "$work/worker-export.log" \
    --export-pack 'Linux Headless Worker' "$bundle/game/Hold-til-Dawn-Server.pck"
test -s "$bundle/game/Hold-til-Dawn-Server.pck"

cp -R "$root/multiplayer-server"/src "$root/multiplayer-server"/test "$server/"
cp "$root/multiplayer-server"/package.json "$root/multiplayer-server"/package-lock.json "$root/multiplayer-server"/tsconfig.json "$server/"
(cd "$server" && npm ci --no-audit --no-fund && npm run build &&
    HTD_COMPAT_ROOT="$root" node --test dist/test/compatibility.test.js &&
    npm ci --omit=dev --omit=optional --no-audit --no-fund &&
    npm pkg delete scripts.build scripts.test)
rm -r "$server/src" "$server/test" "$server/dist/test" "$server/tsconfig.json"
cp "$deploy"/*.service "$deploy"/*.timer "$deploy"/*.rules "$deploy"/*.example "$deploy"/*.sh "$bundle/deploy/"
for template in "$bundle/deploy"/nginx.conf.example "$bundle/deploy"/multiplayer.conf.example "$bundle/deploy"/ddns.conf.example; do
    sed "s/game\.example\.com/$host/g" "$template" > "$template.tmp"
    mv "$template.tmp" "$template"
done

kind=build-only
if [ "$#" -eq 5 ]; then
    install -m 0755 "$4" "$bundle/game/Hold-til-Dawn-Server.x86_64"
    cp -R "$5" "$bundle/node"
    kind=linux-x86_64
fi

if [ "${PACKAGE_DESKTOP:-0}" = 1 ]; then
    cp -R "$root"/addons/colyseus/. "$project/addons/colyseus/"
    sed "s|wss://game\.example\.com|wss://$host|" "$root/multiplayer/lobby-client.gd" > "$project/multiplayer/lobby-client.gd"
    cp "$root/export_presets.cfg" "$project/export_presets.cfg"
    mkdir -p "$bundle/clients/macOS" "$bundle/clients/Windows"
    "$godot" --headless --path "$project" --log-file "$work/client-import.log" --import
    "$godot" --headless --path "$project" --log-file "$work/macOS.log" \
        --export-release 'Development macOS arm64' "$bundle/clients/macOS/Hold-til-Dawn.zip"
    "$godot" --headless --path "$project" --log-file "$work/windows.log" \
        --export-release 'Development Windows x86_64' "$bundle/clients/Windows/Hold-til-Dawn.exe"
    cp -R "$bundle/notices" "$bundle/clients/macOS/"
    cp -R "$bundle/notices" "$bundle/clients/Windows/"
fi

{
    printf 'release=%s\npackage=%s\nlobby=wss://%s\ngodot=%s\nnode=%s\n' "$release" "$kind" "$host" "$godot_version" "$(node --version)"
    (cd "$server" && node --input-type=module -e '
        import { PROTOCOL, CONTENT, CLIENT_BUILD } from "./dist/src/compatibility.js";
        console.log(`protocol=${PROTOCOL}\ncontent=${CONTENT}\nclient_build=${CLIENT_BUILD}`);
    ')
    cd "$bundle"
    find game multiplayer-server/dist -type f -print | LC_ALL=C sort | while IFS= read -r artifact; do
        shasum -a 256 "$artifact"
    done
    shasum -a 256 multiplayer-server/package.json multiplayer-server/package-lock.json notices/colyseus-sdk.SHA256SUMS
    if [ -d clients ]; then
        find clients -type f -print | LC_ALL=C sort | while IFS= read -r artifact; do
            shasum -a 256 "$artifact"
        done
    fi
    if [ -d node ]; then
        shasum -a 256 node/bin/node
    fi
} > "$bundle/RELEASE"
mv "$bundle" "$output"
