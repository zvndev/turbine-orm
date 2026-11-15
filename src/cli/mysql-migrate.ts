/** Native MySQL migrations with a persistent partial-DDL journal and one pinned connection. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MigrationError } from '../errors.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import {
  type AppliedMigration,
  compareAppliedChecksums,
  formatChecksumMismatchError,
  isChecksumValid,
  listIgnoredSqlFiles,
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
} from './migrate.js';
import {
  type MysqlMigrationSqlMode,
  type MysqlMigrationStatement,
  parseMysqlMigrationStatements,
  scanMysqlMigrationDestructive,
} from './mysql-migrate-sql.js';

export interface MysqlMigrationOptions {
  /** MySQL schema is the database selected by the URL; it cannot be overridden. */
  schema?: string;
  adapter?: never;
  dialect?: never;
  lockWaitMs?: number;
  onLockWait?: () => void;
}

export interface MysqlMigrationUpOptions extends MysqlMigrationOptions {
  step?: number;
  allowDrift?: boolean;
  /** Reapplying an applied MySQL migration is unsafe and is refused. */
  force?: boolean;
  allowDestructive?: boolean;
}

export interface MysqlMigrationDownOptions extends MysqlMigrationOptions {
  step?: number;
  allowDrift?: boolean;
  allowDestructive?: boolean;
}

export interface MysqlMigrationDownResult {
  rolledBack: MigrationFile[];
  errors: Array<{ file: MigrationFile; error: string }>;
  rebaselined: RebaselinedChecksum[];
}

export interface MysqlMigrationDirty {
  name: string;
  checksum: string;
  direction: 'up' | 'down';
  /** Confirmed responses, not proof that the following statement had no effects. */
  completedStatements: number;
  totalStatements: number;
}

export interface MysqlMigrationDeployPlan extends MigrationDeployPlan {
  dirty: MysqlMigrationDirty | null;
}

export interface MysqlMigrationStatus extends MigrationStatus {
  dirty?: MysqlMigrationDirty;
}

export interface MysqlMigrationRecoveryOptions extends MysqlMigrationOptions {
  name: string;
  checksum: string;
  outcome: 'applied' | 'rolled-back';
  /** Caller has independently reconciled actual schema/data to the asserted outcome. */
  acknowledgePartialDdl: true;
}

interface NativeConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  execute(sql: string, values: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy(): void;
}

type Row = Record<string, unknown>;
interface Session {
  connection: NativeConnection;
  database: string;
  lockName: string;
  mode: MysqlMigrationSqlMode;
}

const HISTORY = '_turbine_migrations';
const STATE = '_turbine_migration_state';
const HISTORY_SQL = '`_turbine_migrations`';
const STATE_SQL = '`_turbine_migration_state`';
const CREATE_HISTORY = `CREATE TABLE IF NOT EXISTS ${HISTORY_SQL} (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,
  checksum VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB`;
const CREATE_STATE = `CREATE TABLE IF NOT EXISTS ${STATE_SQL} (
  id INT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  checksum VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  direction VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  completed_statements INT UNSIGNED NOT NULL,
  total_statements INT UNSIGNED NOT NULL,
  CHECK (id = 1)
) ENGINE=InnoDB`;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function connectionOptions(connectionString: string, options?: MysqlMigrationUpOptions): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(connectionString);
    if (url.protocol !== 'mysql:' || !url.hostname || url.search || url.hash) throw new Error();
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!database || /[/\\\0]/.test(database) || database.length > 64) throw new Error();
    if (options?.schema !== undefined && options.schema !== database) {
      throw new MigrationError('MySQL migration schema must match the database selected in the connection URL.');
    }
    if (options?.adapter !== undefined || options?.dialect !== undefined) {
      throw new MigrationError('MySQL migrations do not accept PostgreSQL adapters or caller-supplied dialects.');
    }
    if (options?.step !== undefined && (!Number.isSafeInteger(options.step) || options.step <= 0)) {
      throw new MigrationError('MySQL migration step must be a positive safe integer.');
    }
    if (
      options?.lockWaitMs !== undefined &&
      (!Number.isSafeInteger(options.lockWaitMs) || options.lockWaitMs < 0 || options.lockWaitMs > 2147483647)
    ) {
      throw new MigrationError('MySQL migration lockWaitMs must be an integer between 0 and 2147483647.');
    }
    if (options?.force)
      throw new MigrationError('MySQL migrations refuse force reapplication; create a new migration.');
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: 10_000,
    };
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError('MySQL migrations require a mysql:// URL selecting one database, without query options.');
  }
}

