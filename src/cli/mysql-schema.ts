/** Read-only MySQL schema comparison and SQL-file scaffolding. No direct apply path. */
import type { SchemaDef } from '../schema-builder.js';
import { createMigration, listIgnoredSqlFiles, type MigrationFile } from './migrate.js';
import { inspectMysqlMigrationDeploy } from './mysql-migrate.js';
import {
  MYSQL_SCHEMA_COLLATION,
  type MysqlIndex,
  modelMysqlSchema,
  mysqlIndexDefinition,
  quoteMysqlSchemaName as q,
  mysqlSchemaRefusal as refuse,
} from './mysql-schema-ddl.js';
import {
  inspectMysqlSchema,
  MYSQL_SCHEMA_EXCLUDED,
  type MysqlCatalogRow,
  type MysqlSchemaSnapshot,
} from './mysql-schema-snapshot.js';

export type { MysqlSchemaSnapshot } from './mysql-schema-snapshot.js';
export { inspectMysqlSchema } from './mysql-schema-snapshot.js';

export interface MysqlSchemaStep {
  kind: 'create-table' | 'add-column' | 'add-index' | 'add-foreign-key';
  table: string;
  sql: string;
  down: string;
}
export interface MysqlSchemaPlan {
  database: string;
  fingerprint: string;
  steps: MysqlSchemaStep[];
  up: string;
  down: string;
  requiresAlterConsent: boolean;
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
const text = (r: MysqlCatalogRow, key: string) => String(r[key] ?? '');
const equalIndex = (a: MysqlIndex, b: MysqlIndex) => a.unique === b.unique && same(a.columns, b.columns);

/** Complete desired schema required. Nothing is silently dropped or rebuilt. */
export function planMysqlSchema(schema: SchemaDef, snapshot: MysqlSchemaSnapshot): MysqlSchemaPlan {
  const desired = modelMysqlSchema(schema);
  const ignored = new Set<string>(MYSQL_SCHEMA_EXCLUDED);
  const facts = snapshot.facts;
  const tables = facts.tables.filter((r) => !ignored.has(text(r, 'TABLE_NAME')));
  for (const table of tables) {
    const name = text(table, 'TABLE_NAME');
    if (!desired.some((t) => t.name === name)) refuse(`table removal or omitted native object ${name}`);
    if (
      table.TABLE_TYPE !== 'BASE TABLE' ||
      table.ENGINE !== 'InnoDB' ||
      (text(table, 'CREATE_OPTIONS') !== '' && text(table, 'CREATE_OPTIONS').toLowerCase() !== 'row_format=dynamic') ||
      table.ROW_FORMAT !== 'Dynamic' ||
      text(table, 'TABLE_COMMENT')
    )
      refuse(`unsupported native table definition ${name}`);
    if (!Object.hasOwn(snapshot.metadata.tables, name)) refuse(`incomplete general metadata for ${name}`);
  }
  for (const object of facts.unsupported) {
    if (!ignored.has(text(object, 'TABLE_NAME')))
      refuse(`native ${text(object, 'KIND')} on ${text(object, 'TABLE_NAME')}`);
  }
  const steps: MysqlSchemaStep[] = [];
  const fkSteps: MysqlSchemaStep[] = [];
  const foreignKeyNames = new Set<string>();
  for (const table of desired) {
    q(table.name);
    const native = tables.find((r) => r.TABLE_NAME === table.name);
    // A differently-cased native table must never turn into a second table.
    if (!native && tables.some((r) => text(r, 'TABLE_NAME').toLowerCase() === table.name.toLowerCase()))
      refuse('table case collision');
    const columnRows = facts.columns.filter((r) => r.TABLE_NAME === table.name);
    const indexRows = facts.indexes.filter((r) => r.TABLE_NAME === table.name);
    const fkRows = facts.foreignKeys.filter((r) => r.TABLE_NAME === table.name);
    if (native && !columnRows.length) refuse(`missing native columns on ${table.name}`);
    for (const row of columnRows) {
      const col = table.columns.find((c) => c.name === row.COLUMN_NAME);
      if (!col) refuse(`column removal ${table.name}.${text(row, 'COLUMN_NAME')}`);
      // A catalog '?' may actually represent a supplementary Unicode default.
      // Even desired '?' must not silently equate to that lossy native fact.
      if (col.text && text(row, 'COLUMN_DEFAULT').includes('?'))
        refuse(`ambiguous native VARCHAR default ${table.name}.${col.name}`);
      if (
        text(row, 'COLUMN_TYPE').toLowerCase() !== col.type ||
        row.IS_NULLABLE !== (col.nullable ? 'YES' : 'NO') ||
        text(row, 'EXTRA').toLowerCase() !== (col.auto ? 'auto_increment' : '') ||
        text(row, 'GENERATION_EXPRESSION') ||
        text(row, 'COLUMN_COMMENT') ||
        (row.COLUMN_DEFAULT == null ? null : String(row.COLUMN_DEFAULT)) !== col.defaultValue ||
        (col.text
          ? row.CHARACTER_SET_NAME !== 'utf8mb4' || row.COLLATION_NAME !== MYSQL_SCHEMA_COLLATION
          : row.COLLATION_NAME != null)
      )
        refuse(`changed or ambiguous native column ${table.name}.${col.name}`);
    }
    const nativeIndexes: MysqlIndex[] = [];
    for (const row of indexRows) {
      const name = text(row, 'INDEX_NAME');
      if (
        !row.COLUMN_NAME ||
        row.SUB_PART != null ||
        row.EXPRESSION != null ||
        row.COLLATION !== 'A' ||
        row.INDEX_TYPE !== 'BTREE' ||
        row.IS_VISIBLE !== 'YES' ||
        text(row, 'INDEX_COMMENT')
      )
        refuse(`expression, prefix, descending, invisible or unsupported index ${table.name}.${name}`);
      let index = nativeIndexes.find((idx) => idx.name === name);
      if (!index) {
        index = { name, columns: [], unique: Number(row.NON_UNIQUE) === 0, explicit: true };
        nativeIndexes.push(index);
      }
      if (Number(row.SEQ_IN_INDEX) !== index.columns.length + 1 || index.unique !== (Number(row.NON_UNIQUE) === 0))
        refuse('incomplete native index facts');
      index.columns.push(String(row.COLUMN_NAME));
    }
    const primary = nativeIndexes.find((idx) => idx.name === 'PRIMARY');
    if (native && !same(primary?.columns ?? [], table.primary)) refuse(`primary key change on ${table.name}`);
    const remaining = nativeIndexes.filter((idx) => idx.name !== 'PRIMARY');
    const missing: MysqlIndex[] = [];
    for (const index of table.indexes) {
      const byName = remaining.find((idx) => idx.name.toLowerCase() === index.name.toLowerCase());
      if (byName && !equalIndex(byName, index)) refuse(`index definition change ${table.name}.${index.name}`);
      const match = byName ?? (!index.explicit ? remaining.find((idx) => equalIndex(idx, index)) : undefined);
      if (match) remaining.splice(remaining.indexOf(match), 1);
      else missing.push(index);
    }
    if (remaining.length) refuse(`index removal or unmodeled index ${table.name}.${remaining[0]!.name}`);
    if (!native) {
      const definitions = [...table.columns.map((c) => c.sql)];
      if (table.primary.length) definitions.push(`PRIMARY KEY (${table.primary.map(q).join(', ')})`);
      definitions.push(...table.indexes.map(mysqlIndexDefinition));
      steps.push({
        kind: 'create-table',
        table: table.name,
        sql: `CREATE TABLE ${q(table.name)} (\n  ${definitions.join(',\n  ')}\n) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARACTER SET utf8mb4 COLLATE ${MYSQL_SCHEMA_COLLATION};`,
        down: `DROP TABLE ${q(table.name)};`,
      });
    } else {
      for (const column of table.columns) {
        if (columnRows.some((r) => r.COLUMN_NAME === column.name)) continue;
        if (columnRows.some((r) => text(r, 'COLUMN_NAME').toLowerCase() === column.name.toLowerCase()))
          refuse('column case collision');
        if (column.auto || table.primary.includes(column.name) || (!column.nullable && column.defaultValue === null))
          refuse(
            `new ${table.name}.${column.name} must be nullable or have a supported non-NULL literal default, and cannot change the primary key`,
          );
        steps.push({
          kind: 'add-column',
          table: table.name,
          sql: `ALTER TABLE ${q(table.name)} ADD COLUMN ${column.sql};`,
          down: `ALTER TABLE ${q(table.name)} DROP COLUMN ${q(column.name)};`,
        });
      }
      for (const index of missing)
        steps.push({
          kind: 'add-index',
          table: table.name,
          sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${q(index.name)} ON ${q(table.name)} (${index.columns.map(q).join(', ')});`,
          down: `DROP INDEX ${q(index.name)} ON ${q(table.name)};`,
        });
    }
    const nativeFks = new Map<string, MysqlCatalogRow[]>();
    for (const row of fkRows) {
      const name = text(row, 'CONSTRAINT_NAME');
      nativeFks.set(name, [...(nativeFks.get(name) ?? []), row]);
    }
    for (const fk of table.foreignKeys) {
      if (foreignKeyNames.has(fk.name.toLowerCase())) refuse('foreign key name collision');
      foreignKeyNames.add(fk.name.toLowerCase());
      const match = [...nativeFks].find(([, rows]) => rows.length === 1 && rows[0]!.COLUMN_NAME === fk.column);
      if (match) {
        const row = match[1][0]!;
        const action = (key: string) => text(row, key).toLowerCase().replace('no action', 'restrict');
        if (
          Number(row.ORDINAL_POSITION) !== 1 ||
          row.REFERENCED_TABLE_SCHEMA !== snapshot.database ||
          row.REFERENCED_TABLE_NAME !== fk.targetTable ||
          row.REFERENCED_COLUMN_NAME !== fk.targetColumn ||
          action('DELETE_RULE') !== fk.onDelete ||
          action('UPDATE_RULE') !== fk.onUpdate
        )
          refuse(`foreign key change ${table.name}.${fk.column}`);
        nativeFks.delete(match[0]);
      } else {
        if (facts.foreignKeys.some((r) => text(r, 'CONSTRAINT_NAME').toLowerCase() === fk.name.toLowerCase()))
          refuse('native foreign key name collision');
        fkSteps.push({
          kind: 'add-foreign-key',
          table: table.name,
          sql: `ALTER TABLE ${q(table.name)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${q(fk.column)}) REFERENCES ${q(fk.targetTable)} (${q(fk.targetColumn)}) ON DELETE ${fk.onDelete.toUpperCase()} ON UPDATE ${fk.onUpdate.toUpperCase()};`,
          down: `ALTER TABLE ${q(table.name)} DROP FOREIGN KEY ${q(fk.name)};`,
        });
      }
    }
    if (nativeFks.size) refuse(`foreign key removal or composite/ambiguous reference on ${table.name}`);
  }
  steps.push(...fkSteps);
  return {
    database: snapshot.database,
    fingerprint: snapshot.fingerprint,
    steps,
    up: steps.map((step) => step.sql).join('\n'),
    down: [...steps]
      .reverse()
      .map((step) => step.down)
      .join('\n'),
    requiresAlterConsent: steps.some((step) => step.sql.startsWith('ALTER TABLE')),
  };
}

/** Clean migration history first; no directory/file creation until the entire plan succeeds. */
export async function createMysqlSchemaMigration(
  connectionString: string,
  migrationsDir: string,
  name: string,
  schema: SchemaDef,
): Promise<{ plan: MysqlSchemaPlan; file?: MigrationFile }> {
  // Validate desired declarations before opening any connection.
  modelMysqlSchema(schema);
  const history = await inspectMysqlMigrationDeploy(connectionString, migrationsDir);
  if (history.dirty || history.pending.length || history.mismatches.length || listIgnoredSqlFiles(migrationsDir).length)
    refuse(
      'migration history is dirty, pending, drifted, missing or contains ignored SQL files; reconcile it before scaffolding',
    );
  const plan = planMysqlSchema(schema, await inspectMysqlSchema(connectionString));
  if (!plan.steps.length) return { plan };
  const file = createMigration(
    migrationsDir,
    name,
    { up: plan.up, down: plan.down },
    {
      header: `-- MySQL catalog fingerprint: ${plan.fingerprint}\n-- Review UP and destructive DOWN before execution. DOWN can delete data.\n-- Every ALTER requires --allow-destructive, including additive ALTER.\n-- MySQL DDL implicitly commits; failures require journal inspection and manual recovery.\n-- Snapshot comparison is advisory; concurrent schema/data changes can invalidate this plan.`,
    },
  );
  return { plan, file };
}
