import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';
import { WorkerManager } from '../src/worker-manager.js';
import { readLease, writeLease } from '../src/worker-process.js';

test('invalid worker leases are preserved and slots recover', () => {
  for (const content of ['', '{invalid', JSON.stringify({ roomId: 'room' })]) {
    const dir = mkdtempSync(join(tmpdir(), 'htd-lease-'));
    try {
      const key = join(dir, 'key');
      writeFileSync(key, 'a'.repeat(64), { mode: 0o600 });
      const config = readConfig({ WORKER_EXECUTABLE: process.execPath, WORKER_STATE_DIR: dir, ADMISSION_SECRET_FILE: key });
      const path = join(dir, 'worker-7778.json');
      writeFileSync(path, content);
      const manager = new WorkerManager(config, async () => ({ busy: false }));
      const slots = (manager as unknown as { slots: { status: string; lease?: unknown }[] }).slots;
      assert.equal(slots[0].status, 'recovering');
      assert.equal(slots[0].lease, undefined);
      const invalid = readdirSync(dir).filter(name => /^worker-7778\.json\.invalid-\d+-/.test(name));
      assert.equal(invalid.length, 1, 'Invalid lease should be moved aside');
      assert.equal(readFileSync(join(dir, invalid[0]), 'utf8'), content);
      assert.doesNotThrow(() => writeLease(config, 7778));
      const lease = { roomId: 'room', generation: 'generation', name: 'name', launchDeadline: 1, creatorExpiry: 2 };
      writeLease(config, 7778, lease);
      assert.deepEqual(readLease(config, 7778), lease);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      mkdirSync(join(dir, 'worker-7779.json'));
      assert.throws(() => readLease(config, 7779), /Cannot read worker lease/);
      assert.throws(() => writeLease(config, 7779));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
