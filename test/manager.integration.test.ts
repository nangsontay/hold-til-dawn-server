import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Protocol } from '@colyseus/shared-types';
import { decode, encode } from '@colyseus/schema';
import { pack, unpack } from 'msgpackr';
import { CLIENT_BUILD, PROTOCOL } from '../src/compatibility.js';
import { readConfig, sleep, type Port } from '../src/config.js';
import { heartbeatMs, sign } from '../src/worker-control.js';
import { WorkerManager } from '../src/worker-manager.js';
import { ownership, readLease, udpIsFree } from '../src/worker-process.js';

type Ticket = { requestId: string; roomId: string; generation: string; udpEndpoint: { port: Port; host: string };
  ticketId: string; secret: string; ttlMs: number };
type Room = { roomId: string; name: string; humans: number; state: string; available: number; joinable: boolean };
type Directory = { createAvailable: boolean; createCode: string | null; rooms: Room[] };
type Failure = { requestId: string; code: string; message: string };
type Packet = { type: string; data: Ticket | Directory | Failure };
type Response = { ticket?: Ticket; error?: Failure };
type Watched = { process: ChildProcess; text: string };

const root = fileURLToPath(new URL('../../../', import.meta.url));
const godot = process.env.GODOT_BIN ?? '/Applications/Godot.app/Contents/MacOS/Godot';

const controlSchema = JSON.parse(readFileSync(join(root, 'multiplayer/worker-control.schema.json'), 'utf8')) as {
  '$defs': Record<string, object>;
  'x-protocol': {
    managerCommands: Record<string, object>;
    workerEvents: Record<string, object>;
  };
};
const ajv = new Ajv2020({ allErrors: true });
const definitions = { '$defs': controlSchema['$defs'] };
const managerTypes = new Set(Object.keys(controlSchema['x-protocol'].managerCommands));
const workerTypes = new Set(Object.keys(controlSchema['x-protocol'].workerEvents));
const payloadValidator = (group: 'managerCommands' | 'workerEvents', type: string) => {
  const entry = controlSchema['x-protocol'][group][type];
  const schema = { ...definitions, ...entry, description: undefined };
  delete schema.description;
  return ajv.compile(schema);
};
const managerPayloads = new Map(Object.entries(controlSchema['x-protocol'].managerCommands)
  .map(([type]) => [type, payloadValidator('managerCommands', type)]));
const workerPayloads = new Map(Object.entries(controlSchema['x-protocol'].workerEvents)
  .map(([type]) => [type, payloadValidator('workerEvents', type)]));
const frameViolations: string[] = [];
const validateFrame = (direction: 'worker' | 'manager', envelope: string) => {
  const record: unknown = JSON.parse(envelope);
  if (!Array.isArray(record) || record.length !== 9 || record.some(value => typeof value !== 'string')) {
    frameViolations.push(`frame from ${direction} is not a 9-element string envelope: ${envelope.slice(0, 200)}`);
    return;
  }
  const [version, frameDirection, , , , , type, body] = record;
  const payloads = direction === 'worker' ? workerPayloads : managerPayloads;
  const role = direction === 'worker' ? 'worker event' : 'manager command';
  if (version !== '1' || frameDirection !== direction) {
    frameViolations.push(`frame from ${direction} has direction ${frameDirection} with version ${version}`);
    return;
  }
  if (!(direction === 'worker' ? workerTypes : managerTypes).has(type)) {
    frameViolations.push(`frame type ${type} from direction ${direction} is not a documented ${role}`);
    return;
  }
  const data: unknown = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  const validate = payloads.get(type);
  if (validate && !validate(data)) {
    frameViolations.push(`payload of ${role} ${type} from direction ${direction} violates the schema: ${
      JSON.stringify(validate.errors).slice(0, 600)} for body ${body.slice(0, 120)}`);
  }
};
interface FrameAccumulator {
  counts: Map<string, number>;
  receive(chunk: string | Buffer): void;
}
const frameChecks = (direction: 'worker' | 'manager'): FrameAccumulator => {
  const counts = new Map<string, number>();
  let pending = Buffer.alloc(0);
  let broken = false;
  return {
    counts,
    receive(chunk: string | Buffer) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (!broken && pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (size < 1 || size > 8192) {
          frameViolations.push(`frame from ${direction} declares ${size} bytes, outside 1 to 8192`);
          broken = true;
          break;
        }
        if (pending.length < 4 + size) break;
        const envelope = pending.subarray(4, 4 + size).toString('utf8');
        pending = pending.subarray(4 + size);
        try {
          validateFrame(direction, envelope);
        } catch (error) {
          frameViolations.push(`frame from ${direction} failed to decode: ${(error as Error).message} for ${envelope.slice(0, 120)}`);
          broken = true;
          break;
        }
        const type = JSON.parse(envelope)[6] as string;
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      if (broken) pending = Buffer.alloc(0);
    },
  };
};

