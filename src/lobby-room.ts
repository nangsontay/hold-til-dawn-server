import { randomUUID } from 'node:crypto';
import { Room, type Client } from '@colyseus/core';
import { CLIENT_BUILD, PROTOCOL } from './compatibility.js';
import { integer, isObject, token } from './config.js';
import { type Operation, type Reply, type WorkerManager } from './worker-manager.js';

type Directory = ReturnType<WorkerManager['directory']>;
type Request = { operation: Operation; pending?: Promise<Reply>; terminal?: Reply };
type Session = { identity: string; requests: Map<string, Request> };
const errorMessages = new Map([
  ['server_full', 'Server full'], ['server_draining', 'Server maintenance'], ['full', 'Room full'], ['room_started', 'Room is in progress'],
  ['room_not_found', 'Room is no longer available'], ['recovering', 'Room directory is recovering'],
  ['expired', 'Reservation expired'], ['admitted', 'Ticket already used'], ['busy', 'Too many requests'],
  ['invalid_request', 'Invalid request'], ['request_conflict', 'Request ID was already used'],
  ['identity_in_use', 'A seat is already held for this session'],
  ['client_incompatible', 'Game build does not match the server'], ['degraded', 'Server offline'],
]);

export function lobbyRoom(manager: WorkerManager) {
  return class LobbyRoom extends Room {
    maxClients = 256;
    maxMessagesPerSecond = 10;
    private readonly sessions = new Map<Client, Session>();
    private readonly push = (list: Directory) => this.broadcast('rooms', list);

    onCreate() {
      manager.on('directory', this.push);
      this.onMessage('list', client => client.send('rooms', manager.directory()));
      this.onMessage('create', (client, message: unknown) => { void this.request(client, message, true); });
      this.onMessage('join', (client, message: unknown) => { void this.request(client, message, false); });
      this.onMessage('cancel', (client, message: unknown) => {
        if (!isObject(message) || !token(message.requestId)) return;
        const request = this.sessions.get(client)?.requests.get(message.requestId);
        if (request) manager.cancel(request.operation);
      });
    }

    onJoin(client: Client) {
      this.sessions.set(client, { identity: randomUUID(), requests: new Map() });
      client.send('rooms', manager.directory());
    }

    onLeave(client: Client) {
      for (const { operation } of this.sessions.get(client)?.requests.values() ?? []) {
        operation.onRoomStarted = undefined;
      }
      this.sessions.delete(client);
    }

    onDispose() {
      manager.off('directory', this.push);
    }

    private reply(client: Client, requestId: string, result: Reply) {
      if (result.ticket) {
        client.send('admission', { requestId, ...result.ticket });
      } else {
        client.send('admission_error', { requestId, code: result.code,
          message: errorMessages.get(result.code) ?? 'Room is unavailable' });
        client.send('rooms', manager.directory());
      }
    }

    private async request(client: Client, data: unknown, creator: boolean) {
      const session = this.sessions.get(client);
      if (!session) return;
      const requestId = isObject(data) && token(data.requestId) ? data.requestId : '';
      if (requestId && isObject(data) && (data.protocol !== PROTOCOL || data.clientBuild !== CLIENT_BUILD)) {
        this.reply(client, requestId, { code: 'client_incompatible' });
        return;
      }
      const fullName = isObject(data) && typeof data.name === 'string' ? data.name.trim() : '';
      const characters = [...fullName];
      const name = characters.slice(0, 16).join('');
      const roomId = !creator && isObject(data) && token(data.roomId) ? data.roomId : undefined;
      const role = isObject(data) ? data.role : undefined;
      if (!requestId || !name || characters.length > 64 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(fullName) ||
          !integer(role, 0, 2) || (!creator && !roomId)) {
        this.reply(client, requestId, { code: 'invalid_request' });
        return;
      }
      let request = session.requests.get(requestId);
      if (!request) {
        if (session.requests.size >= 256) {
          this.reply(client, requestId, { code: 'busy' });
          return;
        }
        request = { operation: { identity: session.identity, requestId: randomUUID(), roomId, name, role } };
        const tracked = request;
        request.operation.onRoomStarted = () => {
          tracked.terminal = { code: 'room_started' };
          if (this.sessions.get(client) === session) client.send('room_started', { requestId });
        };
        session.requests.set(requestId, request);
      }
      const operation = request.operation;
      if (name !== operation.name || role !== operation.role || roomId !== operation.roomId) {
        this.reply(client, requestId, { code: 'request_conflict' });
        return;
      }
      // Each socket gets one delivery for concurrent duplicate clicks, and may retry once the reply settles.
      if (request.pending || operation.cancelled) return;
      const retry = request.terminal !== undefined;
      request.pending = request.terminal ? Promise.resolve(request.terminal) :
        manager.admit(operation, creator).catch(() => ({ code: 'unavailable' }));
      const result = await request.pending;
      request.pending = undefined;
      if (operation.cancelled || !retry && request.terminal?.code === 'room_started') return;
      if (!result.ticket) request.terminal = result;
      if (this.sessions.get(client) === session) this.reply(client, requestId, result);
    }
  };
}
