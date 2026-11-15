import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { resolveD1Context, withLocalD1 } from '../cli/d1-local.js';
import {
  assertD1Arguments,
  deployD1Project,
  initD1Project,
  seedD1Project,
  statusD1Project,
} from '../cli/d1-project.js';
import { captureD1Seed, D1SeedError, type D1SeedPlan, executeD1Seed } from '../cli/d1-seed.js';
import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from '../d1/types.js';

const dependencies = fileURLToPath(new URL('../../node_modules', import.meta.url));
const migration = [
  {
    id: '0001_items',
    statements: [
      'CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL UNIQUE,n REAL,active INTEGER,missing TEXT,data BLOB,exact TEXT)',
      'CREATE TABLE derived(id INTEGER PRIMARY KEY,base INTEGER,doubled INTEGER GENERATED ALWAYS AS (base*2) STORED)',
    ],
  },
];
const plan = (rows: D1SeedPlan['operations'][number]['rows']): D1SeedPlan => ({
  version: 1,
  operations: [{ table: 'items', columns: ['id', 'label', 'n', 'active', 'missing', 'data', 'exact'], rows }],
});
const row = (id: number, label = `row-${id}`): D1SeedPlan['operations'][number]['rows'][number] => [
  id,
  label,
  1.25,
  true,
  null,
  { bytes: [0, 1, 127, 128, 255] },
  '9007199254740993',
];
const unknown =
  (cause?: unknown, checkCause = false) =>
  (error: unknown) => {
    assert(error instanceof D1SeedError);
    assert.equal(error.phase, 'dispatch');
    assert.equal(error.outcome, 'unknown');
    if (checkCause) assert.equal(error.cause, cause);
    return true;
  };
