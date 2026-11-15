/** Owned TCP proxy: fixed per-chunk latency, no bandwidth/jitter simulation. */
import net from 'node:net';
import { connectionOptions } from './mysql-comparison-config.js';
export async function delayProxy(rttMs: number) {
  const upstreamConfig = connectionOptions();
  const sockets = new Set<net.Socket>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, rttMs / 2);
    timers.add(t);
  };
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: upstreamConfig.host, port: upstreamConfig.port });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.setNoDelay(true);
      s.on('close', () => sockets.delete(s));
    }
    const pipe = (from: net.Socket, to: net.Socket) => {
      from.on('data', (chunk) =>
        later(() => {
          if (!to.destroyed) to.write(chunk);
        }),
      );
      from.on('end', () =>
        later(() => {
          if (!to.destroyed) to.end();
        }),
      );
      from.on('error', () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  const original = new URL(process.env.MYSQL_COMPARISON_URL!);
  original.hostname = '127.0.0.1';
  original.port = String(port);
  return {
    url: original.href,
    port,
    rttMs,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
