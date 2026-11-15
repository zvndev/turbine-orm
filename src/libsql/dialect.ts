import { createPortableSqliteDialect } from '../d1/sqlite-dialect.js';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError } from '../errors.js';
import { decodeBoolean, decodeJson } from './values.js';

const sqliteDialect = createPortableSqliteDialect({ declaredTypes: () => false });

function unavailable(): never {
  throw new UnsupportedFeatureError(
    'Native schema migrations and rebuild',
    'libsql',
    'The node:sqlite migration runner requires native handle authorization and cannot run on a libSQL client. Apply explicitly reviewed DDL separately.',
  );
}

/** SQLite SQL generation with libSQL result decoding and explicit lifecycle limits. */
export const libsqlDialect: Dialect = {
  ...sqliteDialect,
  // Keep SQLite lexical rules; transport identity is the optional entry's contract.
  name: 'sqlite',
  jsonWireRule(type) {
    // Never call the node:sqlite declared-type probe. Schema-aware scalar
    // decoding handles these values on direct and nested relation paths.
    if (/bool|^jsonb?$/i.test(type)) return undefined;
    if (/^(?:bytea|blob)$/i.test(type)) {
      const rule = sqliteDialect.jsonWireRule!('BLOB')!;
      return { ...rule, sql: (ref) => `CASE WHEN ${ref} IS NULL THEN NULL ELSE hex(${ref}) END` };
    }
    return sqliteDialect.jsonWireRule?.(type);
  },
  decodeColumnValue(type) {
    if (/bool/i.test(type)) return decodeBoolean;
    if (/^jsonb?$/i.test(type)) return decodeJson;
    return undefined;
  },
  // biome-ignore lint/correctness/useYield: refusal must occur on iterator.next() so the shared stream finally releases its lease.
  async *openStream() {
    throw new UnsupportedFeatureError(
      'Native incremental streaming',
      'libsql',
      '@libsql/client execute() buffers its result. Use bounded findMany queries; no incremental streaming is provided.',
    );
  },
  introspector: {
    async introspect() {
      throw new UnsupportedFeatureError(
        'Native catalog introspection',
        'libsql',
        'Use code-first schemaDefToMetadata and generateLibsqlFiles; native catalog introspection is not implemented.',
      );
    },
  },
  buildMigrationTrackingTable: unavailable,
  buildMigrationSelectApplied: unavailable,
  buildMigrationUpdateChecksum: unavailable,
  buildMigrationInsertApplied: unavailable,
  buildMigrationDeleteApplied: unavailable,
};
