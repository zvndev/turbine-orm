import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { postgresDialect } from '../dialect.js';
import { UniqueConstraintError, ValidationError } from '../errors.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { TransactionState } from '../transaction-state.js';
import { createTransactionPool, guardTransactionConnection } from '../transaction-transport.js';
import { skipGate } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TRANSPORT = 'src/transaction-transport.ts';
const PROBE = 'src/test/fixtures/transaction-transport-probe.ts';
const native = (() => {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      return typeof db.isTransaction === 'boolean' && typeof db.prepare('SELECT 1').columns === 'function';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
})();
const { it: sqliteIt } = skipGate(
  !native,
  'requires node:sqlite native streaming with DatabaseSync.isTransaction (Node 22.x >= 22.16, or Node >= 24)',
);

/** Resolve every value import before tree shaking, so even an unused driver edge fails. */
function isolatedBundle(entry: string, format: 'esm' | 'cjs') {
  return build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format,
    logLevel: 'silent',
    plugins: [
      {
        name: 'driver-neutral-transport',
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, ({ path }) =>
            path.startsWith('node:')
              ? { path, external: true }
              : { errors: [{ text: `Transport must not load runtime driver ${path}` }] },
          );
        },
      },
    ],
  });
}

describe('transaction transport import boundary', () => {
  it('rejects the client graph as a negative control, then accepts the driver-free transport', async () => {
    await assert.rejects(isolatedBundle('src/client.ts', 'esm'), /Transport must not load runtime driver #pg/);
    for (const format of ['esm', 'cjs'] as const) {
      const result = await isolatedBundle(TRANSPORT, format);
      assert.deepEqual(
        Object.keys(result.metafile.inputs).sort(),
        [
          'src/errors.ts',
          'src/query-channel.ts',
          'src/query/stream-idle.ts',
          'src/transaction-control.ts',
          'src/transaction-state.ts',
          TRANSPORT,
        ].sort(),
      );
      if (format === 'esm') {
        assert.deepEqual(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]!]!.exports.sort(), [
          'createTransactionPool',
          'guardTransactionConnection',
        ]);
      }
      assert.ok(result.outputFiles[0]!.text.length > 1000, 'the runtime implementation is present');
    }
  });

  sqliteIt('executes real transactions, savepoints, streams and ownership guards in isolated ESM and CJS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'transaction-transport-'));
    try {
      for (const [format, extension] of [
        ['esm', 'mjs'],
        ['cjs', 'cjs'],
      ] as const) {
        const bundle = await isolatedBundle(PROBE, format);
        writeFileSync(join(dir, `transport.${extension}`), bundle.outputFiles[0]!.text);
      }
      writeFileSync(
        join(dir, 'run.mjs'),
        `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const driver of ['pg', 'mysql2', 'mssql']) {
  assert.throws(() => require(driver), { code: 'MODULE_NOT_FOUND' });
  await assert.rejects(import(driver), { code: 'ERR_MODULE_NOT_FOUND' });
}
for (const file of ['./transport.mjs', './transport.cjs']) {
  const module = await import(file);
  await module.run();
}
process.stdout.write('ESM and CJS transport executed real SQLite effects without drivers');
`,
      );
      const output = execFileSync(process.execPath, [join(dir, 'run.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
        timeout: 10_000,
      });
      assert.equal(output, 'ESM and CJS transport executed real SQLite effects without drivers');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transaction transport driver compatibility', () => {
  it('keeps typed error mapping and records the identical failure on transaction state', async () => {
    const driverError = { code: '23505', detail: 'Key already exists', constraint: 'items_pkey' };
    const client = {
      query: async () => {
        throw driverError;
      },
      release() {},
    } as PgCompatPoolClient;
    // Only the constructor's transaction policy is needed by this driver test.
    const state = new TransactionState(client, {
      capabilities: { abortsTransactionOnError: false },
    } as ConstructorParameters<typeof TransactionState>[1]);
    const pool = createTransactionPool(client, state, state.rootScope);
    await assert.rejects(pool.query('INSERT INTO items VALUES ($1)', [1]), (error) => {
      assert.ok(error instanceof UniqueConstraintError);
      assert.equal(state.firstFailure, error);
      return true;
    });
    assert.equal(state.busy, false);
    assert.equal(state.running, false);
    assert.equal(pool.streamBatches, undefined, 'no native hook is invented for PG');
  });

  it('preserves callback/submittable forwarding, receiver binding and connection ownership refusals', () => {
    const calls: unknown[][] = [];
    const client = {
      connection: { privateWire: true },
      query(...args: unknown[]) {
        assert.equal(this, client);
        calls.push(args);
        return 'driver result';
      },
      release() {
        assert.fail('released the borrowed driver connection');
      },
      end() {
        assert.fail('ended the borrowed driver connection');
      },
      connect() {
        assert.fail('reconnected the borrowed driver connection');
      },
      receiver() {
        return this;
      },
    };
    const state = new TransactionState(
      client as unknown as PgCompatPoolClient,
      {
        capabilities: { abortsTransactionOnError: false, statementSyntax: 'postgresql' },
      } as ConstructorParameters<typeof TransactionState>[1],
    );
    const raw = guardTransactionConnection(client as unknown as PgCompatPoolClient, state) as unknown as typeof client;
    const callback = () => {};
    assert.equal(raw.query('SELECT 1', callback), 'driver result');
    const cursor = { submit() {} };
    assert.equal(raw.query(cursor), 'driver result');
    assert.equal(calls[0]![1], callback);
    assert.equal(calls[1]![0], cursor);
    assert.equal(raw.receiver(), client);
    assert.equal(raw.receiver, raw.receiver, 'bound methods retain their identity');
    assert.equal('connection' in raw, false);
    assert.equal(raw.connection, undefined);
    for (const api of ['transaction()', '$connection()'] as const) {
      const guarded = guardTransactionConnection(
        client as unknown as PgCompatPoolClient,
        state,
        state.rootScope,
        api,
      ) as unknown as typeof client;
      const who = api === 'transaction()' ? 'transaction(): the callback' : '$connection(): the $transaction callback';
      for (const method of ['release', 'end', 'connect'] as const) {
        assert.equal(guarded[method], guarded[method], 'ownership refusals retain their identity');
        const ownership =
          method === 'release' ? 'releases it after' : 'owns the connection and returns it to the pool after';
        assert.throws(() => guarded[method](), {
          name: 'ValidationError',
          message: `[TURBINE_E003] ${who} must not ${method} its client; the transaction ${ownership} COMMIT or ROLLBACK. (https://turbineorm.dev/errors#e003)`,
        });
      }
    }
    const count = calls.length;
    assert.throws(() => raw.query('COMMIT', callback), /cannot be sent/);
    state.end('committed');
    assert.throws(() => raw.query('SELECT 1', callback), /transaction committed/);
    assert.throws(() => raw.query(cursor), /transaction committed/);
    assert.equal(calls.length, count, 'refused calls never reach the driver');
  });
});

it('cancellable statement ownership blocks later queries and savepoints through settlement', async () => {
  let finishDriver!: () => void;
  let finishCancel!: () => void;
  const driver = new Promise<void>((resolve) => {
    finishDriver = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    finishCancel = resolve;
  });
  const sqls: string[] = [];
  const client = {
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as PgCompatPoolClient;
  const state = new TransactionState(client, postgresDialect, { api: 'transaction' });
  const pool = createTransactionPool(client, state, state.rootScope);
  const pending = pool.runStreamQuery!(() => driver, { promise: settled, closed: false });
  await assert.rejects(pool.query('SELECT 909'), ValidationError);
  finishDriver();
  await pending;
  assert.equal(state.busy, true, 'cancel delivery still owns admission after driver settlement');
  assert.equal(state.running, true, 'transaction cleanup must wait for delivery settlement');
  await assert.rejects(pool.query('SELECT 910'), ValidationError);
  await assert.rejects(
    state.runRaw('ROLLBACK TO SAVEPOINT x', () => client.query('ROLLBACK TO SAVEPOINT x')),
    ValidationError,
  );
  await assert.rejects(
    state.withBlock(async () => {}, state.rootScope),
    ValidationError,
  );
  assert.deepEqual(sqls, []);
  const idle = state.whenIdle(1000);
  finishCancel();
  assert.equal(await idle, true);
  assert.equal(state.busy, false);
  await pool.query('SELECT 911');
  assert.deepEqual(sqls, ['SELECT 911']);
});
