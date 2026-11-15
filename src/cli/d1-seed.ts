/** Local declarative inserts. No SQL scripts, executable seeds or interactive sessions. */
import { join, sep } from 'node:path';
import type { D1Migration } from '../d1/migrate.js';
import { migrationStatement } from '../d1/migrations/sql.js';
import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from '../d1/types.js';
import { ValidationError } from '../errors.js';
import { type D1Context, d1ProjectPath } from './d1-local.js';
import { inspectD1Migrations } from './d1-migrations.js';
import { isRefusedOpen, readNoFollow } from './no-follow.js';

export type D1SeedValue = null | string | number | boolean | { readonly bytes: readonly number[] };
export interface D1SeedPlan {
  readonly version: 1;
  readonly operations: readonly {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly D1SeedValue[])[];
  }[];
}
export class D1SeedError extends ValidationError {
  constructor(
    message: string,
    readonly phase: 'admission' | 'read' | 'dispatch',
    readonly outcome: 'not-dispatched' | 'unknown',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'D1SeedError';
  }
}
function fail(message: string): never {
  throw new D1SeedError(message, 'admission', 'not-dispatched');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    fail('D1 seed records must be plain JSON objects.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))
  )
    fail('D1 seed record has missing, unknown or accessor properties.');
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Object.getPrototypeOf(value) !== Array.prototype)
    fail(`D1 seed requires ordinary arrays of at most ${max} entries.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, i) => descriptors[i]).some(
      (item) => !item?.enumerable || !Object.hasOwn(item, 'value'),
    )
  )
    fail('D1 seed arrays must be dense JSON arrays without extra properties.');
  return Array.from({ length: value.length }, (_, i) => descriptors[i]!.value);
}
function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ||
    /(?:_turbine_|sqlite_|d1_|_cf_)/i.test(value)
  )
    fail('D1 seed identifiers require ordinary ASCII names without reserved engine or journal names.');
  return value;
}
type Insert = { table: string; columns: readonly string[]; sql: string; params: readonly D1SeedValue[] };
/** Internal owned representation; original JSON arrays/bytes are never retained. */
export function captureD1Seed(input: unknown): readonly Insert[] {
  const plan = record(input, ['version', 'operations']);
  if (plan.version !== 1) fail('D1 seed requires plan version 1.');
  const operations = list(plan.operations, 100);
  if (!operations.length) fail('D1 seed requires at least one insert operation.');
  const inserts: Insert[] = [];
  let payload = 0;
  const value = (item: unknown): D1SeedValue => {
    let size = 8;
    let captured: D1SeedValue;
    if (item === null || typeof item === 'boolean') captured = item;
    else if (typeof item === 'string') {
      // Unicode mode treats a valid surrogate pair as one non-surrogate code point.
      if (/[\uD800-\uDFFF]/u.test(item)) fail('D1 seed strings must be well-formed UTF-16.');
      size = Buffer.byteLength(item);
      captured = item;
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        fail('D1 seed numbers must be finite with safe integers; use strings for exact larger values.');
      captured = item;
    } else {
      const bytes = list(record(item, ['bytes']).bytes, 1_000_000);
      if (bytes.some((byte) => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255))
        fail('D1 seed bytes require integers from 0 through 255.');
      size = bytes.length;
      captured = Object.freeze({ bytes: Object.freeze(bytes as number[]) });
    }
    payload += size;
    if (size > 1_000_000 || payload > 10_000_000) fail('D1 seed bound payload exceeds its 1 MB/value or 10 MB limit.');
    return captured;
  };
  for (const item of operations) {
    const operation = record(item, ['table', 'columns', 'rows']);
    const table = identifier(operation.table);
    const columns = Object.freeze(list(operation.columns, 100).map(identifier));
    if (!columns.length || new Set(columns.map((name) => name.toLowerCase())).size !== columns.length)
      fail('D1 seed requires 1..100 distinct columns per operation.');
    const rows = list(operation.rows, 1000);
    if (!rows.length || inserts.length + rows.length > 1000) fail('D1 seed requires 1..1000 total rows.');
    const sql = `INSERT OR ABORT INTO "${table}" (${columns.map((name) => `"${name}"`).join(',')}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(',')})`;
    for (const row of rows) {
      const cells = list(row, 100);
      if (cells.length !== columns.length) fail('D1 seed row width must exactly match its columns.');
      inserts.push(Object.freeze({ table, columns, sql, params: Object.freeze(cells.map(value)) }));
    }
  }
  return Object.freeze(inserts);
}
export function readD1Seed(context: D1Context): readonly Insert[] {
  const path = d1ProjectPath(join(context.migrations, 'seed.json'));
  for (const protectedPath of [context.persist, context.out, context.configPath, context.planPath])
    if (path === protectedPath || path.startsWith(protectedPath + sep) || protectedPath.startsWith(path + sep))
      fail('D1 seed plan must be disjoint from persistence, output, config and migration plan.');
  const refuse = () => fail('D1 seed.json must be a private regular file of at most 10 MB.');
  try {
    // Checked and read through one descriptor, so the file admitted is the file read.
    const bytes = readNoFollow(path, (stat) => {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10_000_000) refuse();
    });
    if (bytes.length > 10_000_000) fail('D1 seed.json exceeds 10 MB.');
    return captureD1Seed(JSON.parse(bytes.toString('utf8')));
  } catch (cause) {
    if (cause instanceof D1SeedError) throw cause;
    if (isRefusedOpen(cause)) refuse();
    throw new D1SeedError('D1 seed plan could not be captured.', 'admission', 'not-dispatched', cause);
  }
}
function rows<Row>(result: D1Result<Row>): Row[] {
  if (result?.success !== true || !Array.isArray(result.results)) fail('Malformed or unsuccessful D1 seed result.');
  return result.results;
}
type Schema = { type: string; name: string; tbl_name: string; sql: string | null };
const SCHEMA = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name';
/** Internal CLI execution, using the original local binding and an already captured complete plan. */
export async function executeD1Seed(
  binding: D1DatabaseBinding,
  inserts: ReturnType<typeof captureD1Seed>,
  migrations: readonly D1Migration[],
): Promise<{ insertedRows: number; statements: number }> {
  let snapshot: string;
  try {
    const status = await inspectD1Migrations(binding, migrations);
    if (status.historyState !== 'initialized' || status.pending.length)
      fail('Deploy the complete D1 migration plan before seeding.');
    const schema = rows(await binding.prepare(SCHEMA).all<Schema>());
    for (const entry of schema) {
      if (entry.type === 'trigger') fail('D1 seeds refuse schemas with triggers.');
      if (
        entry.sql !== null &&
        !entry.name.startsWith('sqlite_') &&
        entry.name !== '_cf_METADATA' &&
        entry.name !== '_turbine_d1_migrations'
      )
        migrationStatement(entry.sql);
    }
    snapshot = JSON.stringify(schema);
    if (Buffer.byteLength(snapshot) > 2_000_000) fail('D1 seed schema snapshot exceeds 2 MB.');
    for (const table of new Set(inserts.map((insert) => insert.table))) {
      const entry = schema.find((entry) => entry.name.toLowerCase() === table.toLowerCase());
      if (entry?.type !== 'table' || !/^CREATE TABLE\b/i.test(entry.sql ?? ''))
        fail('D1 seeds insert only into existing ordinary tables.');
      const columns = rows(
        await binding
          .prepare('SELECT name,hidden FROM pragma_table_xinfo(?1)')
          .bind(table)
          .all<{ name: string; hidden: number }>(),
      );
      const allowed = new Set(
        columns.filter((column) => column.hidden === 0).map((column) => column.name.toLowerCase()),
      );
      for (const insert of inserts.filter((insert) => insert.table === table))
        if (insert.columns.some((name) => !allowed.has(name.toLowerCase())))
          fail('D1 seed columns must exist and must not be generated or hidden.');
    }
  } catch (cause) {
    if (cause instanceof D1SeedError) throw cause;
    throw new D1SeedError('D1 seed admission read failed.', 'read', 'not-dispatched', cause);
  }
  let prepared: D1PreparedStatement[];
  try {
    prepared = [
      binding
        .prepare(`SELECT CASE WHEN
      (SELECT count(*) FROM sqlite_schema) = json_array_length(?1)
      AND NOT EXISTS (SELECT 1 FROM sqlite_schema s WHERE NOT EXISTS (
        SELECT 1 FROM json_each(?1) e WHERE s.type = json_extract(e.value,'$.type')
        AND s.name = json_extract(e.value,'$.name') AND s.tbl_name = json_extract(e.value,'$.tbl_name')
        AND s.sql IS json_extract(e.value,'$.sql')))
      THEN 1 ELSE json('turbine-d1-seed-schema-changed') END AS admitted`)
        .bind(snapshot),
      ...inserts.map((insert) =>
        binding
          .prepare(insert.sql)
          .bind(
            ...insert.params.map((value) =>
              typeof value === 'boolean'
                ? Number(value)
                : value && typeof value === 'object'
                  ? Uint8Array.from(value.bytes).buffer
                  : value,
            ),
          ),
      ),
    ];
  } catch (cause) {
    throw new D1SeedError('D1 seed preparation failed.', 'admission', 'not-dispatched', cause);
  }
  try {
    const results = await binding.batch<Record<string, unknown>>(prepared);
    if (!Array.isArray(results) || results.length !== prepared.length) fail('D1 seed result cardinality mismatch.');
    const guardRows = rows(results[0]!);
    if (guardRows.length !== 1 || guardRows[0]?.admitted !== 1 || Object.keys(guardRows[0]).length !== 1)
      fail('D1 seed schema guard acknowledgement missing.');
    for (const result of results.slice(1)) {
      if (rows(result).length !== 0 || result.meta?.changes !== 1) fail('D1 seed insert acknowledgement mismatch.');
    }
  } catch (cause) {
    throw new D1SeedError(
      'D1 seed batch outcome is unknown. Reconcile durable rows before any manual retry; no automatic retry occurred.',
      'dispatch',
      'unknown',
      cause,
    );
  }
  return { insertedRows: inserts.length, statements: inserts.length };
}
