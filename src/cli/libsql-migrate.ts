/** Bounded additive local libSQL deployment. Not a general SQLite SQL parser. */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConnectionError, MigrationError } from '../errors.js';
import { type LibsqlResultSet, rows } from '../libsql/values.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import { type LibsqlMigrationReader, readLibsqlMigrationHistory } from './libsql-migrate-status.js';
import {
  isChecksumValid,
  listIgnoredSqlFiles,
  listMigrationFiles,
  type MigrationFile,
  parseMigrationContent,
} from './migrate.js';
import { isSymlinkRefusal, readNoFollow } from './no-follow.js';

interface Writer extends LibsqlMigrationReader {
  execute(sql: string | { sql: string; args: string[] }): Promise<LibsqlResultSet>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
  readonly closed: boolean;
}
interface Client {
  execute(sql: string): Promise<LibsqlResultSet>;
  transaction(mode: 'write'): Promise<Writer>;
  close(): void;
  readonly closed: boolean;
  readonly protocol: string;
}
interface Token {
  raw: string;
  value: string;
  kind: 'word' | 'quoted' | 'literal' | 'number' | 'symbol';
}
interface Captured {
  file: MigrationFile;
  content: string;
  hash: string;
}
const TABLE = 'main."_turbine_migrations"';
const CREATE_HISTORY = `CREATE TABLE ${TABLE} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;
function fail(detail: string): never {
  throw new MigrationError(`Local libSQL deploy refused: ${detail}`);
}

/**
 * Closed SQLite lexical subset: ASCII words/numbers, quoted identifiers and
 * strings (doubled delimiters), blobs, nonnested comments, ordinary operators.
 * Re-emit tokens with spaces, so comments/BOM cannot change statement boundaries
 * between admission and SQLite. No PG tokenizer or backslash escapes.
 */
function statements(sql: string): Token[][] {
  if (sql.includes('\0')) fail('NUL in SQL.');
  const result: Token[][] = [];
  let tokens: Token[] = [];
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    if (/[ \t\r\n\f\v\uFEFF]/.test(ch)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0 || sql.slice(i + 2, end).includes('/*')) fail('unterminated or nested SQL comment.');
      i = end + 2;
      continue;
    }
    if (ch === ';') {
      if (tokens.length) result.push(tokens);
      tokens = [];
      i++;
      continue;
    }
    const start = i;
    const blob = (ch === 'x' || ch === 'X') && sql[i + 1] === "'";
    if (blob) i++;
    const quote = sql[i]!;
    if (blob || ['"', "'", '`', '['].includes(quote)) {
      const close = quote === '[' ? ']' : quote;
      let value = '';
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          i++;
          if (quote !== '[' && sql[i] === close) {
            value += close;
            i++;
            continue;
          }
          closed = true;
          break;
        }
        value += sql[i++]!;
      }
      if (!closed) fail('unterminated quoted SQL token.');
      if (blob && (!/^[\da-f]*$/i.test(value) || value.length % 2)) fail('invalid blob literal.');
      tokens.push({
        raw: sql.slice(start, i),
        value: value.toLowerCase(),
        kind: blob || quote === "'" ? 'literal' : 'quoted',
      });
      continue;
    }
    const word = /^[a-z_][a-z_\d]*/i.exec(sql.slice(i));
    if (word) {
      i += word[0].length;
      tokens.push({ raw: word[0], value: word[0].toLowerCase(), kind: 'word' });
      continue;
    }
    const number = /^(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(sql.slice(i));
    if (number) {
      i += number[0].length;
      tokens.push({ raw: number[0], value: number[0], kind: 'number' });
      continue;
    }
    const operator = /^(?:<=|>=|<>|!=|==|\|\||->>|->|[(),.+\-*/%<>=!|&~])/.exec(sql.slice(i));
    if (!operator)
      fail(`unsupported SQL character at offset ${i}. Quote non-ASCII identifiers; parameters are unsupported.`);
    i += operator[0].length;
    tokens.push({ raw: operator[0], value: operator[0], kind: 'symbol' });
  }
  if (tokens.length) result.push(tokens);
  return result;
}

