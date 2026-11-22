#!/bin/sh
set -u
while :; do
  (set -a; . /config/ddns.conf; set +a; /usr/local/bin/update-dns) || echo 'DDNS update failed' >&2
  sleep 300
done
