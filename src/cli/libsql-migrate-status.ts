/** Internal, read-only local libSQL inspection. No migration writer or CLI dispatch. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConnectionError, MigrationError } from '../errors.js';
import { type LibsqlResultSet, rows } from '../libsql/values.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import {
  type AppliedMigration,
  isChecksumValid,
  listIgnoredSqlFiles,
  listMigrationFiles,
  type MigrationStatus,
  type OutOfOrderApply,
  parseMigrationContent,
  parseMigrationFilename,
  predictOutOfOrder,
} from './migrate.js';

export interface LibsqlMigrationReader {
  execute(sql: string): Promise<LibsqlResultSet>;
}
interface ReadTransaction extends LibsqlMigrationReader {
  rollback(): Promise<void>;
  close(): void;
}
interface LocalClient {
  transaction(mode: 'read'): Promise<ReadTransaction>;
  close(): void;
  readonly closed: boolean;
  readonly protocol: string;
}

export interface LibsqlMigrationChecksum {
  name: string;
  stored: string;
  /** SHA-256 of the one captured file read; absent when the file is missing. */
  actual?: string;
  state: 'sha256-match' | 'legacy-match' | 'modified' | 'missing';
}

export interface LibsqlMigrationInspection {
  historyState: 'uninitialized' | 'initialized';
  /** Native ID order. An empty initialized history is distinct from no table. */
  history: AppliedMigration[];
  statuses: MigrationStatus[];
  checksums: LibsqlMigrationChecksum[];
  /** Applied history that moved backwards in timestamp order, using the shared rule. */
  outOfOrder: OutOfOrderApply[];
  ignoredFiles: string[];
}

const TABLE = 'main."_turbine_migrations"';
const TRACKING = '_turbine_migrations';
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
function invalid(detail: string): never {
  throw new MigrationError(`Invalid local libSQL migration history: ${detail}`);
}

async function query(reader: LibsqlMigrationReader, sql: string): Promise<Record<string, unknown>[]> {
  return rows(await reader.execute(sql));
}

/** Internal seam: caller must already own a native read or writer transaction. */
export async function readLibsqlMigrationHistory(
  tx: LibsqlMigrationReader,
): Promise<Pick<LibsqlMigrationInspection, 'historyState' | 'history'>> {
  const entries = await query(
    tx,
    `SELECT name, type FROM main.sqlite_schema WHERE name = '${TRACKING}' COLLATE NOCASE`,
  );
  if (!entries.length) return { historyState: 'uninitialized', history: [] };
  if (entries.length !== 1 || entries[0]!.name !== TRACKING || entries[0]!.type !== 'table')
    invalid('expected the canonical main._turbine_migrations table.');
  const flags = (await query(tx, 'PRAGMA main.table_list')).find((row) => row.name === TRACKING);
  if (flags?.type !== 'table' || flags.wr !== 0) invalid('expected an ordinary rowid table.');
  const columns = await query(tx, `PRAGMA main.table_xinfo(${q(TRACKING)})`);
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (
    columns.length !== 4 ||
    columns.some((column) => column.hidden !== 0) ||
    String(byName.get('id')?.type).toUpperCase() !== 'INTEGER' ||
    byName.get('id')?.pk !== 1
  )
    invalid('expected id/name/applied_at/checksum columns and an INTEGER rowid primary key.');
  for (const name of ['name', 'applied_at', 'checksum']) {
    const column = byName.get(name);
    if (String(column?.type).toUpperCase() !== 'TEXT' || column?.notnull !== 1 || column?.pk !== 0)
      invalid(`${name} must be TEXT NOT NULL.`);
  }
  const indexes = await query(tx, `PRAGMA main.index_list(${q(TRACKING)})`);
  if (indexes.some((index) => index.origin === 'pk')) invalid('id must alias the rowid.');
  let uniqueName = false;
  for (const index of indexes) {
    if (index.unique !== 1 || index.partial !== 0) continue;
    const keys = (await query(tx, `PRAGMA main.index_xinfo(${q(String(index.name))})`)).filter((key) => key.key === 1);
    if (keys.length === 1 && keys[0]!.name === 'name' && keys[0]!.coll === 'BINARY') uniqueName = true;
  }
  if (!uniqueName) invalid('name must have a full, single-column BINARY UNIQUE key.');
  if (
    (
      await query(
        tx,
        `SELECT 1 FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = '${TRACKING}' COLLATE NOCASE`,
      )
    ).length ||
    (await query(tx, `PRAGMA main.foreign_key_list(${q(TRACKING)})`)).length
  )
    invalid('tracking triggers and foreign keys are not canonical.');
  // Match the native SQLite inspector's conservative inbound-FK refusal.
  for (const table of await query(tx, "SELECT name FROM main.sqlite_schema WHERE type = 'table'")) {
    const keys = await query(tx, `PRAGMA main.foreign_key_list(${q(String(table.name))})`);
    if (keys.some((key) => String(key.table).toLowerCase() === TRACKING))
      invalid('user tables must not reference migration tracking metadata.');
  }
  const names = new Set<string>();
  let previousId = 0;
  const history = (await query(tx, `SELECT id, name, applied_at, checksum FROM ${TABLE} ORDER BY id`)).map(
    (row): AppliedMigration => {
      if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= previousId)
        invalid('IDs must be positive, unique safe integers.');
      previousId = row.id;
      if (
        typeof row.name !== 'string' ||
        /[/\\\0]/.test(row.name) ||
        !parseMigrationFilename(`${row.name}.sql`) ||
        names.has(row.name)
      )
        invalid('names must be unique migration filenames without the .sql extension.');
      names.add(row.name);
      if (typeof row.checksum !== 'string' || !/^(?:[0-9a-f]{64}|[0-9a-z]{1,63})$/.test(row.checksum))
        invalid('checksum must be lowercase SHA-256 or a nonempty legacy base36 value.');
      // Both existing SQLite UTC datetime('now') and canonical ISO UTC values.
      if (
        typeof row.applied_at !== 'string' ||
        !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?Z?$/.test(row.applied_at)
      )
        invalid('applied_at must be a SQLite or ISO UTC timestamp.');
      const timestamp = row.applied_at.replace(' ', 'T').replace(/Z?$/, 'Z');
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== timestamp.slice(0, 19))
        invalid('applied_at is not a valid UTC calendar timestamp.');
      return { id: row.id, name: row.name, applied_at: date, checksum: row.checksum };
    },
  );
  return { historyState: 'initialized', history };
}