// No extensions or arbitrary functions. In particular native libSQL ships
// readfile/writefile; even a rolled-back SQL transaction cannot undo file I/O.
const calls = new Set([
  'abs',
  'coalesce',
  'ifnull',
  'length',
  'lower',
  'upper',
  'trim',
  'ltrim',
  'rtrim',
  'round',
  'nullif',
  'typeof',
  'unicode',
  'hex',
  'substr',
  'substring',
  'date',
  'datetime',
  'strftime',
  'julianday',
  'unixepoch',
]);
const grammarCalls = new Set([
  'check',
  'unique',
  'key',
  'in',
  'as',
  'default',
  'values',
  'varchar',
  'char',
  'nvarchar',
  'nchar',
  'decimal',
  'numeric',
]);
function internal(token: Token): boolean {
  return token.value === '_turbine_migrations' || token.value.startsWith('sqlite_');
}
function identifier(tokens: Token[], start: number): number {
  const isName = (t: Token | undefined) => t && ['word', 'quoted', 'literal'].includes(t.kind);
  if (!isName(tokens[start])) fail('expected a table/index identifier.');
  if (tokens[start + 1]?.value === '.') {
    if (tokens[start]!.value !== 'main' || !isName(tokens[start + 2])) fail('only the main schema is supported.');
    return start + 2;
  }
  return start;
}
function checkTokens(tokens: Token[], exempt: Set<number>): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (internal(token)) fail('SQL must not access migration history or SQLite internal metadata.');
    // SQLite treats single-quoted names as identifiers in several contexts.
    // Check quoted/string tokens too, conservatively reserving these values.
    if (token.value === 'replace') fail('REPLACE conflict handling is destructive and unsupported.');
    if (tokens[i + 1]?.value !== '(' || exempt.has(i) || token.kind === 'symbol' || token.kind === 'number') continue;
    if (!calls.has(token.value) && !(token.kind === 'word' && grammarCalls.has(token.value)))
      fail(`unsupported SQL function or expression: ${token.raw}.`);
  }
}
function admittedSql(sql: string): string[] {
  const batch = statements(sql);
  if (!batch.length) fail('migration UP has no executable SQL.');
  return batch.map((tokens) => {
    const word = (index: number, expected: string) =>
      tokens[index]?.kind === 'word' && tokens[index]?.value === expected;
    let target: number;
    if (word(0, 'create') && word(1, 'table')) {
      const start = word(2, 'if') && word(3, 'not') && word(4, 'exists') ? 5 : 2;
      target = identifier(tokens, start);
      if (tokens[target + 1]?.value !== '(')
        fail('CREATE TABLE requires an explicit column definition; AS SELECT is unsupported.');
    } else if (word(0, 'create') && (word(1, 'index') || (word(1, 'unique') && word(2, 'index')))) {
      let start = word(1, 'unique') ? 3 : 2;
      if (word(start, 'if') && word(start + 1, 'not') && word(start + 2, 'exists')) start += 3;
      const name = identifier(tokens, start);
      if (!word(name + 1, 'on')) fail('unsupported CREATE INDEX.');
      target = identifier(tokens, name + 2);
      if (tokens[target + 1]?.value !== '(') fail('CREATE INDEX requires columns.');
    } else if (word(0, 'insert') && word(1, 'into')) {
      target = identifier(tokens, 2);
      // Deliberately no INSERT SELECT, UPSERT, RETURNING, conflict policy or
      // expressions/functions. A VALUES list contains only scalar literals.
      let index = target + 1;
      if (tokens[index]?.value === '(') {
        index++;
        while (index < tokens.length && tokens[index]?.value !== ')') {
          if (index !== identifier(tokens, index)) fail('qualified insert columns are unsupported.');
          index++;
          if (tokens[index]?.value === ',') index++;
          else break;
        }
        if (tokens[index++]?.value !== ')') fail('invalid INSERT column list.');
      }
      if (!word(index++, 'values')) fail('only INSERT INTO ... VALUES with scalar literals is supported.');
      // Recognize tuple boundaries and one scalar at a time. A token allowlist
      // alone also admits arithmetic and parenthesized expressions.
      const invalidValues = () => fail('INSERT VALUES supports scalar literals only.');
      const punctuation = (token: Token | undefined, value: string) =>
        token?.kind === 'symbol' && token.value === value;
      do {
        if (!punctuation(tokens[index++], '(')) invalidValues();
        for (;;) {
          let token = tokens[index++];
          if (token?.kind === 'symbol' && ['+', '-'].includes(token.value)) {
            token = tokens[index++];
            if (token?.kind !== 'number') invalidValues();
          } else if (
            !token ||
            (!['literal', 'number'].includes(token.kind) &&
              !(token.kind === 'word' && ['null', 'true', 'false'].includes(token.value)))
          )
            invalidValues();
          const separator = tokens[index++];
          if (punctuation(separator, ')')) break;
          if (!punctuation(separator, ',')) invalidValues();
        }
        if (index === tokens.length) break;
        if (!punctuation(tokens[index++], ',') || index === tokens.length) invalidValues();
      } while (index < tokens.length);
    } else
      fail(
        'only additive CREATE TABLE/INDEX and INSERT INTO ... VALUES are supported; triggers, destructive SQL and transaction control are unsupported.',
      );
    const exempt = new Set([target]);
    // REFERENCES parent(columns) is SQL grammar, not a function call.
    for (let i = 0; i < tokens.length; i++) if (word(i, 'references')) exempt.add(identifier(tokens, i + 1));
    checkTokens(tokens, exempt);
    // No subqueries, conflict clauses or deferred execution in admitted DDL.
    if (tokens.some((t) => t.kind === 'word' && ['select', 'conflict', 'trigger', 'virtual'].includes(t.value)))
      fail('subqueries, conflict policies, triggers and virtual tables are unsupported.');
    return tokens.map((t) => t.raw).join(' ');
  });
}

