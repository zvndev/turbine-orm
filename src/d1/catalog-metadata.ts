/** SQLite catalog facts normalized for the D1 value contract, never a SQLite transport. */

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
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
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
import { CATALOG_TABLES, CATALOG_VIEWS, type D1CatalogSnapshot, literal, q } from './catalog.js';
import type { D1IntrospectOptions } from './introspect.js';
import { sqliteTypeToTs } from './sqlite-dialect.js';

/** Native D1 INTEGER results are numbers. Decimal affinity may retain nonnumeric TEXT. */
function d1ColumnType(declared: string, nullable: boolean): string {
  if (/^(numeric|decimal)/i.test(declared)) return nullable ? 'number | string | null' : 'number | string';
  return sqliteTypeToTs(declared, nullable);
}
const sqliteName = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

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

export function d1CatalogMetadata(snapshot: D1CatalogSnapshot, options: D1IntrospectOptions): SchemaMetadata {
  const catalog = <T>(sql: string): T[] => snapshot.read<T>(sql);
  // ----- Tables (skip SQLite internal + the migration tracking table) -----
  const catalogTables = catalog<{ name: string; sql: string | null }>(CATALOG_TABLES);
  const views = catalog<{ name: string }>(CATALOG_VIEWS);
  if (views.some((view) => options.include?.includes(view.name)))
    throw new UnsupportedFeatureError('View introspection', 'd1', 'Only main base tables are implemented.');
  const candidateTables = catalogTables.map((t) => t.name);
  const tableDefinitions = new Map(catalogTables.map((t) => [t.name, t.sql ?? '']));
  // include / exclude + default bookkeeping-table exclusions, shared with
  // every other introspector via applyTableFilters.
  const tableNames = applyTableFilters(candidateTables, options);
  const tableSet = new Set(tableNames);
  const flagsList = catalog<{ name: string; type: string; wr: number; strict: number }>('PRAGMA main.table_list');
  for (const name of tableNames) {
    if (flagsList.find((t) => t.name === name)?.type !== 'table')
      throw new UnsupportedFeatureError('Virtual or shadow table introspection', 'd1', printableCatalogName(name));
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
    const cols = catalog<PragmaColumn>(`PRAGMA main.table_xinfo(${q(tableName)})`).filter((c) => c.hidden !== 1);
    const idxList = catalog<PragmaIndex>(`PRAGMA main.index_list(${q(tableName)})`);
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
        tsType: d1ColumnType(declared, nullable),
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
    const fks = catalog<PragmaForeignKey>(`PRAGMA main.foreign_key_list(${q(tableName)})`);
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
      if (!tableSet.has(entry.targetTable)) continue;
      if (entry.targetColumns.length === 0) {
        // Implicit reference → the target table's primary key.
        const targetPk = catalog<PragmaColumn>(`PRAGMA main.table_xinfo(${q(entry.targetTable)})`)
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);
        entry.targetColumns = targetPk;
      }
      if (tableSet.has(entry.targetTable)) {
        if (entry.targetColumns.length !== entry.sourceColumns.length)
          throw new ValidationError(`Unresolvable D1 foreign key: ${printableCatalogName(entry.constraintName)}.`);
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
      const keys = catalog<PragmaIndexColumn>(`PRAGMA main.index_info(${q(idx.name)})`).sort(
        (a, b) => a.seqno - b.seqno,
      );
      const plain = keys.length > 0 && keys.every((c) => c.cid >= 0 && c.name !== null);
      // Expression keys have no column name. Never let their null catalog
      // placeholders reach metadata/codegen or treat the remaining names as a
      // unique set. Keep the real DDL for partial/expression index consumers.
      // `columns` must describe a complete plain key: shared consumers also
      // derive compound selectors from it without parsing the definition.
      const idxCols = plain ? keys.map((c) => c.name!) : [];
      const indexSource = catalog<{ sql: string | null }>(
        `SELECT sql FROM main.sqlite_master WHERE type = 'index' AND name = ${literal(idx.name)}`,
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
        throw new ValidationError(`Unresolvable D1 foreign key: ${printableCatalogName(fk.constraintName)}.`);
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

  const schema: SchemaMetadata = { tables, enums: nullRecord<string[]>() };
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
  const result = options.relationNames ? applyRelationRenames(schema, options.relationNames) : schema;
  assertSafeCatalogSchema(result);
  return result;
}
