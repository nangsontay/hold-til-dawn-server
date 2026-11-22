#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -e "${WORKER_KEY:-./worker.key}" ]; then
  (umask 077; openssl rand -hex 32 > "${WORKER_KEY:-./worker.key}")
fi
export COMPOSE_FILE=compose.yaml:compose.local.yaml COMPOSE_PROFILES=local
docker compose up -d
