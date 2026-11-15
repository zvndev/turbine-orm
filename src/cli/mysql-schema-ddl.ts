/** Strict SchemaDef subset rendered as native MySQL DDL, independent of PG generation. */
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';
import { camelToSnake } from '../schema.js';
import type { ColumnConfig, SchemaDef } from '../schema-builder.js';

export const MYSQL_SCHEMA_COLLATION = 'utf8mb4_0900_bin';
export interface MysqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  auto: boolean;
  defaultValue: string | null;
  defaultSql: string | null;
  text: boolean;
  sql: string;
}
export interface MysqlIndex {
  name: string;
  columns: string[];
  unique: boolean;
  explicit: boolean;
}
export interface MysqlForeignKey {
  name: string;
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: string;
  onUpdate: string;
}
export interface MysqlTable {
  name: string;
  columns: MysqlColumn[];
  primary: string[];
  indexes: MysqlIndex[];
  foreignKeys: MysqlForeignKey[];
}

export function mysqlSchemaRefusal(reason: string): never {
  throw new ValidationError(
    `MySQL schema comparison refused: ${reason}. Use a reviewed native SQL migration; removals, ambiguous definitions and rebuilds are not modeled.`,
  );
}

export function quoteMysqlSchemaName(name: string): string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 64 ||
    /[.\\/\uD800-\uDFFF]/u.test(name) ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /\s$/.test(name)
  )
    mysqlSchemaRefusal('invalid native identifier');
  return `\`${name.replace(/`/g, '``')}\``;
}

function generatedName(prefix: string, ...parts: string[]): string {
  const full = [prefix, ...parts].join('_');
  return full.length <= 64
    ? full
    : `${full.slice(0, 47)}_${createHash('sha256').update(full).digest('hex').slice(0, 16)}`;
}

function defaultFor(
  column: ColumnConfig,
  type: string,
  nullable: boolean,
): { value: string | null; sql: string | null } {
  const raw = column.defaultValue?.trim();
  if (raw == null) return { value: null, sql: null };
  if (/^null$/i.test(raw)) {
    if (!nullable) mysqlSchemaRefusal('NULL default for a NOT NULL column');
    return { value: null, sql: 'NULL' };
  }
  if (['smallint', 'int', 'bigint', 'tinyint(1)'].includes(type)) {
    const value = /^true$/i.test(raw) ? '1' : /^false$/i.test(raw) ? '0' : raw;
    if (!/^-?(?:0|[1-9]\d*)$/.test(value))
      mysqlSchemaRefusal('only integer/boolean literal defaults are supported for numeric columns');
    const n = BigInt(value);
    const bits = type === 'smallint' ? 16n : type === 'bigint' ? 64n : type === 'int' ? 32n : 2n;
    if ((type === 'tinyint(1)' && n !== 0n && n !== 1n) || n < -(2n ** (bits - 1n)) || n >= 2n ** (bits - 1n))
      mysqlSchemaRefusal('integer default outside the modeled native range');
    return { value: n.toString(), sql: n.toString() };
  }
  // No backslashes/control characters: the exact same bytes in both MySQL modes.
  if (
    type.startsWith('varchar(') &&
    /^'(?:[^'\\]|'')*'$/u.test(raw) &&
    ![...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    const value = raw.slice(1, -1).replace(/''/g, "'");
    // MySQL 8's utf8mb3 COLUMN_DEFAULT catalog can replace supplementary
    // characters with '?'. Refuse both spellings instead of emitting a schema
    // that cannot be compared safely on its next introspection.
    if (
      value.includes('?') ||
      [...value].some((c) => {
        const code = c.codePointAt(0)!;
        return code > 0xffff || (code >= 0xd800 && code <= 0xdfff);
      })
    )
      mysqlSchemaRefusal(
        'ambiguous VARCHAR default: question marks and supplementary or invalid Unicode are not modeled',
      );
    if ([...value].length > Number(/^varchar\((\d+)\)$/.exec(type)![1]))
      mysqlSchemaRefusal('varchar default exceeds its length');
    return { value, sql: `'${value.replace(/'/g, "''")}'` };
  }
  mysqlSchemaRefusal('default expressions or literals unsupported for this native type');
}