async function waitFor<T>(label: string, check: () => T | false | undefined, timeout = 8000): Promise<T> {
  const end = performance.now() + timeout;
  do {
    const value = check();
    if (value) return value;
    await sleep(20);
  } while (performance.now() < end);
  throw Error(`Timed out waiting for ${label}`);
}

async function unusedPort() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert(address && typeof address !== 'string');
  listener.close();
  await once(listener, 'close');
  return address.port;
}

class Lobby {
  readonly messages: Packet[] = [];
  private latest?: Directory;
  private acknowledged = false;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', event => {
      const bytes = new Uint8Array(event.data);
      if (bytes[0] === Protocol.JOIN_ROOM) {
        ws.send(Uint8Array.of(Protocol.JOIN_ROOM));
        this.acknowledged = true;
      } else if (bytes[0] === Protocol.ROOM_DATA) {
        const offset = { offset: 1 };
        const type = decode.string(bytes, offset);
        const data = unpack(bytes.subarray(offset.offset));
        this.messages.push({ type, data });
        if (type === 'rooms') this.latest = data;
      }
    });
  }

  static async connect(port: number) {
    const response = await fetch(`http://127.0.0.1:${port}/matchmake/joinOrCreate/directory`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 200);
    const seat = await response.json();
    const client = new Lobby(new WebSocket(`ws://127.0.0.1:${port}/${seat.processId}/${seat.roomId}?sessionId=${seat.sessionId}`));
    try {
      await waitFor('Colyseus handshake', () => client.acknowledged);
      await client.list(() => true);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  close() { this.ws.close(); }

  send(type: string, data?: object) {
    const head = new Uint8Array(32);
    head[0] = Protocol.ROOM_DATA;
    const offset = { offset: 1 };
    encode.string(head, type, offset);
    this.ws.send(Buffer.concat([head.subarray(0, offset.offset), data === undefined ? Buffer.alloc(0) : pack(data)]));
  }

  list(predicate: (list: Directory) => boolean, timeout?: number) {
    return waitFor('directory projection', () => this.latest && predicate(this.latest) && this.latest, timeout);
  }

  async request(type: 'create' | 'join', name: string, roomId?: string, requestId = randomUUID() as string,
    compatibility = { protocol: PROTOCOL, clientBuild: CLIENT_BUILD }): Promise<Response> {
    const next = this.messages.length;
    this.send(type, { requestId, name, role: 2, roomId, ...compatibility });
    const reply = await waitFor(`${type} reply`, () => this.messages.slice(next).find(item =>
      (item.type === 'admission' || item.type === 'admission_error') && 'requestId' in item.data && item.data.requestId === requestId));
    return reply.type === 'admission' ? { ticket: reply.data as Ticket } : { error: reply.data as Failure };
  }
}

function ticket(response: Response): Ticket {
  assert(response.ticket !== undefined, response.error?.code ?? 'Expected an admission reply');
  assert(response.ticket.ticketId.length === 32 && response.ticket.secret.length === 64, 'Malformed admission credentials');
  assert(response.ticket.ttlMs > 0 && response.ticket.ttlMs <= 5500, 'Unbounded ticket lifetime');
  return response.ticket;
}

function room(list: Directory, id: string) { return list.rooms.find(item => item.roomId === id); }

test('a slow failing ownership probe publishes degraded readiness without destroying a live session', { timeout: 25000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'htd-probe-'));
  const key = join(temp, 'host-key');
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  const config = readConfig({ WORKER_EXECUTABLE: godot, WORKER_PROJECT: root, WORKER_STATE_DIR: join(temp, 'workers'),
    ADMISSION_SECRET_FILE: key, LOBBY_PORT: String(await unusedPort()), CONTROL_ENDPOINT: `127.0.0.1:${await unusedPort()}` });
  let failing = false;
  const starts: number[] = [];
  const manager = new WorkerManager(config, async (config, port, lease) => {
    if (port === 7778 && failing) {
      starts.push(performance.now());
      await sleep(550);
      throw Error('Injected supervisor error');
    }
    return ownership(config, port, lease);
  });
  let client: ChildProcess | undefined;
  try {
    for (const port of [7778, 7779, 7780] as const) assert(await udpIsFree(port));
    await manager.start();
    await waitFor('healthy supervision', () => manager.directory().createAvailable);
    const operation = { name: 'Supervisor recovery', role: 2, identity: randomUUID(), requestId: randomUUID() };
    const assignment = (await manager.admit(operation, true)).ticket;
    assert(assignment && assignment.udpEndpoint.port === 7778);
    const launch = { room: assignment.roomId, port: 7778, kind: 'idle', expected: null, generation: assignment.generation,
      ticket: assignment.ticketId, secret: assignment.secret };
    client = spawn(godot, ['--headless', '--path', root, '--log-file', join(temp, 'client.log'),
      '--script', 'tests/admission-client.gd'], {
      env: { ...process.env, ADMISSION_TEST_CONFIG: JSON.stringify(launch) }, stdio: 'ignore',
    });
    const entry = () => room(manager.directory(), assignment.roomId);
    await waitFor('creator admission', () => entry()?.joinable);
    failing = true;
    await waitFor('delayed probe with work still in flight', () => starts.length > 0);
    await sleep(75);
    assert(performance.now() - starts[0] < 400, 'The event loop runs while the ownership probe is pending');
    assert.equal(entry()?.state, 'waiting');
    await waitFor('degraded readiness', () => manager.directory().createCode === 'degraded');
    await sleep(heartbeatMs + 250);
    assert.equal(manager.directory().createCode, 'degraded');
    assert.equal(entry()?.state, 'waiting', 'An authenticated heartbeating room stayed online throughout the outage');
    assert(starts.length >= 3 && starts.length <= 5, 'Stable slots are probed about once per second');
    assert(starts.slice(1).every((started, index) => started - starts[index] >= 950));
    failing = false;
    await waitFor('ownership recovery', () => entry()?.joinable);
    assert.equal(entry()?.humans, 1);
  } finally {
    failing = false;
    if (client && client.exitCode === null && client.signalCode === null) {
      client.kill();
      await once(client, 'exit');
    }
    assert(await manager.shutdown());
    rmSync(temp, { recursive: true, force: true });
  }
});

