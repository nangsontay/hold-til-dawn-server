import { execFile, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Config, type Port, integer, isObject, token } from './config.js';

export type Lease = { roomId: string; generation: string; name: string; launchDeadline: number; creatorExpiry: number };
export type Owner = { busy: boolean; pid?: number } | 'unknown';

const leasePath = (config: Config, port: Port) => join(config.stateDir, `worker-${port}.json`);
const marker = (port: Port, lease: Lease) => `--htd-slot=${port}-${lease.generation}`;
const unit = (port: Port) => `hold-til-dawn-worker@${port}.service`;

export function readLease(config: Config, port: Port): Lease | undefined {
  let raw: string;
  try {
    raw = readFileSync(leasePath(config, port), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw Error('Cannot read worker lease');
  }
  const data: unknown = JSON.parse(raw);
  if (!isObject(data) || !token(data.roomId) || !token(data.generation) ||
      typeof data.name !== 'string' || !integer(data.launchDeadline, 1) || !integer(data.creatorExpiry, 1)) {
    throw Error('Invalid worker lease');
  }
  return { roomId: data.roomId, generation: data.generation, name: data.name,
    launchDeadline: data.launchDeadline, creatorExpiry: data.creatorExpiry };
}

export function writeLease(config: Config, port: Port, lease?: Lease) {
  const path = leasePath(config, port);
  if (!lease) {
    unlinkSync(path);
    return;
  }
  const tmp = path + '.writing';
  writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
  renameSync(tmp, path);
}

export function workerCommand(config: Config, port: Port, lease: Lease) {
  const args = ['--headless'];
  if (config.workerProject) args.push('--path', config.workerProject);
  args.push('--', '--match-worker', marker(port, lease));
  const env = {
    ...process.env,
    MATCH_ROOM_ID: lease.roomId,
    MATCH_GENERATION: lease.generation,
    MATCH_ROOM_NAME: lease.name,
    MATCH_UDP_PORT: String(port),
    CONTROL_ENDPOINT: `127.0.0.1:${config.controlPort}`,
    ADMISSION_SECRET_FILE: config.secretFile,
  };
  return { args, env };
}

const commandOptions = { encoding: 'utf8' as const, timeout: 1000, killSignal: 'SIGKILL' as const, maxBuffer: 4 * 1024 * 1024 };
const run = promisify(execFile);

async function systemctl(args: string[]) {
  return (await run('/usr/bin/systemctl', ['--no-ask-password', ...args], commandOptions)).stdout;
}

export async function ownership(config: Config, port: Port, lease?: Lease): Promise<Owner> {
  try {
    if (config.supervisor === 'systemd') {
      const status = new Map((await systemctl(['show', '--property=LoadState,ActiveState,MainPID,Job', unit(port)]))
        .trim().split('\n').map(line => line.split('=', 2) as [string, string]));
      const state = status.get('ActiveState');
      const mainPid = status.get('MainPID') ?? '';
      const pid = Number(mainPid);
      // Job is omitted when systemctl has no queued work for this unit.
      const job = status.get('Job');
      if (status.get('LoadState') !== 'loaded' || !state || state === 'unknown' ||
          !/^\d+$/.test(mainPid) || !integer(pid, 0)) return 'unknown';
      const busy = pid > 0 || Boolean(job && job !== '0') || (state !== 'inactive' && state !== 'failed');
      const args = pid > 0 && lease ? (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean) : [];
      return { busy, pid: lease && args.at(-1) === marker(port, lease) ? pid : undefined };
    }
    const { stdout: rows } = await run('/bin/ps', ['-axww', '-o', 'pid=,stat=,command='], commandOptions);
    if (!rows.trim()) return 'unknown';
    const matches = rows.split('\n').flatMap(row => {
      const rowMatch = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(row);
      if (!rowMatch || rowMatch[2].startsWith('Z')) return [];
      const last = rowMatch[3].split(/\s+/).at(-1);
      return last?.startsWith(`--htd-slot=${port}-`) ? [{ pid: Number(rowMatch[1]), last }] : [];
    });
    const owner = matches[0];
    return { busy: matches.length > 0, pid: matches.length === 1 && lease &&
      owner.last === marker(port, lease) ? owner.pid : undefined };
  } catch {
    return 'unknown';
  }
}

export function startWorker(config: Config, port: Port, lease: Lease, failed: () => void) {
  if (config.supervisor === 'systemd') {
    void systemctl(['--no-block', 'start', unit(port)]).catch(failed);
    return;
  }
  const { args, env } = workerCommand(config, port, lease);
  const child = spawn(config.workerExecutable, args, { env, detached: true, stdio: 'ignore' });
  child.once('error', failed);
  child.unref();
}

export async function stopWorker(config: Config, port: Port, owner: Exclude<Owner, 'unknown'>, force: boolean) {
  if (config.supervisor === 'systemd') {
    await systemctl(['--no-block', 'stop', unit(port)]);
  } else if (owner.pid) {
    try {
      process.kill(owner.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

export function udpIsFree(port: Port) {
  return new Promise<boolean>(done => {
    const probe = createSocket('udp4');
    probe.once('error', () => { probe.close(); done(false); });
    probe.bind(port, '0.0.0.0', () => probe.close(() => done(true)));
  });
}
