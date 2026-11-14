import {
  applyRelationRenames,
  applyTableFilters,
  assertDistinctColumnFields,
  assertSafeCatalogSchema,
  defaultForeignKeyConstraintName,
  deriveRelations,
  nullRecord,
  printableCatalogName,
  referentialActionFromCatalog,
  sqliteKeyComparison,
} from '../catalog-metadata.js';
/** Native local libSQL catalog reads only; no schema lifecycle or remote transport. */
import { sqliteTypeToTs } from '../d1/sqlite-dialect.js';
import { ConnectionError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { IntrospectOptions } from '../introspect.js';
import type { LibsqlLocalSource } from '../libsql.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import {
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  type ReferentialAction,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from '../schema.js';
import { declaredForeignKeyName, declaredForeignKeyNames } from '../sqlite-constraint-names.js';
import { type LibsqlLocalClient, localUrl } from './pool.js';
import { type LibsqlValue, rows } from './values.js';

export interface LibsqlIntrospectOptions
  extends Pick<
    IntrospectOptions,
    'include' | 'exclude' | 'logger' | 'legacyToManyUniques' | 'relationNames' | 'keepColumnNames'
  > {
  /** Only main base tables are supported. */
  schema?: 'main';
  includeViews?: false;
}

const optionKeys = new Set([
  'include',
  'exclude',
  'logger',
  'legacyToManyUniques',
  'relationNames',
  'keepColumnNames',
  'schema',
  'includeViews',
]);

/**
 * Read main base-table metadata using the optional @libsql/client/node peer.
 * Strings open and close an owned client. Supplied clients remain open on every
 * outcome. Supplying a client attests its local URL has no sync or replicas;
 * private native client configuration cannot be inspected. Do not use that
 * client concurrently. No DDL is issued and no transaction is acquired.
 */
export async function introspectLibsql(
  target: string | LibsqlLocalSource,
  options: LibsqlIntrospectOptions = {},
): Promise<SchemaMetadata> {
  const owned = typeof target === 'string';
  const url = localUrl(owned ? target : target.url);
  if (!owned && Object.keys(target).some((key) => key !== 'client' && key !== 'url'))
    throw new ValidationError(
      'A supplied libSQL source accepts only client and url; sync and remote options are unsupported.',
    );
  for (const key of Object.keys(options)) {
    if (!optionKeys.has(key))
      throw new UnsupportedFeatureError(key, 'libsql', 'Only local main catalog options are implemented.');
  }
  if ((options.schema !== undefined && options.schema !== 'main') || options.includeViews)
    throw new UnsupportedFeatureError(
      'Non-main or view introspection',
      'libsql',
      'Only main base tables are implemented.',
    );

  let client: LibsqlLocalClient;
  if (owned) {
    let peer: { createClient?: (config: { url: string; intMode: 'bigint'; concurrency: number }) => LibsqlLocalClient };
    try {
      peer = (await importOptionalPeer('@libsql/client/node')) as typeof peer;
    } catch (cause) {
      throw new ConnectionError(
        'Local libSQL introspection requires the optional @libsql/client package and its native engine. Install @libsql/client.',
        { cause },
      );
    }
    if (typeof peer.createClient !== 'function')
      throw new ConnectionError('@libsql/client/node must export createClient.');
    client = peer.createClient({ url, intMode: 'bigint', concurrency: 1 });
  } else client = target.client;
  try {
    if (client.closed || client.protocol !== 'file')
      throw new ConnectionError('libSQL introspection requires an open native local client (protocol=file).');
    const probe = await client.execute({ sql: 'SELECT 9007199254740993 AS turbine_libsql_integer' });
    if (probe.rows[0]?.[0] !== 9007199254740993n)
      throw new ValidationError('Local libSQL introspection requires intMode: bigint.');
    const databases = await catalog<{ name: string }>(client, 'PRAGMA database_list');
    if (databases.some((db) => db.name !== 'main' && db.name !== 'temp'))
      throw new UnsupportedFeatureError(
        'Attached database introspection',
        'libsql',
        'Use a client with only main and optional temp databases.',
      );
    const before = await catalog<{ schema_version: number }>(client, 'PRAGMA main.schema_version');
    const result = await readCatalog(client, options);
    const after = await catalog<{ schema_version: number }>(client, 'PRAGMA main.schema_version');
    if (before[0]?.schema_version !== after[0]?.schema_version)
      throw new ValidationError(
        'The local libSQL catalog changed during introspection. Retry without concurrent schema changes.',
      );
    assertSafeCatalogSchema(result);
    return result;
  } finally {
    if (owned) client.close();
  }
}

async function catalog<T>(client: LibsqlLocalClient, sql: string, args?: Record<string, LibsqlValue>): Promise<T[]> {
  // Catalog integer cells are small flags/ordinals, normalized by the existing
  // native row decoder. Identifiers are quoted; query values use native binds.
  return rows(await client.execute({ sql, args })) as T[];
}

const sqliteName = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
function isSqliteDateType(type: string): boolean {
  return isDateType(type.toLowerCase()) || /(timestamp|datetime|date)/i.test(type);
}

interface PragmaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}
interface PragmaForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}
interface PragmaIndex {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface PragmaIndexColumn {
  seqno: number;
  cid: number;
  name: string | null;
}

async function readCatalog(client: LibsqlLocalClient, options: LibsqlIntrospectOptions): Promise<SchemaMetadata> {
  // ----- Tables (skip SQLite internal + the migration tracking table) -----
  const catalogTables = await catalog<{ name: string; sql: string | null }>(
    client,
    "SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name",
  );
  const views = await catalog<{ name: string }>(client, "SELECT name FROM main.sqlite_master WHERE type = 'view'");
  if (views.some((view) => options.include?.includes(view.name)))
    throw new UnsupportedFeatureError('View introspection', 'libsql', 'Only main base tables are implemented.');
  const candidateTables = catalogTables.map((t) => t.name);
  const tableDefinitions = new Map(catalogTables.map((t) => [t.name, t.sql ?? '']));
  // include / exclude + default bookkeeping-table exclusions, shared with
  // every other introspector via applyTableFilters.
  const tableNames = applyTableFilters(candidateTables, options);
  const tableSet = new Set(tableNames);
  const flagsList = await catalog<{ name: string; type: string; wr: number; strict: number }>(
    client,
    'PRAGMA main.table_list',
  );
  for (const name of tableNames) {
    if (flagsList.find((t) => t.name === name)?.type !== 'table')
      throw new UnsupportedFeatureError('Virtual or shadow table introspection', 'libsql', printableCatalogName(name));
  }
  const tableFlags = new Map(flagsList.map((t) => [t.name, t]));

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  const pkByTable = new Map<string, string[]>();
  const uniqueByTable = new Map<string, string[][]>();
  const relationUniqueByTable = new Map<string, string[][]>();
  const indexesByTable = new Map<string, IndexMetadata[]>();

  interface FKEntry {
    sourceTable: string;
    sourceColumns: string[];
    targetTable: string;
    targetColumns: string[];
    constraintName: string;
  }
  const foreignKeys: FKEntry[] = [];
  const fkActions = new Map<FKEntry, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>();

  for (const tableName of tableNames) {
    // ----- Columns + primary key -----
    // table_xinfo also exposes computed columns (hidden = 2/3). Virtual-table
    // hidden inputs (1) are not ordinary projected/writable columns.
    const cols = (await catalog<PragmaColumn>(client, `PRAGMA main.table_xinfo(${q(tableName)})`)).filter(
      (c) => c.hidden !== 1,
    );
    const idxList = await catalog<PragmaIndex>(client, `PRAGMA main.index_list(${q(tableName)})`);
    const flags = tableFlags.get(tableName);
    const primaryColumns = cols.filter((c) => c.pk > 0);
    // Only a sole INTEGER PK on a rowid table aliases the rowid. A separate
    // PK index distinguishes the historical inline PRIMARY KEY DESC exception
    // without parsing DDL; INT/BIGINT and WITHOUT ROWID keys never qualify.
    const rowidKey =
      flags?.wr === 0 && primaryColumns.length === 1 && !idxList.some((idx) => idx.origin === 'pk')
        ? primaryColumns.find((c) => c.type.toUpperCase() === 'INTEGER')?.name
        : undefined;
    const colMeta: ColumnMetadata[] = [];
    const pkCols: { name: string; order: number }[] = [];
    for (const c of cols) {
      const declared = c.type || '';
      const generated = c.hidden === 2 || c.hidden === 3;
      const nullable =
        c.notnull === 0 && c.name !== rowidKey && !(c.pk > 0 && (flags?.wr === 1 || flags?.strict === 1));
      colMeta.push({
        name: c.name,
        field: options.keepColumnNames ? c.name : snakeToCamel(c.name),
        dialectType: declared,
        pgType: declared,
        tsType: sqliteTypeToTs(declared, nullable),
        nullable,
        defaultValue: c.dflt_value,
        hasDefault: c.dflt_value !== null || c.name === rowidKey || generated,
        ...(c.name === rowidKey ? { isGenerated: true } : {}),
        // This existing flag means computed/non-writable to the generator and
        // write guards, which is true for both SQLite VIRTUAL and STORED values.
        ...(generated ? { isGeneratedStored: true } : {}),
        isArray: false,
        arrayType: undefined,
        pgArrayType: 'text[]',
      });
      if (c.pk > 0) pkCols.push({ name: c.name, order: c.pk });
    }
    columnsByTable.set(tableName, colMeta);
    pkByTable.set(
      tableName,
      pkCols.sort((a, b) => a.order - b.order).map((p) => p.name),
    );

    // ----- Foreign keys -----
    const fks = await catalog<PragmaForeignKey>(client, `PRAGMA main.foreign_key_list(${q(tableName)})`);
    // Group by FK id (composite FKs share an id), ordered by seq.
    const fkById = new Map<number, FKEntry>();
    for (const fk of fks.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
      let entry = fkById.get(fk.id);
      if (!entry) {
        entry = {
          sourceTable: tableName,
          sourceColumns: [],
          targetTable: tableNames.find((name) => sqliteName(name) === sqliteName(fk.table)) ?? fk.table,
          targetColumns: [],
          constraintName: `fk_${tableName}_${fk.id}`,
        };
        fkById.set(fk.id, entry);
        fkActions.set(entry, {
          onDelete: referentialActionFromCatalog(fk.on_delete),
          onUpdate: referentialActionFromCatalog(fk.on_update),
        });
      }
      entry.sourceColumns.push(fk.from);
      // `to` is null when the FK references the target's PK implicitly.
      if (fk.to !== null) entry.targetColumns.push(fk.to);
    }
    for (const entry of fkById.values()) {
      if (entry.targetColumns.length === 0) {
        // Implicit reference → the target table's primary key.
        const targetPk = (await catalog<PragmaColumn>(client, `PRAGMA main.table_xinfo(${q(entry.targetTable)})`))
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);
        entry.targetColumns = targetPk;
      }
      if (tableSet.has(entry.targetTable)) {
        if (entry.targetColumns.length !== entry.sourceColumns.length)
          throw new ValidationError(
            `Unresolvable local libSQL foreign key: ${printableCatalogName(entry.constraintName)}.`,
          );
        foreignKeys.push(entry);
      }
    }

    // ----- Indexes + unique constraints -----
    const idxMeta: IndexMetadata[] = [];
    const uniques: string[][] = [];
    // An index's collation can differ from the relation comparison's column
    // collation: UNIQUE BINARY can admit both 'a' and 'A' under NOCASE joins.
    // Column collations are absent from table_xinfo. Conservatively keep the
    // to-many shape if the table/index DDL mentions COLLATE (even in a comment
    // or identifier), rather than promise a to-one on incomplete facts.
    const tableHasCollation = /\bCOLLATE\b/i.test(tableDefinitions.get(tableName) ?? '');
    const relationUniques = tableHasCollation ? [] : [pkByTable.get(tableName) ?? []];
    for (const idx of idxList) {
      const keys = (await catalog<PragmaIndexColumn>(client, `PRAGMA main.index_info(${q(idx.name)})`)).sort(
        (a, b) => a.seqno - b.seqno,
      );
      const plain = keys.length > 0 && keys.every((c) => c.cid >= 0 && c.name !== null);
      // Expression keys have no column name. Never let their null catalog
      // placeholders reach metadata/codegen or treat the remaining names as a
      // unique set. Keep the real DDL for partial/expression index consumers.
      // `columns` must describe a complete plain key: shared consumers also
      // derive compound selectors from it without parsing the definition.
      const idxCols = plain ? keys.map((c) => c.name!) : [];
      const indexSource = (
        await catalog<{ sql: string | null }>(
          client,
          "SELECT sql FROM main.sqlite_master WHERE type = 'index' AND name = :name",
          { name: idx.name },
        )
      )[0];
      idxMeta.push({
        name: idx.name,
        columns: idxCols,
        unique: idx.unique === 1,
        // Internal auto-index DDL is unavailable. Never synthesize executable DDL.
        definition: indexSource?.sql ?? '',
        ...(idx.partial === 1 ? { partial: true } : {}),
      });
      if (idx.unique === 1 && idx.partial === 0 && plain) {
        uniques.push(idxCols);
        if (!tableHasCollation && !/\bCOLLATE\b/i.test(indexSource?.sql ?? '')) relationUniques.push(idxCols);
      }
    }
    indexesByTable.set(tableName, idxMeta);
    uniqueByTable.set(tableName, uniques);
    relationUniqueByTable.set(tableName, relationUniques);
  }

