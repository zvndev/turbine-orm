/** SQLite tool transport. Each checkout owns an existing file opened read-only. */
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectionError, ValidationError } from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import type { IndexMetadata } from '../schema.js';
import { introspectSqliteDatabase, SqlitePool, sqliteDialect } from '../sqlite.js';
import { normalizeSqlitePath } from './config.js';

const databases = new WeakMap<PgCompatPoolClient, DatabaseSync>();
const indexSummaries = new WeakMap<IndexMetadata, Record<string, unknown>>();

/** Native catalog facts for SQLite tool metadata; absent for other engines. */
export function sqliteToolIndexSummary(index: IndexMetadata): Record<string, unknown> | undefined {
  return indexSummaries.get(index);
}

function databaseConstructor(): typeof DatabaseSync | undefined {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) return undefined;
  try {
    return createRequire(join(process.cwd(), 'package.json'))('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
}

/** Runtime facts only: does not open a database, create a file or execute SQL. */
export function sqliteToolRuntime() {
  const available = typeof databaseConstructor() === 'function';
  return {
    available,
    minimumNode: '22.12.0',
    reason: available ? null : 'SQLite tools require node:sqlite with readOnly support (Node >= 22.12).',
  };
}

/** Reuse the engine introspector on the current read-only snapshot. */
export function introspectSqliteToolClient(
  client: PgCompatPoolClient,
  options: { include?: string[]; exclude?: string[]; legacyToManyUniques?: boolean },
) {
  const db = databases.get(client);
  if (!db) throw new ValidationError('SQLite tool metadata requires an active SQLite tool connection.');
  const metadata = introspectSqliteDatabase(db, options);
  // The shared introspector retains native index SQL. Replace it with structural
  // summaries before tool handlers see it, withholding expressions and predicates.
  // index_info preserves expression positions that general metadata omits.
  for (const table of Object.values(metadata.tables)) {
    const indexes = db.prepare(`PRAGMA index_list(${sqliteDialect.quoteIdentifier(table.name)})`).all() as {
      name: string;
      partial: number;
    }[];
    for (const index of table.indexes) {
      const partial = indexes.find((entry) => entry.name === index.name)?.partial === 1;
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const columns = db.prepare(`PRAGMA index_info(${sqliteDialect.quoteIdentifier(index.name)})`).all() as {
        name: string | null;
      }[];
      const expression = columns.some(({ name }) => name === null);
      index.columns = columns.flatMap(({ name }) => (name === null ? [] : [name]));
      const keys = columns.map(({ name }) => (name === null ? '(expression withheld)' : quote(name)));
      index.definition = `${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${quote(table.name)}(${keys.join(', ')})${partial ? ' WHERE (predicate withheld)' : ''}`;
      // Do not reparse this presentation string as PostgreSQL DDL: quoted
      // names can contain apostrophes, parentheses and the word WHERE.
      indexSummaries.set(index, {
        name: index.name,
        columns: index.columns,
        columnsWithheld: expression,
        unique: index.unique,
        partial,
        definitionWithheld: expression,
        definition: expression
          ? '(definition withheld: expression indexes may embed literal values)'
          : index.definition,
      });
    }
  }
  return metadata;
}

/**
 * A lazy adapter: discovery and error lookup need no file or native runtime.
 * No caller-owned database handles are accepted or closed.
 */
export function createSqliteToolPool(url: string, schema: string): PgCompatPool {
  if (schema !== 'main') throw new ValidationError('SQLite tools use schema "main".');
  let closed = false;
  const active = new Set<() => void>();
  return {
    async query(): Promise<never> {
      throw new ValidationError('SQLite tools require a scoped read-only connection.');
    },
    async connect() {
      if (closed) throw new ValidationError('SQLite tool transport is closed.');
      const path = normalizeSqlitePath(url);
      const Database = databaseConstructor();
      if (!Database) throw new ValidationError(sqliteToolRuntime().reason!);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new ValidationError('SQLite tools require an existing database file; no database was created.');
      }
      const db = new Database(path, { readOnly: true });
      let inner: PgCompatPoolClient | undefined;
      let released = false;
      let nativeClosed = false;
      let client: PgCompatPoolClient | undefined;
      const release = () => {
        if (nativeClosed) return;
        if (client) databases.delete(client);
        try {
          if (!released) {
            released = true;
            inner?.release();
          }
        } finally {
          try {
            db.close();
            nativeClosed = true;
          } finally {
            // A failed close can leave the native handle open. Keep ownership
            // for pool.end/release retry; a throw after closure needs no retry.
            if (nativeClosed || db.isOpen === false) {
              nativeClosed = true;
              active.delete(release);
            }
          }
        }
      };
      active.add(release);
      try {
        inner = await new SqlitePool(db).connect();
        if (closed) {
          inner.release();
          throw new ValidationError('SQLite tool transport is closed.');
        }
      } catch (error) {
        try {
          release();
        } catch (cleanup) {
          throw new ConnectionError('SQLite tool checkout and cleanup failed.', { cause: [error, cleanup] });
        }
        throw error;
      }
      client = {
        query: (text, values) => inner!.query(text, values),
        release,
      };
      databases.set(client, db);
      return client;
    },
    async end() {
      closed = true;
      const errors: unknown[] = [];
      for (const release of active) {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new ConnectionError('SQLite tool cleanup failed.', { cause: errors });
    },
  };
}