async function project(check: (config: ReturnType<typeof resolveConfig>, seed: string) => Promise<void>) {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'd1-seed-'));
  try {
    symlinkSync(dependencies, join(root, 'node_modules'), 'dir');
    process.chdir(root);
    const inheritedUrl = process.env.DATABASE_URL;
    let config: ReturnType<typeof resolveConfig>;
    try {
      // Isolate only this synchronous local config read; native PG tests keep their URL.
      delete process.env.DATABASE_URL;
      config = resolveConfig(
        {
          engine: 'd1',
          d1: { binding: 'DB', databaseId: 'seed', persist: './state' },
          out: './generated',
          migrationsDir: './migrations',
        },
        {},
      );
    } finally {
      if (inheritedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = inheritedUrl;
    }
    console.info(`D1 seed project: ${root}; loopback0 runtime ports allocated.`);
    await initD1Project(config);
    writeFileSync('migrations/plan.json', JSON.stringify(migration));
    await deployD1Project(config);
    await check(config, join(root, 'migrations/seed.json'));
    assert.equal(existsSync('state/.turbine-d1.lock'), false);
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}

test('declarative seed captures all values and independent bytes; closed CLI admission', () => {
  const input = { version: 1, operations: [{ table: 'items', columns: ['data'], rows: [[{ bytes: [0, 255] }]] }] };
  const captured = captureD1Seed(input);
  input.operations[0]!.rows[0]![0]!.bytes[0] = 99;
  input.operations[0]!.table = 'changed';
  assert.deepEqual(captured[0]?.params, [{ bytes: [0, 255] }]);
  assert.equal(captured[0]?.sql, 'INSERT OR ABORT INTO "items" ("data") VALUES (?1)');
  assert(Object.isFrozen(captured));
  for (const command of ['seed', 's']) {
    assertD1Arguments([command, '--engine', 'd1']);
    assertD1Arguments([command, '--help']);
    assert.throws(() => assertD1Arguments([command, '--sql', 'DELETE FROM items']));
    assert.throws(() => assertD1Arguments([command, '--engine']));
  }
});

test('seed refuses malformed/extra SQL capabilities, incomplete values, protected names and bounds', () => {
  const cases: unknown[] = [
    null,
    [],
    {},
    { version: 2, operations: [] },
    { version: 1, operations: [] },
    { ...plan([row(1)]), sql: 'DROP TABLE items' },
    ...['_turbine_d1_migrations', 'SQLITE_sequence', '_cf_METADATA', 'd1_internal', 'items;DROP'].map((table) => ({
      version: 1,
      operations: [{ table, columns: ['id'], rows: [[1]] }],
    })),
    ...[['id', 'ID'], ['sqlite_hidden'], []].map((columns) => ({
      version: 1,
      operations: [{ table: 'items', columns, rows: [[1]] }],
    })),
    ...[
      undefined,
      NaN,
      Infinity,
      9007199254740992,
      1n,
      new Date(),
      { sql: '1' },
      { bytes: [-1] },
      { bytes: [256] },
      { bytes: [1.2] },
      'x'.repeat(1_000_001),
    ].map((value) => ({ version: 1, operations: [{ table: 'items', columns: ['id'], rows: [[value]] }] })),
    { version: 1, operations: [{ table: 'items', columns: ['id'], rows: [[1, 2]] }] },
    { version: 1, operations: [{ table: 'items', columns: ['id'], rows: Array.from({ length: 1001 }, () => [1]) }] },
    {
      version: 1,
      operations: [{ table: 'items', columns: Array.from({ length: 101 }, (_, i) => `c${i}`), rows: [[1]] }],
    },
  ];
  const holes = new Array(1);
  cases.push({ version: 1, operations: holes });
  const accessor = { ...plan([row(1)]) };
  Object.defineProperty(accessor, 'operations', {
    get() {
      throw new Error('must not invoke accessor');
    },
  });
  cases.push(accessor);
  for (const input of cases) assert.throws(() => captureD1Seed(input), D1SeedError);
});

test(
  'native seed project persists complete values, rolls back all failed inserts, and recovers',
  { timeout: 120_000 },
  () =>
    project(async (config, seed) => {
      const context = resolveD1Context(config);
      const label = "quotes ' ; DROP TABLE items; -- ☃\u0000";
      writeFileSync(
        seed,
        JSON.stringify(plan([row(1, label), [2, '', -2.5, false, null, { bytes: [] }, '2026-11-07T12:00:00.000Z']])),
      );
      const pending = seedD1Project(config);
      writeFileSync(seed, '{"changed":"after capture"}');
      assert.deepEqual(await pending, { insertedRows: 2, statements: 2 });
      await withLocalD1(context, async (binding) => {
        assert.deepEqual(
          (
            await binding
              .prepare('SELECT id,label,n,active,missing,hex(data) AS bytes,exact FROM items ORDER BY id')
              .all()
          ).results,
          [
            { id: 1, label, n: 1.25, active: 1, missing: null, bytes: '00017F80FF', exact: '9007199254740993' },
            { id: 2, label: '', n: -2.5, active: 0, missing: null, bytes: '', exact: '2026-11-07T12:00:00.000Z' },
          ],
        );
      });
      writeFileSync(seed, JSON.stringify(plan([row(3), row(4, label)])));
      await assert.rejects(seedD1Project(config), (error: unknown) => {
        unknown()(error);
        assert.match(String((error as D1SeedError).cause), /UNIQUE/);
        return true;
      });
      await withLocalD1(context, async (binding) => {
        assert.deepEqual((await binding.prepare('SELECT id FROM items ORDER BY id').all()).results, [
          { id: 1 },
          { id: 2 },
        ]);
      });
      writeFileSync(seed, JSON.stringify(plan([row(3)])));
      assert.deepEqual(await seedD1Project(config), { insertedRows: 1, statements: 1 });
      assert.deepEqual(await statusD1Project(config), {
        historyState: 'initialized',
        applied: ['0001_items'],
        pending: [],
      });
      const caller = join(process.cwd(), 'caller.json');
      writeFileSync(caller, JSON.stringify(plan([row(4)])));
      const callerBytes = readFileSync(caller);
      rmSync(seed);
      linkSync(caller, seed);
      await assert.rejects(seedD1Project(config), /private regular/);
      assert.deepEqual(readFileSync(caller), callerBytes);
      rmSync(seed);
      symlinkSync(caller, seed);
      await assert.rejects(seedD1Project(config), /symbolic links/);
      rmSync(seed);
      writeFileSync(seed, '{"version":1,"operations":[{"sql":"DELETE FROM items"}]}');
      const originalBinary = process.env.MINIFLARE_WORKERD_PATH;
      process.env.MINIFLARE_WORKERD_PATH = '/no-such-workerd';
      try {
        await assert.rejects(seedD1Project(config), /seed record/);
      } finally {
        if (originalBinary === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
        else process.env.MINIFLARE_WORKERD_PATH = originalBinary;
      }
      writeFileSync(
        seed,
        JSON.stringify({ version: 1, operations: [{ table: 'derived', columns: ['id', 'doubled'], rows: [[1, 2]] }] }),
      );
      await assert.rejects(seedD1Project(config), /generated or hidden/);
      writeFileSync(
        seed,
        JSON.stringify({ version: 1, operations: [{ table: 'unknown_table', columns: ['id'], rows: [[1]] }] }),
      );
      await assert.rejects(seedD1Project(config), /existing ordinary tables/);
      writeFileSync(seed, JSON.stringify(plan([row(99)])));
      writeFileSync(
        'migrations/plan.json',
        JSON.stringify([...migration, { id: '0002_pending', statements: ['CREATE TABLE pending(id INTEGER)'] }]),
      );
      await assert.rejects(seedD1Project(config), /complete D1 migration plan before seeding/);
      writeFileSync('migrations/plan.json', JSON.stringify(migration));
      await withLocalD1(context, async (binding) => {
        await binding.prepare('CREATE VIEW existing_view AS SELECT id FROM items').all();
      });
      await assert.rejects(seedD1Project(config), (error: unknown) => {
        assert(error instanceof D1SeedError);
        assert.equal(error.outcome, 'not-dispatched');
        return true;
      });
      await withLocalD1(context, async (binding) => {
        assert.deepEqual((await binding.prepare('SELECT id FROM items ORDER BY id').all()).results, [
          { id: 1 },
          { id: 2 },
          { id: 3 },
        ]);
        await binding.prepare('DROP VIEW existing_view').all();
      });
    }),
);

test('native schema races, exact faults and unknown acknowledgements never retry', { timeout: 120_000 }, () =>
  project(async (config) => {
    await withLocalD1(resolveD1Context(config), async (binding) => {
      let seedDispatches = 0;
      const wrap = (
        dispatch: (statements: D1PreparedStatement[]) => Promise<D1Result<unknown>[]>,
      ): D1DatabaseBinding => {
        let seedPrepared = false;
        return {
          prepare(text) {
            if (text.startsWith('INSERT ')) seedPrepared = true;
            return binding.prepare(text);
          },
          async batch<Row>(statements: D1PreparedStatement[]) {
            if (seedPrepared) {
              seedPrepared = false;
              seedDispatches++;
              return (await dispatch(statements)) as D1Result<Row>[];
            }
            return binding.batch<Row>(statements);
          },
        };
      };
      let next = 1;
      for (const ddl of [
        'CREATE TRIGGER late AFTER INSERT ON items BEGIN INSERT INTO derived(id,base) VALUES(new.id,1); END',
        'CREATE VIEW late AS SELECT id FROM items',
        'ALTER TABLE items ADD COLUMN added TEXT',
      ]) {
        const input = captureD1Seed(plan([row(next++)]));
        const raced = wrap(async (statements) => {
          await binding.prepare(ddl).all();
          return binding.batch(statements);
        });
        await assert.rejects(executeD1Seed(raced, input, migration), unknown());
        assert.deepEqual((await binding.prepare('SELECT * FROM items').all()).results, []);
        assert.deepEqual((await binding.prepare('SELECT * FROM derived').all()).results, []);
        if (ddl.startsWith('CREATE TRIGGER')) await binding.prepare('DROP TRIGGER late').all();
        else if (ddl.startsWith('CREATE VIEW')) await binding.prepare('DROP VIEW late').all();
      }
      for (const sentinel of [null, undefined, false, 0, '']) {
        const id = next++;
        const lost = wrap(async (statements) => {
          await binding.batch(statements);
          throw sentinel;
        });
        await assert.rejects(executeD1Seed(lost, captureD1Seed(plan([row(id)])), migration), unknown(sentinel, true));
        assert.deepEqual((await binding.prepare('SELECT id FROM items WHERE id=?1').bind(id).all()).results, [{ id }]);
      }
      for (const mode of [
        'short',
        'unsuccessful',
        'changes',
        'rows',
        'guard-extra',
        'guard-value',
        'missing-meta',
        'null-entry',
      ]) {
        const id = next++;
        const malformed = wrap(async (statements) => {
          const result = await binding.batch(statements);
          if (mode === 'short') return result.slice(0, -1);
          if (mode === 'unsuccessful') result[1]!.success = false;
          if (mode === 'changes') result[1]!.meta.changes = 0;
          if (mode === 'rows') result[1]!.results = [{ unexpected: 1 }];
          if (mode === 'guard-extra') result[0]!.results.push({ admitted: 1 });
          if (mode === 'guard-value') result[0]!.results = [{ admitted: 0 }];
          if (mode === 'missing-meta') delete (result[1] as Partial<D1Result>)!.meta;
          if (mode === 'null-entry') (result as unknown[])[1] = null;
          return result;
        });
        await assert.rejects(executeD1Seed(malformed, captureD1Seed(plan([row(id)])), migration), unknown());
        assert.deepEqual((await binding.prepare('SELECT id FROM items WHERE id=?1').bind(id).all()).results, [{ id }]);
      }
      assert.equal(seedDispatches, 16);
      const before = (await binding.prepare('SELECT id FROM items ORDER BY id').all()).results;
      for (const sentinel of [null, undefined, false, 0, '']) {
        const broken: D1DatabaseBinding = {
          prepare(text) {
            if (text.startsWith('INSERT ')) throw sentinel;
            return binding.prepare(text);
          },
          batch: binding.batch.bind(binding),
        };
        await assert.rejects(executeD1Seed(broken, captureD1Seed(plan([row(next++)])), migration), (error: unknown) => {
          assert(error instanceof D1SeedError);
          assert.equal(error.phase, 'admission');
          assert.equal(error.outcome, 'not-dispatched');
          assert.equal(error.cause, sentinel);
          return true;
        });
      }
      assert.deepEqual((await binding.prepare('SELECT id FROM items ORDER BY id').all()).results, before);
    });
  }),
);

test('native local 100-parameter rows and 1000-row batch upper bounds are exercised', { timeout: 120_000 }, () =>
  project(async (config) => {
    await withLocalD1(resolveD1Context(config), async (binding) => {
      const columns = Array.from({ length: 100 }, (_, i) => `c${i}`);
      await binding.prepare(`CREATE TABLE wide(${columns.map((name) => `"${name}" INTEGER`).join(',')})`).all();
      const wide = captureD1Seed({
        version: 1,
        operations: [{ table: 'wide', columns, rows: [columns.map((_, i) => i)] }],
      });
      assert.deepEqual(await executeD1Seed(binding, wide, migration), { insertedRows: 1, statements: 1 });
      assert.deepEqual((await binding.prepare('SELECT * FROM wide').all()).results, [
        Object.fromEntries(columns.map((name, i) => [name, i])),
      ]);
      const input = plan(Array.from({ length: 1000 }, (_, i) => row(i + 1)));
      assert.deepEqual(await executeD1Seed(binding, captureD1Seed(input), migration), {
        insertedRows: 1000,
        statements: 1000,
      });
      const actual = (
        await binding.prepare('SELECT id,label,n,active,missing,hex(data) AS bytes,exact FROM items ORDER BY id').all()
      ).results;
      assert.deepEqual(
        actual,
        Array.from({ length: 1000 }, (_, i) => ({
          id: i + 1,
          label: `row-${i + 1}`,
          n: 1.25,
          active: 1,
          missing: null,
          bytes: '00017F80FF',
          exact: '9007199254740993',
        })),
      );
    });
  }),
);
