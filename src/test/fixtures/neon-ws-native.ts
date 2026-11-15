/** Local transport evidence: actual WebSockets relaying bytes to native PostgreSQL. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type Socket, createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { NeonWsDriverOptions, NeonWsPoolConfig } from '../../neon-ws.js';
import importOptionalPeer from '../../optional-peer-import.cjs';

type Ws = {
  on(name: string, fn: (...args: never[]) => void): void;
  send(data: Uint8Array): void;
  close(): void;
  terminate(): void;
};
type WsServer = {
  on(name: string, fn: (...args: never[]) => void): void;
  close(cb: () => void): void;
  clients: Set<Ws>;
};

export async function runCommand(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${command} ${args.join(' ')}: ${output}`);
  return output;
}

export async function startNative(pgRoot: string) {
  const serviceUrl = pgRoot ? undefined : process.env.TURBINE_NEON_WS_PG_SERVICE_URL;
  assert.ok(pgRoot || serviceUrl, 'Explicit PostgreSQL binary root or disposable service URL required');
  if (serviceUrl)
    assert.equal(process.env.TURBINE_NEON_WS_PG_DISPOSABLE, '1', 'Explicit disposable service assertion required');
  const root = await mkdtemp(join(tmpdir(), 'turbine-neon-ws-'));
  const server = createServer();
  const sockets = new Set<Socket>();
  let started = false;
  let wss: WsServer | undefined;
  let admin: pg.Pool | undefined;
  let pid: number | undefined;
  let serviceAdmin: pg.Client | undefined;
  let database: string | undefined;
  let pgHost = '127.0.0.1';
  const ownedProcesses: { pid: number; group: number }[] = [];
  const processTree = async (parent: number): Promise<{ pid: number; group: number }[]> => {
    const stat = await readFile(`/proc/${parent}/stat`, 'utf8').catch(() => '');
    if (!stat) return [];
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const result = [{ pid: parent, group: Number(fields[2]) }];
    const children = await readFile(`/proc/${parent}/task/${parent}/children`, 'utf8').catch(() => '');
    for (const child of children.trim().split(/\s+/).filter(Boolean))
      result.push(...(await processTree(Number(child))));
    return result;
  };
  let pgPort = 0;
  let proxyPort = 0;
  const data = join(root, 'data');
  const bin = (name: string) => join(pgRoot, 'bin', name);
  const close = async () => {
    let databaseBackendsBeforeDrop: unknown[] = [];
    await admin?.end();
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss!.close(resolve));
    }
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (!started && !serviceUrl) {
      pid = Number((await readFile(join(data, 'postmaster.pid'), 'utf8').catch(() => '')).split('\n')[0]) || undefined;
      if (pid) {
        const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        assert.ok(command.includes(data), 'cleanup must only target the fixture datadir');
        started = true;
      }
    }
    if (pid) ownedProcesses.push(...(await processTree(pid)));
    if (started) await runCommand(bin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '15', 'stop']);
    let pidGone = true;
    if (pid) {
      try {
        process.kill(pid, 0);
        pidGone = false;
      } catch {}
    }
    assert.equal(pidGone, true, 'owned PostgreSQL PID must be gone');
    const remainingPids: number[] = [];
    for (const owned of ownedProcesses) {
      try {
        process.kill(owned.pid, 0);
        remainingPids.push(owned.pid);
      } catch {}
    }
    assert.deepEqual(remainingPids, [], 'all owned PostgreSQL children must be gone');
    const remainingGroups: number[] = [];
    for (const group of new Set(ownedProcesses.map((owned) => owned.group))) {
      try {
        process.kill(-group, 0);
        remainingGroups.push(group);
      } catch {}
    }
    assert.deepEqual(remainingGroups, [], 'all owned PostgreSQL process groups must be gone');
    try {
      if (serviceAdmin && database) {
        // A destroyed client can leave pg_sleep running until the backend reads
        // the closed socket. Only this freshly created database belongs to this fixture.
        databaseBackendsBeforeDrop = (
          await serviceAdmin.query('SELECT pid, state, query FROM pg_stat_activity WHERE datname=$1', [database])
        ).rows;
        await serviceAdmin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        assert.deepEqual(
          (await serviceAdmin.query('SELECT datname FROM pg_database WHERE datname=$1', [database])).rows,
          [],
        );
      }
    } finally {
      await serviceAdmin?.end();
    }
    for (const port of (serviceUrl ? [proxyPort] : [pgPort, proxyPort]).filter(Boolean)) {
      const probe = tcpServer();
      probe.listen(port, '127.0.0.1');
      await once(probe, 'listening');
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    await rm(data, { recursive: true, force: true });
    await rm(join(root, `.s.PGSQL.${pgPort}`), { force: true });
    await writeFile(
      join(root, 'audit.json'),
      JSON.stringify(
        {
          pid,
          pgPort,
          proxyPort,
          pidGone,
          ownedProcesses,
          remainingPids,
          remainingGroups,
          socketCount: sockets.size,
          activeWebSockets: wss?.clients.size ?? 0,
          stopped: true,
          datadir: serviceUrl ? null : data,
          socket: serviceUrl ? null : root,
          ownership: serviceUrl ? 'database-only' : 'owned-process',
          database,
          databaseRemoved: Boolean(database),
          databaseBackendsBeforeDrop,
          databaseDropForced: Boolean(database),
          datadirRemoved: true,
          connectionsClosed: true,
          auditComplete: true,
        },
        null,
        2,
      ),
    );
    console.log(`native transport cleanup audit: ${root}/audit.json`);
  };
  try {
    let connectionString: string;
    if (serviceUrl) {
      const endpoint = new URL(serviceUrl);
      assert.ok(['postgres:', 'postgresql:'].includes(endpoint.protocol));
      serviceAdmin = new pg.Client({ connectionString: serviceUrl, connectionTimeoutMillis: 3000 });
      await serviceAdmin.connect();
      const name = `neon_ws_${process.pid}_${Date.now()}`;
      await serviceAdmin.query(`CREATE DATABASE "${name}"`);
      database = name;
      endpoint.pathname = `/${name}`;
      connectionString = endpoint.toString();
      pgHost = endpoint.hostname;
      pgPort = Number(endpoint.port || 5432);
    } else {
      const version = await runCommand(bin('postgres'), ['--version']);
      assert.match(version, /PostgreSQL\) 18\.6\b/, 'this native contract requires PostgreSQL18.6');
      await runCommand(bin('initdb'), [
        '-D',
        data,
        '-L',
        join(pgRoot, 'share/postgresql'),
        '--no-locale',
        '--encoding=UTF8',
        '--auth=trust',
        '--username=transport',
      ]);
      const portProbe = tcpServer();
      portProbe.listen(0, '127.0.0.1');
      await once(portProbe, 'listening');
      pgPort = (portProbe.address() as { port: number }).port;
      await new Promise<void>((resolve) => portProbe.close(() => resolve()));
      await runCommand(bin('pg_ctl'), [
        '-D',
        data,
        '-l',
        join(root, 'postgres.log'),
        '-w',
        '-t',
        '20',
        '-o',
        `-h 127.0.0.1 -p ${pgPort} -k ${root} -c dynamic_library_path=${pgRoot}/lib/postgresql`,
        'start',
      ]);
      started = true;
      pid = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
      connectionString = `postgresql://transport@127.0.0.1:${pgPort}/postgres`;
    }
    admin = new pg.Pool({ connectionString });
    const ws = (await importOptionalPeer('ws')) as {
      WebSocketServer: new (config: unknown) => WsServer;
      WebSocket: NeonWsDriverOptions['webSocketConstructor'];
    };
    wss = new ws.WebSocketServer({ server });
    wss.on('connection', ((client: Ws) => {
      const socket = connect({ host: pgHost, port: pgPort });
      sockets.add(socket);
      socket.on('data', (chunk) => client.send(chunk));
      socket.on('close', () => {
        sockets.delete(socket);
        client.close();
      });
      socket.on('error', () => client.close());
      client.on('message', ((chunk: Uint8Array) => socket.write(chunk)) as (...args: never[]) => void);
      client.on('close', () => socket.destroy());
      client.on('error', () => socket.destroy());
    }) as (...args: never[]) => void);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    proxyPort = (server.address() as { port: number }).port;
    const connection: NeonWsPoolConfig = {
      connectionString,
      max: 4,
      connectionTimeoutMillis: 2000,
      application_name: 'neon_ws_native',
    };
    const driver: NeonWsDriverOptions = {
      webSocketConstructor: ws.WebSocket,
      wsProxy: () => `127.0.0.1:${proxyPort}/v1`,
      useSecureWebSocket: false,
      pipelineConnect: false,
    };
    return { connection, driver, admin, root, close, sockets, wss };
  } catch (error) {
    await close();
    throw error;
  }
}
