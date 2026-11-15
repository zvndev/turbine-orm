import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repo, 'src/cli/index.ts');
const loader = join(repo, 'node_modules/tsx/dist/loader.mjs');

describe('MySQL actual CLI refusal boundaries', () => {
  it('never opens a PostgreSQL or MySQL connection for invalid targets or unsupported commands', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const port = (server.address() as AddressInfo).port;
    const run = async (args: string[]) => {
      const child = spawn(process.execPath, ['--import', loader, cli, ...args], {
        cwd: dir,
        env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, 'close');
      return { code, output };
    };
    for (const [command, expected] of [
      ['push', /exactly one of --dry-run or --yes/],
      ['seed', /MySQL seed file not found/],
    ] as const) {
      const result = await run([command, '--engine', 'mysql', '--url', `mysql://127.0.0.1:${port}/test`]);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, expected);
    }
    for (const [engine, url] of [
      ['mysql', `postgres://127.0.0.1:${port}/test`],
      ['postgresql', `mysql://127.0.0.1:${port}/test`],
      ['mysql', `mysql://127.0.0.1:${port}/test?ssl=true`],
    ]) {
      const result = await run(['generate', '--engine', engine!, '--url', url!]);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /MySQL CLI requires|requires engine "mysql"/);
    }
    writeFileSync(join(dir, 'turbine.config.mjs'), "throw new Error('broken config');\n");
    const broken = await run(['init', '--engine', 'mysql', '--url', `mysql://127.0.0.1:${port}/test`]);
    assert.equal(broken.code, 1, broken.output);
    assert.match(broken.output, /Could not load.*broken config/);
    assert.equal(connections, 0);
    assert.deepEqual(readdirSync(dir), ['turbine.config.mjs']);
    // Negative control: the socket counter must actually observe a connection.
    const { connect } = await import('node:net');
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'close');
    assert.equal(connections, 1);
  });

  it('prints engine-specific help without a database or a native peer connection', () => {
    const result = spawnSync(process.execPath, ['--import', loader, cli, 'migrate', '--engine', 'mysql', '--help'], {
      env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MySQL SQL-first migrations/);
    assert.match(result.stdout, /Recovery requires manual reconciliation/);
    assert.doesNotMatch(result.stdout, /Postgres advisory|pg_advisory/);
  });
});
