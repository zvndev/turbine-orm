/** Native SQLite schema planning/apply. No PostgreSQL diff SQL is executed here. */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../errors.js';
import type { SchemaDef } from '../schema-builder.js';
import { schemaToSQL } from '../schema-sql.js';
import { sqliteDialect } from '../sqlite.js';
import { type SqliteMigrationOptions, withSqliteSchemaTransaction } from './sqlite-migrate.js';
import { parseSqliteTableDdl, sqliteIndexDdlKey } from './sqlite-schema-ddl.js';

interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
interface Step {
  sql: string;
  params?: string[];
}
export interface SqliteSchemaPlan {
  catalogHash: string;
  /** Hash of the complete displayed plan, checked again under the writer lock. */
  planHash: string;
  changes: Array<{ table: string; kind: 'create' | 'add' | 'rebuild' | 'index' }>;
  steps: Step[];
  /** Objects retained even when omitted from the code-first definition. */
  preserved: string[];
}

function refusal(message: string): never {
  throw new ValidationError(
    `SQLite schema: ${message}. No schema changes applied. Use an explicit reviewed SQL migration.`,
  );
}
function quote(name: string): string {
  return sqliteDialect.quoteIdentifier(name);
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function databaseConstructor(): typeof DatabaseSync {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 22 || (major === 22 && minor! < 16) || major === 23) {
    refusal('requires node:sqlite readOnly support (Node 22.x >= 22.16 or Node >= 24)');
  }
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return refusal('requires node:sqlite');
  }
}
function filenameCheck(filename: string): void {
  if (!filename || filename.includes('\0') || filename === ':memory:' || /^[a-z][a-z\d+.-]*:/i.test(filename)) {
    refusal('requires a persistent normalized filesystem filename');
  }
  if (existsSync(filename) && !statSync(filename).isFile()) refusal('database path is not a file');
}
function catalog(db: DatabaseSync): CatalogEntry[] {
  return db
    .prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name')
    .all() as unknown as CatalogEntry[];
}
function columns(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA main.table_xinfo(${quote(table)})`).all();
}
function fks(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA main.foreign_key_list(${quote(table)})`).all();
}

