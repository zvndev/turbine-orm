/** Exploratory matched-binding supplement using the existing catalog and fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { bulkRows, openLane, recentOrder, type Lane } from '../sqlite-comparison-clients.js';
import { buildCatalog } from '../sqlite-comparison-catalog.js';
import { assertExact, nativeFixture, verifyScenarios } from '../sqlite-equivalence.js';
import { column, ddl, decodeRow, fields, fixtureRow, volumes } from '../sqlite-seed.js';
import { openMatchedRc } from './sqlite-matched-rc.js';

const [entry, file, output] = process.argv.slice(2);
assert.ok(entry && file && output, 'usage: ENTRY OWNED_NEW_DB OUTPUT');
const implementation = await import(pathToFileURL(entry).href);
const selected = [
  'headline-0',
  'headline-1',
  'headline-2',
  'headline-3',
  'headline-4',
  'headline-9',
  'large-5000',
  'large-50000',
  'large-wide',
  'list-page3',
  'relations-author',
  'relations-tags',
  'relations-count',
  'relations-filter',
  'agg',
  'writes-bulk',
];
const report: Record<string, unknown> = {
  helperSha256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  exploratory: true,
  acceptedTiming: false,
  concurrentWorkers: true,
  sqliteVersionNode: process.versions.sqlite,
  node: process.version,
  executable: process.execPath,
  implementation: entry,
  implementationSha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  selected,
  note: 'Original better-sqlite3 full-stack arm and additional node:sqlite matched arm are distinct.',
  cases: [],
  direct: [],
  handlesClosed: false,
};
const admin = new DatabaseSync(file);
const lanes: Lane[] = [];
const sample = async (fn: () => unknown, setup?: () => unknown) => {
  let result: unknown;
  for (let i = 0; i < 3; i++) {
    await setup?.();
    result = await fn();
  }
  const samples = [];
  for (let i = 0; i < 9; i++) {
    await setup?.();
    const start = performance.now();
    result = await fn();
    samples.push(performance.now() - start);
  }
  return {
    samples,
    median: [...samples].sort((a, b) => a - b)[4],
    rows: Array.isArray(result) ? result.length : undefined,
  };
};
try {
  admin.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN');
  admin.exec(ddl);
  for (const [table, n] of Object.entries(volumes)) {
    if (table === 'post_tags' || !n) continue;
    const keys = fields[table]!;
    const insert = admin.prepare(
      `INSERT INTO ${table} (${keys.map(column).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    );
    for (let i = 1; i <= n; i++) {
      const row = fixtureRow(table, i);
      insert.run(
        ...(keys.map((k) =>
          row[k] instanceof Date
            ? (row[k] as Date).toISOString()
            : typeof row[k] === 'boolean'
              ? Number(row[k])
              : row[k],
        ) as (string | number | null)[]),
      );
    }
  }
  const junction = admin.prepare('INSERT INTO post_tags VALUES (?,?)');
  for (let p = 1; p <= 10000; p++) for (const off of [0, 17, 31]) junction.run(p, (((p % 50) + off) % 50) + 1);
  admin.exec('COMMIT; ANALYZE');
  const nodeImplementation = await import(
    pathToFileURL(new URL('../../dist/sqlite.js', import.meta.url).pathname).href
  );
  const schema = nodeImplementation.introspectSqliteDatabase(admin);
  const factory = implementation.turbineSqlite ?? implementation.turbineBetterSqlite3;
  const optional = !!implementation.turbineBetterSqlite3;
  const db = await factory(file, schema, { logger: {}, diagnostics: { cacheCheck: 'off' } });
  const turbine: Lane = {
    name: 'Turbine',
    kind: optional ? 'better-sqlite3' : 'node:sqlite',
    db,
    handle: db.pool.db,
    find: (t, s = {}, one = false) => db.table(t)[one ? 'findUnique' : 'findMany'](s),
    count: (t, w) => db.table(t).count(w ? { where: w } : {}),
    write: (op) => {
      assert.equal(op, 'bulk');
      return db.table('bench_writes').createMany({ data: bulkRows });
    },
    dashboard: async (tx) => {
      const queries = [
        db.table('users').buildFindUnique({ where: { id: 1 } }),
        db.table('posts').buildCount({ where: { userId: 1 } }),
        db.table('comments').buildCount({ where: { userId: 1 } }),
        db.table('posts').buildFindMany({ where: { userId: 1 }, orderBy: recentOrder, limit: 5 }),
        db.table('users').buildCount(),
      ];
      return tx ? db.$transaction(queries) : db.pipeline(queries, { transactional: false });
    },
    close: () => db.disconnect(),
  };
  lanes.push(turbine);
  const rawLane = await openLane('Raw', file);
  lanes.push(rawLane);
  const fixture = nativeFixture(admin);
  for (const [label, rc] of [
    [optional ? 'same-better-sqlite3-binding' : 'original-full-stack', await openLane('Drizzle RC', file)],
    [optional ? 'optional-better-vs-node' : 'same-node-sqlite-binding', openMatchedRc(file)],
  ] as const) {
    lanes.push(rc);
    const all = buildCatalog([turbine, rc, rawLane], fixture, admin, file).scenarios.filter((s) =>
      selected.includes(s.id),
    );
    assert.equal(all.length, 16);
    const verified = await verifyScenarios(all);
    for (const scenario of all)
      for (const arm of scenario.arms) {
        if (arm.name === 'Drizzle RC junction') continue;
        const run = () => arm.fn(37);
        const setup = () => arm.setup?.(37);
        const measurement = await sample(run, setup);
        await setup();
        const final = await run();
        assertExact(
          `${label}/${scenario.id}/${arm.name} sampled output`,
          scenario.normalize ? scenario.normalize(final as never) : final,
          scenario.expected(37),
        );
        await scenario.after?.(arm, 37);
        await scenario.restore?.();
        (report.cases as unknown[]).push({
          comparison: label,
          id: scenario.id,
          scenario: scenario.scenario,
          arm: arm.name,
          binding: arm.name === 'Turbine' ? turbine.kind : rc.kind,
          verified: verified.find((v) => v.id === scenario.id && v.arm === arm.name),
          ...measurement,
        });
      }
  }
  const { toSqliteParam } = await import(new URL('../../dist/d1/sqlite-dialect.js', import.meta.url).href);
  const directCases = [
    ...(
      [
        ['users', 100],
        ['comments', 5000],
        ['comments', 50000],
        ['bench_wide', 1000],
      ] as const
    ).map(([table, n]) => ({ id: `${table}-${n}`, table, n, args: { orderBy: { id: 'asc' }, limit: n }, bulk: false })),
    {
      id: 'relations-L2',
      table: 'users',
      n: 50,
      args: { orderBy: { id: 'asc' }, limit: 50, with: { posts: { orderBy: { id: 'asc' } } } },
      bulk: false,
    },
    { id: 'full-returning1000', table: 'bench_writes', n: 1000, args: {}, bulk: true },
  ];
  const reset = () => admin.exec("DELETE FROM bench_writes; DELETE FROM sqlite_sequence WHERE name='bench_writes'");
  for (const test of directCases) {
    const { table, n, id } = test;
    const query = test.bulk
      ? db.table(table).buildCreateMany({ data: bulkRows })
      : db.table(table).buildFindMany(test.args);
    const setup = test.bulk ? reset : undefined;
    for (const [binding, D] of [
      ['node:sqlite', DatabaseSync],
      ['better-sqlite3', BetterSqlite3],
    ] as const) {
      const raw = new D(file);
      try {
        raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
        const params = Object.fromEntries(
          query.params.map((v: unknown, i: number) => [
            binding === 'node:sqlite' && test.bulk ? `:p${i + 1}` : `p${i + 1}`,
            toSqliteParam(v),
          ]),
        );
        for (const mode of ['objects', 'arrays'] as const) {
          const run = () => {
            const stmt = raw.prepare(query.sql);
            if ('setReadBigInts' in stmt) {
              stmt.setReadBigInts(true);
              stmt.setReturnArrays(mode === 'arrays');
              if (test.bulk) stmt.setAllowBareNamedParameters(false);
            } else {
              stmt.safeIntegers(true);
              stmt.raw(mode === 'arrays');
            }
            return Object.keys(params).length ? stmt.all(params) : stmt.all();
          };
          const measured = await sample(run, setup);
          assert.equal(measured.rows, n);
          const sqliteVersion = raw.prepare('SELECT sqlite_version() AS v').get()!.v;
          (report.direct as unknown[]).push({
            id,
            table,
            n,
            binding,
            mode,
            sqliteVersion,
            policy: test.bulk
              ? 'explicit one-statement buildCreateMany diagnostic; not the chunked createMany execution path; setup outside measurement'
              : 'fresh prepare; safe integer native values; no ORM decoding; same SQL; setup outside measurement',
            ...measured,
          });
        }
      } finally {
        raw.close();
      }
    }
    const pool = await sample(() => db.pool.query(query.sql, query.params), setup);
    (report.direct as unknown[]).push({ id, table, n, binding: turbine.kind, mode: 'pool-normalized', ...pool });
    await setup?.();
    const result = await db.pool.query(query.sql, query.params);
    const transformed = await sample(() => query.transform(result));
    assert.equal(transformed.rows, n);
    (report.direct as unknown[]).push({
      id,
      table,
      n,
      binding: turbine.kind,
      mode: 'transform-only; same immutable normalized input',
      ...transformed,
    });
    if (test.bulk)
      assertExact(
        'full returning direct transform',
        query.transform(result),
        bulkRows.map((r, i) => ({ id: i + 1, ...r })),
      );
    else if (id !== 'relations-L2')
      assertExact(`typed direct fixture ${table}/${n}`, query.transform(result), fixture[table]!.slice(0, n));
    else assertExact('relations transform', query.transform(result), await db.table(table).findMany(test.args));
    await setup?.();
  }

  // Replay the actual public createMany statement sequence, including its
  // transaction and chunk boundaries. A single buildCreateMany statement above
  // is a separate native-prepare diagnostic and cannot stand in for this path.
  const trace: { sql: string; params: unknown[]; rows: number }[] = [];
  const poolQuery = db.pool.query,
    poolConnect = db.pool.connect;
  const observe = async (
    fn: () => Promise<{ rows: unknown[] }>,
    arg: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) => {
    const result = await fn();
    trace.push({
      sql: typeof arg === 'string' ? arg : arg.text,
      params: [...((typeof arg === 'string' ? values : (arg.values ?? values)) ?? [])],
      rows: result.rows.length,
    });
    return result;
  };
  try {
    db.pool.query = function (arg: string | { text: string; values?: unknown[] }, values?: unknown[]) {
      return observe(() => poolQuery.call(this, arg, values), arg, values);
    };
    db.pool.connect = async function () {
      const connection = await poolConnect.call(this),
        query = connection.query;
      connection.query = function (arg: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        return observe(() => query.call(this, arg, values), arg, values);
      };
      return connection;
    };
    reset();
    assertExact(
      'captured public createMany',
      await db.table('bench_writes').createMany({ data: bulkRows }),
      bulkRows.map((r, i) => ({ id: i + 1, ...r })),
    );
  } finally {
    db.pool.query = poolQuery;
    db.pool.connect = poolConnect;
  }
  assert.ok(trace.length > 2, 'chunked public execution must retain its transaction');
  assert.match(trace[0]!.sql, /^BEGIN/i);
  assert.match(trace.at(-1)!.sql, /^COMMIT/i);
  assert.equal(
    trace.reduce((n, q) => n + q.rows, 0),
    1000,
  );
  report.bulkExecutionTrace = trace.map((q) => ({
    sql: q.sql,
    valueCount: q.params.length,
    rows: q.rows,
    valuesSha256: createHash('sha256')
      .update(JSON.stringify(q.params, (_k, v) => (typeof v === 'bigint' ? { bigint: v.toString() } : v)))
      .digest('hex'),
  }));
  for (const [binding, D] of [
    ['node:sqlite', DatabaseSync],
    ['better-sqlite3', BetterSqlite3],
  ] as const) {
    const raw = new D(file);
    try {
      raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      for (const mode of ['objects', 'arrays'] as const) {
        const run = () => {
          const output: unknown[] = [];
          try {
            for (const q of trace) {
              const stmt = raw.prepare(q.sql);
              if ('setReadBigInts' in stmt) {
                stmt.setReadBigInts(true);
                stmt.setAllowBareNamedParameters(false);
                if (q.rows) stmt.setReturnArrays(mode === 'arrays');
              } else {
                stmt.safeIntegers(true);
                if (q.rows) stmt.raw(mode === 'arrays');
              }
              const params = Object.fromEntries(
                q.params.map((v, i) => [binding === 'node:sqlite' ? `:p${i + 1}` : `p${i + 1}`, toSqliteParam(v)]),
              );
              if (q.rows) output.push(...(q.params.length ? stmt.all(params) : stmt.all()));
              else if (q.params.length) stmt.run(params);
              else stmt.run();
            }
            return output;
          } catch (error) {
            if (raw.isTransaction ?? raw.inTransaction) raw.exec('ROLLBACK');
            throw error;
          }
        };
        const measured = await sample(run, reset);
        assert.equal(measured.rows, 1000);
        reset();
        const rows = run().map((r) => {
          const object =
            mode === 'arrays'
              ? Object.fromEntries(fields.bench_writes!.map((k, i) => [column(k), (r as unknown[])[i]]))
              : (r as Record<string, unknown>);
          return decodeRow(
            'bench_writes',
            Object.fromEntries(
              Object.entries(object).map(([k, v]) => [
                k,
                typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v,
              ]),
            ),
          );
        });
        assertExact(
          `native public bulk replay ${binding}/${mode}`,
          rows,
          bulkRows.map((r, i) => ({ id: i + 1, ...r })),
        );
        assertExact(
          'native public bulk replay storage',
          admin
            .prepare('SELECT * FROM bench_writes ORDER BY id')
            .all()
            .map((r) => decodeRow('bench_writes', r)),
          bulkRows.map((r, i) => ({ id: i + 1, ...r })),
        );
        (report.direct as unknown[]).push({
          id: 'full-returning1000-public-replay',
          binding,
          mode,
          statementCount: trace.length,
          policy:
            'exact captured public createMany SQL/parameters/chunks/transaction; complete native returned rows; setup outside timing; no ORM decoding',
          ...measured,
        });
      }
    } finally {
      if (raw.isTransaction ?? raw.inTransaction) raw.exec('ROLLBACK');
      raw.close();
    }
  }
  reset();
} finally {
  for (const lane of lanes.reverse()) await lane.close();
  if (admin.isTransaction) admin.exec('ROLLBACK');
  admin.close();
  report.handlesClosed = lanes.every((l) => (l.handle.isOpen ?? l.handle.open) === false) && !admin.isOpen;
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
assert.equal(report.handlesClosed, true);
console.log(
  JSON.stringify({ output, cells: (report.cases as unknown[]).length, direct: (report.direct as unknown[]).length }),
);
