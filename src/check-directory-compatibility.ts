import { randomUUID } from 'node:crypto';
import { Protocol } from '@colyseus/shared-types';
import { decode, encode } from '@colyseus/schema';
import { pack, unpack } from 'msgpackr';
import { CLIENT_BUILD, PROTOCOL } from './compatibility.js';

async function check() {
  const host = `127.0.0.1:${process.argv[2] ?? 2567}`;
  const response = await fetch(`http://${host}/matchmake/joinOrCreate/directory`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw Error();
  const seat = await response.json();
  const ws = new WebSocket(`ws://${host}/${seat.processId}/${seat.roomId}?sessionId=${seat.sessionId}`);
  ws.binaryType = 'arraybuffer';
  const requests = [
    { type: 'create', protocol: PROTOCOL, clientBuild: CLIENT_BUILD, expected: 'server_draining' },
    { type: 'join', protocol: PROTOCOL, clientBuild: CLIENT_BUILD, expected: 'server_draining' },
    { type: 'create', protocol: PROTOCOL, clientBuild: 'incompatible', expected: 'client_incompatible' },
    { type: 'join', protocol: PROTOCOL + 1, clientBuild: CLIENT_BUILD, expected: 'client_incompatible' },
  ];
  const expected = new Map<string, string>();
  let sent = false;
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('close', () => reject(Error()), { once: true });
      ws.addEventListener('error', () => reject(Error()), { once: true });
      ws.addEventListener('message', event => {
        try {
          const bytes = new Uint8Array(event.data);
          if (bytes[0] === Protocol.JOIN_ROOM) {
            ws.send(Uint8Array.of(Protocol.JOIN_ROOM));
          } else if (bytes[0] === Protocol.ROOM_DATA) {
            const offset = { offset: 1 };
            const type = decode.string(bytes, offset);
            if (type === 'rooms' && !sent) {
              sent = true;
              for (const { type, protocol, clientBuild, expected: code } of requests) {
                const requestId = randomUUID();
                expected.set(requestId, code);
                const header = new Uint8Array(32);
                header[0] = Protocol.ROOM_DATA;
                const position = { offset: 1 };
                encode.string(header, type, position);
                ws.send(Buffer.concat([header.subarray(0, position.offset),
                  pack({ requestId, protocol, clientBuild, name: 'Release check', role: 0, roomId: 'release-check' })]));
              }
            } else if (type === 'admission_error') {
              const { requestId, code } = unpack(bytes.subarray(offset.offset));
              if (code !== expected.get(requestId) || !expected.delete(requestId)) throw Error();
              if (expected.size === 0) resolve();
            } else if (type === 'admission') {
              throw Error();
            }
          }
        } catch (error) {
          reject(error);
        }
      });
      AbortSignal.timeout(5000).addEventListener('abort', () => reject(Error()), { once: true });
    });
  } finally {
    ws.close();
  }
}

try {
  await check();
} catch {
  console.error('Directory compatibility check failed while admissions were drained.');
  process.exitCode = 1;
}
