# Hold ’til Dawn multiplayer server

The Colyseus directory allocates three Godot match workers. This repository is the `multiplayer-server/` submodule of the game checkout; tests compare game protocol and client files and run Godot workers from the parent checkout. Clone the game with `git clone --recurse-submodules <game-repository-url>`, or run `git submodule update --init` in an existing checkout.

## Development

Install Node 26.13.0 and Godot 4.7.2 stable official `ed1daf0bf`, then from the game root run `python3 tools/fetch-colyseus-sdk.py` and `godot --headless --path . --import`. In this directory run `npm ci`, `npm run build`, and `GODOT_BIN=/path/to/godot npm test`. The game [deployment guide](https://github.com/pmh2612/Hold-til-Dawn/blob/main/docs/deployment-guide.md) describes local source execution and the existing systemd deployment.

## Docker

Build from the game checkout with Docker Compose, the pinned Godot editor and the verified SDK binaries installed:

```sh
GODOT_BIN=/path/to/godot multiplayer-server/deploy/build-docker.sh hold-til-dawn:release-1
```

The script stages the existing `Linux Headless Worker` preset, imports its resources, exports the PCK and builds an image tagged as requested. The Docker build downloads the official Godot 4.7.2 export templates, verifies their SHA-512 against the [official release checksums](https://github.com/godotengine/godot-builds/releases/tag/4.7.2-stable), and extracts the Linux x86-64 release template to run the PCK. The release worker has the same non-debug behavior as the systemd release; no locally installed export templates are required. Production is `linux/amd64`; Apple Silicon runs this image using amd64 emulation, not a native arm64 worker. The runtime includes `ps` for ownership checks and an init process to reap detached children.

All following commands run in `multiplayer-server/`. Keep the private worker key and named volumes across upgrades; never commit them or use `down -v` in production. The one-time root init container copies the Compose secret into a private volume, owned by the unprivileged directory user with mode 0600. Keep the source key private too.

### Local debug

After building the default `hold-til-dawn:local` image, one command generates `worker.key` if absent and starts the directory and workers, waiting for readiness:

```sh
deploy/docker-local.sh
```

For the `release-1` example above, use `HTD_IMAGE=hold-til-dawn:release-1 deploy/docker-local.sh`. The local profile uses a separate Compose project named `hold-til-dawn-local` so it cannot recreate the production containers. The local override publishes TCP 2567 only on 127.0.0.1 and advertises 127.0.0.1 for worker UDP. From the game root connect a debug client with `godot --path . -- --lobby-url=ws://127.0.0.1:2567`. Check `curl -fsS http://127.0.0.1:2567/health`. From the game root, verify an admitted leader cannot add a development bot with `godot --headless --path . -s res://multiplayer-server/test/release-client-check.gd -- --headless-client --lobby-url=ws://127.0.0.1:2567`. Use `COMPOSE_FILE=compose.yaml:compose.local.yaml COMPOSE_PROFILES=local` with the operations commands below; stop with `COMPOSE_PROJECT_NAME=hold-til-dawn-local HTD_IMAGE=hold-til-dawn:local GAME_HOST=127.0.0.1 docker compose -f compose.yaml -f compose.local.yaml --profile local down`.

### Production and first certificate

Create the gitignored `multiplayer-server/.env` with these two values, substituting your public hostname and release image tag:

```dotenv
GAME_HOST=game.example.com
HTD_IMAGE=hold-til-dawn:release-1
```

Compose reads this file automatically and refuses to start if either value is missing. Shell environment values override it, so unset any stale `GAME_HOST` and `HTD_IMAGE` variables before operating production. Generate the key once with `(umask 077; openssl rand -hex 32 > worker.key)`. Allow inbound TCP 80/443 and UDP 7778–7780. Keep TCP 2567 and 2569 private. The production profile publishes no directory TCP port. DNS must point to the host before issuance.

The bootstrap nginx serves only HTTP-01 because TLS nginx cannot start before the certificate exists. Obtain a real certificate with your email, then replace bootstrap with production nginx:

```sh
docker compose --profile bootstrap up -d bootstrap
docker compose --profile production run --rm --no-deps --entrypoint certbot certbot certonly --webroot -w /var/www/letsencrypt -d game.example.com --email you@example.com --agree-tos --no-eff-email
docker compose --profile bootstrap stop bootstrap
docker compose --profile production run --rm --no-deps --user root --entrypoint sh init -c 'mkdir -p /state; touch /state/drain; chown 1000:1000 /state /state/drain; chmod 700 /state; chmod 600 /state/drain'
docker compose --profile production up -d
deploy/docker-ops.sh check
```

Certbot checks for renewal every 12 hours. nginx reloads every six hours after checking its configuration, picking up renewed certificates without access to the Docker socket. Run `docker compose --profile production run --rm --no-deps --entrypoint certbot certbot renew --dry-run` and monitor expiry and the externally served chain.

For RFC 2136 DDNS, copy `deploy/ddns.conf.example` to `ddns.conf`, set its values and set `DDNS_KEY_FILE=/config/ddns.key`. Store the TSIG key in `ddns.key` privately. Start with `docker compose --profile production --profile ddns up -d --build`; omit the DDNS profile for a static IP. The updater invokes the existing script immediately and every five minutes. Verify the authoritative DNS answer and public resolver after the prior TTL.

### Drain, release, rollback and logs

`deploy/docker-ops.sh on` stops new admissions, `deploy/docker-ops.sh wait` waits for all leases to clear (optional timeout in seconds), and `deploy/docker-ops.sh shutdown` waits then stops the directory. `deploy/docker-ops.sh check` verifies directory compatibility and authenticated worker launch and close on all three slots while drained. Keep admissions closed if any check fails. `deploy/docker-ops.sh off` reopens admissions after staging and public client verification.

For upgrade: drain and wait, edit `HTD_IMAGE` in `.env` to the new tag, run `docker compose --profile production up -d --no-deps --force-recreate directory`, reload nginx with `docker compose --profile production exec nginx nginx -s reload`, then run `deploy/docker-ops.sh check`. Verify matched clients over WSS and UDP before reopening. Roll back by editing the same `.env` value to the previous image tag and repeating, checking again while drained. The state volume preserves the drain flag; a container restart ends its child workers and live matches, unlike a systemd directory-only restart. Retain the old image and matching client artifacts.

Inspect `docker compose --profile production logs -f directory nginx certbot` and, if enabled, `docker compose --profile ddns logs -f ddns`. Worker output is detached by the existing supervisor; directory allocation and release events remain in its logs. Do not expose keys in logs.
