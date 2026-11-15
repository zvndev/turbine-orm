import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

/** Deterministic declarations, including SQL Server fixtures, not native evidence. */
export function nativeIntegerSchema(target: 'postgresql' | 'sqlite' | 'mysql' | 'mssql') {
  const schema = schemaDefToMetadata(
    defineSchema({
      accounts: {
        id: { type: 'bigint', primaryKey: true },
        alternate: { type: 'bigint', unique: true },
        label: { type: 'text', notNull: true },
      },
      entries: {
        id: { type: 'integer', primaryKey: true },
        accountId: { type: 'bigint', notNull: true, references: 'accounts.id' },
        value: { type: 'bigint', notNull: true },
        optional: { type: 'bigint' },
        narrow: { type: 'smallint', notNull: true },
        amount: { type: 'numeric', notNull: true },
        fraction: { type: 'double', notNull: true },
        enabled: { type: 'boolean', notNull: true },
        computed: { type: 'bigint', notNull: true },
        declared: { type: 'bigint', tsType: 'bigint' },
      },
    }),
  );
  const spellings: Record<string, string> =
    target === 'sqlite'
      ? { int8: 'BIGINT', int4: 'INT2', int2: 'TINYINT', numeric: 'NUMERIC', float8: 'REAL', bool: 'BOOLEAN' }
      : target === 'mysql'
        ? { int8: 'bigint', int4: 'int', int2: 'smallint', numeric: 'decimal', float8: 'double', bool: 'tinyint(1)' }
        : target === 'mssql'
          ? { int8: 'bigint', int4: 'int', int2: 'smallint', numeric: 'decimal', float8: 'float', bool: 'bit' }
          : {};
  for (const table of Object.values(schema.tables)) {
    for (const col of table.columns) {
      if (spellings[col.pgType]) col.dialectType = spellings[col.pgType];
      if (col.name === 'computed') {
        col.isGeneratedStored = true;
        col.generationExpression = 'value';
      }
    }
  }
  return schema;
}