test('directory with real Colyseus connections and Godot workers', { timeout: 145000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'htd-phase3-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const keyPath = join(temp, 'host-key');
  const wrapper = join(temp, 'godot-wrapper');
  const stateDir = join(temp, 'workers');
  const markerFile = join(temp, 'prebind');
  writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(wrapper, [
    '#!/bin/sh',
    'if [ "$MATCH_ROOM_NAME" = BeforeTicket ] || [ "$MATCH_ROOM_NAME" = CancelBefore ]; then',
    '  touch "$PREBIND_TEST_MARKER"',
    '  sleep 4',
    'fi',
    'if [ "$MATCH_ROOM_NAME" = Alice-Long-Room- ]; then export CONTROL_ENDPOINT="$TEST_CONTROL_RELAY"; fi',
    'exec "$GODOT_BIN" "$@"',
  ].join('\n'), { mode: 0o700 });
  const lobbyPort = await unusedPort();
  const controlPort = await unusedPort();
  let dropControl = false;
  let lastControl = 0;
  type RelayedChecks = { worker: FrameAccumulator; manager: FrameAccumulator };
  const relayedCounts: RelayedChecks[] = [];
  const relay = createServer(worker => {
    const manager = connect(controlPort, '127.0.0.1');
    const checks = { worker: frameChecks('worker'), manager: frameChecks('manager') };
    relayedCounts.push(checks);
    worker.on('data', data => {
      checks.worker.receive(data);
      if (!dropControl && !manager.destroyed) {
        lastControl = performance.now();
        manager.write(data);
      }
    });
    manager.pipe(worker);
    manager.on('data', data => {
      checks.manager.receive(data);
    });
    worker.on('error', () => worker.destroy()).once('close', () => manager.destroy());
    manager.on('error', () => manager.destroy()).once('close', () => worker.destroy());
  }).listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => { relay.close(); });
  const relayAddress = relay.address();
  assert(relayAddress && typeof relayAddress !== 'string');
  const env = { ...process.env, GODOT_BIN: godot, PREBIND_TEST_MARKER: markerFile, WORKER_EXECUTABLE: wrapper,
    TEST_CONTROL_RELAY: `127.0.0.1:${relayAddress.port}`,
    WORKER_PROJECT: root, WORKER_STATE_DIR: stateDir, WORKER_SUPERVISOR: 'local', WORKER_HOST: '127.0.0.1',
    LOBBY_PORT: String(lobbyPort), LOBBY_HOST: '127.0.0.1', LOBBY_URL: undefined, DEBUG: 'colyseus:message',
    CONTROL_ENDPOINT: `127.0.0.1:${controlPort}`, ADMISSION_SECRET_FILE: keyPath, ADMISSION_TTL_MS: '5500' };
  const config = readConfig(env);
  const workerPorts = [7778, 7779, 7780] as const;
  const processes: Watched[] = [];
  const sockets: Lobby[] = [];
  const issued: Ticket[] = [];
  let manager!: Watched;

  const watch = (command: string, args: string[], vars = env): Watched => {
    const child = spawn(command, args, { cwd: root, env: vars, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Watched = { process: child, text: '' };
    child.stdout.on('data', bytes => { output.text += bytes; });
    child.stderr.on('data', bytes => { output.text += bytes; });
    child.on('error', () => { output.text += '\nProcess error'; });
    processes.push(output);
    return output;
  };
  const exit = async (child: Watched, signal?: NodeJS.Signals) => {
    if (signal && child.process.exitCode === null && child.process.signalCode === null) child.process.kill(signal);
    await waitFor('process exit', () => child.process.exitCode !== null || child.process.signalCode !== null, 16000);
    return child.process.exitCode;
  };
  const start = async () => {
    manager = watch(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))]);
    await waitFor('directory startup', () => manager.text.includes('Multiplayer directory listening'));
  };
  const enter = async () => {
    const client = await Lobby.connect(lobbyPort);
    sockets.push(client);
    return client;
  };
  const request = async (client: Lobby, type: 'create' | 'join', name: string, roomId?: string, requestId?: string) => {
    const response = await client.request(type, name, roomId, requestId);
    if (response.ticket) issued.push(response.ticket);
    return response;
  };
  const enet = async (assignment: Ticket, kind = 'idle', expected = '', proofFile?: string) => {
    const leaveFile = join(temp, randomUUID());
    const launch = { room: assignment.roomId, port: assignment.udpEndpoint.port, kind, generation: assignment.generation,
      ticket: assignment.ticketId, secret: assignment.secret, expected: expected || null, leaveFile, proofFile };
    const child = watch(godot, ['--headless', '--log-file', join(temp, 'godot.log'), '--path', root,
      '--script', 'tests/admission-client.gd'], { ...env, ADMISSION_TEST_CONFIG: JSON.stringify(launch) } as typeof env);
    const marker = proofFile ? 'CLIENT proof_paused' : `CLIENT result ${expected || 'admitted'}`;
    await waitFor('ENet admission progress', () => child.text.includes(marker));
    return { child, leave: async () => { writeFileSync(leaveFile, ''); assert.equal(await exit(child), 0, 'ENet leave'); } };
  };
  const owner = async (port: Port) => {
    const result = await ownership(config, port, readLease(config, port));
    return result === 'unknown' ? undefined : result.pid;
  };
  const minimumOpen = async (client: Lobby) => client.list(list => list.createAvailable);

  try {
    for (const port of workerPorts) assert.equal(await udpIsFree(port), true, `Fixed UDP port ${port} must be free`);
    assert.throws(() => readConfig({ ...env, CONTROL_ENDPOINT: '0.0.0.0:2569' }), /Invalid CONTROL_ENDPOINT/);
    assert.throws(() => readConfig({ ...env, LOBBY_URL: 'ws://game.example.com' }), /Invalid LOBBY_URL/);
    assert.throws(() => readConfig({ ...env, ADMISSION_TTL_MS: '30001' }), /Invalid ADMISSION_TTL_MS/);
    writeFileSync(join(temp, 'invalid'), 'invalid', { mode: 0o600 });
    assert.throws(() => readConfig({ ...env, ADMISSION_SECRET_FILE: join(temp, 'invalid') }), /^Error: Invalid ADMISSION_SECRET_FILE$/);
    const external = createSocket('udp4');
    external.bind(7780, '0.0.0.0');
    await once(external, 'listening');
    let externalBound = true;
    t.after(() => { if (externalBound) external.close(); });
    await start();
    let observer = await enter();
    assert.equal((await observer.list(() => true)).createCode, 'recovering');
    await minimumOpen(observer);

    assert.equal((await observer.request('create', 'WrongBuild', undefined, 'bad-build',
      { protocol: PROTOCOL, clientBuild: 'other-map' })).error?.code, 'client_incompatible');
    assert.equal((await observer.request('join', 'WrongProtocol', 'other-room', 'bad-protocol',
      { protocol: PROTOCOL + 1, clientBuild: CLIENT_BUILD })).error?.code, 'client_incompatible');
    assert(workerPorts.every(port => !readLease(config, port)), 'Incompatible peer allocated a lease');
    const cancelled = await enter();
    cancelled.send('create', { requestId: 'cancel-create', name: 'CancelBefore', role: 2,
      protocol: PROTOCOL, clientBuild: CLIENT_BUILD });
    await waitFor('worker allocated for early cancel', () => readdirSync(temp).includes('prebind'));
    cancelled.send('cancel', { requestId: 'cancel-create' });
    await waitFor('cancelled creator lease release', () => !readLease(config, 7778));
    assert(!cancelled.messages.some(item => item.type === 'admission'));
    assert.equal(await udpIsFree(7778), true);
    unlinkSync(markerFile);

    const abandoned = await enter();
    abandoned.send('create', { requestId: 'before-ticket', name: 'BeforeTicket', role: 2,
      protocol: PROTOCOL, clientBuild: CLIENT_BUILD });
    await waitFor('delayed worker before UDP bind', () => readdirSync(temp).includes('prebind'));
    abandoned.close();
    const delayed = readLease(config, 7778);
    const delayedPid = await owner(7778);
    assert(delayed && delayedPid);
    assert.equal(await udpIsFree(7778), true);
    await exit(manager, 'SIGKILL');
    await start();
    observer = await enter();
    await minimumOpen(observer);
    const drop = await enter();
    const unclaimed = ticket(await request(drop, 'create', 'Unclaimed'));
    assert.equal(unclaimed.udpEndpoint.port, 7779);
    assert.equal(await owner(7778), delayedPid);
    assert.equal(readLease(config, 7778)?.roomId, delayed.roomId);
    assert.equal((await observer.list(() => true)).rooms.length, 0);
    await observer.list(list => list.createCode === 'server_full');
    assert.equal((await request(observer, 'create', 'Occupied')).error?.message, 'Server full');
    external.close();
    externalBound = false;
    await minimumOpen(observer);
    drop.close();
    await waitFor('unclaimed worker exit after ticket TTL', () => !readLease(config, 7779));
    await waitFor('prebind worker eventual exit', () => !readLease(config, 7778), 15000);
    t.diagnostic('Recovered ownership before UDP bind and expired both unpublished rooms after socket loss.');

    const host = await enter();
    const alice = ticket(await request(host, 'create', 'Alice-Long-Room-Name', undefined, 'create-alice'));
    const same = ticket(await request(host, 'create', 'Alice-Long-Room-Name', undefined, 'create-alice'));
    assert(same.ticketId === alice.ticketId && same.secret === alice.secret && same.ttlMs <= alice.ttlMs);
    assert.equal(alice.udpEndpoint.port, 7778);
    assert.equal((await observer.list(() => true)).rooms.length, 0);
    assert.equal((await request(observer, 'join', 'TooSoon', alice.roomId)).error?.code, 'room_not_found');
    const mismatchedWorker = await enet(alice, 'wrong_content', 'incompatible_content');
    assert.equal(await exit(mismatchedWorker.child), 0);
    const creator = await enet(alice);
    await observer.list(list => room(list, alice.roomId)?.name === 'Alice-Long-Room-');
    assert.equal((await request(host, 'create', 'Alice-Long-Room-Name', undefined, 'create-alice')).error?.code, 'admitted');
    host.close();
    await observer.list(list => room(list, alice.roomId)?.humans === 1);
    const canceller = await enter();
    const first = ticket(await request(canceller, 'join', 'EarlyCancel', alice.roomId));
    canceller.send('cancel', { requestId: first.requestId });
    const second = ticket(await request(canceller, 'join', 'EarlyCancel', alice.roomId));
    assert.notEqual(second.ticketId, first.ticketId);
    canceller.send('cancel', { requestId: second.requestId });
    canceller.send('join', { requestId: 'cancel-queued', name: 'EarlyCancel', role: 2, roomId: alice.roomId,
      protocol: PROTOCOL, clientBuild: CLIENT_BUILD });
    canceller.send('cancel', { requestId: 'cancel-queued' });
    const third = ticket(await request(canceller, 'join', 'EarlyCancel', alice.roomId));
    canceller.send('cancel', { requestId: third.requestId });
    await observer.list(list => room(list, alice.roomId)?.available === 4);
    assert(!canceller.messages.some(item => item.type === 'admission' &&
      'requestId' in item.data && item.data.requestId === 'cancel-queued'));

    const activeHost = await enter();
    const active = ticket(await request(activeHost, 'create', 'Carol'));
    assert.equal(active.udpEndpoint.port, unclaimed.udpEndpoint.port);
    assert(active.generation !== unclaimed.generation);
    const replay = await enet({ ...unclaimed, generation: active.generation, roomId: active.roomId }, 'stale_ticket', 'invalid_ticket');
    assert.equal(await exit(replay.child), 0);
    const activeCreator = await enet(active, 'play');
    activeHost.close();
    await observer.list(list => !!room(list, active.roomId));
    const invalidated = ticket(await request(canceller, 'join', 'BetweenTicketAndProof', active.roomId));
    const activePeers = await Promise.all([enter(), enter()]);
    const teammates = await Promise.all(activePeers.map((client, index) =>
      request(client, 'join', `Team${index}`, active.roomId)));
    const proofFile = join(temp, 'complete-invalidated-proof');
    const started = await enet(invalidated, 'stale_ticket', 'room_started', proofFile);
    const activeTeam = await Promise.all(teammates.map(response => enet(ticket(response), 'play')));
    activePeers.forEach(client => client.close());
    await observer.list(list => room(list, active.roomId)?.state === 'playing');
    await waitFor('room_started delivered to the original directory session', () => canceller.messages.some(item =>
      item.type === 'room_started' && 'requestId' in item.data && item.data.requestId === invalidated.requestId));
    assert(!sockets.filter(socket => socket !== canceller).some(socket =>
      socket.messages.some(item => item.type === 'room_started')));
    writeFileSync(proofFile, '');
    assert.equal(await exit(started.child), 0);
    assert(started.child.text.includes('CLIENT result room_started'));
    assert.equal((await request(observer, 'join', 'Late', active.roomId)).error?.code, 'room_started');

    const drain = join(stateDir, 'drain');
    writeFileSync(drain, '', { mode: 0o600 });
    await observer.list(list => list.createCode === 'server_draining' &&
      room(list, active.roomId)?.state === 'playing' && room(list, alice.roomId)?.joinable === false);
    assert.equal((await request(observer, 'create', 'DuringDrain')).error?.code, 'server_draining');
    assert.equal((await request(observer, 'join', 'DuringDrain', alice.roomId)).error?.code, 'server_draining');
    unlinkSync(drain);
    await observer.list(list => list.createAvailable && room(list, alice.roomId)?.joinable === true);

    const lastHost = await enter();
    const last = ticket(await request(lastHost, 'create', 'EmptyTimer'));
    const emptyPeer = await enet(last);
    lastHost.close();
    assert.equal(last.udpEndpoint.port, 7780);
    await observer.list(list => list.rooms.length === 3 && !list.createAvailable);
    const fourth = await request(observer, 'create', 'Fourth', undefined, 'fourth');
    assert.equal(fourth.error?.message, 'Server full');
    await observer.list(list => list.rooms.length === 3 && list.createCode === 'server_full');
    assert.equal(readdirSync(stateDir).filter(file => /^worker-\d+\.json$/.test(file)).length, 3);
    const sdk = watch(godot, ['--headless', '--log-file', join(temp, 'sdk.log'), '--path', root,
      '--script', 'tests/directory-client-check.gd'], { ...env, DIRECTORY_TEST_URL: `ws://127.0.0.1:${lobbyPort}` } as typeof env);
    assert.equal(await exit(sdk), 0, 'Native Godot SDK directory handshake');
    assert(sdk.text.includes('Godot Colyseus SDK received the room directory'));

    const peers = await Promise.all([enter(), enter(), enter(), enter(), enter()]);
    const firstThree = await Promise.all(peers.slice(0, 3).map((client, index) =>
      request(client, 'join', `Waiting${index}`, alice.roomId, 'shared-id')));
    await observer.list(list => room(list, alice.roomId)?.available === 1);
    const waiting = await Promise.all(firstThree.map(response => enet(ticket(response))));
    const finalSeat = await Promise.all(peers.slice(3).map((client, index) =>
      request(client, 'join', `Final${index}`, alice.roomId, 'shared-id')));
    assert.equal(finalSeat.filter(result => result.error?.code === 'full').length, 1);
    const winner = ticket(finalSeat.find(result => result.ticket)!);
    const winnerUntil = performance.now() + winner.ttlMs;
    await observer.list(list => {
      const entry = room(list, alice.roomId);
      return entry?.humans === 4 && entry.available === 0 && !entry.joinable;
    });
    await observer.list(list => performance.now() >= winnerUntil && room(list, alice.roomId)?.available === 1);
    const expired = await enet(winner, 'stale_ticket', 'invalid_ticket');
    assert.equal(await exit(expired.child), 0);
    const winnerIndex = finalSeat.findIndex(result => result.ticket);
    assert.equal((await request(peers[3 + winnerIndex], 'join', `Final${winnerIndex}`, alice.roomId, 'shared-id')).error?.code, 'expired');
    const loser = finalSeat.findIndex(result => result.error?.code === 'full');
    assert.equal((await request(peers[3 + loser], 'join', `Final${loser}`, alice.roomId, 'shared-id')).error?.code, 'full');
    const accepted = await enet(ticket(await request(peers[3 + loser], 'join', 'Replacement', alice.roomId)));
    await observer.list(list => room(list, alice.roomId)?.humans === 5);
    await accepted.leave();
    await creator.leave();
    await observer.list(list => room(list, alice.roomId)?.name === 'Waiting0' ||
      room(list, alice.roomId)?.name === 'Waiting1' || room(list, alice.roomId)?.name === 'Waiting2');
    t.diagnostic('Verified creator-first publication, three-room cap, concurrent final-seat arbitration, expiry, and leader name updates.');

    const idlePid = await owner(alice.udpEndpoint.port);
    const activePid = await owner(active.udpEndpoint.port);
    assert(idlePid && activePid);
    const lease = readLease(config, alice.udpEndpoint.port)!;
    const invalidHello = async (generation: string, pid: number, counter: string, signingKey: Buffer,
      reportSequence = 10000, replay = false) => {
      const socket = connect(controlPort, '127.0.0.1');
      await once(socket, 'connect');
      let dataBytes = 0;
      socket.on('data', chunk => { dataBytes += chunk.length; });
      const body = Buffer.from(JSON.stringify({ pid, nonce: randomBytes(32).toString('hex'), reportSequence })).toString('base64');
      const fields = ['1', 'worker', lease.roomId, generation, String(alice.udpEndpoint.port), counter, 'hello', body];
      const signature = sign(signingKey, ['hold-til-dawn/control', ...fields]).toString('hex');
      const frame = Buffer.from(JSON.stringify([...fields, signature]));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(frame.length);
      const wire = Buffer.concat([header, frame]);
      socket.write(wire);
      if (replay) {
        await waitFor('manager challenge', () => dataBytes > 0);
        socket.write(wire);
      }
      await once(socket, 'close');
      if (!replay) assert.equal(dataBytes, 0);
    };
    await invalidHello(randomUUID(), idlePid, '1', config.hostKey);
    await invalidHello(lease.generation, activePid, '1', config.hostKey);
    await invalidHello(lease.generation, idlePid, '2', config.hostKey);
    await invalidHello(lease.generation, idlePid, '1', randomBytes(32));
    await invalidHello(lease.generation, idlePid, '1', config.hostKey, 0);
    await invalidHello(lease.generation, idlePid, '1', config.hostKey, 10000, true);

    const beforeQuiet = lastControl;
    await waitFor('fresh control heartbeat', () => lastControl > beforeQuiet);
    dropControl = true;
    try {
      await sleep(1600);
      assert.equal(room(await observer.list(() => true), alice.roomId)?.state, 'waiting',
        'A silence longer than the previous deadline should preserve the room');
      await observer.list(list => room(list, alice.roomId)?.state === 'recovering');
      assert.equal((await request(observer, 'join', 'DuringGap', alice.roomId)).error?.code, 'recovering');
      assert.equal((await request(observer, 'create', 'StillFull')).error?.code, 'server_full');
    } finally {
      dropControl = false;
    }
    await observer.list(list => room(list, alice.roomId)?.joinable === true);
    assert.equal(await owner(alice.udpEndpoint.port), idlePid);

    await emptyPeer.leave();
    await observer.list(list => room(list, last.roomId)?.humans === 0);
    const emptyStarted = performance.now();
    const samples = activeCreator.child.text.split('CLIENT sample ').length;
    sockets.forEach(client => client.close());
    await exit(manager, 'SIGKILL');
    await waitFor('active room samples without manager', () => activeCreator.child.text.split('CLIENT sample ').length > samples + 2);
    const gameSamples = [...activeCreator.child.text.matchAll(/CLIENT sample (-?\d+) ([\d.]+) \d+/g)].slice(-3);
    assert(gameSamples.length === 3 && gameSamples[0][1] === gameSamples[2][1] &&
      Number(gameSamples[0][2]) > Number(gameSamples[2][2]));
    await start();
    observer = await enter();
    await observer.list(list => list.rooms.length === 3 && list.createCode === 'server_full');
    assert.equal(await owner(alice.udpEndpoint.port), idlePid);
    assert.equal(await owner(active.udpEndpoint.port), activePid);
    assert.equal((await request(observer, 'join', 'AfterCrash', active.roomId)).error?.code, 'room_started');
    assert((await request(observer, 'join', 'WaitingAfterCrash', alice.roomId)).ticket !== undefined);

    // A returning human resets the worker's empty timer. Measure a full idle interval after that return.
    const returned = await enet(ticket(await request(observer, 'join', 'Returned', last.roomId)));
    assert(performance.now() - emptyStarted < 60000);
    await sleep(3000);
    await returned.leave();
    await observer.list(list => room(list, last.roomId)?.humans === 0);
    const restartedEmpty = performance.now();
    await observer.list(list => !room(list, last.roomId) && list.createAvailable, 65000);
    const emptyElapsed = performance.now() - restartedEmpty;
    assert(emptyElapsed >= 59500 && emptyElapsed <= 63500, `Empty worker exited after ${Math.round(emptyElapsed)} ms`);
    assert.equal(await udpIsFree(7780), true);
    assert(waiting.every(peer => peer.child.process.exitCode === null && peer.child.process.signalCode === null),
      'Waiting players survived directory recovery and the isolated control outage');
    const replacementHost = await enter();
    const replacement = ticket(await request(replacementHost, 'create', 'ReusedPort', undefined, 'reused'));
    assert.equal(replacement.udpEndpoint.port, 7780);
    assert(replacement.generation !== last.generation);
    const old = await enet({ ...last, roomId: replacement.roomId, generation: replacement.generation }, 'stale_ticket', 'invalid_ticket');
    assert.equal(await exit(old.child), 0);
    assert.equal((await request(observer, 'create', 'Fourth', undefined, 'fourth')).error?.code, 'server_full');
    const replacementPid = await owner(7780);
    assert(replacementPid);
    process.kill(replacementPid, 'SIGKILL');
    await observer.list(list => list.createAvailable);
    assert.equal((await request(replacementHost, 'create', 'ReusedPort', undefined, 'reused')).error?.code, 'unavailable');
    await Promise.all([activeCreator, ...activeTeam].map(peer => peer.leave()));
    await observer.list(list => room(list, active.roomId)?.state === 'result');
    assert.equal((await request(observer, 'join', 'DuringResult', active.roomId)).error?.code, 'room_started');
    await observer.list(list => room(list, active.roomId)?.state === 'waiting', 12000);
    const nextMatch = ticket(await request(observer, 'join', 'BetweenMatches', active.roomId));
    assert(nextMatch.generation === active.generation);
    await enet(nextMatch);
    const final = ticket(await request(replacementHost, 'create', 'FreshAfterDeath'));
    assert(final.udpEndpoint.port === 7780 && final.generation !== replacement.generation);
    t.diagnostic(`Verified worker survival, unchanged PIDs, authenticated recovery, and port reuse after ${Math.round(emptyElapsed)} ms empty.`);

    assert.equal(await exit(manager, 'SIGTERM'), 0);
    for (const port of workerPorts) {
      assert.equal(await udpIsFree(port), true);
      assert.equal(readLease(config, port), undefined);
    }
    writeFileSync(drain, '', { mode: 0o600 });
    await start();
    const rehearsal = await enter();
    await rehearsal.list(list => list.createCode === 'server_draining');
    const directoryCheck = watch(process.execPath,
      [fileURLToPath(new URL('../src/check-directory-compatibility.js', import.meta.url)), String(lobbyPort)]);
    assert.equal(await exit(directoryCheck), 0, 'Drained directory compatibility probe');
    manager.process.kill('SIGUSR2');
    const health = `http://127.0.0.1:${lobbyPort}/health`;
    const checkDeadline = performance.now() + 10000;
    let releaseCheck = '';
    while (performance.now() < checkDeadline) {
      ({ releaseCheck } = await (await fetch(health)).json());
      if (['passed', 'failed'].includes(releaseCheck)) break;
      await sleep(50);
    }
    assert.equal(releaseCheck, 'passed');
    for (const port of workerPorts) {
      assert.equal(await udpIsFree(port), true);
      assert.equal(readLease(config, port), undefined);
    }
    await rehearsal.list(list => list.createCode === 'server_draining' && list.rooms.length === 0);
    assert.equal(await exit(manager, 'SIGTERM'), 0);
    const publicMessages = sockets.flatMap(client => client.messages.filter(item => item.type !== 'admission'));
    const publicText = JSON.stringify(publicMessages) + processes.map(child => child.text).join('\n');
    assert(!issued.some(assignment => publicText.includes(assignment.secret) || publicText.includes(assignment.ticketId)),
      'Admission material escaped direct responses');
    assert(!publicText.includes(readFileSync(keyPath, 'utf8').trim()), 'Host recovery credential escaped');
    assert(!sockets.filter(client => client !== drop).some(client => client.messages.some(item =>
      item.type === 'admission' && 'ticketId' in item.data && item.data.ticketId === unclaimed.ticketId)),
      'An unrelated connection received the creator ticket');
    assert(frameViolations.length === 0, `Relayed control frames violated worker-control.schema.json:\n${frameViolations.join('\n')}`);
    const observed = (direction: 'worker' | 'manager') => {
      const totals = new Map<string, number>();
      for (const counts of relayedCounts) {
        for (const [type, count] of counts[direction].counts) totals.set(type, (totals.get(type) ?? 0) + count);
      }
      return totals;
    };
    const totals = { worker: observed('worker'), manager: observed('manager') };
    t.diagnostic(`relayed worker frames ${JSON.stringify(Object.fromEntries(totals.worker))}`);
    t.diagnostic(`relayed manager frames ${JSON.stringify(Object.fromEntries(totals.manager))}`);
    assert([...totals.worker.values()].reduce((sum, count) => sum + count, 0) > 0, 'No worker frames were validated');
    assert([...totals.manager.values()].reduce((sum, count) => sum + count, 0) > 0, 'No manager frames were validated');
    for (const type of ['hello', 'challenge', 'register', 'registered', 'ready', 'heartbeat', 'ping', 'reserve', 'reservation']) {
      const direction = ['challenge', 'registered', 'ping', 'reserve'].includes(type) ? 'manager' : 'worker';
      assert((totals[direction].get(type) ?? 0) > 0, `No relayed ${type} frame was validated`);
    }
  } finally {
    sockets.forEach(client => client.close());
    if (manager && manager.process.exitCode === null && manager.process.signalCode === null) {
      await exit(manager, 'SIGTERM').catch(() => manager.process.kill('SIGKILL'));
    }
    for (const port of workerPorts) {
      const pid = await owner(port);
      if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }
    }
    await Promise.all(processes.map(child => exit(child, 'SIGKILL')));
  }
});
