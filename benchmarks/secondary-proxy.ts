/** Delay-only TCP -> Unix socket transport. RTT zero still traverses this proxy. */
import assert from 'node:assert/strict';
import net from 'node:net';

export async function startDelayProxy(socketPath: string, rttMs: number) {
  assert.ok(Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= 1000, 'Invalid proxy RTT');
  const half = rttMs / 2;
  const sockets = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  let bytes = 0;
  let chunks = 0;
  let connections = 0;
  const later = (fn: () => void, ms: number) => {
    if (closed) return;
    if (ms <= 0) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) fn();
    }, ms);
    timers.add(timer);
  };
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ path: socketPath, allowHalfOpen: true });
    connections++;
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const pipe = (from: net.Socket, to: net.Socket) => {
      from.on('data', (chunk) => {
        bytes += chunk.length;
        chunks++;
        // Equal timers preserve insertion order. No per-row or per-query timer.
        later(() => {
          if (!to.destroyed && !to.write(chunk)) {
            from.pause();
            to.once('drain', () => from.resume());
          }
        }, half);
      });
      from.on('end', () =>
        later(() => {
          if (!to.destroyed) to.end();
        }, half),
      );
      from.on('error', () => {
        from.destroy();
        to.destroy();
      });
      from.on('close', () => {
        sockets.delete(from);
        if (!to.destroyed) to.destroy();
      });
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  const facts = () => ({ port, rttMs, connections, bytes, chunks, sockets: sockets.size, timers: timers.size, closed });
  return {
    port,
    facts,
    disconnect() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      if (closed) return facts();
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const gone = [...sockets].map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', resolve);
            socket.destroy();
          }),
      );
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await Promise.all(gone);
      assert.equal(sockets.size, 0, 'Proxy leaked a socket');
      assert.equal(timers.size, 0, 'Proxy leaked a delay timer');
      return facts();
    },
  };
}
