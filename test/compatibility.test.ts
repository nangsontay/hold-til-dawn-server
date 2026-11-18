import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_BUILD, CONTENT, PROTOCOL } from '../src/compatibility.js';

test('directory compatibility matches the Godot worker and lobby client', () => {
  const root = process.env.HTD_COMPAT_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
  const worker = readFileSync(resolve(root, 'match-worker.gd'), 'utf8');
  const lobby = readFileSync(resolve(root, 'multiplayer/lobby-client.gd'), 'utf8');
  assert.equal(worker.match(/^const PROTOCOL := (\d+)$/m)?.[1], String(PROTOCOL));
  assert.equal(worker.match(/^const CONTENT := "([^"]+)"$/m)?.[1], CONTENT);
  const build = worker.match(/^const CLIENT_BUILD := CONTENT \+ "([^"]+)"$/m);
  assert(build);
  assert.equal(CONTENT + build[1], CLIENT_BUILD);
  assert.match(lobby, /^const MatchWorker = preload\("res:\/\/match-worker\.gd"\)$/m);
  assert.match(lobby, /"protocol": MatchWorker\.PROTOCOL,\s*"clientBuild": MatchWorker\.CLIENT_BUILD/);
});