/** The ordinary generator does not encode catalog modes. Validate the merged DDL with them too. */
function validateTableModes(sql: string): void {
  const Database = databaseConstructor();
  const db = new Database(':memory:');
  try {
    parseSqliteTableDdl(sql);
    db.exec(sql);
  } catch (error) {
    refusal(`target DDL cannot preserve native table modes: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

/** Compile the existing SQLite generator into a disposable native catalog first. */
function desiredCatalog(schema: SchemaDef): { entries: CatalogEntry[]; sql: string[] } {
  for (const table of Object.values(schema.tables)) {
    if (/^(sqlite_|_turbine_)/i.test(table.name)) refusal(`reserved table name ${table.name}`);
    for (const col of Object.values(table.columns)) {
      if (col.isArray || col.vectorDimensions != null || col.maxLength != null)
        refusal('arrays, vectors and length limits are not representable in this SQLite schema slice');
    }
  }
  const sql = schemaToSQL(schema, { dialect: sqliteDialect });
  const Database = databaseConstructor();
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    // Generated source can contain raw CHECK/default expressions. This catalog
    // accepts only one CREATE TABLE/INDEX per generator statement. No effects
    // can escape this in-memory handle, even for malformed raw expressions.
    for (const statement of sql) {
      if (/^CREATE TABLE /i.test(statement)) parseSqliteTableDdl(statement);
      else if (/^CREATE (?:UNIQUE )?INDEX /i.test(statement)) sqliteIndexDdlKey(statement);
      else refusal('unsupported generated statement');
    }
    const native = createRequire(process.cwd())('node:sqlite') as { constants: Record<string, number> };
    const guarded = db as DatabaseSync & {
      setAuthorizer?: (
        callback: ((action: number, first: string | null, second: string | null) => number) | null,
      ) => void;
    };
    const c = native.constants;
    // Reader runtimes may lack authorizer support. They can still compile the
    // parsed DDL; reject semicolons outside its final terminator for indexes.
    if (guarded.setAuthorizer)
      guarded.setAuthorizer((action, first, second) => {
        if (
          [
            c.SQLITE_TRANSACTION,
            c.SQLITE_SAVEPOINT,
            c.SQLITE_PRAGMA,
            c.SQLITE_ATTACH,
            c.SQLITE_DETACH,
            c.SQLITE_CREATE_VTABLE,
            c.SQLITE_DROP_VTABLE,
            c.SQLITE_CREATE_TRIGGER,
            c.SQLITE_CREATE_VIEW,
            c.SQLITE_DROP_TABLE,
            c.SQLITE_DROP_INDEX,
          ].includes(action)
        )
          return c.SQLITE_DENY!;
        if (
          [c.SQLITE_INSERT, c.SQLITE_UPDATE, c.SQLITE_DELETE].includes(action) &&
          first !== 'sqlite_master' &&
          first !== 'sqlite_sequence'
        )
          return c.SQLITE_DENY!;
        if (action === c.SQLITE_FUNCTION && second?.toLowerCase() === 'load_extension') return c.SQLITE_DENY!;
        return c.SQLITE_OK!;
      });
    for (const statement of sql) db.exec(statement);
    guarded.setAuthorizer?.(null);
    const entries = catalog(db);
    const names = entries
      .filter((e) => e.type === 'table' && !e.name.startsWith('sqlite_'))
      .map((e) => e.name)
      .sort();
    if (
      hash(names) !==
      hash(
        Object.values(schema.tables)
          .map((t) => t.name)
          .sort(),
      )
    )
      refusal('generated table catalog is ambiguous');
    // Reuse the native catalog to validate target names and composite key compatibility.
    for (const name of names) {
      for (const col of parseSqliteTableDdl(entries.find((e) => e.type === 'table' && e.name === name)!.sql!).columns) {
        if (col.defaultSql !== undefined) db.prepare(`SELECT ${col.defaultSql}`);
      }
      for (const fk of fks(db, name))
        if (!names.includes(String(fk.table))) refusal(`foreign key target ${String(fk.table)} must be declared`);
      db.prepare(`PRAGMA main.foreign_key_check(${quote(name)})`).all();
    }
    return { entries, sql };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return refusal(
      `target DDL cannot be represented by native SQLite: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db.close();
  }
}

function buildPlan(db: DatabaseSync, desired: ReturnType<typeof desiredCatalog>, exists: boolean): SqliteSchemaPlan {
  const entries = catalog(db);
  const tables = entries.filter((e) => e.type === 'table' && !e.name.startsWith('sqlite_'));
  const tableOrder = desired.sql
    .filter((sql) => /^CREATE TABLE /i.test(sql))
    .map((sql) => parseSqliteTableDdl(sql).name);
  const targetTables = tableOrder.map((name) => desired.entries.find((e) => e.type === 'table' && e.name === name)!);
  const changes: SqliteSchemaPlan['changes'] = [];
  const steps: Step[] = [];
  const preserved: string[] = [];
  const catalogHash = hash({ exists, entries, version: db.prepare('PRAGMA main.schema_version').get() });
  const add = (sql: string, params?: string[]) => steps.push({ sql, ...(params ? { params } : {}) });
  for (const target of targetTables) {
    const original = tables.find((e) => e.name === target.name);
    if (!original) {
      if (entries.some((e) => e.name.toLowerCase() === target.name.toLowerCase()))
        refusal(`object name collision for ${target.name}`);
      changes.push({ table: target.name, kind: 'create' });
      add(target.sql!);
      continue;
    }
    if (!original.sql || !target.sql) refusal(`unavailable table SQL for ${target.name}`);
    const before = parseSqliteTableDdl(original.sql);
    const after = parseSqliteTableDdl(target.sql);
    if (before.constraintsKey !== after.constraintsKey) refusal(`table constraints differ for ${target.name}`);
    const originalColumns = columns(db, target.name);
    if (originalColumns.some((c) => c.hidden !== 0)) refusal(`generated/hidden columns in ${target.name}`);
    const beforeNames = before.columns.map((c) => c.name);
    if (beforeNames.some((name) => !after.columns.some((c) => c.name === name)))
      refusal(`column removal or rename in ${target.name}`);
    let needsRebuild = false;
    const merged = before.columns.map((old) => {
      const next = after.columns.find((c) => c.name === old.name)!;
      if (old.fixedKey !== next.fixedKey)
        refusal(`type, key, reference, collation or CHECK change for ${target.name}.${old.name}`);
      // These modes enforce primary-key nullability independently of an explicit
      // NOT NULL clause. Preserve its original spelling and native key behavior.
      const implicitNotNull =
        (before.strict || before.withoutRowid) && originalColumns.some((c) => c.name === old.name && Number(c.pk) > 0);
      const notNull = implicitNotNull ? old.notNull : next.notNull;
      if (
        (old.notNull || implicitNotNull) !== (next.notNull || implicitNotNull) ||
        old.defaultKey !== next.defaultKey
      ) {
        needsRebuild = true;
        if (
          next.notNull &&
          db.prepare(`SELECT 1 FROM main.${quote(target.name)} WHERE ${quote(old.name)} IS NULL LIMIT 1`).get()
        )
          refusal(`NULL rows prevent NOT NULL on ${target.name}.${old.name}`);
      }
      return `${old.fixedSql}\n${notNull ? ' NOT NULL' : ''}${next.defaultSql === undefined ? '' : ` DEFAULT ${next.defaultSql}`}`;
    });
    const additions = after.columns.filter((c) => !beforeNames.includes(c.name));
    // Native STRICT ADD runs an internal quick_check PRAGMA. Keep the shared
    // authorizer closed and use the proven rebuild/copy path for these tables.
    if (before.strict && additions.length) needsRebuild = true;
    for (const col of additions) {
      // Native ADD COLUMN cannot add keys/references; accepting only a scalar
      // definition keeps existing constraints authoritative and avoids coercion.
      if (!/^(?:INTEGER|REAL|TEXT|BLOB|NUMERIC|BOOLEAN)$/i.test(col.fixedSql.slice(quote(col.name).length).trim()))
        refusal(`new constrained column ${target.name}.${col.name} needs a SQL migration`);
      if (
        col.notNull &&
        (col.defaultSql === undefined || /^NULL$/i.test(col.defaultSql)) &&
        db.prepare(`SELECT 1 FROM main.${quote(target.name)} LIMIT 1`).get()
      )
        refusal(`new NOT NULL column ${target.name}.${col.name} has no non-NULL default`);
      if (
        col.defaultSql !== undefined &&
        !/^(?:NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|'(?:[^']|'')*')$/i.test(col.defaultSql)
      )
        needsRebuild = true;
      merged.push(col.sql);
    }
    const definition = `(${[...merged, ...before.constraints].join(',\n')})${before.suffixSql ? ` ${before.suffixSql}` : ''}`;
    if ((before.strict || before.withoutRowid) && (needsRebuild || additions.length))
      validateTableModes(`CREATE TABLE ${quote(target.name)} ${definition}`);
    if (!needsRebuild) {
      for (const col of additions) {
        changes.push({ table: target.name, kind: 'add' });
        add(`ALTER TABLE main.${quote(target.name)} ADD COLUMN ${col.sql}`);
      }
      continue;
    }
    // Keeping FK enforcement enabled means DROP of a referenced table can run
    // cascades. Refuse every inbound edge, including self references, rather
    // than toggling foreign_keys or assuming deferral suppresses those effects.
    for (const table of tables) {
      if (fks(db, table.name).some((fk) => String(fk.table).toLowerCase() === target.name.toLowerCase()))
        refusal(`rebuild of ${target.name} has inbound foreign keys from ${table.name}`);
    }
    // SQLite validates all views during ALTER RENAME. Conservatively refuse
    // views and triggers owned by another table: their dependencies are opaque.
    if (entries.some((e) => e.type === 'view' || (e.type === 'trigger' && e.tbl_name !== target.name)))
      refusal(`rebuild of ${target.name} has opaque view/external trigger dependencies`);
    const replacement = `_turbine_rebuild_${createHash('sha256').update(target.name).digest('hex').slice(0, 16)}`;
    if (entries.some((e) => e.name.toLowerCase() === replacement.toLowerCase()))
      refusal(`replacement name collision for ${target.name}`);
    const rowid = before.withoutRowid
      ? undefined
      : ['rowid', '_rowid_', 'oid'].find((n) => !after.columns.some((c) => c.name.toLowerCase() === n));
    if (!before.withoutRowid && !rowid) refusal(`all rowid aliases are shadowed in ${target.name}`);
    changes.push({ table: target.name, kind: 'rebuild' });
    add(`CREATE TABLE main.${quote(replacement)} ${definition}`);
    const copy = [...(rowid ? [rowid] : []), ...beforeNames].map(quote).join(', ');
    add(`INSERT INTO main.${quote(replacement)} (${copy}) SELECT ${copy} FROM main.${quote(target.name)}`);
    if (before.columns.some((c) => c.autoincrement))
      add(
        'UPDATE main.sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM main.sqlite_sequence WHERE name = ?), seq)) WHERE name = ?',
        [target.name, replacement],
      );
    add(`DROP TABLE main.${quote(target.name)}`);
    add(`ALTER TABLE main.${quote(replacement)} RENAME TO ${quote(target.name)}`);
    // Indexes first, then triggers. Copying into the replacement never invokes
    // user triggers; restored triggers observe only subsequent application writes.
    for (const entry of entries.filter((e) => e.tbl_name === target.name && e.sql && e.type === 'index'))
      add(entry.sql!);
    for (const entry of entries.filter((e) => e.tbl_name === target.name && e.sql && e.type === 'trigger'))
      add(entry.sql!);
  }
  for (const index of desired.entries.filter((e) => e.type === 'index' && e.sql)) {
    const old = entries.find((e) => e.name.toLowerCase() === index.name.toLowerCase());
    if (old) {
      if (old.type !== 'index' || !old.sql || sqliteIndexDdlKey(old.sql) !== sqliteIndexDdlKey(index.sql!))
        refusal(`index definition collision for ${index.name}`);
    } else {
      changes.push({ table: index.tbl_name, kind: 'index' });
      add(index.sql!);
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith('sqlite_') || entry.name === '_turbine_migrations') continue;
    if (
      (entry.type === 'table' && !targetTables.some((t) => t.name === entry.name)) ||
      entry.type === 'trigger' ||
      (entry.type === 'index' && !desired.entries.some((e) => e.name === entry.name))
    )
      preserved.push(`${entry.type} ${entry.name}`);
  }
  // Table steps follow the existing generator's FK dependency order; indexes
  // follow all tables. New child tables are empty during any parent rebuild.
  const result = { catalogHash, changes, steps, preserved };
  return { ...result, planHash: hash(result) };
}

