/** Native SQLite migration lifecycle. The PostgreSQL runner stays PostgreSQL-specific. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { MigrationError } from '../errors.js';
import type { DestructiveStatement } from './destructive.js';
import {
  type AppliedMigration,
  compareAppliedChecksums,
  type DestructiveOffender,
  formatChecksumMismatchError,
  hasExecutableStatement,
  isChecksumValid,
  listMigrationFiles,
  type MigrationDeployPlan,
  type MigrationFile,
  type MigrationRunResult,
  type MigrationStatus,
  parseMigrationContent,
  parseMigrationFilename,
  planMigrationDeploy,
  predictOutOfOrder,
  type RebaselinedChecksum,
  scanMigrationDestructive,
} from './migrate.js';

export interface SqliteMigrationOptions {
  /** SQLite has one migration schema: main. */
  schema?: string;
  /** PostgreSQL-compatible adapter locks cannot own a SQLite transaction. */
  adapter?: never;
  dialect?: never;
  lockWaitMs?: number;
  onLockWait?: () => void;
}

export interface SqliteMigrationUpOptions extends SqliteMigrationOptions {
  step?: number;
  allowDrift?: boolean;
  force?: boolean;
  allowDestructive?: boolean;
}

export interface SqliteMigrationDownOptions extends SqliteMigrationOptions {
  step?: number;
  allowDrift?: boolean;
  allowDestructive?: boolean;
}

export interface SqliteMigrationDownResult {
  rolledBack: MigrationFile[];
  errors: Array<{ file: MigrationFile; error: string }>;
  rebaselined: RebaselinedChecksum[];
}

// Local structural types keep this new capability usable with older @types/node.
type Authorizer = (
  action: number,
  first: string | null,
  second: string | null,
  database: string | null,
  origin: string | null,
) => number;
interface NativeDatabase extends DatabaseSync {
  readonly isTransaction: boolean;
  setAuthorizer(callback: Authorizer | null): void;
}
interface NativeSqlite {
  DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => NativeDatabase;
  constants: Record<string, number>;
}

