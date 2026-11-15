/** Owned, read-only catalog snapshots for conservative MySQL schema planning. */
import { createHash } from 'node:crypto';
import { ValidationError } from '../errors.js';
import { DEFAULT_EXCLUDED_TABLES } from '../introspect.js';
import { introspectMysqlWith } from '../mysql.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import type { SchemaMetadata } from '../schema.js';
import { mysqlDatabaseFromUrl } from './config.js';
import { quoteMysqlSchemaName } from './mysql-schema-ddl.js';

export type MysqlCatalogRow = Record<string, unknown>;
export interface MysqlSchemaFacts {
  tables: MysqlCatalogRow[];
  columns: MysqlCatalogRow[];
  indexes: MysqlCatalogRow[];
  foreignKeys: MysqlCatalogRow[];
  unsupported: MysqlCatalogRow[];
}
export interface MysqlSchemaSnapshot {
  database: string;
  version: string;
  metadata: SchemaMetadata;
  facts: MysqlSchemaFacts;
  fingerprint: string;
}

export const MYSQL_SCHEMA_EXCLUDED = [...DEFAULT_EXCLUDED_TABLES, '_turbine_migration_state'];

interface Connection {
  query(sql: string): Promise<[unknown, unknown]>;
  execute(sql: string, values: unknown[] | Record<string, unknown>): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy(): void;
}

/** No query options, borrowed handles, session SETs or mutable shared pools. */
export async function inspectMysqlSchema(connectionString: string): Promise<MysqlSchemaSnapshot> {
  const database = mysqlDatabaseFromUrl(connectionString);
  const url = new URL(connectionString);
  let peer: { createConnection(options: Record<string, unknown>): Promise<Connection> };
  try {
    peer = (await importOptionalPeer('mysql2/promise')) as typeof peer;
  } catch {
    throw new ValidationError('MySQL schema comparison requires the optional mysql2 peer.');
  }
  const connection = await peer.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    namedPlaceholders: true,
    multipleStatements: false,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10_000,
  });
  const rows = async (sql: string, values?: unknown[] | Record<string, unknown>): Promise<MysqlCatalogRow[]> => {
    const [result] = values === undefined ? await connection.query(sql) : await connection.execute(sql, values);
    if (!Array.isArray(result)) throw new ValidationError('Invalid MySQL schema catalog response.');
    return result as MysqlCatalogRow[];
  };
  try {
    const [probe] = await rows(`SELECT DATABASE() AS db, VERSION() AS version,
      @@lower_case_table_names AS lower_case_table_names, @@foreign_key_checks AS foreign_key_checks, @@innodb_page_size AS page_size`);
    const version = String(probe?.version ?? '');
    const match = /^(8)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
    if (!match || /mariadb/i.test(version) || (Number(match[2]) === 0 && Number(match[3]) < 17))
      throw new ValidationError('MySQL schema comparison requires native MySQL 8.0.17+ in the 8.x series.');
    if (
      probe?.db !== database ||
      Number(probe.lower_case_table_names) !== 0 ||
      Number(probe.foreign_key_checks) !== 1 ||
      Number(probe.page_size) < 16384
    )
      throw new ValidationError(
        'MySQL schema comparison requires the selected database, case-sensitive table names, enabled foreign keys and InnoDB pages of at least 16 KiB.',
      );
    // Table-level privileges can hide entire tables; TRIGGER/SHOW VIEW metadata
    // has its own visibility rules. Refuse unless effective grants prove coverage.
    const grants = (await rows('SHOW GRANTS')).flatMap((row) => Object.values(row).map(String));
    assertMysqlCatalogVisibility(grants, database);
    await connection.query('START TRANSACTION READ ONLY');
    const capture = async (): Promise<MysqlSchemaFacts> => ({
      tables: await rows(
        `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, ROW_FORMAT, CREATE_OPTIONS, TABLE_COMMENT
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [database],
      ),
      columns: await rows(
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
        EXTRA, GENERATION_EXPRESSION, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [database],
      ),
      indexes: await rows(
        `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
        SUB_PART, EXPRESSION, COLLATION, INDEX_TYPE, IS_VISIBLE, INDEX_COMMENT
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [database],
      ),
      foreignKeys: await rows(
        `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
        k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [database],
      ),
      unsupported: await rows(
        `SELECT TABLE_NAME, 'CHECK' AS KIND FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = ? AND CONSTRAINT_TYPE = 'CHECK'
        UNION ALL SELECT EVENT_OBJECT_TABLE AS TABLE_NAME, 'TRIGGER' AS KIND FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?
        UNION ALL SELECT TABLE_NAME, 'PARTITION' AS KIND FROM information_schema.PARTITIONS
        WHERE TABLE_SCHEMA = ? AND PARTITION_NAME IS NOT NULL ORDER BY TABLE_NAME, KIND`,
        [database, database, database],
      ),
    });
    const facts = await capture();
    // Reuse the stable general introspection seam. Native safety facts above do
    // not derive a second set of client metadata or parse index display strings.
    const metadata = await introspectMysqlWith(
      (sql, params) => rows(sql, Object.fromEntries(params.map((value, i) => [`p${i + 1}`, value]))),
      database,
      { exclude: MYSQL_SCHEMA_EXCLUDED, logger: {} },
    );
    // MySQL dictionary queries are not an atomic DDL snapshot. Detect observed
    // concurrent changes; execution must still review/revalidate current state.
    const serialized = JSON.stringify(facts);
    if (serialized !== JSON.stringify(await capture()))
      throw new ValidationError('MySQL catalog changed during comparison; retry after schema changes stop.');
    await connection.query('ROLLBACK');
    return { database, version, metadata, facts, fingerprint: createHash('sha256').update(serialized).digest('hex') };
  } finally {
    try {
      await connection.end();
    } catch {
      connection.destroy();
    }
  }
}

/** Prove whole-database catalog visibility without exposing grant or account text. */
export function assertMysqlCatalogVisibility(grants: string[], database: string): void {
  const privileges = new Set<string>();
  // SHOW GRANTS uses double-quoted identifiers under ANSI_QUOTES. Compare
  // complete scopes, including escaped delimiters; never accept table grants.
  const scopes = new Set(['*.*', `${quoteMysqlSchemaName(database)}.*`, `"${database.replaceAll('"', '""')}".*`]);
  for (const grant of grants) {
    if (/^REVOKE /i.test(grant))
      throw new ValidationError('MySQL schema comparison cannot prove catalog visibility with partial revokes.');
    const match = /^GRANT ([A-Z_, ]+) ON /i.exec(grant);
    // A quoted database identifier can itself contain the grant delimiter.
    const scope = match ? grant.slice(match[0].length) : '';
    if (match && [...scopes].some((allowed) => scope.startsWith(`${allowed} TO `)))
      for (const privilege of match[1]!.split(',').map((p) => p.trim().toUpperCase())) privileges.add(privilege);
  }
  if (!privileges.has('ALL PRIVILEGES') && !['SELECT', 'SHOW VIEW', 'TRIGGER'].every((p) => privileges.has(p)))
    throw new ValidationError(
      'MySQL schema comparison requires effective database-wide SELECT, SHOW VIEW and TRIGGER visibility grants (or global equivalents) in SHOW GRANTS; table-only grants are not sufficient.',
    );
}
