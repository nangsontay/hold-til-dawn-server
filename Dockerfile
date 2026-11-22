FROM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725 AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && rm -rf dist/test

FROM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725 AS godot-template
# SHA-512 from godot-builds 4.7.2-stable/SHA512-SUMS.txt.
RUN curl -fsSL https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz -o /tmp/templates.tpz \
 && echo 'ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079  /tmp/templates.tpz' | sha512sum -c - \
 && unzip -p /tmp/templates.tpz templates/linux_release.x86_64 > /tmp/godot \
 && chmod 755 /tmp/godot

FROM node:26.13.0@sha256:438603bbb5cda404b9416f0b5c8026f61501ab911760d861ec28c36b5d675725
COPY --from=godot-template /tmp/godot /app/Hold-til-Dawn-Server.x86_64
RUN test "$(/app/Hold-til-Dawn-Server.x86_64 --headless --version)" = '4.7.2.stable.official.ed1daf0bf'
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