function capture(filename: string, migrationsDir: string): { absolute: string; files: Captured[]; ignored: string[] } {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename.includes('\0') ||
    filename === ':memory:' ||
    /^[a-z][a-z\d+.-]*:/i.test(filename)
  )
    fail('requires an existing filesystem filename, not a URL.');
  if (typeof migrationsDir !== 'string' || !migrationsDir || migrationsDir.includes('\0'))
    fail('requires a migrations directory.');
  const absolute = resolve(filename);
  const database = lstatSync(absolute);
  if (!database.isFile() || database.isSymbolicLink())
    fail('database must be an existing regular file without a symlink leaf.');
  // SQLite can write or replace these before migration SQL runs. Protect the
  // captured inputs from preexisting filesystem aliases, including WAL mode.
  const writableFiles = [database];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = lstatSync(absolute + suffix, { throwIfNoEntry: false });
    if (!sidecar) continue;
    if (!sidecar.isFile() || sidecar.isSymbolicLink())
      fail('database sidecars must be regular files without symlinks.');
    if (writableFiles.some((file) => file.dev === sidecar.dev && file.ino === sidecar.ino))
      fail('database and sidecars must not alias each other.');
    writableFiles.push(sidecar);
  }
  const dir = resolve(migrationsDir);
  if (!lstatSync(dir).isDirectory()) fail('migrations must be an existing directory.');
  const rel = relative(realpathSync(dir), realpathSync(absolute));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)))
    fail('database must be outside the migrations directory.');
  const files = listMigrationFiles(dir).map((file) => {
    const refuse = () =>
      fail('migration inputs must be regular files and must not alias the database or its sidecars.');
    // All reads and hashes precede the first await, including peer loading.
    // Checked and read through one descriptor, so the file admitted is the file read.
    let bytes: Buffer;
    try {
      bytes = readNoFollow(file.path, (stat) => {
        if (!stat.isFile() || writableFiles.some((file) => stat.dev === file.dev && stat.ino === file.ino)) refuse();
      });
    } catch (error) {
      if (isSymlinkRefusal(error)) refuse();
      throw error;
    }
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) fail('migration files must be valid UTF-8.');
    parseMigrationContent(content, file.path);
    return { file, content, hash: createHash('sha256').update(bytes).digest('hex') };
  });
  return { absolute, files, ignored: listIgnoredSqlFiles(dir) };
}

