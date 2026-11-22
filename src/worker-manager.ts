import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { CONTENT, PROTOCOL } from './compatibility.js';
import { type Config, type Port, hex, integer, ports, sleep, token } from './config.js';
import { Control, heartbeatMs, sign } from './worker-control.js';
import { type Lease, type Owner, ownership, readLease, startWorker, stopWorker, udpIsFree, writeLease } from './worker-process.js';

const recoverMs = 2000;
const startupMs = 6000;
const requestMs = 2000;
const states = ['waiting', 'playing', 'timeout', 'result'];
const reservationCodes = new Set([
  'reserved', 'invalid_request', 'expired', 'recovering', 'request_conflict', 'room_started', 'creator_pending',
  'creator_exists', 'full', 'identity_in_use', 'busy', 'unavailable', 'cancelled', 'admitted', 'insertion_failed',
]);

type Projection = { name: string; humans: number; capacity: number; mode: number; state: string;
  available: number; creatorAdmitted: boolean; pending: number };
type Credential = { roomId: string; generation: string; udpEndpoint: { host: string; port: Port };
  ticketId: string; secret: string; ttlMs: number };
export type Reply = { code: string; ticket?: Credential };
export type Operation = { roomId?: string; name: string; role: number; identity: string; requestId: string;
  expiresAt?: number; slot?: Slot; lease?: Lease; cancelled?: boolean; onRoomStarted?: () => void };
type Reservation = { operation: Operation; expiresAt: number; finish?: (reply: Reply) => void;
  settled?: 'delivered' | 'without-ticket' };
type Probe = { lease?: Lease; at: number; result?: Owner; pending?: Promise<Owner> };
type Slot = {
  port: Port; status: 'recovering' | 'free' | 'starting' | 'owned'; lease?: Lease; pid?: number;
  control?: Control; snapshot?: Projection; sequence: number; lastReport: number; reportAt?: number;
  stopAt?: number; closedLease?: Lease; probe?: Probe; reservations: Map<string, Reservation>;
};

export class WorkerManager extends EventEmitter {
  private readonly slots: Slot[];
  private readonly listener = createServer(socket => this.accept(socket));
  private readonly sockets = new Set<Socket>();
  private timer?: NodeJS.Timeout;
  private recoverUntil = Infinity;
  private ticking = false;
  private closing = false;
  private lastList = '';
  releaseCheck: 'idle' | 'running' | 'passed' | 'failed' = 'idle';

  constructor(private readonly config: Config, private readonly probeOwner = ownership) {
    super();
    this.slots = ports.map(port => ({
      port, status: 'recovering', lease: readLease(config, port),
      sequence: 0, lastReport: 0, reservations: new Map(),
    }));
  }

