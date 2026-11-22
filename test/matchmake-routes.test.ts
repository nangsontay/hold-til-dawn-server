import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('only joinOrCreate is exposed for matchmaking', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'directory-routes-'));
  const key = join(temp, 'key');
  writeFileSync(key, 'a'.repeat(64), { mode: 0o600 });
  const listeners = [createServer(), createServer()];
  let child: ReturnType<typeof spawn> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    for (const listener of listeners) {
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
    }
    const [lobbyPort, controlPort] = listeners.map(listener => {
      const address = listener.address();
      assert(address && typeof address !== 'string');
      return address.port;
    });
    await Promise.all(listeners.map(listener => new Promise<void>(resolve => listener.close(() => resolve()))));

    const preload = `import { matchMaker } from ${JSON.stringify(import.meta.resolve('@colyseus/core'))};
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1500);
      process.on('message', async () => process.send((await matchMaker.query({ name: 'directory' })).length));`;
    child = spawn(process.execPath, [ '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL('../src/server.js', import.meta.url)) ], {
      env: { PATH: process.env.PATH, LOBBY_PORT: String(lobbyPort), CONTROL_ENDPOINT: `127.0.0.1:${controlPort}`,
        ADMISSION_SECRET_FILE: key, WORKER_EXECUTABLE: process.execPath, WORKER_STATE_DIR: temp },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    // Stop before the manager's two-second recovery period can reach its UDP probes.
    deadline = setTimeout(() => child?.kill('SIGKILL'), 1500);
    const exited = once(child, 'exit');
    while (!output.includes('Multiplayer directory listening')) {
      assert.equal(child.exitCode, null, output);
      assert.equal(child.signalCode, null, output);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const count = async () => {
      const response = once(child!, 'message');
      child!.send!('count');
      return (await response)[0];
    };
    const post = (path: string) => fetch(`http://127.0.0.1:${lobbyPort}/matchmake/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(await count(), 0);
    const create = await post('create/directory');
    assert.equal(create.ok, false);
    assert.equal(await count(), 0);
    const allowed = await post('joinOrCreate/directory');
    assert.equal(allowed.status, 200);
    const seat = await allowed.json() as { processId: string; roomId: string };
    assert.match(`/${seat.processId}/${seat.roomId}`, /^\/[A-Za-z0-9_-]{9}\/[A-Za-z0-9_-]{9}$/);
    assert.equal(await count(), 1);
    for (const path of ['join/directory', `joinById/${seat.roomId}`]) {
      const rejected = await post(path);
      assert.equal(rejected.ok, false, path);
      assert.equal(await count(), 1, path);
    }
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0, `${signal}: ${output}`);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    for (const listener of listeners) if (listener.listening) listener.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
