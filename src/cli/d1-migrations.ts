/** Local complete-plan capture and genuinely read-only native D1 journal inspection. */
import { createHash } from 'node:crypto';
import { type D1Migration, D1MigrationError } from '../d1/migrate.js';
import { migrationStatement } from '../d1/migrations/sql.js';
import type { D1DatabaseBinding, D1Result } from '../d1/types.js';
import { ValidationError } from '../errors.js';
import { isRefusedOpen, readNoFollow } from './no-follow.js';

const JOURNAL = '_turbine_d1_migrations';
const CREATE =
  'CREATE TABLE "_turbine_d1_migrations" (position INTEGER PRIMARY KEY CHECK(position >= 0), id TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL CHECK(length(checksum) = 64)) STRICT';
const SCHEMA = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name';
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
type History = { position: number; id: string; checksum: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never {
  throw new D1MigrationError(message, 'admission', 'not-dispatched');
}

/** Owned JSON values, never executable module loading or SQL script splitting. */
export function captureD1Plan(value: unknown): D1Migration[] {
  if (!Array.isArray(value)) fail('D1 migrations require a complete ordered array.');
  const plan = Array.from(value, (entry): D1Migration => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Object.keys(entry).some((key) => key !== 'id' && key !== 'statements') ||
      typeof entry.id !== 'string' ||
      !/^[0-9]{4,}_[a-z0-9][a-z0-9_-]*$/.test(entry.id) ||
      entry.id.length > 200 ||
      !Array.isArray(entry.statements) ||
      !entry.statements.length
    )
      fail('Invalid D1 migration entry.');
    return {
      id: entry.id,
      statements: Array.from(entry.statements, (sql) => {
        try {
          migrationStatement(sql);
        } catch (cause) {
          throw new D1MigrationError('D1 migration SQL admission failed.', 'admission', 'not-dispatched', cause);
        }
        return sql as string;
      }),
    };
  });
  for (let i = 1; i < plan.length; i++)
    if (plan[i - 1]!.id >= plan[i]!.id) fail('Migration ids must be unique and strictly ordered.');
  return plan;
}
export function readD1Plan(path: string): D1Migration[] {
  const refused = () => new ValidationError('D1 plan.json must be a regular, unaliased file of at most 10 MB.');
  let bytes: Buffer;
  try {
    // Checked and read through one descriptor, so the file admitted is the file read.
    bytes = readNoFollow(path, (stat) => {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10_000_000) throw refused();
    });
  } catch (error) {
    if (isRefusedOpen(error)) throw refused();
    throw error;
  }
  return captureD1Plan(JSON.parse(bytes.toString('utf8')));
}
function rows<Row>(result: D1Result<Row>): Row[] {
  if (result?.success !== true || !Array.isArray(result.results))
    throw new Error('Malformed or unsuccessful D1 result.');
  return result.results;
}
function admittedSchema(schema: SchemaRow[]): void {
  for (const row of schema) {
    if (
      !row ||
      typeof row.type !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.tbl_name !== 'string' ||
      (row.sql !== null && typeof row.sql !== 'string')
    )
      fail('Malformed D1 schema snapshot.');
    if (row.name === JOURNAL) {
      if (row.type !== 'table' || row.tbl_name !== JOURNAL || row.sql !== CREATE) fail('D1 journal schema mismatch.');
    } else if (row.tbl_name === JOURNAL) {
      if (row.type !== 'index' || row.sql !== null || row.name !== `sqlite_autoindex_${JOURNAL}_1`)
        fail('D1 journal index mismatch.');
    } else {
      if (row.type === 'trigger' || (row.sql ?? '').toLowerCase().includes(JOURNAL))
        fail('Unsupported D1 migration schema.');
      if (row.sql !== null && !row.name.startsWith('sqlite_') && row.name !== '_cf_METADATA') {
        try {
          migrationStatement(row.sql);
        } catch {
          fail('Unsupported D1 migration schema.');
        }
      }
    }
  }
}
export interface D1MigrationStatus {
  historyState: 'uninitialized' | 'initialized';
  applied: string[];
  pending: string[];
}
/**
 * All statements are SELECTs in one native atomic batch. Discovery only chooses
 * whether the journal SELECT is legal; the captured schema must still match it.
 * Miniflare may maintain its own files/WAL while opening the persistent binding.
 */
export async function inspectD1Migrations(
  binding: D1DatabaseBinding,
  input: readonly D1Migration[],
): Promise<D1MigrationStatus> {
  const plan = captureD1Plan(input);
  const checksums = plan.map((entry) =>
    hash(`turbine-d1-migration-v1\n${JSON.stringify([entry.id, entry.statements])}`),
  );
  let schema: SchemaRow[];
  let snapshot: History[];
  try {
    const discovered = rows(await binding.prepare(SCHEMA).all<SchemaRow>());
    admittedSchema(discovered);
    const hasJournal = discovered.some((row) => row.name === JOURNAL);
    const statements = [binding.prepare(SCHEMA)];
    if (hasJournal)
      statements.push(binding.prepare(`SELECT position, id, checksum FROM "${JOURNAL}" ORDER BY position`));
    const results = await binding.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length)
      throw new Error('D1 status result cardinality mismatch.');
    schema = rows(results[0]!) as SchemaRow[];
    admittedSchema(schema);
    if (JSON.stringify(schema) !== JSON.stringify(discovered))
      fail('D1 schema changed during status discovery. Retry status.');
    snapshot = hasJournal ? (rows(results[1]!) as History[]) : [];
  } catch (cause) {
    if (cause instanceof D1MigrationError) throw cause;
    throw new D1MigrationError(
      'D1 migration history could not be read; nothing dispatched.',
      'read',
      'not-dispatched',
      cause,
    );
  }
  const initialized = schema.some((row) => row.name === JOURNAL);
  if (!initialized) return { historyState: 'uninitialized', applied: [], pending: plan.map((entry) => entry.id) };
  const head = snapshot[0];
  if (head?.position !== 0 || head.id !== '!turbine-d1-v1') fail('D1 journal history head is missing or tampered.');
  const history = snapshot.slice(1);
  if (history.length > plan.length) fail('Applied migrations are missing from the supplied complete plan.');
  for (let i = 0; i < history.length; i++) {
    const actual = history[i]!;
    if (!actual || actual.position !== i + 1 || actual.id !== plan[i]!.id || actual.checksum !== checksums[i])
      fail('D1 migration history drift, gap, reorder or changed checksum.');
  }
  if (
    head.checksum !==
    hash(`turbine-d1-history-v1\n${JSON.stringify(history.map((row) => [row.position, row.id, row.checksum]))}`)
  )
    fail('D1 journal history head mismatch or deleted history suffix.');
  return {
    historyState: 'initialized',
    applied: history.map((row) => row.id),
    pending: plan.slice(history.length).map((entry) => entry.id),
  };
}
