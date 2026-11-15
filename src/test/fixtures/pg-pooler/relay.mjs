// The existing neon-ws-native fixture's byte relay, routed to PgBouncer instead of PG.
// No SQL/result simulation and no driver-global changes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';

export async function poolerRelay(targetPort) {
  const server = createServer();
  const sockets = new Set();
  const routes = [];
  const wss = new WebSocketServer({ server });
  wss.on('connection', (client, request) => {
    assert.ok(['/session', '/transaction'].includes(request.url), 'known pooler route required');
    routes.push({ path: request.url, target: `127.0.0.1:${targetPort}` });
    const socket = connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(socket);
    socket.on('data', (chunk) => client.send(chunk));
    socket.on('close', () => {
      sockets.delete(socket);
      client.close();
    });
    socket.on('error', () => client.close());
    client.on('message', (chunk) => socket.write(chunk));
    client.on('close', () => socket.destroy());
    client.on('error', () => socket.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closing;
  return {
    port: server.address().port,
    routes,
    close() {
      closing ??= (async () => {
        for (const client of wss.clients) client.terminate();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => wss.close(resolve));
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        assert.equal(sockets.size, 0);
        assert.equal(wss.clients.size, 0);
      })();
      return closing;
    },
  };
}