async function rows(connection: NativeConnection, sql: string, values?: unknown[]): Promise<Row[]> {
  // Server-bound values remain correct under NO_BACKSLASH_ESCAPES, including
  // migration names with apostrophes. mysql2.query(values) escapes in JS.
  const [result] = values ? await connection.execute(sql, values) : await connection.query(sql);
  if (!Array.isArray(result)) throw new MigrationError('Invalid native MySQL migration query result.');
  return result as Row[];
}

async function changed(connection: NativeConnection, sql: string, values: unknown[]): Promise<void> {
  const [result] = await connection.execute(sql, values);
  if ((result as { affectedRows?: number })?.affectedRows !== 1) {
    throw new MigrationError('MySQL migration metadata changed unexpectedly; inspect the journal before recovery.');
  }
}

async function withSession<T>(
  connectionString: string,
  options: MysqlMigrationUpOptions | undefined,
  body: (session: Session) => Promise<T>,
): Promise<T> {
  const config = connectionOptions(connectionString, options);
  let peer: { createConnection(config: Record<string, unknown>): Promise<NativeConnection> };
  try {
    peer = (await importOptionalPeer('mysql2/promise')) as typeof peer;
  } catch {
    throw new MigrationError('Native MySQL migrations require the optional mysql2 peer. Install mysql2 to use them.');
  }
  const connection = await peer.createConnection(config);
  let locked = false;
  let failed = false;
  let failure: unknown;
  let result!: T;
  let lockName = '';
  try {
    const [probe] = await rows(
      connection,
      `SELECT DATABASE() AS db, VERSION() AS version, @@session.autocommit AS autocommit,
       @@session.sql_mode AS sql_mode, @@session.default_storage_engine AS engine,
       @@lower_case_table_names AS lower_case_table_names`,
    );
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(String(probe?.version));
    if (
      !probe ||
      /mariadb/i.test(String(probe.version)) ||
      !version ||
      Number(version[1]) < 8 ||
      (Number(version[1]) === 8 && Number(version[2]) === 0 && Number(version[3]) < 17)
    ) {
      throw new MigrationError(
        'Native MySQL migrations require MySQL >= 8.0.17 for exact binary migration-name identity; MariaDB is unsupported.',
      );
    }
    if (
      probe.db !== config.database ||
      Number(probe.autocommit) !== 1 ||
      String(probe.engine).toUpperCase() !== 'INNODB' ||
      !/(?:^|,)STRICT_(?:TRANS|ALL)_TABLES(?:,|$)/.test(String(probe.sql_mode))
    ) {
      throw new MigrationError(
        'MySQL migrations require the selected database, autocommit, strict SQL mode and default InnoDB.',
      );
    }
    const database = String(probe.db);
    const lockDatabase = Number(probe.lower_case_table_names) ? database.toLowerCase() : database;
    lockName = `turbine:${sha256(lockDatabase).slice(0, 56)}`;
    let [lock] = await rows(connection, 'SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(lock?.acquired) !== 1 && lock?.acquired !== null && (options?.lockWaitMs ?? 0) > 0) {
      options?.onLockWait?.();
      [lock] = await rows(connection, 'SELECT GET_LOCK(?, ?) AS acquired', [lockName, options!.lockWaitMs! / 1000]);
    }
    if (Number(lock?.acquired) !== 1) throw new MigrationError('Could not acquire the native MySQL migration lock.');
    locked = true;
    const modes = String(probe.sql_mode).split(',');
    result = await body({
      connection,
      database,
      lockName,
      mode: { noBackslashEscapes: modes.includes('NO_BACKSLASH_ESCAPES'), ansiQuotes: modes.includes('ANSI_QUOTES') },
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      if (locked) {
        const [released] = await rows(connection, 'SELECT RELEASE_LOCK(?) AS released', [lockName]);
        if (Number(released?.released) !== 1 && !failed) {
          failed = true;
          failure = new MigrationError('MySQL migration lock ownership was lost.');
        }
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    } finally {
      try {
        await connection.end();
      } catch {
        connection.destroy();
      }
    }
  }
  if (failed) throw failure;
  return result;
}

async function assertOwnership(session: Session): Promise<void> {
  const [row] = await rows(
    session.connection,
    'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned, DATABASE() AS db, @@session.autocommit AS autocommit',
    [session.lockName],
  );
  if (Number(row?.owned) !== 1 || row?.db !== session.database || Number(row?.autocommit) !== 1) {
    throw new MigrationError('MySQL migration connection, database or lock ownership changed.');
  }
}

/** Validate history storage before trusting any metadata or issuing writes to it. */
async function metadataTables(connection: NativeConnection): Promise<Set<string>> {
  const tables = await rows(
    connection,
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) IN (?, ?)`,
    [HISTORY, STATE],
  );
  const present = new Set<string>();
  for (const table of tables) {
    const name = String(table.name);
    if (![HISTORY, STATE].includes(name) || table.type !== 'BASE TABLE' || table.engine !== 'InnoDB') {
      throw new MigrationError('Invalid MySQL migration tracking metadata: expected native InnoDB tables.');
    }
    present.add(name);
    const columns = await rows(
      connection,
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS key_type,
       EXTRA AS extra, COLLATION_NAME AS collation, CHARACTER_MAXIMUM_LENGTH AS max_length,
       COLUMN_TYPE AS full_type FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [name],
    );
    const expected =
      name === HISTORY
        ? ['id', 'name', 'checksum', 'applied_at']
        : ['id', 'name', 'checksum', 'direction', 'completed_statements', 'total_statements'];
    if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index])) {
      throw new MigrationError('Invalid MySQL migration tracking metadata: unexpected columns or column order.');
    }
    for (const column of columns) {
      const key = String(column.name);
      const isId = key === 'id';
      const type = isId
        ? name === HISTORY
          ? 'bigint'
          : 'int'
        : key === 'applied_at'
          ? 'datetime'
          : key.endsWith('_statements')
            ? 'int'
            : 'varchar';
      const extra = isId && name === HISTORY ? 'auto_increment' : '';
      const collation =
        key === 'name' ? 'utf8mb4_0900_bin' : ['checksum', 'direction'].includes(key) ? 'ascii_bin' : null;
      const length = key === 'name' ? 255 : key === 'checksum' ? 64 : key === 'direction' ? 4 : null;
      if (
        column.type !== type ||
        column.nullable !== 'NO' ||
        column.extra !== extra ||
        column.collation !== collation ||
        (length !== null && Number(column.max_length) !== length) ||
        (isId && column.key_type !== 'PRI') ||
        (type === 'int' || type === 'bigint' ? !/unsigned/i.test(String(column.full_type)) : false)
      ) {
        throw new MigrationError(`Invalid MySQL migration tracking metadata: incompatible ${key} column.`);
      }
    }
    const indexes = await rows(
      connection,
      `SELECT INDEX_NAME AS name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique,
       SUB_PART AS prefix_length FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [name],
    );
    const primary = indexes.filter((index) => index.name === 'PRIMARY');
    const uniqueName = indexes.some(
      (index) =>
        index.column_name === 'name' &&
        Number(index.non_unique) === 0 &&
        index.prefix_length === null &&
        indexes.filter((other) => other.name === index.name).length === 1,
    );
    if (primary.length !== 1 || primary[0]?.column_name !== 'id' || (name === HISTORY && !uniqueName)) {
      throw new MigrationError(
        'Invalid MySQL migration tracking metadata: expected primary id and unique migration names.',
      );
    }
  }
  if (present.size) {
    const triggers = await rows(
      connection,
      `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE()
       AND LOWER(EVENT_OBJECT_TABLE) IN (?, ?)`,
      [HISTORY, STATE],
    );
    const foreignKeys = await rows(
      connection,
      `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND
       ((TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) IN (?, ?)) OR
        (REFERENCED_TABLE_SCHEMA = DATABASE() AND LOWER(REFERENCED_TABLE_NAME) IN (?, ?)))`,
      [HISTORY, STATE, HISTORY, STATE],
    );
    if (triggers.length || foreignKeys.length)
      throw new MigrationError('MySQL migration tracking metadata must have no triggers or foreign keys.');
  }
  return present;
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    !value.includes('\0') &&
    !!parseMigrationFilename(`${value}.sql`)
  );
}

