/** Exploratory read-cost decomposition over the unchanged original fixture/catalog. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import pg from 'pg';
import { TurbineClient } from '../../generated/turbine/index.js';
import { createExtendedSuite } from '../bench-extended.js';
import { summarizeSamples } from '../bench-harness.js';
import { assertExtendedExact, extendedGroups, nativeCounts, verifyExtended } from '../extended-equivalence.js';
import { turbineTypeTable } from '../node_modules/turbine-orm/dist/supplied-pool-types.js';

const output = process.argv[2];
assert.ok(output, 'Explicit fresh report path required');
const rounds = Number(process.env.PG_READ_COST_ROUNDS ?? 20);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 5);
const suite = await createExtendedSuite(process.env.DATABASE_URL!, rounds, 5, true);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const db = new TurbineClient({ pool, logging: false, preparedStatements: true });
const types = turbineTypeTable(() => pg.types, true);
const report: Record<string, unknown> = {
  scope: 'exploratory-concurrent-workers; no accepted timing or win claim',
  runtime: { executable: process.execPath, version: process.version },
  defaultsChanged: false,
  versions: suite.versions,
  encoding: suite.encoding,
  cells: [],
};
const inspector = new Session();
inspector.connect();
const post = (method: 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop') =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    inspector.post(method, (error, result) => error ? reject(error) : resolve(result as Record<string, unknown>));
  });
try {
  await db.connect();
  report.preflight = await verifyExtended(suite.scenarios, [...extendedGroups], suite.oracle);
  report.settings = (await pool.query("SELECT name,setting FROM pg_settings WHERE name IN ('server_version','TimeZone','fsync','synchronous_commit','full_page_writes','plan_cache_mode') ORDER BY name")).rows;
  await post('Profiler.enable');
  await post('Profiler.start');
  for (const id of ['comments-5000', 'comments-50000', 'wide-1000', 'relation-count'] as const) {
    const scenario = suite.scenarios.find((s) => s.id === id)!;
    const query = id === 'wide-1000'
      ? db.benchWide.buildFindMany({ limit: 1000, orderBy: { id: 'asc' } })
      : id === 'relation-count'
        ? db.users.buildFindMany({ limit: 100, orderBy: { id: 'asc' }, with: { _count: { posts: true } } })
        : db.comments.buildFindMany({ limit: id === 'comments-5000' ? 5000 : 50000, orderBy: { id: 'asc' } });
    const named = { text: query.sql, values: query.params, name: query.preparedName, types };
    const raw = await pool.query(named);
    assert.ok(raw.rows.length > 0 && raw.fields.length > 0);
    const shape = raw.fields.map((field) => ({ name: field.name, oid: field.dataTypeID, format: field.format }));
    const transformed = (result: unknown) => query.transform(result as never);
    const normalize = (value: unknown) => id === 'relation-count' ? nativeCounts(value) : value;
    const expected = await scenario.arms.find((a) => a.name === 'Turbine')!.fn(0);
    assertExtendedExact(`${id}/installed transform`, normalize(transformed(raw)), expected);
    const arrayResult = await pool.query({ ...named, rowMode: 'array' });
    const arrayToObject = (result: typeof arrayResult) => ({
      ...result,
      rows: result.rows.map((row) => Object.fromEntries(result.fields.map((field, i) => [field.name, row[i]]))),
    });
    assert.deepEqual(arrayToObject(arrayResult).rows, raw.rows, `${id}/all array-mode fields/order/types`);
    const arms: { name: string; fn: () => unknown; boundary: string }[] = [
      ...scenario.arms.filter((a) => ['Turbine', 'Drizzle RC'].includes(a.name)).map((a) => ({
        name: a.name, fn: () => a.fn(0), boundary: 'original complete ORM result',
      })),
      { name: 'matched-object-named', fn: () => pool.query(named), boundary: 'driver objects, before ORM transform' },
      { name: 'matched-array-named', fn: () => pool.query({ ...named, rowMode: 'array' }), boundary: 'driver arrays, before object mapping/ORM transform' },
      { name: 'array-object-transform', fn: async () => normalize(transformed(arrayToObject(await pool.query({ ...named, rowMode: 'array' })))), boundary: 'complete result; array-to-object mapping included' },
      { name: 'matched-object-unnamed-extended', fn: () => pool.query({ text: query.sql, values: query.params, types, queryMode: 'extended' } as pg.QueryConfig), boundary: 'separate protocol/preparation experiment, driver objects only' },
      { name: 'transform-only', fn: () => normalize(transformed(raw)), boundary: 'reused driver result; excludes SQL, transfer and driver materialization' },
    ];
    const samples = new Map(arms.map((a) => [a.name, [] as number[]]));
    for (let i = -5; i < rounds; i++) {
      // Rotate arm order; no pairwise speed claim is admitted from this profile.
      for (let j = 0; j < arms.length; j++) {
        const arm = arms[(j + i + 5) % arms.length]!;
        const start = performance.now();
        await arm.fn();
        if (i >= 0) samples.get(arm.name)!.push(performance.now() - start);
      }
    }
    const plans = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params)).rows;
    (report.cells as unknown[]).push({
      id, sql: query.sql, params: query.params, preparedName: query.preparedName, shape,
      rows: raw.rows.length, plans,
      arms: arms.map((a) => ({ boundary: a.boundary, ...summarizeSamples(a.name, samples.get(a.name)!, true) })),
    });
  }
  report.prepared = (await pool.query('SELECT name,statement,parameter_types,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name')).rows;
  const { profile } = await post('Profiler.stop');
  writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile));
  report.success = true;
} finally {
  inspector.disconnect();
  await db.disconnect();
  await pool.end();
  await suite.close();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