function modelColumn(field: string, c: ColumnConfig, primary: string[]): MysqlColumn {
  const name = camelToSnake(field);
  quoteMysqlSchemaName(name);
  if (c.isArray || c.check || c.enumName || c.vectorDimensions || c.updatedAt)
    mysqlSchemaRefusal(`unsupported column feature on ${name}`);
  if (c.isNullable && (c.isNotNull || primary.includes(name)))
    mysqlSchemaRefusal(`contradictory nullability on ${name}`);
  const types: Record<string, string> = {
    SERIAL: 'int',
    BIGSERIAL: 'bigint',
    INTEGER: 'int',
    SMALLINT: 'smallint',
    BIGINT: 'bigint',
    BOOLEAN: 'tinyint(1)',
    TEXT: 'text',
    VARCHAR: 'varchar',
    DATE: 'date',
    JSONB: 'json',
  };
  let type = types[c.type];
  if (!type) mysqlSchemaRefusal(`unsupported type ${c.type} on ${name}`);
  if (type === 'varchar') {
    if (!Number.isSafeInteger(c.maxLength) || c.maxLength! < 1 || c.maxLength! > 16383)
      mysqlSchemaRefusal(`varchar ${name} requires an explicit length in 1..16383`);
    type += `(${c.maxLength})`;
  } else if (c.maxLength != null) mysqlSchemaRefusal(`length on non-varchar column ${name}`);
  const auto = c.type === 'SERIAL' || c.type === 'BIGSERIAL';
  const nullable = !primary.includes(name) && !c.isNotNull;
  if (auto && (primary.length !== 1 || primary[0] !== name || c.defaultValue != null || c.isNullable))
    mysqlSchemaRefusal(`auto increment ${name} must be the sole primary key without a default`);
  const d = defaultFor(c, type, nullable);
  const text = type === 'text' || type.startsWith('varchar(');
  const sql = `${quoteMysqlSchemaName(name)} ${type.toUpperCase()}${text ? ` CHARACTER SET utf8mb4 COLLATE ${MYSQL_SCHEMA_COLLATION}` : ''}${nullable ? ' NULL' : ' NOT NULL'}${auto ? ' AUTO_INCREMENT' : ''}${d.sql !== null ? ` DEFAULT ${d.sql}` : ''}`;
  return { name, type, nullable, auto, text, defaultValue: d.value, defaultSql: d.sql, sql };
}

function action(value: string | null): string {
  const result = (value ?? 'restrict').toLowerCase();
  if (!['cascade', 'restrict', 'set null', 'no action'].includes(result))
    mysqlSchemaRefusal('unsupported foreign key action');
  return result === 'no action' ? 'restrict' : result;
}