async function readMetadata(
  connection: NativeConnection,
): Promise<{ applied: AppliedMigration[]; dirty: MysqlMigrationDirty | null }> {
  const tables = await metadataTables(connection);
  const history = tables.has(HISTORY)
    ? await rows(connection, `SELECT id, name, checksum, applied_at FROM ${HISTORY_SQL} ORDER BY id`)
    : [];
  const names = new Set<string>();
  const applied = history.map((row): AppliedMigration => {
    const id = Number(row.id);
    const timestamp = String(row.applied_at);
    const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !validName(row.name) ||
      names.has(row.name) ||
      typeof row.checksum !== 'string' ||
      !/^[a-z0-9]{1,64}$/.test(row.checksum) ||
      !Number.isFinite(date.getTime())
    ) {
      throw new MigrationError('Invalid MySQL migration tracking row.');
    }
    names.add(row.name);
    return { id, name: row.name, checksum: row.checksum, applied_at: date };
  });
  const journal = tables.has(STATE) ? await rows(connection, `SELECT * FROM ${STATE_SQL} ORDER BY id`) : [];
  let dirty: MysqlMigrationDirty | null = null;
  if (journal.length) {
    const row = journal[0]!;
    const completed = Number(row.completed_statements);
    const total = Number(row.total_statements);
    if (
      journal.length !== 1 ||
      Number(row.id) !== 1 ||
      !validName(row.name) ||
      typeof row.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.checksum) ||
      !['up', 'down'].includes(String(row.direction)) ||
      !Number.isSafeInteger(completed) ||
      !Number.isSafeInteger(total) ||
      completed < 0 ||
      total < 1 ||
      completed > total
    ) {
      throw new MigrationError('Invalid MySQL migration dirty journal.');
    }
    dirty = {
      name: row.name,
      checksum: row.checksum,
      direction: row.direction as 'up' | 'down',
      completedStatements: completed,
      totalStatements: total,
    };
  }
  return { applied, dirty };
}