async function assertCatalog(tx: Writer): Promise<void> {
  if (rows(await tx.execute('PRAGMA foreign_keys'))[0]?.foreign_keys !== 1)
    fail('native foreign key enforcement is unavailable.');
  const tables = rows(await tx.execute('PRAGMA main.table_list'));
  if (tables.some((t) => ['virtual', 'shadow'].includes(String(t.type))))
    fail('existing virtual/shadow tables are unsupported.');
  const schema = rows(await tx.execute('SELECT type, name, sql FROM main.sqlite_schema WHERE sql IS NOT NULL'));
  for (const entry of schema) {
    if (entry.type === 'trigger' || entry.type === 'view') fail('existing triggers/views are unsupported.');
    if (entry.name === 'sqlite_sequence') continue;
    // Existing expression indexes, defaults and CHECKs can run during inserts.
    // Admit them by the same closed DDL rules, including the canonical journal
    // only after replacing its reserved name for this lexical inspection.
    const ddl = String(entry.sql);
    if (entry.name === '_turbine_migrations') {
      const tokens = statements(ddl);
      if (tokens.length !== 1) fail('invalid journal DDL.');
      const target = identifier(tokens[0]!, 2);
      tokens[0]![target] = { raw: 'history_placeholder', value: 'history_placeholder', kind: 'word' };
      admittedSql(tokens[0]!.map((t) => t.raw).join(' '));
    } else admittedSql(ddl);
  }
}

/**
 * Owns a dedicated native file client. No borrowed handles, remote URLs, sync,
 * extension loading, hook callbacks, lock waiting or checksum rewriting.
 * Filesystem names/content must remain stable against other processes during
 * deployment; captured bytes, not subsequent reads, are applied and journaled.
 * Native write transaction covers the whole pending batch. Lock contention
 * fails immediately. A failed COMMIT is not reported as a confirmed rollback:
 * inspect durable status before retrying after I/O errors or process loss.
 */
