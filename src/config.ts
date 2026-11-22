import { accessSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ports = [7778, 7779, 7780] as const;
export type Port = typeof ports[number];
export const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export const hex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
export const integer = (value: unknown, low: number, high = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function setting(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number) {
  const raw = env[key] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !integer(value, min, max)) throw Error(`Invalid ${key}`);
  return value;
}

export function readConfig(env = process.env) {
  const lobbyPort = setting(env, 'LOBBY_PORT', 2567, 1, 65535);
  const endpoint = /^127\.0\.0\.1:(\d+)$/.exec(env.CONTROL_ENDPOINT ?? '127.0.0.1:2569');
  const controlPort = Number(endpoint?.[1]);
  if (!integer(controlPort, 1, 65535) || controlPort === lobbyPort) throw Error('Invalid CONTROL_ENDPOINT');
  const lobbyHost = env.LOBBY_HOST ?? '127.0.0.1';
  if (lobbyHost !== '127.0.0.1' && lobbyHost !== '0.0.0.0') throw Error('Invalid LOBBY_HOST');
  const workerHost = env.WORKER_HOST ?? '127.0.0.1';
  if (!(isIP(workerHost) || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(workerHost))) {
    throw Error('Invalid WORKER_HOST');
  }
  let publicAddress: string | undefined;
  if (env.LOBBY_URL !== undefined) {
    try {
      const url = new URL(env.LOBBY_URL);
      if (url.protocol !== 'wss:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error();
      publicAddress = url.host;
    } catch {
      throw Error('Invalid LOBBY_URL');
    }
  }
  const workerExecutable = env.WORKER_EXECUTABLE ?? '';
  const workerProject = env.WORKER_PROJECT;
  const secretFile = env.ADMISSION_SECRET_FILE ?? '';
  let rawKey: string;
  try {
    if (!isAbsolute(secretFile)) throw Error();
    const stat = statSync(secretFile);
    if (!stat.isFile() || stat.size < 64 || stat.size > 65 || (stat.mode & 0o037) !== 0) throw Error();
    rawKey = readFileSync(secretFile, 'utf8').replace(/\n$/, '');
    if (!hex(rawKey, 64)) throw Error();
  } catch {
    throw Error('Invalid ADMISSION_SECRET_FILE');
  }
  try {
    if (!isAbsolute(workerExecutable) || !statSync(workerExecutable).isFile()) throw Error();
    accessSync(workerExecutable, constants.X_OK);
  } catch {
    throw Error('Invalid WORKER_EXECUTABLE');
  }
  if (workerProject !== undefined) {
    try {
      if (!isAbsolute(workerProject) || !statSync(resolve(workerProject, 'project.godot')).isFile()) throw Error();
    } catch {
      throw Error('Invalid WORKER_PROJECT');
    }
  }
  const supervisor = env.WORKER_SUPERVISOR ?? 'local';
  if (supervisor !== 'local' && (supervisor !== 'systemd' || process.platform !== 'linux' || !publicAddress)) {
    throw Error('Invalid WORKER_SUPERVISOR or missing public WSS configuration');
  }
  const stateDir = env.WORKER_STATE_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../.runtime');
  try {
    if (!isAbsolute(stateDir)) throw Error();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (!statSync(stateDir).isDirectory() || (statSync(stateDir).mode & 0o077) !== 0) throw Error();
  } catch {
    throw Error('Invalid WORKER_STATE_DIR');
  }
  const ticketMs = setting(env, 'ADMISSION_TTL_MS', 15000, 3000, 30000);
  return {
    lobbyPort, lobbyHost, controlPort, publicAddress, workerHost, workerExecutable, workerProject,
    secretFile, hostKey: Buffer.from(rawKey, 'hex'), stateDir, supervisor, ticketMs,
  };
}

export type Config = ReturnType<typeof readConfig>;