function assertClean(dirty: MysqlMigrationDirty | null): void {
  if (dirty) {
    throw new MigrationError(
      `MySQL migration ${dirty.name} has unresolved partial-DDL state (${dirty.direction}, ${dirty.completedStatements}/${dirty.totalStatements} confirmed statements). Automatic retry is refused. Inspect schema/data and explicitly recover; autocommitted DDL is not rolled back.`,
    );
  }
}

async function assertNoStoredPrograms(connection: NativeConnection): Promise<void> {
  const programs = await rows(
    connection,
    `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
     UNION ALL SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()`,
  );
  if (programs.length) {
    throw new MigrationError(
      'This MySQL migration runner refuses writes in schemas with stored triggers or routines: their indirect effects can change migration metadata or lock ownership. Inspect/status remain available.',
    );
  }
}

/** Inspect pending files and durable partial-DDL state without creating metadata. */
export async function inspectMysqlMigrationDeploy(
  connectionString: string,
  migrationsDir: string,
  options?: MysqlMigrationOptions,
): Promise<MysqlMigrationDeployPlan> {
  return withSession(connectionString, options, async ({ connection }) => {
    const { applied, dirty } = await readMetadata(connection);
    return { ...planMigrationDeploy(migrationsDir, applied), dirty };
  });
}