export function modelMysqlSchema(schema: SchemaDef): MysqlTable[] {
  if (!schema?.tables || typeof schema.tables !== 'object' || Array.isArray(schema.tables))
    mysqlSchemaRefusal('expected a SchemaDef');
  if (Object.keys(schema.enums ?? {}).length) mysqlSchemaRefusal('schema-level enums');
  const tables: MysqlTable[] = [];
  const aliases = new Map<string, string>();
  for (const [accessor, table] of Object.entries(schema.tables)) {
    quoteMysqlSchemaName(table.name);
    if (/^_(?:turbine|prisma)_/i.test(table.name)) mysqlSchemaRefusal('reserved bookkeeping table');
    if (aliases.has(table.name) || tables.some((t) => t.name.toLowerCase() === table.name.toLowerCase()))
      mysqlSchemaRefusal('duplicate or case-colliding table names');
    aliases.set(accessor, table.name);
    const columns = Object.entries(table.columns);
    if (!columns.length || table.checks?.length || table.manyToMany?.length)
      mysqlSchemaRefusal(`empty table or unsupported constraints on ${table.name}`);
    const primary = table.primaryKey
      ? table.primaryKey.map(camelToSnake)
      : columns.filter(([, c]) => c.isPrimaryKey).map(([f]) => camelToSnake(f));
    const model: MysqlTable = {
      name: table.name,
      columns: columns.map(([f, c]) => modelColumn(f, c, primary)),
      primary,
      indexes: [],
      foreignKeys: [],
    };
    if (new Set(model.columns.map((c) => c.name.toLowerCase())).size !== columns.length)
      mysqlSchemaRefusal('duplicate column names');
    const checkKey = (keys: string[]) => {
      if (!keys.length || new Set(keys).size !== keys.length) mysqlSchemaRefusal('empty or duplicate key columns');
      let bytes = 0;
      for (const key of keys) {
        const col = model.columns.find((c) => c.name === key);
        if (!col || col.type === 'text' || col.type === 'json' || col.type === 'date')
          mysqlSchemaRefusal(`unsupported key column ${key}`);
        bytes += col.type.startsWith('varchar(') ? Number(col.type.slice(8, -1)) * 4 : 8;
      }
      if (bytes > 3072) mysqlSchemaRefusal('key exceeds the supported InnoDB byte limit');
    };
    if (primary.length) checkKey(primary);
    for (const [field, c] of columns) {
      const name = camelToSnake(field);
      if (c.isUnique)
        model.indexes.push({
          name: generatedName('uq', table.name, name),
          columns: [name],
          unique: true,
          explicit: false,
        });
      if (c.referencesTarget) {
        const target = /^([^.]+)\.([^.]+)$/.exec(c.referencesTarget);
        if (!target) mysqlSchemaRefusal(`invalid reference on ${name}`);
        const onDelete = action(c.onDelete),
          onUpdate = action(c.onUpdate);
        if (
          (onDelete === 'set null' || onUpdate === 'set null') &&
          !model.columns.find((col) => col.name === name)!.nullable
        )
          mysqlSchemaRefusal('SET NULL requires a nullable foreign key');
        model.foreignKeys.push({
          name: generatedName('fk', table.name, name),
          column: name,
          targetTable: target[1]!,
          targetColumn: camelToSnake(target[2]!),
          onDelete,
          onUpdate,
        });
      }
    }
    for (const idx of table.indexes ?? []) {
      if (!('columns' in idx)) mysqlSchemaRefusal('expression/doc-field indexes');
      const keys = idx.columns.map(camelToSnake);
      model.indexes.push({
        name: idx.name ?? generatedName('idx', table.name, ...keys),
        columns: keys,
        unique: idx.unique === true,
        explicit: idx.name !== undefined,
      });
    }
    for (const fk of model.foreignKeys) {
      if (primary[0] !== fk.column && !model.indexes.some((idx) => idx.columns[0] === fk.column))
        model.indexes.push({
          name: generatedName('idx', table.name, fk.column, 'fk'),
          columns: [fk.column],
          unique: false,
          explicit: false,
        });
    }
    const names = new Set<string>(['primary']);
    for (const idx of model.indexes) {
      quoteMysqlSchemaName(idx.name);
      if (names.has(idx.name.toLowerCase())) mysqlSchemaRefusal('duplicate index name');
      names.add(idx.name.toLowerCase());
      checkKey(idx.columns);
    }
    tables.push(model);
  }
  for (const table of tables)
    for (const fk of table.foreignKeys) {
      fk.targetTable = aliases.get(fk.targetTable) ?? fk.targetTable;
      const target = tables.find((t) => t.name === fk.targetTable);
      const col = target?.columns.find((c) => c.name === fk.targetColumn);
      const source = table.columns.find((c) => c.name === fk.column)!;
      if (
        !target ||
        !col ||
        source.type !== col.type ||
        source.text !== col.text ||
        (!(target.primary.length === 1 && target.primary[0] === col.name) &&
          !target.indexes.some((idx) => idx.unique && idx.columns.length === 1 && idx.columns[0] === col.name))
      )
        mysqlSchemaRefusal(
          `foreign key ${table.name}.${fk.column} requires an in-schema, identical-type, single-column unique target`,
        );
    }
  return tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function mysqlIndexDefinition(index: MysqlIndex): string {
  return `${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteMysqlSchemaName(index.name)} (${index.columns.map(quoteMysqlSchemaName).join(', ')})`;
}
