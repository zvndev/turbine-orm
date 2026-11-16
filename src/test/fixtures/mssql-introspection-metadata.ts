/** Observable catalog facts, with BIT values in the boolean shape delivered by tedious. */
import assert from 'node:assert/strict';
import type { MssqlRowExecutor } from '../../mssql.js';

export type CatalogRow = Record<string, unknown>;
export function catalogColumn(table: string, column: string, extra: CatalogRow = {}): CatalogRow {
  return {
    TABLE_NAME: table,
    COLUMN_NAME: column,
    DATA_TYPE: 'int',
    IS_NULLABLE: 'NO',
    HAS_DEFAULT: false,
    IS_COMPUTED: false,
    GENERATED_ALWAYS_TYPE: 0,
    IS_HIDDEN: false,
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: 10,
    NUMERIC_SCALE: 0,
    DATETIME_PRECISION: null,
    COLLATION_NAME: null,
    ...extra,
  };
}
export function catalogIndex(table: string, name: string, columns: string[], extra: CatalogRow = {}): CatalogRow[] {
  return columns.map((column, i) => ({
    TABLE_NAME: table,
    INDEX_NAME: name,
    COLUMN_NAME: column,
    SEQ: i + 1,
    IS_UNIQUE: true,
    IS_INCLUDED: false,
    IS_DESCENDING: false,
    HAS_FILTER: false,
    IS_DISABLED: false,
    IS_HYPOTHETICAL: false,
    TYPE_DESC: 'NONCLUSTERED',
    ...extra,
  }));
}
export function catalogFixture() {
  const tables = [
    'parents',
    'profiles',
    'primary_profiles',
    'filtered_profiles',
    'computed_profiles',
    'superset_profiles',
    'disabled_profiles',
    'hypothetical_profiles',
    'composite_parents',
    'composite_links',
    'composite_unique_links',
    'text_parents',
    'text_profiles',
    'uncertain_profiles',
    'different_profiles',
    'generated_records',
    'mandatory_keys',
  ];
  const columns: CatalogRow[] = [];
  const primary: CatalogRow[] = [];
  const foreign: CatalogRow[] = [];
  const indexes: CatalogRow[] = [];
  const identities: CatalogRow[] = [];
  /** Explicit CHECK and key constraint names, `{ TABLE_NAME, CONSTRAINT_NAME }`. */
  const constraints: CatalogRow[] = [];
  const pk = (table: string, names: string[]) =>
    names.forEach((name, i) => {
      primary.push({
        TABLE_NAME: table,
        COLUMN_NAME: name,
        ORDINAL_POSITION: i + 1,
      });
    });
  const fk = (table: string, child: string[], parent: string, target: string[], extra: CatalogRow = {}) =>
    child.forEach((name, i) => {
      foreign.push({
        TABLE_NAME: table,
        COLUMN_NAME: name,
        REFERENCED_TABLE_NAME: parent,
        REFERENCED_COLUMN_NAME: target[i],
        TABLE_SCHEMA: 'app',
        REFERENCED_TABLE_SCHEMA: 'app',
        CONSTRAINT_NAME: `FK_${table}`,
        ORDINAL_POSITION: i + 1,
        ...extra,
      });
    });
  columns.push(catalogColumn('parents', 'id'));
  pk('parents', ['id']);
  for (const table of tables.slice(1, 8)) {
    columns.push(
      catalogColumn(table, 'id'),
      catalogColumn(table, 'parent_id', { IS_NULLABLE: 'YES' }),
      catalogColumn(table, 'scope'),
      catalogColumn(table, 'label', {
        DATA_TYPE: 'nvarchar',
        IS_NULLABLE: 'YES',
        CHARACTER_MAXIMUM_LENGTH: 50,
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        COLLATION_NAME: 'Latin1_General_100_CS_AS',
      }),
    );
    pk(table, table === 'primary_profiles' ? ['parent_id'] : ['id']);
    fk(table, ['parent_id'], 'parents', ['id']);
  }
  indexes.push(
    ...catalogIndex('profiles', 'UQ_profiles_parent', ['parent_id']),
    ...catalogIndex('profiles', 'UQ_profiles_parent', ['label'], { IS_INCLUDED: true, SEQ: 0 }),
    ...catalogIndex('filtered_profiles', 'UQ_filtered', ['parent_id'], { HAS_FILTER: true }),
    ...catalogIndex('filtered_profiles', 'UQ_filtered_compound', ['parent_id', 'scope'], { HAS_FILTER: true }),
    ...catalogIndex('computed_profiles', 'UQ_computed', ['parent_id', 'normalized']),
    ...catalogIndex('superset_profiles', 'UQ_superset', ['parent_id', 'scope']),
    ...catalogIndex('disabled_profiles', 'UQ_disabled', ['parent_id'], { IS_DISABLED: true }),
    ...catalogIndex('hypothetical_profiles', 'UQ_hypothetical', ['parent_id'], { IS_HYPOTHETICAL: true }),
  );
  columns.push(catalogColumn('computed_profiles', 'normalized', { IS_COMPUTED: true }));
  const text = {
    DATA_TYPE: 'nvarchar',
    CHARACTER_MAXIMUM_LENGTH: 20,
    NUMERIC_PRECISION: null,
    NUMERIC_SCALE: null,
    COLLATION_NAME: 'Latin1_General_100_CS_AS',
  };
  for (const table of ['composite_parents', 'composite_links']) {
    columns.push(catalogColumn(table, 'tenant_id'), catalogColumn(table, 'code', text));
    pk(table, table === 'composite_parents' ? ['code', 'tenant_id'] : ['tenant_id', 'code']);
  }
  fk('composite_links', ['tenant_id', 'code'], 'composite_parents', ['tenant_id', 'code']);
  columns.push(
    catalogColumn('composite_unique_links', 'id'),
    catalogColumn('composite_unique_links', 'tenant_id'),
    catalogColumn('composite_unique_links', 'code', text),
  );
  pk('composite_unique_links', ['id']);
  fk('composite_unique_links', ['tenant_id', 'code'], 'composite_parents', ['tenant_id', 'code']);
  indexes.push(...catalogIndex('composite_unique_links', 'UQ_composite_link', ['code', 'tenant_id']));

  columns.push(catalogColumn('text_parents', 'code', text));
  pk('text_parents', ['code']);
  for (const table of ['text_profiles', 'uncertain_profiles', 'different_profiles']) {
    columns.push(
      catalogColumn(table, 'id'),
      catalogColumn(table, 'parent_code', {
        ...text,
        ...(table === 'uncertain_profiles' ? { COLLATION_NAME: null } : {}),
        ...(table === 'different_profiles' ? { COLLATION_NAME: 'Latin1_General_100_CI_AS' } : {}),
      }),
    );
    pk(table, ['id']);
    fk(table, ['parent_code'], 'text_parents', ['code']);
    indexes.push(...catalogIndex(table, `UQ_${table}`, ['parent_code']));
  }
  fk('profiles', ['scope'], 'parents', ['id'], { CONSTRAINT_NAME: 'FK_external', REFERENCED_TABLE_SCHEMA: 'external' });
  columns.push(
    catalogColumn('generated_records', 'id'),
    catalogColumn('generated_records', 'quantity'),
    catalogColumn('generated_records', 'optional_text', { ...text, IS_NULLABLE: 'YES' }),
    catalogColumn('generated_records', 'default_count', { HAS_DEFAULT: true }),
    catalogColumn('generated_records', 'virtual_total', { IS_COMPUTED: true, IS_NULLABLE: 'YES' }),
    catalogColumn('generated_records', 'stored_total', { IS_COMPUTED: true, IS_NULLABLE: 'YES' }),
    catalogColumn('generated_records', 'version', { DATA_TYPE: 'timestamp' }),
    catalogColumn('generated_records', 'period_start', { DATA_TYPE: 'datetime2', GENERATED_ALWAYS_TYPE: 1 }),
    catalogColumn('generated_records', 'hidden_period', {
      DATA_TYPE: 'datetime2',
      GENERATED_ALWAYS_TYPE: 2,
      IS_HIDDEN: true,
    }),
    catalogColumn('mandatory_keys', 'code', text),
  );
  pk('generated_records', ['id']);
  pk('mandatory_keys', ['code']);
  identities.push({ TABLE_NAME: 'generated_records', COLUMN_NAME: 'id' });
  const queries: string[] = [];
  const exec: MssqlRowExecutor = async (sql, params) => {
    assert.deepEqual(params, ['app'], 'namespace must be a bound value in every catalog query');
    queries.push(sql);
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return tables.map((TABLE_NAME) => ({ TABLE_NAME }));
    if (sql.includes('sys.identity_columns')) return identities;
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return columns;
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) return primary;
    if (sql.includes('sys.foreign_keys')) return foreign;
    if (sql.includes('sys.indexes')) return indexes;
    if (sql.includes('sys.check_constraints')) return constraints;
    assert.fail('Unexpected catalog query');
  };
  return { exec, tables, columns, primary, foreign, indexes, identities, constraints, queries };
}