function rollbackPlan(
  applied: AppliedMigration[],
  migrationsDir: string,
  options?: MysqlMigrationDownOptions,
): MigrationFile[] {
  const files = new Map(listMigrationFiles(migrationsDir).map((file) => [file.name, file]));
  return applied
    .slice()
    .reverse()
    .slice(0, options?.step ?? 1)
    .map((row) => {
      const file = files.get(row.name);
      if (!file) throw new MigrationError(`Cannot run MySQL DOWN: migration file is missing: ${row.name}.`);
      return file;
    });
}

/** Plan inverse SQL in reverse application order; no DDL is executed. */
export async function planMysqlMigrationRollback(
  connectionString: string,
  migrationsDir: string,
  options?: MysqlMigrationDownOptions,
): Promise<MigrationFile[]> {
  return withSession(connectionString, options, async ({ connection }) => {
    const { applied, dirty } = await readMetadata(connection);
    assertClean(dirty);
    return rollbackPlan(applied, migrationsDir, options);
  });
}

/** Status includes missing files and dirty UP/DOWN entries, even before history insertion. */
export async function migrateMysqlStatus(
  connectionString: string,
  migrationsDir: string,
  options?: MysqlMigrationOptions,
): Promise<MysqlMigrationStatus[]> {
  return withSession(connectionString, options, async ({ connection }) => {
    const { applied, dirty } = await readMetadata(connection);
    const records = new Map(applied.map((row) => [row.name, row]));
    const files = listMigrationFiles(migrationsDir);
    const statuses: MysqlMigrationStatus[] = files.map((file) => {
      const row = records.get(file.name);
      return {
        file,
        applied: !!row,
        appliedAt: row?.applied_at,
        checksumValid: row ? isChecksumValid(row.checksum, readFileSync(file.path, 'utf8')) : undefined,
      };
    });
    for (const name of new Set([...applied.map((row) => row.name), ...(dirty ? [dirty.name] : [])])) {
      let entry = statuses.find((status) => status.file.name === name);
      if (!entry) {
        const row = records.get(name);
        entry = {
          file: parseMigrationFilename(`${name}.sql`)!,
          applied: !!row,
          appliedAt: row?.applied_at,
          checksumValid: false,
          missingFile: true,
        };
        entry.file.path = '';
        statuses.push(entry);
      }
      if (name === dirty?.name) entry.dirty = dirty;
    }
    return statuses.sort((a, b) => (a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0));
  });
}

async function metadataTransaction(connection: NativeConnection, body: () => Promise<void>): Promise<void> {
  await connection.query('START TRANSACTION');
  try {
    await body();
    await connection.query('COMMIT');
  } catch (error) {
    // Only trusted InnoDB history/journal writes occur in this transaction.
    // Migration DDL never runs inside it and is never claimed to be undone.
    try {
      await connection.query('ROLLBACK');
    } catch {
      /* A lost connection retains the durable journal unless COMMIT succeeded. */
    }
    throw error;
  }
}