/** Read-only planning never creates a missing database. */
export function planSqliteSchema(schema: SchemaDef, filename: string): SqliteSchemaPlan {
  filenameCheck(filename);
  const desired = desiredCatalog(schema);
  const exists = existsSync(filename);
  const Database = databaseConstructor();
  const db = new Database(exists ? filename : ':memory:', { readOnly: exists });
  try {
    db.exec('BEGIN');
    return buildPlan(db, desired, exists);
  } finally {
    db.close();
  }
}

/** Recompute and validate under the same native lock used by SQL migrations. */
export function pushSqliteSchema(
  schema: SchemaDef,
  filename: string,
  options?: SqliteMigrationOptions & { expectedPlan?: SqliteSchemaPlan },
): SqliteSchemaPlan {
  filenameCheck(filename);
  const desired = desiredCatalog(schema);
  const existed = existsSync(filename);
  // Refuse unsupported catalog/schema definitions before opening for writing.
  const preview = planSqliteSchema(schema, filename);
  if (options?.expectedPlan && options.expectedPlan.planHash !== preview.planHash) refusal('displayed plan is stale');
  return withSqliteSchemaTransaction(
    filename,
    (db) => {
      const plan = buildPlan(db, desired, existed);
      if (plan.planHash !== preview.planHash) refusal('catalog changed before the writer lock was acquired');
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) refusal('foreign key enforcement is required');
      if (db.prepare('PRAGMA main.foreign_key_check').all().length)
        refusal('database already contains foreign key violations');
      for (const step of plan.steps) db.prepare(step.sql).run(...(step.params ?? []));
      if (db.prepare('PRAGMA main.foreign_key_check').all().length)
        refusal('foreign key validation failed; transaction will roll back');
      return plan;
    },
    options,
  );
}