const TRACKING = '_turbine_migrations';
const TABLE = 'main."_turbine_migrations"';
const CREATE_TRACKING = `CREATE TABLE ${TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

function validateOptions(filename: string, options?: SqliteMigrationUpOptions): void {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.includes('\0') ||
    (filename !== ':memory:' && /^[a-z][a-z\d+.-]*:/i.test(filename))
  ) {
    throw new MigrationError('SQLite migrations require a normalized filesystem filename or :memory:, not a URL.');
  }
  if (options?.schema !== undefined && options.schema !== 'main') {
    throw new MigrationError('SQLite migrations support only schema "main".');
  }
  if (options?.adapter !== undefined || options?.dialect !== undefined) {
    throw new MigrationError('SQLite migrations do not accept PostgreSQL adapters or caller-supplied dialects.');
  }
  if (options?.step !== undefined && (!Number.isSafeInteger(options.step) || options.step <= 0)) {
    throw new MigrationError('SQLite migration step must be a positive safe integer.');
  }
  if (
    options?.lockWaitMs !== undefined &&
    (!Number.isSafeInteger(options.lockWaitMs) || options.lockWaitMs < 0 || options.lockWaitMs > 2147483647)
  ) {
    throw new MigrationError('SQLite migration lockWaitMs must be an integer between 0 and 2147483647.');
  }
}

function nativeSqlite(write: boolean): NativeSqlite {
  let native: NativeSqlite;
  try {
    native = createRequire(process.cwd())('node:sqlite') as NativeSqlite;
  } catch {
    throw new MigrationError(
      'SQLite migrations require node:sqlite (read inspectors need Node 22.x >= 22.16 or Node >= 24; writes Node >= 24.10).',
    );
  }
  if (write && typeof native.DatabaseSync.prototype.setAuthorizer !== 'function') {
    throw new MigrationError(
      'Native SQLite migrations require DatabaseSync.setAuthorizer and isTransaction (Node >= 24.10).',
    );
  }
  return native;
}

function openDatabase(filename: string, write: boolean): { db: NativeDatabase; native: NativeSqlite } {
  const native = nativeSqlite(write);
  // Probe before opening a filename: unsupported runtimes must not create a DB.
  const probe = new native.DatabaseSync(':memory:');
  try {
    if (write && typeof probe.isTransaction !== 'boolean') {
      throw new MigrationError('Native SQLite migrations require DatabaseSync.isTransaction (Node >= 24.10).');
    }
    if (!write && typeof probe.isTransaction !== 'boolean') {
      throw new MigrationError(
        'SQLite migration inspectors require native readOnly and isTransaction support (Node 22.x >= 22.16 or Node >= 24).',
      );
    }
  } finally {
    probe.close();
  }
  const db = new native.DatabaseSync(filename, { readOnly: !write });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
      throw new MigrationError('SQLite migrations require foreign key enforcement.');
    }
    return { db, native };
  } catch (error) {
    db.close();
    throw error;
  }
}

function readApplied(db: NativeDatabase): AppliedMigration[] {
  const entry = db.prepare('SELECT type FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE').get(TRACKING);
  if (!entry) return [];
  if (entry.type !== 'table') throw new MigrationError('Invalid SQLite migration tracking metadata: expected a table.');
  const columns = db.prepare(`PRAGMA main.table_xinfo("${TRACKING}")`).all();
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (
    columns.length !== 4 ||
    String(byName.get('id')?.type).toUpperCase() !== 'INTEGER' ||
    byName.get('id')?.pk !== 1 ||
    !byName.has('name') ||
    !byName.has('applied_at') ||
    !byName.has('checksum')
  ) {
    throw new MigrationError(
      'Invalid SQLite migration tracking metadata: expected id/name/applied_at/checksum columns.',
    );
  }
  for (const name of ['name', 'checksum', 'applied_at']) {
    const column = byName.get(name)!;
    if (String(column.type).toUpperCase() !== 'TEXT' || column.notnull !== 1 || column.pk !== 0) {
      throw new MigrationError(`Invalid SQLite migration tracking metadata: ${name} must be TEXT NOT NULL.`);
    }
  }
  const uniqueName = db
    .prepare(`PRAGMA main.index_list("${TRACKING}")`)
    .all()
    .some((index) => {
      if (index.unique !== 1 || index.partial !== 0) return false;
      const escaped = String(index.name).replace(/"/g, '""');
      const keys = db.prepare(`PRAGMA main.index_info("${escaped}")`).all();
      return keys.length === 1 && keys[0]?.name === 'name';
    });
  if (!uniqueName) throw new MigrationError('Invalid SQLite migration tracking metadata: name must be UNIQUE.');
  if (
    db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE").get(TRACKING)
  ) {
    throw new MigrationError('SQLite migration tracking metadata must not have triggers.');
  }
  // A user FK could cascade during a trusted history DELETE. Refuse that edge,
  // including FKs introduced by this batch before its first history write.
  for (const table of db.prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table'").all()) {
    const escaped = String(table.name).replace(/"/g, '""');
    const foreignKeys = db.prepare(`PRAGMA main.foreign_key_list("${escaped}")`).all();
    if (foreignKeys.some((fk) => String(fk.table).toLowerCase() === TRACKING)) {
      throw new MigrationError('User tables must not reference SQLite migration tracking metadata.');
    }
  }
  const rows = db.prepare(`SELECT id, name, applied_at, checksum FROM ${TABLE} ORDER BY id`).all();
  const names = new Set<string>();
  return rows.map((row) => {
    // The existing SQLite dialect uses datetime('now'), which is UTC without
    // a zone suffix. Date's space-separated form would otherwise use local TZ.
    const timestamp = String(row.applied_at);
    const date = new Date(
      /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(timestamp) ? `${timestamp.replace(' ', 'T')}Z` : timestamp,
    );
    if (
      typeof row.id !== 'number' ||
      !Number.isSafeInteger(row.id) ||
      row.id < 1 ||
      typeof row.name !== 'string' ||
      names.has(row.name) ||
      typeof row.checksum !== 'string' ||
      !Number.isFinite(date.getTime())
    ) {
      throw new MigrationError('Invalid SQLite migration tracking row.');
    }
    names.add(row.name);
    return { id: row.id, name: row.name, applied_at: date, checksum: row.checksum };
  });
}

function trackingSequence(db: NativeDatabase): unknown[] {
  if (!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'sqlite_sequence'").get())
    return [];
  return db.prepare('SELECT seq FROM main.sqlite_sequence WHERE name = ? COLLATE NOCASE').all(TRACKING);
}

function withRead<T>(
  filename: string,
  options: SqliteMigrationOptions | undefined,
  inspect: (applied: AppliedMigration[]) => T,
): T {
  validateOptions(filename, options);
  nativeSqlite(false);
  if (filename !== ':memory:' && !existsSync(filename)) return inspect([]);
  const { db } = openDatabase(filename, false);
  try {
    // One consistent snapshot even while a writer commits a batch.
    db.exec('BEGIN');
    return inspect(readApplied(db));
  } finally {
    db.close();
  }
}

/** SQLite lexical normalization for the existing destructive scanner only.
 * Execution always uses the original SQL, and SQLite's authorizer owns safety.
 * SQLite has bracket/backtick identifiers, non-nesting comments and no PG E''
 * escaping or dollar quotes. Do not run SQLite policy against PG lexical rules.
 */
function normalizedSql(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end;
      out += ' ';
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const endQuote = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length) {
        if (sql[i++] !== endQuote) continue;
        if (ch !== '[' && sql[i] === endQuote) {
          i++;
          continue;
        }
        break;
      }
      // SQLite accepts single-quoted identifiers in identifier positions too.
      // Hide the content without losing DROP/ALTER's identifier shape.
      out += '"identifier"';
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

interface Snapshot {
  file: MigrationFile;
  content: string;
  sql: string;
  hash: string;
  hits: DestructiveStatement[];
}

/** Static inventory for CLI confirmation. Native authorization also sees trigger effects. */
export function scanSqliteMigrationDestructive(sql: string): DestructiveStatement[] {
  const normalized = normalizedSql(sql);
  const hits = scanMigrationDestructive(normalized).map((hit) => ({ ...hit, statement: sql }));
  if (/\bREPLACE\b(?!\s*\()|\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(normalized)) {
    hits.push({ kind: 'dynamic-unclassified', target: 'SQLite replacement or trigger', statement: sql });
  }
  return hits;
}

function assertNoTransactionControl(normalized: string, file: MigrationFile): void {
  const tokens = normalized.match(/"identifier"|[A-Za-z_][A-Za-z_0-9$]*|[();]/g) ?? [];
  let start = true;
  let trigger = false;
  let body = false;
  let closed = false;
  let cases = 0;
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!.toUpperCase();
    if (start) {
      if (/^(?:BEGIN|END|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ABORT|START)$/.test(word)) {
        throw new MigrationError(`SQLite migration transaction control is owned by the runner: ${file.filename}`);
      }
      const next = tokens[i + 1]?.toUpperCase();
      trigger =
        word === 'CREATE' &&
        (next === 'TRIGGER' ||
          ((next === 'TEMP' || next === 'TEMPORARY') && tokens[i + 2]?.toUpperCase() === 'TRIGGER'));
      body = false;
      closed = false;
      cases = 0;
      start = false;
    }
    if (trigger) {
      if (!body && word === 'BEGIN') body = true;
      else if (body && word === 'CASE') cases++;
      else if (body && word === 'END') {
        if (cases) cases--;
        else closed = true;
      }
    }
    if (word === ';' && (!trigger || closed)) start = true;
  }
}

function snapshot(file: MigrationFile, section: 'up' | 'down'): Snapshot {
  const content = readFileSync(file.path, 'utf8');
  if (content.includes('\0')) throw new MigrationError(`SQLite migration contains a NUL character: ${file.filename}`);
  const parsed = parseMigrationContent(content, file.path);
  if (parsed.noTransaction) throw new MigrationError(`SQLite refuses -- turbine:no-transaction: ${file.filename}`);
  const sql = parsed[section];
  const normalized = normalizedSql(sql);
  if (!hasExecutableStatement(normalized)) {
    throw new MigrationError(`Migration ${file.filename} has no executable ${section.toUpperCase()} section.`);
  }
  assertNoTransactionControl(normalized, file);
  const hits = scanSqliteMigrationDestructive(sql);
  return { file, content, sql, hash: createHash('sha256').update(content, 'utf8').digest('hex'), hits };
}

/** Read-only static preflight for CLI previews. Native authorization is execution-only. */
export function assertSqliteMigrationFiles(files: readonly MigrationFile[], direction: 'up' | 'down'): void {
  for (const file of files) snapshot(file, direction);
}

function rollbackPlan(applied: AppliedMigration[], migrationsDir: string, options?: SqliteMigrationDownOptions) {
  const { mismatches } = compareAppliedChecksums(applied, migrationsDir);
  const blocking = mismatches.filter((m) => m.type === 'missing' || !options?.allowDrift);
  if (blocking.length) throw new MigrationError(formatChecksumMismatchError(blocking, 'roll back'));
  const files = new Map(listMigrationFiles(migrationsDir).map((f) => [f.name, f]));
  const toRollback: MigrationFile[] = [];
  for (const row of [...applied].reverse().slice(0, options?.step ?? 1)) {
    const file = files.get(row.name)!; // missing files refused above
    if (
      !hasExecutableStatement(normalizedSql(parseMigrationContent(readFileSync(file.path, 'utf8'), file.path).down))
    ) {
      return { toRollback, stoppedAt: { name: row.name, error: 'No executable DOWN section found in migration file' } };
    }
    snapshot(file, 'down');
    toRollback.push(file);
  }
  return { toRollback, stoppedAt: null };
}

export async function inspectSqliteMigrationDeploy(
  filename: string,
  migrationsDir: string,
  options?: SqliteMigrationOptions,
): Promise<MigrationDeployPlan> {
  return withRead(filename, options, (applied) => planMigrationDeploy(migrationsDir, applied));
}

export async function planSqliteMigrationRollback(
  filename: string,
  migrationsDir: string,
  options?: SqliteMigrationDownOptions,
): Promise<ReturnType<typeof rollbackPlan>> {
  return withRead(filename, options, (applied) => rollbackPlan(applied, migrationsDir, options));
}

export async function migrateSqliteStatus(
  filename: string,
  migrationsDir: string,
  options?: SqliteMigrationOptions,
): Promise<MigrationStatus[]> {
  return withRead(filename, options, (applied) => {
    const records = new Map(applied.map((row) => [row.name, row]));
    const files = listMigrationFiles(migrationsDir);
    const names = new Set(files.map((f) => f.name));
    const statuses: MigrationStatus[] = files.map((file) => {
      const row = records.get(file.name);
      return {
        file,
        applied: !!row,
        appliedAt: row?.applied_at,
        checksumValid: row ? isChecksumValid(row.checksum, readFileSync(file.path, 'utf8')) : undefined,
      };
    });
    for (const row of applied) {
      if (names.has(row.name)) continue;
      statuses.push({
        file: parseMigrationFilename(`${row.name}.sql`) ?? {
          filename: `${row.name}.sql`,
          path: '',
          name: row.name,
          timestamp: '',
        },
        applied: true,
        appliedAt: row.applied_at,
        checksumValid: false,
        missingFile: true,
      });
    }
    return statuses.sort((a, b) => (a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0));
  });
}

/** The same native writer slot is used by migrations and schema pushes. */
function beginSqliteWrite(db: NativeDatabase, options?: SqliteMigrationOptions): void {
  const wait = options?.lockWaitMs ?? 0;
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    if ((error as { errcode?: number }).errcode !== 5) throw error;
    if (wait === 0) throw new MigrationError('Could not acquire SQLite migration lock: another writer is running.');
    options?.onLockWait?.();
    db.exec(`PRAGMA busy_timeout = ${wait}`);
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (cause) {
      if ((cause as { errcode?: number }).errcode !== 5) throw cause;
      throw new MigrationError(`Could not acquire SQLite migration lock within ${wait}ms: another writer is running.`);
    }
  }
  if (!db.isTransaction) throw new MigrationError('SQLite migration transaction ownership was lost.');
  // Keep the same bound for a COMMIT waiting on existing readers, even when
  // BEGIN IMMEDIATE acquired the writer slot without waiting.
  db.exec(`PRAGMA busy_timeout = ${wait}`);
}

/**
 * Internal schema lifecycle seam. Owns the handle and BEGIN IMMEDIATE; callbacks
 * are synchronous, must leave the transaction open, and cannot write history.
 * History and its AUTOINCREMENT sequence are checked before committing.
 */
export function withSqliteSchemaTransaction<T>(
  filename: string,
  run: (db: DatabaseSync) => T,
  options?: SqliteMigrationOptions,
): T {
  validateOptions(filename, options);
  const { db, native } = openDatabase(filename, true);
  let denied = false;
  try {
    beginSqliteWrite(db, options);
    const history = JSON.stringify(readApplied(db));
    const sequence = JSON.stringify(trackingSequence(db));
    const c = native.constants;
    db.setAuthorizer((action, first, second) => {
      const pragma = first?.toLowerCase();
      const safePragma =
        action === c.SQLITE_PRAGMA &&
        ((['foreign_keys', 'schema_version'].includes(pragma ?? '') && second === null) ||
          ['foreign_key_check', 'table_xinfo', 'foreign_key_list'].includes(pragma ?? ''));
      if (
        [
          c.SQLITE_TRANSACTION,
          c.SQLITE_SAVEPOINT,
          c.SQLITE_ATTACH,
          c.SQLITE_DETACH,
          c.SQLITE_CREATE_VTABLE,
          c.SQLITE_DROP_VTABLE,
        ].includes(action) ||
        (action === c.SQLITE_PRAGMA && !safePragma) ||
        ([c.SQLITE_INSERT, c.SQLITE_UPDATE, c.SQLITE_DELETE, c.SQLITE_DROP_TABLE].includes(action) &&
          first?.toLowerCase() === TRACKING) ||
        (action === c.SQLITE_ALTER_TABLE && second?.toLowerCase() === TRACKING)
      ) {
        denied = true;
        return c.SQLITE_DENY!;
      }
      return c.SQLITE_OK!;
    });
    const result = run(db);
    db.setAuthorizer(null);
    if (denied)
      throw new MigrationError(
        'SQLite schema SQL must not change transaction ownership, foreign key policy or migration history.',
      );
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new MigrationError('SQLite schema transaction callback must be synchronous.');
    }
    if (
      !db.isTransaction ||
      history !== JSON.stringify(readApplied(db)) ||
      sequence !== JSON.stringify(trackingSequence(db))
    ) {
      throw new MigrationError('SQLite schema transaction ownership or migration history changed; rolling back.');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.setAuthorizer(null);
    // A failed cleanup must not replace the original DDL/constraint failure.
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* close still releases the owned handle */
    }
    if (denied)
      throw new MigrationError(
        'SQLite schema SQL must not change transaction ownership, foreign key policy or migration history.',
      );
    throw error;
  } finally {
    db.close();
  }
}

interface BatchResult {
  files: MigrationFile[];
  errors: Array<{ file: MigrationFile; error: string }>;
  destructive: DestructiveOffender[];
  rebaselined: RebaselinedChecksum[];
  outOfOrder: MigrationRunResult['outOfOrder'];
}

function runBatch(
  filename: string,
  migrationsDir: string,
  direction: 'up' | 'down',
  options?: SqliteMigrationUpOptions,
): BatchResult {
  validateOptions(filename, options);
  const { db, native } = openDatabase(filename, true);
  const result: BatchResult = { files: [], errors: [], destructive: [], rebaselined: [], outOfOrder: [] };
  let current: Snapshot | undefined;
  let userSql = false;
  let denied: string | undefined;
  let replacingTables = new Set<string>();
  let replacingTriggers = new Set<string>();
  const c = native.constants;
  try {
    beginSqliteWrite(db, options);
    const applied = readApplied(db);
    const { mismatches, legacyUpgrades } = compareAppliedChecksums(applied, migrationsDir);
    const blocking = mismatches.filter((m) => m.type === 'missing' || !(options?.allowDrift || options?.force));
    if (blocking.length)
      throw new MigrationError(
        formatChecksumMismatchError(blocking, direction === 'up' ? 'apply pending migrations' : 'roll back'),
      );
    let files: MigrationFile[];
    if (direction === 'up') {
      const names = new Set(applied.map((row) => row.name));
      files = listMigrationFiles(migrationsDir)
        .filter((f) => !names.has(f.name))
        .slice(0, options?.step);
    } else {
      const plan = rollbackPlan(applied, migrationsDir, options);
      if (plan.stoppedAt)
        throw new MigrationError(`${plan.stoppedAt.name}: ${plan.stoppedAt.error}; no migrations rolled back.`);
      files = plan.toRollback;
    }
    const batch = files.map((file) => snapshot(file, direction));
    if (direction === 'down' && !options?.allowDrift) {
      const recorded = new Map(applied.map((row) => [row.name, row.checksum]));
      for (const item of batch) {
        if (!isChecksumValid(recorded.get(item.file.name)!, item.content)) {
          throw new MigrationError(
            `Migration ${item.file.filename} changed after checksum validation; no migrations rolled back.`,
          );
        }
      }
    }
    result.destructive = batch.filter((s) => s.hits.length).map((s) => ({ file: s.file.filename, hits: s.hits }));
    if (!options?.allowDestructive && result.destructive.length) {
      throw new MigrationError(
        `Refusing DESTRUCTIVE SQLite migration SQL (${direction}): ${result.destructive.map((o) => o.file).join(', ')}. Review and pass --allow-destructive.`,
      );
    }
    if (!db.prepare('SELECT 1 FROM main.sqlite_schema WHERE name = ? COLLATE NOCASE').get(TRACKING))
      db.exec(CREATE_TRACKING);
    db.setAuthorizer((action, first, second, _database, origin) => {
      // READ/UPDATE put a column in second; index/trigger DDL and ALTER put
      // their target table there. Other actions (such as REINDEX) may name an
      // index instead. Protect only arguments documented as table/view names.
      // https://www.sqlite.org/c3ref/c_alter_table.html
      const target = [
        c.SQLITE_CREATE_INDEX,
        c.SQLITE_CREATE_TEMP_INDEX,
        c.SQLITE_CREATE_TRIGGER,
        c.SQLITE_CREATE_TEMP_TRIGGER,
        c.SQLITE_DROP_INDEX,
        c.SQLITE_DROP_TEMP_INDEX,
        c.SQLITE_DROP_TRIGGER,
        c.SQLITE_DROP_TEMP_TRIGGER,
        c.SQLITE_ALTER_TABLE,
      ].includes(action)
        ? second
        : [
              c.SQLITE_CREATE_TABLE,
              c.SQLITE_CREATE_TEMP_TABLE,
              c.SQLITE_CREATE_VIEW,
              c.SQLITE_CREATE_TEMP_VIEW,
              c.SQLITE_DELETE,
              c.SQLITE_DROP_TABLE,
              c.SQLITE_DROP_TEMP_TABLE,
              c.SQLITE_DROP_VIEW,
              c.SQLITE_DROP_TEMP_VIEW,
              c.SQLITE_INSERT,
              c.SQLITE_READ,
              c.SQLITE_UPDATE,
              c.SQLITE_ANALYZE,
              c.SQLITE_CREATE_VTABLE,
              c.SQLITE_DROP_VTABLE,
            ].includes(action)
          ? first
          : null;
      const internal = target?.toLowerCase() === TRACKING;
      if (internal && (userSql || origin !== null)) {
        denied = 'User migration SQL must not access internal SQLite migration tracking metadata.';
      } else if (
        userSql &&
        [
          c.SQLITE_TRANSACTION,
          c.SQLITE_SAVEPOINT,
          c.SQLITE_PRAGMA,
          c.SQLITE_ATTACH,
          c.SQLITE_DETACH,
          c.SQLITE_CREATE_VTABLE,
          c.SQLITE_DROP_VTABLE,
        ].includes(action)
      ) {
        denied = 'SQLite migration transaction control, PRAGMA, ATTACH/DETACH and virtual tables are unsupported.';
      } else if (
        userSql &&
        ([c.SQLITE_DELETE, c.SQLITE_UPDATE, c.SQLITE_DROP_TABLE, c.SQLITE_ALTER_TABLE].includes(action) ||
          (action === c.SQLITE_INSERT &&
            !!first &&
            (first.toLowerCase() === 'sqlite_sequence' ||
              replacingTables.has(first.toLowerCase()) ||
              (origin !== null && replacingTriggers.has(origin.toLowerCase()))))) &&
        target &&
        (!target.toLowerCase().startsWith('sqlite_') || target.toLowerCase() === 'sqlite_sequence')
      ) {
        // SQLite sees triggers, cascades, alternate quoting and every lexer edge.
        // Conservatively include all UPDATEs, including those with WHERE.
        const hit: DestructiveStatement = {
          kind:
            action === c.SQLITE_DELETE
              ? 'delete'
              : action === c.SQLITE_DROP_TABLE
                ? 'drop-table'
                : 'dynamic-unclassified',
          target,
          statement: current!.sql,
        };
        let offender = result.destructive.find((o) => o.file === current!.file.filename);
        if (!offender) {
          offender = { file: current!.file.filename, hits: [] };
          result.destructive.push(offender);
        }
        if (!offender.hits.some((h) => h.kind === hit.kind && h.target === target)) offender.hits.push(hit);
        if (!options?.allowDestructive)
          denied = `Refusing DESTRUCTIVE SQLite migration SQL affecting ${target}; review and pass --allow-destructive.`;
      }
      return denied ? c.SQLITE_DENY! : c.SQLITE_OK!;
    });
    try {
      for (const item of batch) {
        current = item;
        if (!db.isTransaction) throw new MigrationError('SQLite migration transaction ownership was lost.');
        replacingTables = new Set(
          db
            .prepare(`SELECT name, sql FROM main.sqlite_schema WHERE type = 'table'
          UNION ALL SELECT name, sql FROM temp.sqlite_schema WHERE type = 'table'`)
            .all()
            .filter((table) => /\bON\s+CONFLICT\s+REPLACE\b/i.test(normalizedSql(String(table.sql))))
            .map((table) => String(table.name).toLowerCase()),
        );
        replacingTriggers = new Set(
          db
            .prepare(`SELECT name, sql FROM main.sqlite_schema WHERE type = 'trigger'
          UNION ALL SELECT name, sql FROM temp.sqlite_schema WHERE type = 'trigger'`)
            .all()
            .filter((trigger) => /\bREPLACE\b(?!\s*\()/i.test(normalizedSql(String(trigger.sql))))
            .map((trigger) => String(trigger.name).toLowerCase()),
        );
        // SQLite maintains user-table sequences during DROP/RENAME. Permit that
        // with destructive consent, but require the history sequence to survive
        // user SQL unchanged before any trusted tracking operation occurs.
        const sequenceBefore = trackingSequence(db);
        userSql = true;
        try {
          db.exec(item.sql);
        } finally {
          userSql = false;
        }
        if (denied) throw new MigrationError(denied);
        if (!db.isTransaction) throw new MigrationError('SQLite migration transaction ownership was lost.');
        const sequenceAfter = trackingSequence(db);
        if (JSON.stringify(sequenceBefore) !== JSON.stringify(sequenceAfter)) {
          throw new MigrationError(
            'User migration SQL must not modify internal SQLite migration tracking metadata sequences.',
          );
        }
        readApplied(db); // validate no newly-created FK/trigger can affect tracking
        const change =
          direction === 'up'
            ? db.prepare(`INSERT INTO ${TABLE} (name, checksum) VALUES (?, ?)`).run(item.file.name, item.hash)
            : db.prepare(`DELETE FROM ${TABLE} WHERE name = ?`).run(item.file.name);
        if (change.changes !== 1)
          throw new MigrationError('SQLite migration history write did not affect exactly one row; rolling back.');
      }
      for (const upgrade of legacyUpgrades)
        db.prepare(`UPDATE ${TABLE} SET checksum = ? WHERE name = ?`).run(upgrade.checksum, upgrade.name);
      for (const mismatch of mismatches) {
        if (mismatch.type !== 'modified') continue;
        const updated = db
          .prepare(`UPDATE ${TABLE} SET checksum = ? WHERE name = ?`)
          .run(mismatch.actual, mismatch.name);
        if (updated.changes)
          result.rebaselined.push({ name: mismatch.name, from: mismatch.expected, to: mismatch.actual });
      }
      const expected = new Map(applied.map((row) => [row.name, row.checksum]));
      for (const upgrade of legacyUpgrades) expected.set(upgrade.name, upgrade.checksum);
      for (const mismatch of mismatches) {
        if (mismatch.type === 'modified') expected.set(mismatch.name, mismatch.actual);
      }
      for (const item of batch) {
        if (direction === 'up') expected.set(item.file.name, item.hash);
        else expected.delete(item.file.name);
      }
      const finalHistory = readApplied(db);
      if (
        finalHistory.length !== expected.size ||
        finalHistory.some((row) => expected.get(row.name) !== row.checksum)
      ) {
        throw new MigrationError('SQLite migration history differs from the executed batch; rolling back.');
      }
      if (!db.isTransaction) throw new MigrationError('SQLite migration transaction ownership was lost before commit.');
      db.exec('COMMIT');
      result.files = files;
      result.outOfOrder = direction === 'up' ? predictOutOfOrder(applied, files) : [];
      return result;
    } catch (error) {
      if (denied) throw new MigrationError(denied);
      if (error instanceof MigrationError || !current) throw error;
      result.rebaselined = [];
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({
        file: current.file,
        error: db.isTransaction
          ? message
          : `SQLite rolled back the migration transaction and released its writer lock: ${message}`,
      });
      return result;
    }
  } finally {
    // Clearing the authorizer also makes rollback possible after a denied op.
    db.setAuthorizer(null);
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}

/** One native writer transaction covers the entire selected batch. */
export async function migrateSqliteUp(
  filename: string,
  migrationsDir: string,
  options?: SqliteMigrationUpOptions,
): Promise<MigrationRunResult> {
  const result = runBatch(filename, migrationsDir, 'up', options);
  return {
    applied: result.files,
    errors: result.errors,
    destructive: result.destructive,
    outOfOrder: result.outOfOrder,
    noTransaction: [],
    rebaselined: result.rebaselined,
  };
}

export async function migrateSqliteDeploy(
  filename: string,
  migrationsDir: string,
  options?: SqliteMigrationOptions & { allowDrift?: boolean },
): Promise<MigrationRunResult> {
  return migrateSqliteUp(filename, migrationsDir, { ...options, allowDestructive: true });
}

export async function migrateSqliteDown(
  filename: string,
  migrationsDir: string,
  options?: SqliteMigrationDownOptions,
): Promise<SqliteMigrationDownResult> {
  const result = runBatch(filename, migrationsDir, 'down', options);
  return { rolledBack: result.files, errors: result.errors, rebaselined: result.rebaselined };
}
