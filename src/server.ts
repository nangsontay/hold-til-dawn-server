import type { IncomingMessage, ServerResponse } from 'node:http';
import { debugMessage, defineRoom, defineServer, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { readConfig } from './config.js';
import { lobbyRoom } from './lobby-room.js';
import { WorkerManager } from './worker-manager.js';

async function main() {
  // The transport's verbose message logger includes raw direct reply payloads.
  debugMessage.enabled = false;
  matchMaker.controller.exposedMethods = ['joinOrCreate'];
  const config = readConfig();
  const manager = new WorkerManager(config);
  await manager.start();
  manager.on('fault', () => {
    console.error('Worker reconciliation failed');
    process.exit(1);
  });
  const transport = new WebSocketTransport({ maxPayload: 2048 });
  transport.server?.on('error', () => {
    console.error('Could not bind directory listener');
    process.exit(1);
  });
  const app = defineServer({
    transport, rooms: { directory: defineRoom(lobbyRoom(manager)) }, greet: false,
    publicAddress: config.publicAddress, gracefullyShutdown: false,
    express: http => http.get('/health', (_request: IncomingMessage, response: ServerResponse) => {
      const { createCode } = manager.directory();
      const draining = manager.draining();
      const ready = createCode === null || createCode === 'server_full' || createCode === 'server_draining';
      response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ready, draining, createCode, releaseCheck: manager.releaseCheck }));
    }),
  });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const stopped = await manager.shutdown();
    await app.gracefullyShutdown(false);
    if (!stopped) console.error('Worker shutdown deadline reached');
    process.exit(stopped ? 0 : 1);
  }
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGHUP', () => { if (!stopping) process.exit(1); });
  process.on('SIGUSR2', () => { if (!stopping) void manager.checkRelease(); });
  await app.listen(config.lobbyPort, config.lobbyHost);
  console.log('Multiplayer directory listening');
}

try {
  await main();
} catch {
  console.error('Could not start multiplayer directory. Check listener and worker configuration.');
  process.exit(1);
}