async function finalize(
  connection: NativeConnection,
  dirty: MysqlMigrationDirty,
  applied: AppliedMigration[],
  outcome: 'applied' | 'rolled-back',
): Promise<void> {
  const row = applied.find((migration) => migration.name === dirty.name);
  await metadataTransaction(connection, async () => {
    if (outcome === 'applied' && !row) {
      await changed(
        connection,
        `INSERT INTO ${HISTORY_SQL} (name, checksum, applied_at) VALUES (?, ?, UTC_TIMESTAMP(3))`,
        [dirty.name, dirty.checksum],
      );
    } else if (outcome === 'rolled-back' && row) {
      await changed(connection, `DELETE FROM ${HISTORY_SQL} WHERE id = ? AND name = ? AND checksum = ?`, [
        row.id,
        row.name,
        row.checksum,
      ]);
    }
    await changed(connection, `DELETE FROM ${STATE_SQL} WHERE id = 1 AND name = ? AND checksum = ? AND direction = ?`, [
      dirty.name,
      dirty.checksum,
      dirty.direction,
    ]);
  });
}

interface PreparedMigration {
  file: MigrationFile;
  checksum: string;
  statements: MysqlMigrationStatement[];
}

async function runBatch(
  connectionString: string,
  migrationsDir: string,
  direction: 'up' | 'down',
  options?: MysqlMigrationUpOptions,
  deploy = false,
): Promise<MigrationRunResult> {
  return withSession(connectionString, options, async (session) => {
    return runSessionBatch(session, migrationsDir, direction, options, deploy);
  });
}

interface WorkspaceSelection {
  expected: { name: string; checksum: string };
  verify: (completed: number) => Promise<void>;
}

