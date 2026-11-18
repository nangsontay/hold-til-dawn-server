#!/bin/sh
set -eu
: "${DDNS_NAME:?}" "${DDNS_ZONE:?}" "${DDNS_SERVER:?}" "${DDNS_KEY_FILE:?}" "${DDNS_IP_URL:?}"
for name in "$DDNS_NAME" "$DDNS_ZONE" "$DDNS_SERVER"; do
    printf '%s\n' "$name" | LC_ALL=C grep -Eq '^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$'
done
case "$DDNS_NAME" in *."$DDNS_ZONE") ;; *) exit 2 ;; esac
test -r "$DDNS_KEY_FILE"
case "$DDNS_IP_URL" in https://*) ;; *) exit 2 ;; esac
response=$(curl -4fsS --proto '=https' --max-time 15 --retry 2 --max-filesize 64 -- "$DDNS_IP_URL")
address=$(printf '%s' "$response" |
    python3 -c 'import ipaddress,sys; print(ipaddress.IPv4Address(sys.stdin.read().strip()))' 2>/dev/null)
printf 'server %s\nzone %s.\nupdate delete %s. A\nupdate add %s. 60 A %s\nsend\n' \
    "$DDNS_SERVER" "$DDNS_ZONE" "$DDNS_NAME" "$DDNS_NAME" "$address" |
    nsupdate -v -t 15 -k "$DDNS_KEY_FILE"
