#!/bin/sh
set -eu
envsubst '${GAME_HOST}' < /etc/nginx/htd.conf.template > /etc/nginx/conf.d/default.conf
nginx -t
(while sleep 21600; do nginx -t && nginx -s reload; done) &
exec nginx -g 'daemon off;'
