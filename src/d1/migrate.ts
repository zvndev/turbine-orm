/** Optional binding-native migrations. No sessions, callbacks, drivers or connection ownership. */
import { migrationStatement } from './migrations/sql.js';
import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from './types.js';

export interface D1Migration {
  /** Strictly increasing ASCII identifiers. Keep the complete immutable history in source control. */
  id: string;
  /** One complete SQLite statement per entry, including optional trailing semicolon/comments. */
  statements: readonly string[];
}
export interface D1MigrateOptions {
  /** Apply the contiguous prefix ending here; still supply the complete plan for drift admission. */
  through?: string;
  /** Pre-dispatch refusal only. A dispatched D1 batch cannot be cancelled. */
  signal?: AbortSignal;
}
export interface D1MigrationReport {
  applied: readonly string[];
  alreadyApplied: readonly string[];
}
export class D1MigrationError extends Error {
  constructor(
    message: string,
    readonly phase: 'admission' | 'read' | 'dispatch',
    readonly outcome: 'not-dispatched' | 'unknown',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'D1MigrationError';
  }
}

const JOURNAL = '_turbine_d1_migrations';
const TABLE = `"${JOURNAL}"`;
const CREATE = `CREATE TABLE ${TABLE} (position INTEGER PRIMARY KEY CHECK(position >= 0), id TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL CHECK(length(checksum) = 64)) STRICT`;
type Entry = { id: string; statements: string[]; checksum: string };
type History = { position: number; id: string; checksum: string };
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
const SCHEMA = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name';

async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function historyChecksum(history: History[]): Promise<string> {
  return checksum(
    `turbine-d1-history-v1\n${JSON.stringify(history.map((row) => [row.position, row.id, row.checksum]))}`,
  );
}

function fail(message: string): never {
  throw new D1MigrationError(message, 'admission', 'not-dispatched');
}
function rows<Row>(result: D1Result<Row>): Row[] {
  if (result?.success !== true || !Array.isArray(result.results))
    throw new Error('Malformed or unsuccessful D1 result.');
  return result.results;
}
function schemaAllowed(schema: SchemaRow[]): boolean {
  return schema.every((row) => {
    if (row.name === JOURNAL) return row.type === 'table' && row.tbl_name === JOURNAL && row.sql === CREATE;
    if (row.tbl_name === JOURNAL)
      return row.type === 'index' && row.sql === null && row.name === `sqlite_autoindex_${JOURNAL}_1`;
    // Existing triggers can indirectly mutate history; virtual modules can have
    // side effects outside the admitted SQL subset. Fail closed for both.
    if (row.type === 'trigger' || (row.sql ?? '').toLowerCase().includes(JOURNAL)) return false;
    if (row.sql !== null && !row.name.startsWith('sqlite_') && row.name !== '_cf_METADATA') {
      try {
        migrationStatement(row.sql);
      } catch {
        return false;
      }
    }
    return true;
  });
}

/**
 * The assertion executes IN the write batch, before user SQL. A false predicate
 * evaluates malformed JSON, forcing a native SQL error and rollback even if a
 * competing writer replaced the journal with an unconstrained table. JSON is
 * bound data, never interpolated SQL. This is an assertion, not a row-count test.
 */
function guard(binding: D1DatabaseBinding, history: History[], schema: SchemaRow[]): D1PreparedStatement {
  const encodedSchema = JSON.stringify(schema);
  const encodedHistory = JSON.stringify(history);
  if ([encodedSchema, encodedHistory].some((value) => new TextEncoder().encode(value).length > 2_000_000)) {
    fail('D1 migration admission snapshot exceeds the native 2 MB bound-value limit.');
  }
  return binding
    .prepare(`SELECT CASE WHEN COALESCE((
      (SELECT count(*) FROM sqlite_schema) = json_array_length(?1)
      AND NOT EXISTS (
        SELECT 1 FROM sqlite_schema s WHERE NOT EXISTS (
          SELECT 1 FROM json_each(?1) e WHERE
            s.type = json_extract(e.value,'$.type') AND s.name = json_extract(e.value,'$.name')
            AND s.tbl_name = json_extract(e.value,'$.tbl_name') AND s.sql IS json_extract(e.value,'$.sql')))
      AND (SELECT count(*) FROM ${TABLE}) = json_array_length(?2)
      AND NOT EXISTS (
        SELECT 1 FROM ${TABLE} j WHERE NOT EXISTS (
          SELECT 1 FROM json_each(?2) e WHERE
            j.position = json_extract(e.value,'$.position') AND j.id = json_extract(e.value,'$.id')
            AND j.checksum = json_extract(e.value,'$.checksum')))
    ), 0) THEN 1 ELSE json('turbine-d1-migration-guard-failed') END AS admitted`)
    .bind(encodedSchema, encodedHistory);
}

/**
 * Apply all selected pending migrations in ONE native D1 batch. No automatic retry.
 * Pass the original D1Database binding (not a replicated/unconstrained Session).
 * SQL failures roll back natively, but any lost/malformed dispatch response is
 * conservatively unknown. Retry the same complete plan to reconcile the journal.
 */