export async function migrateLibsqlDeploy(
  filename: string,
  migrationsDir: string,
): Promise<{ applied: string[]; scope: 'local-additive'; atomic: true }> {
  const captured = capture(filename, migrationsDir);
  if (captured.ignored.length) fail(`ignored SQL files: ${captured.ignored.join(', ')}.`);
  let peer: { createClient(config: { url: string; intMode: 'bigint'; concurrency: number; timeout: number }): Client };
  try {
    peer = (await importOptionalPeer('@libsql/client/node')) as typeof peer;
  } catch (cause) {
    throw new ConnectionError('Local libSQL deploy requires optional @libsql/client and its native engine.', { cause });
  }
  // mode=rw prevents creation after the preflight. Double URI encoding keeps
  // literal ?, # and % in filenames out of SQLite's URI option namespace.
  const url = `file:${encodeURIComponent(`${pathToFileURL(captured.absolute).href}?mode=rw`)}`;
  const client = peer.createClient({ url, intMode: 'bigint', concurrency: 1, timeout: 0 });
  let tx: Writer | undefined;
  let committing = false;
  let committed = false;
  const run = async (): Promise<{ applied: string[]; scope: 'local-additive'; atomic: true }> => {
    if (client.closed || client.protocol !== 'file') fail('requires an open native local client.');
    await client.execute('PRAGMA foreign_keys = ON');
    try {
      tx = await client.transaction('write');
    } catch (cause) {
      throw new MigrationError(
        `Could not acquire local libSQL migration writer lock; retry after active writers finish. ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (tx.closed) fail('native writer transaction is not open.');
    const before = await readLibsqlMigrationHistory(tx);
    await assertCatalog(tx);
    const byName = new Map(captured.files.map((item) => [item.file.name, item]));
    let prior = '';
    for (const row of before.history) {
      const item = byName.get(row.name);
      if (!item) fail(`applied migration file is missing: ${row.name}.`);
      if (!isChecksumValid(row.checksum, item.content)) fail(`checksum drift: ${row.name}.`);
      if (row.name <= prior) fail('applied migration history is out of filename order.');
      prior = row.name;
    }
    const applied = new Set(before.history.map((row) => row.name));
    const pending = captured.files.filter((item) => !applied.has(item.file.name));
    if (pending.some((item) => item.file.name <= prior)) fail('pending migration is out of filename order.');
    const batch = pending.map((item) => {
      const parsed = parseMigrationContent(item.content, item.file.path);
      if (parsed.noTransaction) fail('no-transaction directive is unsupported.');
      return { ...item, statements: admittedSql(parsed.up) };
    });
    if (!batch.length) {
      await tx.rollback();
      return { applied: [], scope: 'local-additive', atomic: true };
    }
    // The journal is not created until *every* pending SQL form is admitted.
    if (before.historyState === 'uninitialized') await tx.execute(CREATE_HISTORY);
    for (const item of batch) {
      for (const sql of item.statements) {
        if (tx.closed) fail('native transaction ownership was lost.');
        await tx.execute(sql);
        if (tx.closed) fail('native transaction ended during migration SQL.');
      }
      const result = await tx.execute({
        sql: `INSERT INTO ${TABLE}(name, checksum, applied_at) VALUES (?, ?, ?)`,
        args: [item.file.name, item.hash, new Date().toISOString()],
      });
      if (result.rowsAffected !== 1) fail('journal insertion did not affect exactly one row.');
    }
    const after = await readLibsqlMigrationHistory(tx);
    const expected = [
      ...before.history.map((row) => [row.name, row.checksum]),
      ...batch.map((item) => [item.file.name, item.hash]),
    ];
    if (JSON.stringify(after.history.map((row) => [row.name, row.checksum])) !== JSON.stringify(expected))
      fail('journal differs from the captured batch.');
    if (tx.closed) fail('native transaction ended before commit.');
    committing = true;
    await tx.commit();
    committed = true;
    return { applied: batch.map((item) => item.file.name), scope: 'local-additive', atomic: true };
  };
  let result: Awaited<ReturnType<typeof run>> | undefined;
  // A presence wrapper distinguishes a thrown undefined/null from success.
  // Cleanup follows the catch rather than carrying a catch assignment into
  // finally (which can be miscompiled by consumer minifiers).
  let primary: { error: unknown } | undefined;
  try {
    result = await run();
  } catch (cause) {
    primary = {
      error: committing
        ? new MigrationError(
            `Local libSQL COMMIT did not acknowledge success. Durable outcome is uncertain; inspect migration status before retrying. ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        : cause,
    };
  }
  const cleanupFailures: Array<{ step: string; error: unknown }> = [];
  const clean = async (step: string, operation: () => void | Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push({ step, error });
    }
  };
  if (tx) {
    await clean('rollback', async () => {
      if (!tx!.closed) await tx!.rollback();
    });
    await clean('transaction close', () => tx!.close());
  }
  await clean('client close', () => client.close());
  if (primary) {
    if (cleanupFailures.length) {
      // Best-effort structured evidence plus a diagnostic, also for primitive
      // rejection values. Neither a frozen error nor a failed diagnostic sink
      // may replace the primary transaction outcome.
      try {
        if ((typeof primary.error === 'object' && primary.error !== null) || typeof primary.error === 'function')
          Object.defineProperty(primary.error, 'cleanupFailures', { value: cleanupFailures });
      } catch {
        /* Preserve the original rejection identity. */
      }
      for (const failure of cleanupFailures) {
        try {
          console.error(
            `Local libSQL cleanup failed (${failure.step}); primary deployment failure preserved:`,
            failure.error,
          );
        } catch {
          /* A diagnostic failure cannot replace the transaction outcome. */
        }
      }
    }
    throw primary.error;
  }
  if (cleanupFailures.length) {
    throw new AggregateError(
      cleanupFailures.map((failure) => failure.error),
      committed
        ? 'Local libSQL COMMIT acknowledged success, but owned cleanup failed. Inspect migration status before retrying.'
        : 'Local libSQL owned cleanup failed. No COMMIT success was acknowledged; inspect migration status before retrying.',
    );
  }
  return result!;
}