  // SQLite resolves FK identifiers with ASCII case folding. Preserve the actual
  // catalog spelling in metadata and refuse unresolved in-scope references.
  for (const fk of foreignKeys) {
    const resolve = (table: string, name: string): string => {
      const column = columnsByTable.get(table)?.find((c) => sqliteName(c.name) === sqliteName(name));
      if (!column)
        throw new ValidationError(`Unresolvable local libSQL foreign key: ${printableCatalogName(fk.constraintName)}.`);
      return column.name;
    };
    fk.sourceColumns = fk.sourceColumns.map((name) => resolve(fk.sourceTable, name));
    fk.targetColumns = fk.targetColumns.map((name) => resolve(fk.targetTable, name));
  }
  // SQLite's catalog names no constraint, and relation naming reads the name
  // for a composite FK: take it from the CREATE TABLE text, else the name
  // PostgreSQL would give it.
  const constraintNames = new Set<string>();
  const relationActions = new Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>();
  for (const fk of foreignKeys) {
    const actions = fkActions.get(fk)!;
    const declared = declaredForeignKeyName(
      declaredForeignKeyNames(tableDefinitions.get(fk.sourceTable) ?? ''),
      fk.sourceColumns,
      fk.targetTable,
    );
    if (declared !== undefined) constraintNames.add(declared);
    fk.constraintName = declared ?? defaultForeignKeyConstraintName(fk.sourceTable, fk.sourceColumns, constraintNames);
    relationActions.set(`${fk.sourceTable}::${fk.constraintName}`, actions);
  }