async function runSessionBatch(
  session: Session,
  migrationsDir: string,
  direction: 'up' | 'down',
  options?: MysqlMigrationUpOptions,
  deploy = false,
  selection?: WorkspaceSelection,
): Promise<MigrationRunResult> {
  const { connection } = session;
  const { applied, dirty } = await readMetadata(connection);
  assertClean(dirty);
  const drift = compareAppliedChecksums(applied, migrationsDir);
  const missing = drift.mismatches.filter((mismatch) => mismatch.type === 'missing');
  if (missing.length || (drift.mismatches.length && (options?.allowDrift !== true || deploy))) {
    throw new MigrationError(
      formatChecksumMismatchError(drift.mismatches, direction === 'up' ? 'apply pending migrations' : 'roll back'),
    );
  }
  const appliedNames = new Set(applied.map((row) => row.name));
  const selected =
    direction === 'down'
      ? rollbackPlan(applied, migrationsDir, options)
      : listMigrationFiles(migrationsDir)
          .filter((file) => !appliedNames.has(file.name))
          .slice(0, deploy ? undefined : options?.step);
  if (
    selection &&
    (listIgnoredSqlFiles(migrationsDir).length ||
      selected.length !== 1 ||
      listMigrationFiles(migrationsDir).filter((file) => !appliedNames.has(file.name)).length !== 1 ||
      selected[0]!.name !== selection.expected.name ||
      sha256(readFileSync(selected[0]!.path, 'utf8')) !== selection.expected.checksum)
  )
    throw new MigrationError(
      'MySQL push requires exactly its unchanged pending migration; files changed or unrelated pending files exist.',
    );
  // Freeze the original bytes and validate the WHOLE selection before creating
  // metadata or running its first statement. Later source edits produce drift.
  const prepared: PreparedMigration[] = selected.map((file) => {
    if (!validName(file.name)) throw new MigrationError('MySQL migration name must fit VARCHAR(255).');
    const content = readFileSync(file.path, 'utf8');
    const parsed = parseMigrationContent(content, file.path);
    const statements = parseMysqlMigrationStatements(parsed[direction], session.mode);
    if (!statements.length)
      throw new MigrationError(`MySQL migration has no executable ${direction.toUpperCase()} SQL: ${file.filename}.`);
    return { file, checksum: sha256(content), statements };
  });
  if (selection && prepared[0]!.checksum !== selection.expected.checksum)
    throw new MigrationError('MySQL push migration changed while preparing SQL.');
  const destructive = prepared.flatMap(({ file, statements }) => {
    const hits = scanMysqlMigrationDestructive(statements);
    return hits.length ? [{ file: file.filename, hits }] : [];
  });
  if (destructive.length && options?.allowDestructive !== true && !deploy) {
    throw new MigrationError(
      'MySQL migration contains destructive SQL; explicit allowDestructive consent is required.',
    );
  }
  const result: MigrationRunResult = {
    applied: [],
    errors: [],
    destructive,
    outOfOrder: [],
    noTransaction: [],
    rebaselined: [],
  };
  if (!selected.length && !drift.legacyUpgrades.length && !drift.mismatches.length) return result;
  await selection?.verify(0);
  await assertNoStoredPrograms(connection);
  await connection.query(CREATE_HISTORY);
  await connection.query(CREATE_STATE);
  await metadataTables(connection);
  const upgrades = [
    ...drift.legacyUpgrades,
    ...drift.mismatches.map((mismatch) => ({ name: mismatch.name, checksum: mismatch.actual })),
  ];
  if (upgrades.length) {
    await metadataTransaction(connection, async () => {
      for (const upgrade of upgrades) {
        const row = applied.find((migration) => migration.name === upgrade.name)!;
        await changed(connection, `UPDATE ${HISTORY_SQL} SET checksum = ? WHERE id = ? AND checksum = ?`, [
          upgrade.checksum,
          row.id,
          row.checksum,
        ]);
      }
    });
    for (const upgrade of upgrades) {
      const row = applied.find((migration) => migration.name === upgrade.name)!;
      if (drift.mismatches.some((mismatch) => mismatch.name === row.name))
        result.rebaselined.push({ name: row.name, from: row.checksum, to: upgrade.checksum });
      row.checksum = upgrade.checksum;
    }
  }
  for (const entry of prepared) {
    const journal: MysqlMigrationDirty = {
      name: entry.file.name,
      checksum: entry.checksum,
      direction,
      completedStatements: 0,
      totalStatements: entry.statements.length,
    };
    try {
      await assertOwnership(session);
      await changed(
        connection,
        `INSERT INTO ${STATE_SQL} (id, name, checksum, direction, completed_statements, total_statements) VALUES (1, ?, ?, ?, 0, ?)`,
        [journal.name, journal.checksum, direction, journal.totalStatements],
      );
      for (const statement of entry.statements) {
        await selection?.verify(journal.completedStatements);
        await assertOwnership(session);
        await connection.query(statement.sql);
        await assertOwnership(session);
        await changed(
          connection,
          `UPDATE ${STATE_SQL} SET completed_statements = ? WHERE id = 1 AND name = ? AND checksum = ? AND direction = ? AND completed_statements = ?`,
          [journal.completedStatements + 1, journal.name, journal.checksum, direction, journal.completedStatements],
        );
        journal.completedStatements++;
      }
      await selection?.verify(journal.completedStatements);
      await metadataTables(connection);
      await finalize(connection, journal, applied, direction === 'up' ? 'applied' : 'rolled-back');
      result.applied.push(entry.file);
      result.noTransaction.push(entry.file);
      if (direction === 'up') {
        result.outOfOrder.push(...predictOutOfOrder(applied, [entry.file]));
        // Application ordering, not the filename, defines DOWN order.
        const latest = await rows(connection, `SELECT id, applied_at FROM ${HISTORY_SQL} WHERE name = ?`, [
          entry.file.name,
        ]);
        applied.push({
          id: Number(latest[0]!.id),
          name: entry.file.name,
          checksum: entry.checksum,
          applied_at: new Date(`${String(latest[0]!.applied_at).replace(' ', 'T')}Z`),
        });
      } else {
        applied.splice(
          applied.findIndex((row) => row.name === entry.file.name),
          1,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native MySQL migration execution failed.';
      result.errors.push({
        file: entry.file,
        error: `MySQL migration stopped; autocommitted DDL/data may remain applied. No rollback is claimed. Inspect status and recover any dirty journal before retrying. ${message}`,
      });
      break;
    }
  }
  return result;
}

/** Engine-local orchestration seam: one cooperative lock, existing journaled execution only. */
export async function withMysqlMigrationWorkspace<T>(
  connectionString: string,
  migrationsDir: string,
  options: MysqlMigrationOptions & { allowDestructive?: boolean },
  body: (workspace: {
    inspect(): Promise<MysqlMigrationDeployPlan>;
    apply(
      expected: { name: string; checksum: string },
      verify: (completed: number) => Promise<void>,
    ): Promise<MigrationRunResult>;
  }) => Promise<T>,
): Promise<T> {
  return withSession(connectionString, options, async (session) =>
    body({
      inspect: async () => {
        const { applied, dirty } = await readMetadata(session.connection);
        return { ...planMigrationDeploy(migrationsDir, applied), dirty };
      },
      apply: (expected, verify) =>
        runSessionBatch(session, migrationsDir, 'up', { allowDestructive: options.allowDestructive }, false, {
          expected,
          verify,
        }),
    }),
  );
}

/** Execute pending files, persisting intent before any autocommitted migration SQL. */
export async function migrateMysqlUp(
  connectionString: string,
  migrationsDir: string,
  options?: MysqlMigrationUpOptions,
): Promise<MigrationRunResult> {
  return runBatch(connectionString, migrationsDir, 'up', options);
}

/** Deploy all pending files with destructive consent, always refusing checksum drift. */
export async function migrateMysqlDeploy(
  connectionString: string,
  migrationsDir: string,
  options?: MysqlMigrationUpOptions,
): Promise<MigrationRunResult> {
  return runBatch(connectionString, migrationsDir, 'up', options, true);
}

/** Execute inverse SQL; successful DOWN is not a transactional DDL rollback. */
export async function migrateMysqlDown(
  connectionString: string,
  migrationsDir: string,
  options?: MysqlMigrationDownOptions,
): Promise<MysqlMigrationDownResult> {
  const result = await runBatch(connectionString, migrationsDir, 'down', options);
  return { rolledBack: result.applied, errors: result.errors, rebaselined: result.rebaselined };
}

/**
 * Finalize history only after independent manual schema/data reconciliation.
 * This never retries migration SQL or attempts to undo autocommitted DDL.
 */
export async function recoverMysqlMigration(
  connectionString: string,
  migrationsDir: string,
  options: MysqlMigrationRecoveryOptions,
): Promise<void> {
  if (options?.acknowledgePartialDdl !== true || !['applied', 'rolled-back'].includes(options.outcome)) {
    throw new MigrationError(
      'MySQL recovery requires acknowledgePartialDdl: true and an explicit applied/rolled-back outcome.',
    );
  }
  return withSession(connectionString, options, async (session) => {
    const { applied, dirty } = await readMetadata(session.connection);
    if (!dirty || dirty.name !== options.name || dirty.checksum !== options.checksum) {
      throw new MigrationError('MySQL recovery requires the exact dirty migration name and checksum.');
    }
    const file = listMigrationFiles(migrationsDir).find((candidate) => candidate.name === dirty.name);
    if (!file || sha256(readFileSync(file.path, 'utf8')) !== dirty.checksum) {
      throw new MigrationError(
        'MySQL recovery requires the unchanged migration file; restore it before reconciling history.',
      );
    }
    const row = applied.find((migration) => migration.name === dirty.name);
    if (
      (dirty.direction === 'up' && row) ||
      (dirty.direction === 'down' && (!row || row.checksum !== dirty.checksum))
    ) {
      throw new MigrationError(
        'MySQL recovery found inconsistent history and dirty journal; refusing to erase evidence.',
      );
    }
    await assertOwnership(session);
    await finalize(session.connection, dirty, applied, options.outcome);
  });
}