  async start() {
    this.listener.listen(this.config.controlPort, '127.0.0.1');
    await once(this.listener, 'listening');
    this.recoverUntil = performance.now() + recoverMs;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tick().catch(() => this.emit('fault')).finally(() => { this.ticking = false; });
    }, 200);
  }

  private online(slot: Slot) {
    return slot.status === 'owned' && !!slot.control && !slot.control.socket.destroyed &&
      performance.now() - slot.lastReport < heartbeatMs && slot.stopAt === undefined;
  }

  draining() {
    return existsSync(join(this.config.stateDir, 'drain'));
  }

  directory() {
    const draining = this.draining();
    const degraded = this.slots.some(slot => slot.probe?.result === 'unknown');
    const recovering = performance.now() < this.recoverUntil || this.slots.some(slot => slot.probe?.result === undefined);
    const roomsOpen = !draining && !degraded && !recovering && !this.closing;
    const rooms = this.slots.flatMap(slot => {
      const { snapshot, lease } = slot;
      if (!lease || !snapshot?.creatorAdmitted) return [];
      const online = this.online(slot);
      const { name, humans, capacity, mode, state, available } = snapshot;
      return [{ roomId: lease.roomId, name, humans, capacity, mode, state: online ? state : 'recovering',
        available: online ? available : 0, joinable: roomsOpen && online && state === 'waiting' && available > 0 }];
    });
    const free = this.slots.filter(slot => slot.status === 'free').length;
    const createCode = this.closing ? 'unavailable' : degraded ? 'degraded' : recovering ? 'recovering' :
      draining ? 'server_draining' : free === 0 ? 'server_full' : null;
    return { rooms, createAvailable: createCode === null, createCode };
  }

  private probe(slot: Slot) {
    const cached = slot.probe;
    const now = performance.now();
    const interval = slot.status === 'starting' || slot.stopAt !== undefined ? 200 : 1000;
    if (cached && cached.lease === slot.lease) {
      if (cached.pending) return cached.pending;
      if (now - cached.at < interval && cached.result !== undefined) return Promise.resolve(cached.result);
    }
    const probe: Probe = { at: now, lease: slot.lease, result: cached?.result };
    slot.probe = probe;
    probe.pending = this.probeOwner(this.config, slot.port, slot.lease)
      .catch(() => 'unknown' as const)
      .then(result => {
        probe.result = result;
        probe.pending = undefined;
        return result;
      });
    return probe.pending;
  }

  private publish() {
    const list = this.directory();
    const serialized = JSON.stringify(list);
    if (serialized === this.lastList) return;
    this.lastList = serialized;
    this.emit('directory', list);
  }

  private accept(socket: Socket) {
    if (this.sockets.size >= 24) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let slot: Slot | undefined;
    let lease: Lease | undefined;
    let pid: number;
    let sequence: number;
    let challenged = false;
    let registered = false;
    let ready = false;
    const control = new Control(socket, this.config.hostKey, ({ context, type, data }) => {
      if (type === 'hello' && !slot) {
        const [roomId, generation, port] = context;
        slot = this.slots.find(candidate => String(candidate.port) === port);
        lease = slot?.lease;
        if (!slot || !lease || lease.roomId !== roomId || lease.generation !== generation ||
            this.slots.some(other => other !== slot && other.lease?.roomId === roomId) ||
            !integer(data.pid, 1) || !integer(data.reportSequence, slot.sequence) || !hex(data.nonce, 64) ||
            (slot.pid !== undefined && slot.pid !== data.pid)) throw Error();
        pid = data.pid;
        sequence = data.reportSequence;
        const workerNonce = data.nonce;
        const target = slot;
        void this.probe(target).then(owner => {
          if (socket.destroyed || target.lease !== lease || owner === 'unknown' || owner.pid !== pid) {
            socket.destroy();
            return;
          }
          const managerNonce = randomBytes(32).toString('hex');
          control.context = context;
          challenged = control.send('challenge', { workerNonce, managerNonce });
          control.key = sign(this.config.hostKey,
            ['hold-til-dawn/session', '1', ...context, pid, sequence, workerNonce, managerNonce]);
        });
        return;
      }
      if (!slot || !lease || slot.lease !== lease) throw Error();
      if (!registered) {
        const owner = slot.probe?.result;
        if (!challenged || type !== 'register' || data.pid !== pid || data.reportSequence !== sequence ||
            sequence < slot.sequence || slot.control && !slot.control.socket.destroyed ||
            owner === undefined || owner === 'unknown' || owner.pid !== pid) throw Error();
        slot.pid = pid;
        slot.sequence = sequence;
        slot.control = control;
        registered = true;
        control.send('registered');
        return;
      }
      if (slot.control !== control) throw Error();
      if (type === 'ready' || type === 'heartbeat' || type === 'creator_admitted') {
        if ((type === 'ready') === ready) throw Error();
        if (!integer(data.pid, 1) || data.pid !== pid || data.protocol !== PROTOCOL || data.content !== CONTENT ||
            typeof data.name !== 'string' || [...data.name].length > 16 ||
            !integer(data.humans, 0, 5) || !integer(data.mode, 0, 2) || data.capacity !== 5 ||
            !integer(data.available, 0, 5) || !integer(data.pending, 0, 5) || !integer(data.bots, 0, 5) ||
            data.humans + data.pending + data.bots + data.available > 5 ||
            typeof data.state !== 'string' || !states.includes(data.state) ||
            !integer(data.leader, 0) || typeof data.creatorAdmitted !== 'boolean' ||
            slot.snapshot?.creatorAdmitted && !data.creatorAdmitted ||
            type === 'creator_admitted' && !data.creatorAdmitted) throw Error();
        if (type === 'heartbeat') {
          if (!integer(data.sequence, slot.sequence + 1) || data.sequence !== slot.sequence + 1) throw Error();
          slot.sequence = data.sequence;
          control.send('ping');
        }
        ready = true;
        slot.snapshot = { name: data.name, humans: data.humans, capacity: 5, mode: data.mode, state: data.state,
          available: data.available, creatorAdmitted: data.creatorAdmitted, pending: data.pending };
        slot.status = 'owned';
        slot.lastReport = performance.now();
        slot.reportAt = Date.now();
        if (type === 'ready') {
          if (slot.stopAt !== undefined) control.send('close');
          else for (const [requestId, reservation] of slot.reservations) {
            if (reservation.operation.cancelled || reservation.settled === 'without-ticket') control.send('cancel', { requestId });
          }
        }
        this.publish();
      } else if (type === 'reservation') {
        this.reservation(slot, lease, data);
      } else if (type === 'reservation_cancelled') {
        if (!token(data.requestId) || data.reason !== 'room_started') throw Error();
        const reservation = slot.reservations.get(data.requestId);
        if (reservation && !reservation.operation.cancelled) {
          reservation.operation.onRoomStarted?.();
          reservation.finish?.({ code: 'room_started' });
          slot.reservations.delete(data.requestId);
        }
      } else if (type === 'cancellation') {
        // Explicit cancellation does not depend on a reply.
      } else if (type === 'closing' && data.code === 'closed') {
        slot.closedLease = lease;
        slot.status = 'recovering';
        this.invalidate(slot);
        this.publish();
      } else {
        throw Error();
      }
    });
    socket.once('close', () => {
      this.sockets.delete(socket);
      if (slot?.control === control) {
        slot.control = undefined;
        slot.status = 'recovering';
        this.invalidate(slot);
        this.publish();
      }
    });
  }

  private reservation(slot: Slot, lease: Lease, data: Record<string, unknown>) {
    if (!token(data.requestId) || typeof data.code !== 'string' || !reservationCodes.has(data.code)) throw Error();
    const reservation = slot.reservations.get(data.requestId);
    if (!reservation) return;
    const { operation, finish } = reservation;
    if (operation.cancelled || reservation.settled === 'without-ticket') {
      if (data.code === 'reserved') slot.control?.send('cancel', { requestId: data.requestId });
      return;
    }
    if (data.code !== 'reserved') {
      finish?.({ code: data.code });
      return;
    }
    if (!hex(data.ticketId, 32) || !hex(data.secret, 64) || !integer(data.ttlMs, 1, this.config.ticketMs)) throw Error();
    if (finish && (Date.now() >= reservation.expiresAt || !this.online(slot) || slot.snapshot?.state !== 'waiting')) {
      finish({ code: Date.now() >= reservation.expiresAt ? 'expired' : 'unavailable' });
      slot.control?.send('cancel', { requestId: data.requestId });
      return;
    }
    finish?.({ code: 'reserved', ticket: {
      roomId: lease.roomId, generation: lease.generation,
      udpEndpoint: { host: this.config.workerHost, port: slot.port },
      ticketId: data.ticketId, secret: data.secret, ttlMs: data.ttlMs,
    } });
  }

  private invalidate(slot: Slot) {
    for (const reservation of slot.reservations.values()) reservation.finish?.({ code: 'unavailable' });
  }

  private async tick() {
    await Promise.all(this.slots.map(slot => this.tickSlot(slot)));
    this.publish();
  }

  private async tickSlot(slot: Slot) {
    const now = Date.now();
    for (const [id, reservation] of slot.reservations) {
      if (now >= reservation.expiresAt) {
        reservation.finish?.({ code: 'expired' });
        // Retain the outcome through the control heartbeat deadline for late replies.
        if (now >= reservation.expiresAt + heartbeatMs) slot.reservations.delete(id);
      }
    }
    const lease = slot.lease;
    const owner = await this.probe(slot);
    if (slot.lease !== lease) return;
    if (slot.status === 'owned' && slot.control &&
        (performance.now() - slot.lastReport >= heartbeatMs || owner !== 'unknown' && owner.pid !== slot.pid)) {
      slot.control.socket.destroy();
      slot.status = 'recovering';
      this.invalidate(slot);
    }
    if (lease && slot.stopAt === undefined && (
      (this.online(slot) && !slot.snapshot?.creatorAdmitted && slot.snapshot?.pending === 0 &&
          (slot.reportAt ?? 0) >= lease.creatorExpiry) ||
      (slot.status === 'starting' && now >= lease.launchDeadline)
    )) this.closeSlot(slot);
    if (owner === 'unknown') return;
    if (slot.status === 'free') {
      if (owner.busy) slot.status = 'recovering';
      return;
    }
    if (lease && owner.busy && slot.stopAt !== undefined && now >= slot.stopAt + 2000) {
      await stopWorker(this.config, slot.port, owner, now >= slot.stopAt + 4000).catch(() => {
        if (slot.probe) slot.probe.result = 'unknown';
      });
    }
    if (owner.busy || performance.now() < this.recoverUntil ||
        (lease && !slot.pid && now < lease.launchDeadline)) return;
    if (slot.control && !slot.control.socket.destroyed) return;
    const portFree = await udpIsFree(slot.port);
    if (slot.lease !== lease || slot.control && !slot.control.socket.destroyed) return;
    if (lease) {
      writeLease(this.config, slot.port);
      console.log('Worker released room=%s generation=%s udp=%d', lease.roomId, lease.generation, slot.port);
    }
    this.invalidate(slot);
    slot.reservations.clear();
    Object.assign(slot, { status: portFree ? 'free' : 'recovering', lease: undefined, pid: undefined, snapshot: undefined,
      sequence: 0, lastReport: 0, reportAt: undefined, stopAt: undefined });
  }

  private closeSlot(slot: Slot) {
    slot.stopAt = Date.now();
    slot.control?.send('close');
    this.invalidate(slot);
    this.publish();
  }

  private reserve(slot: Slot, op: Operation, creator: boolean): Promise<Reply> {
    if (op.cancelled) return Promise.resolve({ code: 'cancelled' });
    if (!this.online(slot) || !op.expiresAt || slot.lease !== op.lease) return Promise.resolve({ code: 'unavailable' });
    const expiresAt = op.expiresAt;
    return new Promise(resolve => {
      const reservation: Reservation = { operation: op, expiresAt, finish };
      const timer = setTimeout(() => finish({ code: 'unavailable' }), requestMs);
      slot.reservations.set(op.requestId, reservation);
      const { requestId, name, role, identity } = op;
      if (!slot.control?.send('reserve', { requestId, name, role, identity, creator, expiresAt })) finish({ code: 'unavailable' });

      function finish(reply: Reply) {
        clearTimeout(timer);
        reservation.finish = undefined;
        reservation.settled = reply.ticket ? 'delivered' : 'without-ticket';
        resolve(reply);
      }
    });
  }

  cancel(op: Operation) {
    op.cancelled = true;
    const slot = op.slot;
    if (!slot || slot.lease !== op.lease) return;
    const reservation = slot.reservations.get(op.requestId);
    if (reservation) {
      reservation.finish?.({ code: 'cancelled' });
      slot.control?.send('cancel', { requestId: op.requestId });
    } else if (!op.roomId && op.expiresAt === undefined && slot.stopAt === undefined) {
      this.closeSlot(slot);
    }
  }

  async admit(op: Operation, creator: boolean, releaseCheck = false): Promise<Reply> {
    if (this.closing) return { code: 'unavailable' };
    if (op.cancelled) return { code: 'cancelled' };
    const { createCode } = this.directory();
    if (createCode === 'degraded' || createCode === 'recovering' ||
        createCode === 'server_draining' && !releaseCheck) return { code: createCode };
    if (op.expiresAt && Date.now() >= op.expiresAt) return { code: 'expired' };
    if (op.slot && op.slot.lease !== op.lease) return { code: 'unavailable' };
    if (!op.slot && creator) {
      const slot = this.slots.find(item => item.status === 'free');
      if (!slot) return { code: 'server_full' };
      const launchDeadline = Date.now() + startupMs;
      const lease = { roomId: randomUUID(), generation: randomUUID(), name: op.name, launchDeadline,
        creatorExpiry: launchDeadline };
      writeLease(this.config, slot.port, lease);
      console.log('Worker allocated room=%s generation=%s udp=%d', lease.roomId, lease.generation, slot.port);
      slot.status = 'starting';
      slot.lease = lease;
      slot.closedLease = undefined;
      op.slot = slot;
      op.lease = lease;
      this.publish();
      const failed = () => {
        if (slot.lease === lease && slot.stopAt === undefined) this.closeSlot(slot);
      };
      try {
        startWorker(this.config, slot.port, lease, failed);
        while (slot.lease === lease && !this.online(slot) && slot.stopAt === undefined && Date.now() < launchDeadline) {
          await sleep(20);
        }
      } catch {
        failed();
      }
      if (!this.online(slot) || slot.lease !== lease || this.closing || op.cancelled) {
        failed();
        return { code: 'unavailable' };
      }
      lease.creatorExpiry = Date.now() + this.config.ticketMs;
      writeLease(this.config, slot.port, lease);
      op.expiresAt = lease.creatorExpiry;
      const reply = await this.reserve(slot, op, true);
      if (reply.code !== 'reserved' && slot.lease === lease && slot.stopAt === undefined) this.closeSlot(slot);
      return reply;
    }
    if (!op.slot) {
      const slot = this.slots.find(item => item.lease?.roomId === op.roomId && item.snapshot?.creatorAdmitted);
      if (!slot) return { code: 'room_not_found' };
      if (!this.online(slot)) return { code: 'recovering' };
      if (slot.snapshot?.state !== 'waiting') return { code: 'room_started' };
      op.slot = slot;
      op.lease = slot.lease;
      op.expiresAt = Date.now() + this.config.ticketMs;
    }
    // Retries query the worker’s ledger, including tickets consumed since the first reply.
    if (op.slot.snapshot?.state !== 'waiting') return { code: 'room_started' };
    return this.reserve(op.slot, op, creator);
  }

  async checkRelease() {
    if (this.releaseCheck === 'running') return;
    if (this.directory().createCode !== 'server_draining' || this.slots.some(slot => slot.status !== 'free')) {
      this.releaseCheck = 'failed';
      return;
    }
    this.releaseCheck = 'running';
    const operations: Operation[] = this.slots.map(() => ({
      name: 'Release check', role: 0, identity: randomUUID(), requestId: randomUUID(),
    }));
    try {
      const replies = await Promise.allSettled(operations.map(op => this.admit(op, true, true)));
      for (const { slot, lease } of operations) {
        if (slot && slot.lease === lease && slot.stopAt === undefined) this.closeSlot(slot);
      }
      const deadline = performance.now() + 8000;
      while (this.slots.some(slot => slot.lease) && performance.now() < deadline) await sleep(50);
      this.releaseCheck = replies.every(result => result.status === 'fulfilled' && result.value.ticket) &&
        operations.every(({ slot, lease }) => slot && lease && slot.closedLease === lease && slot.status === 'free') &&
        this.directory().createCode === 'server_draining' ? 'passed' : 'failed';
    } catch {
      this.releaseCheck = 'failed';
    }
  }

  async shutdown() {
    this.closing = true;
    this.publish();
    for (const slot of this.slots) if (slot.lease && slot.stopAt === undefined) this.closeSlot(slot);
    const deadline = Date.now() + 10000;
    while (this.slots.some(slot => slot.lease) && Date.now() < deadline) await sleep(100);
    clearInterval(this.timer);
    for (const socket of this.sockets) socket.destroy();
    this.listener.close();
    return this.slots.every(slot => !slot.lease);
  }
}