export async function migrateD1(
  binding: D1DatabaseBinding,
  migrations: readonly D1Migration[],
  options: D1MigrateOptions = {},
): Promise<D1MigrationReport> {
  // Capture every caller-controlled execution value BEFORE the first await,
  // including all statements and options, not just the currently selected tail.
  if (!binding || typeof binding.prepare !== 'function' || typeof binding.batch !== 'function')
    fail('A caller-owned D1Database binding is required.');
  if (
    !options ||
    typeof options !== 'object' ||
    Object.keys(options).some((key) => key !== 'through' && key !== 'signal')
  )
    fail('Unsupported D1 migration options.');
  const through = options.through;
  const signal = options.signal;
  if (through !== undefined && typeof through !== 'string') fail('through must name an entry in the complete plan.');
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('signal must be an AbortSignal.');
  if (signal?.aborted) throw signal.reason;
  if (!Array.isArray(migrations)) fail('D1 migrations require a complete ordered array.');
  let plan: Entry[];
  try {
    plan = Array.from(migrations, (item) => {
      if (!item || typeof item !== 'object' || Object.keys(item).some((key) => key !== 'id' && key !== 'statements'))
        fail('Invalid D1 migration entry.');
      const id = item.id;
      const statements = item.statements;
      if (typeof id !== 'string' || !/^[0-9]{4,}_[a-z0-9][a-z0-9_-]*$/.test(id) || id.length > 200)
        fail('Migration ids require a numeric prefix and lowercase ASCII name.');
      if (!Array.isArray(statements) || statements.length === 0) fail('A migration requires nonempty statements.');
      return {
        id,
        statements: Array.from(statements, (sql) => {
          migrationStatement(sql);
          return sql;
        }),
        checksum: '',
      };
    });
  } catch (error) {
    if (error instanceof D1MigrationError) throw error;
    throw new D1MigrationError('D1 migration SQL admission failed.', 'admission', 'not-dispatched', error);
  }
  for (let i = 1; i < plan.length; i++)
    if (plan[i - 1]!.id >= plan[i]!.id) fail('Migration ids must be unique and strictly ordered.');
  const selected = through === undefined ? plan.length : plan.findIndex((entry) => entry.id === through) + 1;
  if (through !== undefined && selected === 0) fail('through must name an entry in the complete plan.');
  for (const entry of plan) {
    entry.checksum = await checksum(`turbine-d1-migration-v1\n${JSON.stringify([entry.id, entry.statements])}`);
  }
  let schema: SchemaRow[];
  let snapshot: History[];
  try {
    schema = rows(await binding.prepare(SCHEMA).all<SchemaRow>());
    if (!schemaAllowed(schema))
      fail(
        'D1 migration journal collision or unsupported existing schema (triggers, virtual tables or journal references).',
      );
    snapshot = schema.some((row) => row.name === JOURNAL)
      ? rows(await binding.prepare(`SELECT position, id, checksum FROM ${TABLE} ORDER BY position`).all<History>())
      : [];
  } catch (error) {
    if (error instanceof D1MigrationError) throw error;
    throw new D1MigrationError(
      'D1 migration history could not be read; nothing dispatched.',
      'read',
      'not-dispatched',
      error,
    );
  }
  const hasJournal = schema.some((row) => row.name === JOURNAL);
  const head = snapshot[0];
  if (hasJournal && (head?.position !== 0 || head.id !== '!turbine-d1-v1'))
    fail('D1 journal history head is missing or tampered.');
  const history = hasJournal ? snapshot.slice(1) : [];
  if (history.length > plan.length) fail('Applied migrations are missing from the supplied complete plan.');
  for (let i = 0; i < history.length; i++) {
    const actual = history[i]!;
    const expected = plan[i]!;
    if (actual.position !== i + 1 || actual.id !== expected.id || actual.checksum !== expected.checksum)
      fail('D1 migration history drift, gap, reorder or changed checksum.');
  }
  if (hasJournal && head!.checksum !== (await historyChecksum(history)))
    fail('D1 journal history head mismatch or deleted history suffix.');
  if (selected < history.length) fail('through cannot rewind applied history.');
  const pending = plan.slice(history.length, selected);
  const nextHead = await historyChecksum(
    plan.slice(0, selected).map((entry, i) => ({ position: i + 1, id: entry.id, checksum: entry.checksum })),
  );
  const expectedSchema = hasJournal
    ? schema
    : [
        ...schema,
        { type: 'table', name: JOURNAL, tbl_name: JOURNAL, sql: CREATE },
        { type: 'index', name: `sqlite_autoindex_${JOURNAL}_1`, tbl_name: JOURNAL, sql: null },
      ];
  const prepared: D1PreparedStatement[] = [];
  try {
    prepared.push(
      binding.prepare(CREATE.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')),
      guard(binding, snapshot, expectedSchema),
    );
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i]!;
      for (const sql of entry.statements) prepared.push(binding.prepare(migrationStatement(sql)));
      prepared.push(
        binding
          .prepare(`INSERT INTO ${TABLE}(position,id,checksum) VALUES (?1,?2,?3)`)
          .bind(history.length + i + 1, entry.id, entry.checksum),
      );
    }
    prepared.push(
      binding
        .prepare(
          `INSERT INTO ${TABLE}(position,id,checksum) VALUES (0,'!turbine-d1-v1',?1) ON CONFLICT(position) DO UPDATE SET checksum=excluded.checksum`,
        )
        .bind(nextHead),
    );
  } catch (error) {
    throw new D1MigrationError(
      'D1 migration preparation failed; nothing dispatched.',
      'admission',
      'not-dispatched',
      error,
    );
  }
  if (signal?.aborted) throw signal.reason;
  try {
    const results = await binding.batch(prepared);
    if (!Array.isArray(results) || results.length !== prepared.length)
      throw new Error('D1 migration result cardinality mismatch.');
    for (const result of results) rows(result);
  } catch (error) {
    throw new D1MigrationError(
      'D1 migration batch outcome is unknown. Do not assume rollback or cancel; retry the identical complete plan to reconcile durable history.',
      'dispatch',
      'unknown',
      error,
    );
  }
  return {
    applied: pending.map((entry) => entry.id),
    alreadyApplied: history.map((entry) => entry.id),
  };
}