  // ----- Build relations from foreign keys (belongsTo + hasMany + m2m) -----
  // The ONE relation derivation every engine calls, with SQLite's own facts:
  // its unique keys, and when a foreign key compares the way its key does. A
  // to-one is decided per foreign key before naming, so it is named as
  // PostgreSQL names it (`users.profile`).
  for (const [tableName, cols] of columnsByTable) assertDistinctColumnFields(tableName, cols);
  const relationsByTable = deriveRelations({
    tableNames,
    foreignKeys,
    pkByTable,
    columnsByTable,
    uniqueKeysByTable: relationUniqueByTable,
    sameKeyComparison: sqliteKeyComparison(columnsByTable, tableDefinitions, tableFlags),
    junctionKeysByTable: new Map(
      Array.from(uniqueByTable, ([table, keys]) => [table, keys.filter((key) => key.length === 2)]),
    ),
    fkActions: relationActions,
    ...(options.legacyToManyUniques ? { legacyToManyUniques: true } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  // ----- Assemble TableMetadata -----
  const tables: Record<string, TableMetadata> = nullRecord<TableMetadata>();
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) ?? [];
    const columnMap: Record<string, string> = nullRecord<string>();
    const reverseColumnMap: Record<string, string> = nullRecord<string>();
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = nullRecord<string>();
    const pgTypes: Record<string, string> = nullRecord<string>();
    const allColumns: string[] = [];

    for (const col of columns) {
      columnMap[col.field] = col.name;
      reverseColumnMap[col.name] = col.field;
      allColumns.push(col.name);
      dialectTypes[col.name] = col.dialectType ?? col.pgType;
      pgTypes[col.name] = col.pgType;
      if (isSqliteDateType(col.dialectType ?? col.pgType)) dateColumns.add(col.name);
    }

    tables[tableName] = {
      name: tableName,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns,
      dialectTypes,
      pgTypes,
      allColumns,
      primaryKey: pkByTable.get(tableName) ?? [],
      uniqueColumns: uniqueByTable.get(tableName) ?? [],
      relations: relationsByTable.get(tableName) ?? nullRecord<RelationDef>(),
      indexes: indexesByTable.get(tableName) ?? [],
    };
  }

  const schema: SchemaMetadata = { tables, enums: {} };
  // Shared renaming also supports raw-name metadata. Check the actual field
  // names here before handing camelCase metadata to that helper.
  for (const [name, renames] of Object.entries(options.relationNames ?? {})) {
    for (const [from, to] of Object.entries(renames)) {
      if (from !== to && tables[name]?.columns.some((column) => column.field === to))
        throw new ValidationError(
          `relationNames: a column already uses field "${printableCatalogName(to)}" on "${printableCatalogName(name)}".`,
        );
    }
  }
  return options.relationNames ? applyRelationRenames(schema, options.relationNames) : schema;
}
