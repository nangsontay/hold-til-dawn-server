import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { hex, isObject, token } from './config.js';

const maxFrame = 8192;
export const heartbeatMs = 2800;
export const sign = (key: Buffer, fields: (number | string)[]) =>
  createHmac('sha256', key).update(fields.join('\n')).digest();

export type Context = [roomId: string, generation: string, port: string];
type Message = { context: Context; type: string; data: Record<string, unknown> };

export class Control {
  private incoming: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private received = 0;
  private sent = 0;
  context?: Context;

  constructor(readonly socket: Socket, public key: Buffer, receive: (msg: Message) => void) {
    socket.setNoDelay(true);
    socket.setTimeout(heartbeatMs, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (chunk.length + this.incoming.length > 128 * 1024) {
        socket.destroy();
        return;
      }
      this.incoming = Buffer.concat([this.incoming, chunk]);
      try {
        while (!socket.destroyed && this.incoming.length >= 4) {
          const length = this.incoming.readUInt32BE();
          if (length === 0 || length > maxFrame) throw Error();
          if (this.incoming.length < 4 + length) break;
          const frame = this.incoming.subarray(4, length + 4);
          this.incoming = this.incoming.subarray(length + 4);
          receive(this.decode(frame));
        }
      } catch {
        socket.destroy();
      }
    });
  }

  private decode(frame: Buffer): Message {
    const record: unknown = JSON.parse(frame.toString('utf8'));
    if (!Array.isArray(record) || record.length !== 9 || record.some(value => typeof value !== 'string')) throw Error();
    const [version, direction, roomId, generation, port, counter, type, body, mac] = record;
    const context: Context = [roomId, generation, port];
    if (version !== '1' || direction !== 'worker' || counter !== String(this.received + 1) || !token(type) ||
        !token(roomId) || !token(generation) || !hex(mac, 64) ||
        this.context?.some((field, index) => field !== context[index])) throw Error();
    const expected = sign(this.key, ['hold-til-dawn/control', ...record.slice(0, 8)]);
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw Error();
    const bytes = Buffer.from(body, 'base64');
    if (bytes.toString('base64') !== body) throw Error();
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isObject(data)) throw Error();
    this.received++;
    return { context, type, data };
  }

  send(type: string, data: object = {}) {
    if (!this.context || this.socket.destroyed || this.socket.writableLength > maxFrame) {
      this.socket.destroy();
      return false;
    }
    const body = Buffer.from(JSON.stringify(data)).toString('base64');
    const fields = ['1', 'manager', ...this.context, String(++this.sent), type, body];
    const signature = sign(this.key, ['hold-til-dawn/control', ...fields]).toString('hex');
    const record = Buffer.from(JSON.stringify([...fields, signature]));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(record.length);
    this.socket.write(Buffer.concat([header, record]));
    return true;
  }
}
