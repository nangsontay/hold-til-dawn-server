import { Room, defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';

// Development-only proof of transport compatibility, not the production lobby.
class HandshakeRoom extends Room {
  onCreate() {
    this.onMessage('hello', (client, message) => {
      if (message && message.protocol === 1) client.send('hello_ack', { protocol: 1 });
    });
  }
}
const port = Number(process.env.LOBBY_PORT || 2567);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LOBBY_PORT');
const app = defineServer({ transport: new WebSocketTransport(), rooms: { handshake: defineRoom(HandshakeRoom) }, greet: false });
await app.listen(port, process.env.LOBBY_HOST || '127.0.0.1');
console.log(`Development lobby listening on ${port}`);
