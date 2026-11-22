import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';

test('directory bind is loopback by default and permits only the deliberate container bind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'htd-bind-'));
  try {
    const key = join(dir, 'key');
    writeFileSync(key, 'a'.repeat(64), { mode: 0o600 });
    const env = { WORKER_EXECUTABLE: process.execPath, WORKER_STATE_DIR: dir, ADMISSION_SECRET_FILE: key };
    assert.equal(readConfig(env).lobbyHost, '127.0.0.1');
    assert.equal(readConfig({ ...env, LOBBY_HOST: '0.0.0.0' }).lobbyHost, '0.0.0.0');
    for (const host of ['', '::', 'localhost', '192.0.2.1']) {
      assert.throws(() => readConfig({ ...env, LOBBY_HOST: host }), /Invalid LOBBY_HOST/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
