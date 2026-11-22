#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -e "${WORKER_KEY:-./worker.key}" ]; then
  (umask 077; openssl rand -hex 32 > "${WORKER_KEY:-./worker.key}")
fi
export COMPOSE_FILE=compose.yaml:compose.local.yaml COMPOSE_PROFILES=local
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-hold-til-dawn-local}
export HTD_IMAGE=${HTD_IMAGE:-hold-til-dawn:local} GAME_HOST=${GAME_HOST:-127.0.0.1}
docker compose up -d --wait
