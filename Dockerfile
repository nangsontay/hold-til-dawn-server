FROM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725 AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && rm -rf dist/test

FROM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725
RUN apt-get update && apt-get install -y --no-install-recommends procps libx11-6 libxcursor1 libxinerama1 libgl1 libasound2t64 unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip -o /tmp/godot.zip \
 && echo 'cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4  /tmp/godot.zip' | sha256sum -c - \
 && unzip -p /tmp/godot.zip Godot_v4.7.2-stable_linux.x86_64 > /usr/local/bin/godot \
 && chmod 755 /usr/local/bin/godot && rm /tmp/godot.zip \
 && test "$(godot --headless --version)" = '4.7.2.stable.official.ed1daf0bf'
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build /app/package.json ./package.json
ARG WORKER_PACK
COPY ${WORKER_PACK} /app/Hold-til-Dawn-Server.pck
COPY docker/worker.sh /usr/local/bin/worker
USER node
ENV WORKER_EXECUTABLE=/usr/local/bin/worker WORKER_STATE_DIR=/state ADMISSION_SECRET_FILE=/private/worker.key WORKER_SUPERVISOR=local CONTROL_ENDPOINT=127.0.0.1:2569 LOBBY_HOST=0.0.0.0
CMD ["node", "dist/src/server.js"]