function inspectFiles(
  history: AppliedMigration[],
  migrationsDir: string,
): Omit<LibsqlMigrationInspection, 'historyState' | 'history'> {
  const files = listMigrationFiles(resolve(migrationsDir));
  const records = new Map(history.map((row) => [row.name, row]));
  const checksums: LibsqlMigrationChecksum[] = [];
  const statuses: MigrationStatus[] = files.map((file) => {
    // Parse and checksum the same captured content; never run its UP or DOWN.
    const content = readFileSync(file.path, 'utf8');
    parseMigrationContent(content, file.path);
    const row = records.get(file.name);
    if (!row) return { file, applied: false };
    const actual = createHash('sha256').update(content, 'utf8').digest('hex');
    const valid = isChecksumValid(row.checksum, content);
    checksums.push({
      name: row.name,
      stored: row.checksum,
      actual,
      state: actual === row.checksum ? 'sha256-match' : valid ? 'legacy-match' : 'modified',
    });
    return { file, applied: true, appliedAt: row.applied_at, checksumValid: valid };
  });
  const present = new Set(files.map((file) => file.name));
  const outOfOrder: OutOfOrderApply[] = [];
  const prior: AppliedMigration[] = [];
  for (const row of history) {
    const file = parseMigrationFilename(`${row.name}.sql`)!;
    outOfOrder.push(...predictOutOfOrder(prior, [file]));
    prior.push(row);
    if (present.has(row.name)) continue;
    statuses.push({ file, applied: true, appliedAt: row.applied_at, checksumValid: false, missingFile: true });
    checksums.push({ name: row.name, stored: row.checksum, state: 'missing' });
  }
  statuses.sort((a, b) => (a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0));
  return { statuses, checksums, outOfOrder, ignoredFiles: listIgnoredSqlFiles(migrationsDir) };
}

/**
 * Inspect an EXISTING local file using @libsql/client/node and SQLite mode=ro.
 * Catalog and history share one native read transaction. File contents are read
 * once each, outside any filesystem snapshot: callers must keep files stable.
 * Always owns and closes its client; never borrows a caller's transaction.
 * No checksums are written, including matching legacy values. No writer lock,
 * migration execution, remote transport, replica or sync capability is implied.
 */
export async function inspectLibsqlMigrations(
  filename: string,
  migrationsDir: string,
): Promise<LibsqlMigrationInspection> {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.includes('\0') ||
    filename === ':memory:' ||
    /^[a-z][a-z\d+.-]*:/i.test(filename)
  )
    throw new MigrationError('Local libSQL migration inspection requires an existing filesystem filename, not a URL.');
  if (typeof migrationsDir !== 'string' || !migrationsDir || migrationsDir.includes('\0'))
    throw new MigrationError('Local libSQL migration inspection requires a migrations directory.');
  const absolute = resolve(filename);
  if (!statSync(absolute).isFile())
    throw new MigrationError('Local libSQL migration inspection requires a regular file.');
  let peer: {
    createClient(config: { url: string; intMode: 'bigint'; concurrency: number; timeout: number }): LocalClient;
  };
  try {
    peer = (await importOptionalPeer('@libsql/client/node')) as typeof peer;
  } catch (cause) {
    throw new ConnectionError(
      'Local libSQL migration inspection requires optional @libsql/client and its native engine.',
      {
        cause,
      },
    );
  }
  // The outer client URI decodes to a native SQLite file URI. Encode both
  // levels so literal ?, # and % in a filesystem name cannot become options.
  // mode=ro also prevents file creation if the preflight file disappears.
  const url = `file:${encodeURIComponent(`${pathToFileURL(absolute).href}?mode=ro`)}`;
  const client = peer.createClient({ url, intMode: 'bigint', concurrency: 1, timeout: 0 });
  let tx: ReadTransaction | undefined;
  try {
    if (client.closed || client.protocol !== 'file')
      throw new ConnectionError('Migration inspection requires an open native local libSQL client.');
    tx = await client.transaction('read');
    const snapshot = await readLibsqlMigrationHistory(tx);
    return { ...snapshot, ...inspectFiles(snapshot.history, migrationsDir) };
  } finally {
    try {
      if (tx) {
        try {
          await tx.rollback();
        } finally {
          tx.close();
        }
      }
    } finally {
      client.close();
    }
  }
}
