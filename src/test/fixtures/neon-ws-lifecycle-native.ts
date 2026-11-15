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

const importOptionalPeer = async (name: string): Promise<unknown> => import(name);

type Ws = {
  readyState: number;
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
  const root = await mkdtemp(join(tmpdir(), 'turbine-ws-corrections-service-'));
  const server = createServer();
  const sockets = new Set<Socket>();
  const controls: { holdServer: boolean; held: [Ws, Uint8Array][]; release: () => void } = {
    holdServer: false,
    held: [],
    release: () => {
      controls.holdServer = false;
      for (const [client, chunk] of controls.held.splice(0)) if (client.readyState === 1) client.send(chunk);
    },
  };
  let started = false;
  let wss: WsServer | undefined;
  let admin: pg.Pool | undefined;
  let pid: number | undefined;
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
  const captureOwnership = async () => {
    if (pid) ownedProcesses.push(...(await processTree(pid)));
    await writeFile(
      join(root, 'ownership.json'),
      JSON.stringify(
        {
          root,
          data,
          pid,
          pgPort,
          proxyPort,
          runnerPid: process.pid,
          ownedProcesses: [...new Map(ownedProcesses.map((p) => [p.pid, p])).values()],
        },
        null,
        2,
      ),
    );
  };
  let closing: Promise<void> | undefined;
  let stopping = false;
  let pendingSetup: Promise<unknown> = Promise.resolve();
  const setupCommand = (command: string, args: string[]): Promise<string> => {
    if (stopping) throw new Error('Fixture setup stopped by cleanup');
    const pending = runCommand(command, args);
    pendingSetup = pending.catch(() => {});
    return pending;
  };
  const close = (): Promise<void> => {
    stopping = true;
    closing ??= shutdown();
    return closing;
  };
  const onInt = () => {
    void close().then(() => process.exit(130));
  };
  const onTerm = () => {
    void close().then(() => process.exit(143));
  };
  const shutdown = async () => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    await pendingSetup;
    await captureOwnership();
    // These are this fixture's native administrator Clients only. Release any
    // outstanding checkout too, so signal cleanup cannot wait on the test body.
    for (const raw of (admin as unknown as { _clients?: pg.PoolClient[] })?._clients ?? []) {
      try {
        raw.release(true);
      } catch {}
    }
    await admin?.end();
    if (wss) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss!.close(resolve));
    }
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (!started) {
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
    for (const port of [pgPort, proxyPort].filter(Boolean)) {
      const probe = tcpServer();
      probe.listen(port, '127.0.0.1');
      await once(probe, 'listening');
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    await writeFile(
      join(root, 'audit.json'),
      JSON.stringify(
        {
          root,
          data,
          socketPath: join(root, `.s.PGSQL.${pgPort}`),
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
        },
        null,
        2,
      ),
    );
    await rm(data, { recursive: true, force: true });
    await rm(join(root, `.s.PGSQL.${pgPort}`), { force: true });
    console.log(`native transport cleanup audit: ${root}/audit.json`);
  };
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    const version = await setupCommand(bin('postgres'), ['--version']);
    assert.match(version, /PostgreSQL\) 18\.6\b/, 'this native contract requires PostgreSQL18.6');
    await setupCommand(bin('initdb'), [
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
    await setupCommand(bin('pg_ctl'), [
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
    const connectionString = `postgresql://transport@127.0.0.1:${pgPort}/postgres`;
    admin = new pg.Pool({ connectionString });
    admin.on('connect', (raw) => raw.on('error', () => {}));
    const ws = (await importOptionalPeer('ws')) as {
      WebSocketServer: new (config: unknown) => WsServer;
      WebSocket: NeonWsDriverOptions['webSocketConstructor'];
    };
    wss = new ws.WebSocketServer({ server });
    wss.on('connection', ((client: Ws) => {
      const socket = connect({ host: '127.0.0.1', port: pgPort });
      sockets.add(socket);
      socket.on('data', (chunk) => {
        if (controls.holdServer) controls.held.push([client, chunk]);
        else client.send(chunk);
      });
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
    await captureOwnership();
    return { connection, driver, admin, root, close, sockets, wss, controls, captureOwnership };
  } catch (error) {
    await close();
    throw error;
  }
}
