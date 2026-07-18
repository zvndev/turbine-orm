/**
 * turbine-orm — write compilation (extracted from builder.ts)
 *
 * SQL builders for the mutating operations (create / createMany / update /
 * delete / upsert / updateMany / deleteMany) plus the write-projection helpers
 * (writeReturningColumns / writeReselectSelection / parseWriteRow, the PII
 * column set, optimistic-lock and atomic-operator SET clauses). All functions
 * take a {@link BuilderCtx} first argument; WHERE compilation is reused from
 * where.ts (via `whereMod`), and the cache / dialect / row-parse primitives
 * stay class-resident, reached through the ctx. See builder.ts for the thin
 * delegating methods and the async execute wrappers.
 */

import type { ReturningSelection } from '../dialect.js';
import { NotFoundError, OptimisticLockError, ValidationError } from '../errors.js';
import type { TableMetadata } from '../schema.js';
import { camelToSnake, snakeToCamel } from '../schema.js';
import type { DeferredQuery } from './deferred.js';
import { UPDATE_OPERATOR_KEYS } from './filters.js';
import type {
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from './types.js';
import type { SqlCacheEntry } from './utils.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';

/**
 * Build a `SELECT * ... WHERE <predicate>` that re-fetches the row(s) matched
 * by a write's `where` clause. Used by the `'reselect'` result strategy to
 * return rows from non-RETURNING engines. Reuses the same parameterized WHERE
 * builder as reads, so no user value is interpolated.
 */
export function buildReselectByWhere(
  qi: BuilderCtx,
  whereObj: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clause = whereMod.buildWhereClause(qi, whereObj, params);
  const where = clause ? ` WHERE ${clause}` : '';
  return { sql: `SELECT ${writeReselectSelection(qi)} FROM ${qi.q(qi.table)}${where}`, params };
}

export function buildCreate<T extends object>(qi: BuilderCtx, args: CreateArgs<T>): DeferredQuery<T> {
  assertWritable(qi, 'create');
  assertNoGeneratedColumns(qi, args.data as Record<string, unknown>, 'create');
  const entries = Object.entries(args.data as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const columns = entries.map(([k]) => qi.toSqlColumn(k));
  const params = entries.map(([, v]) => v);
  // Enum columns get an explicit `::"EnumName"` cast (see enumTypeForColumn).
  const placeholders = entries.map(([k], i) => `${qi.p(i + 1)}${whereMod.enumCastSuffix(qi, qi.toColumn(k))}`);

  const sql = qi.dialect.buildInsertStatement({
    table: qi.q(qi.table),
    columns,
    valuePlaceholders: placeholders,
    returning: writeReturningColumns(qi),
  });

  return {
    sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError({
          table: qi.table,
          operation: 'create',
          message: `[turbine] create on "${qi.table}" returned no row from RETURNING * — this should never happen.`,
        });
      }
      return parseWriteRow(qi, row) as T;
    },
    tag: `${qi.table}.create`,
    // Non-RETURNING engines: INSERT, then re-fetch the new row by primary key
    // (provided value, else the driver's generated insert id).
    reselect: makeCreateReselect(qi, sql, params, args.data as Record<string, unknown>),
  };
}

/**
 * Build the `'reselect'` plan for {@link buildCreate}: run the INSERT, then
 * `SELECT * WHERE pk = ?`. Returns `undefined` (skipped) unless the active
 * dialect's result strategy is `'reselect'`, so the PostgreSQL/RETURNING path
 * pays nothing. Not yet wired to a real non-RETURNING engine.
 */
export function makeCreateReselect<T extends object>(
  qi: BuilderCtx,
  insertSql: string,
  insertParams: unknown[],
  data: Record<string, unknown>,
): DeferredQuery<T>['reselect'] {
  if (qi.dialect.resultStrategy !== 'reselect') return undefined;
  return async (exec) => {
    const writeResult = await exec(insertSql, insertParams);
    const insertId = qi.mutationInsertId(writeResult);
    const conds: string[] = [];
    const selParams: unknown[] = [];
    let idx = 1;
    for (const pk of qi.tableMeta.primaryKey) {
      const field = qi.tableMeta.reverseColumnMap[pk] ?? snakeToCamel(pk);
      selParams.push(data[field] ?? data[pk] ?? insertId);
      conds.push(`${qi.q(pk)} = ${qi.p(idx++)}`);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    return exec(`SELECT ${writeReselectSelection(qi)} FROM ${qi.q(qi.table)}${where}`, selParams);
  };
}

export function buildCreateMany<T extends object>(qi: BuilderCtx, args: CreateManyArgs<T>): DeferredQuery<T[]> {
  const qt = qi.q(qi.table);
  if (args.data.length === 0) {
    return {
      sql: `SELECT * FROM ${qt} WHERE false`,
      params: [],
      transform: () => [],
      tag: `${qi.table}.createMany`,
    };
  }

  assertWritable(qi, 'createMany');
  for (const row of args.data) {
    assertNoGeneratedColumns(qi, row as Record<string, unknown>, 'createMany');
  }

  const keys = Object.keys(args.data[0]!).filter((k) => (args.data[0] as Record<string, unknown>)[k] !== undefined);
  const columns = keys.map((k) => qi.toColumn(k));

  const rowValues = args.data.map((row) => {
    const record = row as Record<string, unknown>;
    return keys.map((key) => record[key]);
  });

  // Use actual Postgres types for array casts in the default PostgreSQL dialect.
  // Enum columns cast to `"EnumName"[]` — the generic text[] fallback would
  // type the UNNEST output as text, which Postgres refuses to coerce to the
  // enum ("column X is of type Y but expression is of type text").
  const typeCasts = columns.map((col) => {
    const enumType = whereMod.enumTypeForColumn(qi, col);
    return enumType ? `${qi.q(enumType)}[]` : whereMod.getColumnArrayType(qi, col);
  });
  const quotedColumns = columns.map((c) => qi.q(c));

  const built = qi.dialect.buildBulkInsertStatement({
    table: qt,
    columns: quotedColumns,
    rowValues,
    columnArrayTypes: typeCasts,
    skipDuplicates: args.skipDuplicates,
    returning: writeReturningColumns(qi),
  });

  return {
    sql: built.sql,
    params: built.params,
    transform: (result) => result.rows.map((row) => parseWriteRow(qi, row) as T),
    tag: `${qi.table}.createMany`,
  };
}

export function buildUpdate<T extends object>(qi: BuilderCtx, args: UpdateArgs<T>): DeferredQuery<T> {
  assertWritable(qi, 'update');
  qi.currentSkip = args.skipGlobalFilters;
  const dataObj = args.data as Record<string, unknown>;
  assertNoGeneratedColumns(qi, dataObj, 'update');
  const userWhere = args.where as Record<string, unknown>;
  const lock = args.optimisticLock;
  // The empty-`where` guard checks the USER predicate only — a global filter
  // must never turn an unguarded mass update into an allowed one.
  const userHasPredicate = !whereMod.userPredicateIsEmpty(qi, userWhere) || !!lock;
  whereMod.assertMutationHasPredicate(qi, 'update', userHasPredicate ? ' WHERE x' : '', args.allowFullTableScan);
  // The SQL is built from the global-filter-merged where (soft-delete keeps an
  // update from touching already-deleted rows).
  const whereObj = (whereMod.mergeGlobalFilter(qi, userWhere) ?? {}) as Record<string, unknown>;
  const setFp = fingerprintSet(qi, dataObj);
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = lock ? null : `u:${setFp}|${whereFp}${whereMod.globalFilterCacheSegment(qi)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const setEntries = Object.entries(dataObj).filter(([, v]) => v !== undefined);
    const setClauses = setEntries.map(([k, v]) => buildSetClause(qi, k, v, freshParams));

    if (lock) {
      const versionCol = qi.toSqlColumn(lock.field);
      setClauses.push(`${versionCol} = ${versionCol} + 1`);
    }

    const whereClause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    let whereSql = whereClause ? ` WHERE ${whereClause}` : '';

    if (lock) {
      const versionCol = qi.toSqlColumn(lock.field);
      freshParams.push(lock.expected);
      const versionCheck = `${versionCol} = ${qi.p(freshParams.length)}`;
      whereSql = whereSql ? `${whereSql} AND ${versionCheck}` : ` WHERE ${versionCheck}`;
    }

    // Engines that inject their returning shape MID-statement (SQL Server
    // `OUTPUT INSERTED.*` between SET and WHERE) override buildUpdateStatement;
    // absent → the trailing-clause PG/SQLite/MySQL form (byte-identical).
    // `returning` excludes PII columns on tagged tables (else '*').
    const returning = writeReturningColumns(qi);
    return qi.dialect.buildUpdateStatement
      ? qi.dialect.buildUpdateStatement({ table: qi.q(qi.table), setClauses, whereSql, returning })
      : `UPDATE ${qi.q(qi.table)} SET ${setClauses.join(', ')}${whereSql}${qi.dialect.buildReturningClause(returning)}`;
  };

  let sql: string;
  let preparedName: string | undefined;
  let cacheEntry: SqlCacheEntry | undefined;

  if (ck) {
    cacheEntry = qi.acquireSql(ck, buildSql);
    sql = cacheEntry.sql;
    preparedName = cacheEntry.name;
  } else {
    // optimisticLock path: value-variant version check → uncacheable, no cross-check.
    sql = buildSql([]);
  }

  // Collect params: SET first, then WHERE, then version check (same order as fresh build)
  collectSetParams(qi, dataObj, params);
  whereMod.collectWhereParams(qi, whereObj, params);
  if (lock) {
    params.push(lock.expected);
  }
  if (ck && cacheEntry) {
    qi.crossCheckCache('update', ck, cacheEntry, buildSql, params);
  }

  return {
    sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        if (lock) {
          throw new OptimisticLockError({
            table: qi.table,
            versionField: lock.field,
            expectedVersion: lock.expected,
          });
        }
        throw new NotFoundError({
          table: qi.table,
          where: args.where,
          operation: 'update',
        });
      }
      return parseWriteRow(qi, row) as T;
    },
    tag: `${qi.table}.update`,
    preparedName,
    // Non-RETURNING engines: UPDATE, then re-fetch the row by the same where.
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            const writeResult = await exec(sql, params, preparedName);
            // Optimistic-lock conflict: the version-checked UPDATE matched no
            // row. The re-fetch below uses `where` WITHOUT the version
            // predicate, so it would return the stale row and silently mask
            // the conflict — detect it from affected-rows here instead, to
            // match the OptimisticLockError thrown on RETURNING/OUTPUT engines.
            if (lock && (writeResult.rowCount ?? 0) === 0) {
              throw new OptimisticLockError({
                table: qi.table,
                versionField: lock.field,
                expectedVersion: lock.expected,
              });
            }
            const sel = buildReselectByWhere(qi, whereObj);
            return exec(sel.sql, sel.params);
          }
        : undefined,
  };
}

export function buildDelete<T extends object>(qi: BuilderCtx, args: DeleteArgs<T>): DeferredQuery<T> {
  assertWritable(qi, 'delete');
  qi.currentSkip = args.skipGlobalFilters;
  // Guard the USER predicate (a global filter must not satisfy the guard).
  whereMod.assertMutationHasPredicate(
    qi,
    'delete',
    whereMod.userPredicateIsEmpty(qi, args.where as Record<string, unknown>) ? '' : ' WHERE x',
    args.allowFullTableScan,
  );
  const whereObj = (whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = `d:${whereFp}${whereMod.globalFilterCacheSegment(qi)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const clause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    const whereSql = clause ? ` WHERE ${clause}` : '';
    // SQL Server injects `OUTPUT DELETED.*` between `DELETE FROM <t>` and WHERE;
    // absent override → the trailing-clause PG/SQLite/MySQL form (byte-identical).
    // `returning` excludes PII columns on tagged tables (else '*').
    const returning = writeReturningColumns(qi);
    return qi.dialect.buildDeleteStatement
      ? qi.dialect.buildDeleteStatement({ table: qi.q(qi.table), whereSql, returning })
      : `DELETE FROM ${qi.q(qi.table)}${whereSql}${qi.dialect.buildReturningClause(returning)}`;
  };
  const entry = qi.acquireSql(ck, buildSql);

  whereMod.collectWhereParams(qi, whereObj, params);
  qi.crossCheckCache('delete', ck, entry, buildSql, params);

  return {
    sql: entry.sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError({
          table: qi.table,
          where: args.where,
          operation: 'delete',
        });
      }
      return parseWriteRow(qi, row) as T;
    },
    tag: `${qi.table}.delete`,
    preparedName: entry.name,
    // Non-RETURNING engines: the row is gone after DELETE, so pre-SELECT it
    // by the same where, then run the DELETE, returning the captured row.
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            const sel = buildReselectByWhere(qi, whereObj);
            const pre = await exec(sel.sql, sel.params);
            await exec(entry.sql, params, entry.name);
            return pre;
          }
        : undefined,
  };
}

export function buildUpsert<T extends object>(qi: BuilderCtx, args: UpsertArgs<T>): DeferredQuery<T> {
  assertWritable(qi, 'upsert');
  assertNoGeneratedColumns(qi, args.create as Record<string, unknown>, 'upsert');
  assertNoGeneratedColumns(qi, args.update as Record<string, unknown>, 'upsert');
  qi.currentSkip = args.skipGlobalFilters;
  // Build the INSERT part from create data
  const createEntries = Object.entries(args.create as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const columns = createEntries.map(([k]) => qi.toSqlColumn(k));
  const createParams = createEntries.map(([, v]) => v);
  // Enum columns get an explicit `::"EnumName"` cast (see enumTypeForColumn).
  const placeholders = createEntries.map(([k], i) => `${qi.p(i + 1)}${whereMod.enumCastSuffix(qi, qi.toColumn(k))}`);

  // The conflict target comes from `where` keys — must be unique/PK columns
  const conflictKeys = Object.keys(args.where as Record<string, unknown>).filter(
    (k) => (args.where as Record<string, unknown>)[k] !== undefined,
  );
  const conflictColumns = conflictKeys.map((k) => qi.toSqlColumn(k));

  // Build the UPDATE SET part
  const updateEntries = Object.entries(args.update as Record<string, unknown>).filter(([, v]) => v !== undefined);
  let paramIdx = createParams.length + 1;
  const setClauses = updateEntries.map(([k]) => {
    const clause = `${qi.toSqlColumn(k)} = ${qi.p(paramIdx)}${whereMod.enumCastSuffix(qi, qi.toColumn(k))}`;
    paramIdx++;
    return clause;
  });
  const updateParams = updateEntries.map(([, v]) => v);

  const params = [...createParams, ...updateParams];

  // Global filter → restrict the conflict-UPDATE (soft-delete / tenancy) so an
  // upsert never resurrects a soft-deleted row or writes across tenants. Only
  // on engines whose upsert can carry a predicate (Postgres); the gf params
  // continue the placeholder numbering after create+update params.
  let updateWhere: string | undefined;
  if (qi.dialect.supportsUpsertUpdateWhere) {
    const gf = whereMod.resolveGlobalFilter(qi, qi.table);
    if (gf) updateWhere = whereMod.buildWhereClause(qi, gf, params) ?? undefined;
  }

  const sql = qi.dialect.buildUpsertStatement({
    table: qi.q(qi.table),
    insertColumns: columns,
    valuePlaceholders: placeholders,
    conflictColumns,
    updateSetClauses: setClauses,
    updateWhere,
    returning: writeReturningColumns(qi),
  });

  return {
    sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError({
          table: qi.table,
          where: args.where,
          operation: 'upsert',
          message: `[turbine] upsert on "${qi.table}" returned no row from RETURNING * — this should never happen.`,
        });
      }
      return parseWriteRow(qi, row) as T;
    },
    tag: `${qi.table}.upsert`,
    // Non-RETURNING engines: run the upsert, then re-fetch by the where keys.
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            await exec(sql, params);
            const sel = buildReselectByWhere(
              qi,
              (whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown>) ?? {}) as Record<string, unknown>,
            );
            return exec(sel.sql, sel.params);
          }
        : undefined,
  };
}

export function buildUpdateMany<T extends object>(
  qi: BuilderCtx,
  args: UpdateManyArgs<T>,
): DeferredQuery<{ count: number }> {
  assertWritable(qi, 'updateMany');
  qi.currentSkip = args.skipGlobalFilters;
  const dataObj = args.data as Record<string, unknown>;
  assertNoGeneratedColumns(qi, dataObj, 'updateMany');
  whereMod.assertMutationHasPredicate(
    qi,
    'updateMany',
    whereMod.userPredicateIsEmpty(qi, args.where as Record<string, unknown>) ? '' : ' WHERE x',
    args.allowFullTableScan,
  );
  const whereObj = (whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const setFp = fingerprintSet(qi, dataObj);
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = `um:${setFp}|${whereFp}${whereMod.globalFilterCacheSegment(qi)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const setEntries = Object.entries(dataObj).filter(([, v]) => v !== undefined);
    const setClauses = setEntries.map(([k, v]) => buildSetClause(qi, k, v, freshParams));
    const whereClause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
    return `UPDATE ${qi.q(qi.table)} SET ${setClauses.join(', ')}${whereSql}`;
  };
  const entry = qi.acquireSql(ck, buildSql);

  collectSetParams(qi, dataObj, params);
  whereMod.collectWhereParams(qi, whereObj, params);
  qi.crossCheckCache('updateMany', ck, entry, buildSql, params);

  return {
    sql: entry.sql,
    params,
    transform: (result) => ({ count: result.rowCount ?? 0 }),
    tag: `${qi.table}.updateMany`,
    preparedName: entry.name,
  };
}

export function buildDeleteMany<T extends object>(
  qi: BuilderCtx,
  args: DeleteManyArgs<T>,
): DeferredQuery<{ count: number }> {
  assertWritable(qi, 'deleteMany');
  qi.currentSkip = args.skipGlobalFilters;
  whereMod.assertMutationHasPredicate(
    qi,
    'deleteMany',
    whereMod.userPredicateIsEmpty(qi, args.where as Record<string, unknown>) ? '' : ' WHERE x',
    args.allowFullTableScan,
  );
  const whereObj = (whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = `dm:${whereFp}${whereMod.globalFilterCacheSegment(qi)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const clause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    const whereSql = clause ? ` WHERE ${clause}` : '';
    return `DELETE FROM ${qi.q(qi.table)}${whereSql}`;
  };
  const entry = qi.acquireSql(ck, buildSql);

  whereMod.collectWhereParams(qi, whereObj, params);
  qi.crossCheckCache('deleteMany', ck, entry, buildSql, params);

  return {
    sql: entry.sql,
    params,
    transform: (result) => ({ count: result.rowCount ?? 0 }),
    tag: `${qi.table}.deleteMany`,
    preparedName: entry.name,
  };
}

/**
 * The snake_case names of a table's PII-tagged (`defineSchema` `pii: true`)
 * columns. PII columns are excluded from default projections (findMany /
 * findUnique / relation subqueries / batched loads) unless the query opts in
 * via `includePii` or names the column explicitly in `select`. Returns an
 * empty set for any table with no PII column, so untagged schemas keep their
 * byte-identical SQL.
 */
export function piiColumns(_qi: BuilderCtx, meta: TableMetadata): Set<string> {
  const out = new Set<string>();
  for (const col of meta.columns) {
    if (col.pii) out.add(col.name);
  }
  return out;
}

/**
 * The camelCase field names of a table's PII-tagged columns: the read-side
 * counterpart of {@link piiColumns} applied to already-parsed entities.
 * Used to strip PII from a write's RETURNING/reselect row (writes accept no
 * `includePii`/`select`, so their returned row always applies the default
 * exclusion; you may still write PII fields freely).
 */
export function piiFields(_qi: BuilderCtx, meta: TableMetadata): string[] {
  const out: string[] = [];
  for (const col of meta.columns) {
    if (col.pii) out.push(col.field);
  }
  return out;
}

/**
 * The `RETURNING` / `OUTPUT` selection for a write on this table. A table with
 * no PII column returns `'*'` (every column — byte-identical SQL to before);
 * a table WITH PII columns returns an explicit quoted list of every non-PII
 * column so the PII values never leave the database on a write. A PII-tagged
 * PRIMARY KEY column is kept in the projection regardless (the returned row
 * must stay addressable): tag sensitive data, not keys — a PII PK is
 * documented out of scope for stripping. Writes accept no `select`/`includePii`
 * (unlike reads), so this is the whole write-return policy at the SQL level;
 * {@link parseWriteRow} remains as a defense-in-depth strip (a no-op once the
 * SQL already excludes the columns). Derived purely from static per-table
 * schema metadata, so the write SQL cache needs no extra key segment.
 */
export function writeReturningColumns(qi: BuilderCtx): ReturningSelection {
  const piiCols = piiColumns(qi, qi.tableMeta);
  if (piiCols.size === 0) return '*';
  const pk = new Set(qi.tableMeta.primaryKey);
  return qi.tableMeta.allColumns.filter((col) => !piiCols.has(col) || pk.has(col)).map((col) => qi.q(col));
}

/**
 * String form of {@link writeReturningColumns} for a `SELECT` list (the
 * `'reselect'` result strategy re-fetches via a SELECT, not RETURNING).
 * `'*'` when there is no PII column; otherwise the comma-joined quoted list.
 */
export function writeReselectSelection(qi: BuilderCtx): string {
  const cols = writeReturningColumns(qi);
  return cols === '*' ? '*' : cols.join(', ');
}

/**
 * Parse a write's returned row (create/update/upsert/delete), then strip the
 * table's PII fields: the write-side read policy. On PII-tagged tables the
 * statement's RETURNING/OUTPUT already omits these columns (see
 * {@link writeReturningColumns}), so this strip is defense-in-depth and a
 * no-op. Untagged tables incur only one `for` over a zero-length field list,
 * so behavior is unchanged.
 */
export function parseWriteRow(qi: BuilderCtx, row: Record<string, unknown>): Record<string, unknown> {
  const parsed = qi.parseRow(row, qi.table);
  for (const field of piiFields(qi, qi.tableMeta)) {
    delete parsed[field];
  }
  return parsed;
}

/**
 * Reject any write against a view (H4). Views are introspected with
 * `isView: true` and are read-only in every engine; a write raises a
 * {@link ValidationError} (E003) rather than emitting SQL Postgres would
 * reject (or, worse, silently applying to an updatable view).
 */
export function assertWritable(qi: BuilderCtx, operation: string): void {
  if (qi.tableMeta.isView) {
    throw new ValidationError(
      `[turbine] Cannot ${operation} "${qi.table}": it is a view (read-only). ` +
        'Views support reads (findMany/findFirst/…) but not writes.',
    );
  }
}

/**
 * Reject a write whose `data` names a `GENERATED ALWAYS AS (...) STORED`
 * column (H3). Postgres computes these from other columns and errors if you
 * try to write them; we fail early with a clear {@link ValidationError} (E003)
 * instead of surfacing a cryptic driver error. Undefined values are ignored
 * (they're stripped from the statement anyway).
 */
export function assertNoGeneratedColumns(qi: BuilderCtx, data: Record<string, unknown>, operation: string): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const col = qi.tableMeta.columns.find((c) => c.field === key || c.name === key || c.name === camelToSnake(key));
    if (col?.isGeneratedStored) {
      throw new ValidationError(
        `[turbine] Cannot ${operation} "${qi.table}": column "${key}" is a GENERATED ALWAYS AS (…) STORED ` +
          'column whose value the database computes — remove it from your data.',
      );
    }
  }
}

/**
 * Build a single SET clause entry for update/updateMany.
 *
 * Supports plain values and atomic operator objects ({ set, increment,
 * decrement, multiply, divide }). An operator object is detected ONLY when
 * it has EXACTLY one key that is one of the 5 operator keys — this avoids
 * misinterpreting JSON column values like `{ set: 'x' }` as operators
 * (real operator objects always have exactly one key, and a plain JSON
 * payload that happens to have a single `set` key is extremely unusual).
 * Multi-key objects are always treated as plain (JSON) values.
 *
 * Returns the SQL fragment (e.g., `"view_count" = "view_count" + $3`) and
 * pushes any required params onto the shared params array so that WHERE
 * clause numbering continues correctly afterward.
 */
export function buildSetClause(qi: BuilderCtx, key: string, value: unknown, params: unknown[]): string {
  const col = qi.toSqlColumn(key);
  // Enum columns get an explicit `::"EnumName"` cast on their value bind
  // (see enumTypeForColumn); `''` everywhere else. Value-invariant, so the
  // SQL cache and collectSetParams are unaffected.
  const cast = whereMod.enumCastSuffix(qi, qi.toColumn(key));

  // Detect atomic-operator object: plain object (not null, not array, not
  // Date, not Buffer) with EXACTLY one key matching an operator name.
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  ) {
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
      const op = keys[0]!;
      const opValue = v[op];

      if (op === 'set') {
        params.push(opValue);
        return `${col} = ${qi.p(params.length)}${cast}`;
      }

      // Arithmetic operators: must be finite numbers
      if (typeof opValue !== 'number' || !Number.isFinite(opValue)) {
        throw new ValidationError(
          `[turbine] update operator "${op}" on "${qi.table}.${key}" requires a finite number, got ${typeof opValue}`,
        );
      }

      if (op === 'increment') {
        params.push(opValue);
        return `${col} = ${col} + ${qi.p(params.length)}`;
      }
      if (op === 'decrement') {
        params.push(opValue);
        return `${col} = ${col} - ${qi.p(params.length)}`;
      }
      if (op === 'multiply') {
        params.push(opValue);
        return `${col} = ${col} * ${qi.p(params.length)}`;
      }
      if (op === 'divide') {
        params.push(opValue);
        return `${col} = ${col} / ${qi.p(params.length)}`;
      }
    }
    // Fall through: multi-key objects or non-operator single-key objects
    // are treated as plain values (e.g., JSONB column payloads).
  }

  // Plain value (including null, Date, Buffer, arrays, JSON objects)
  params.push(value);
  return `${col} = ${qi.p(params.length)}${cast}`;
}

/**
 * Fingerprint SET clauses for update/updateMany.
 * Captures key names + operator types (set/increment/etc) but not values.
 */
export function fingerprintSet(_qi: BuilderCtx, data: Record<string, unknown>): string {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  const parts: string[] = [];
  for (const [k, v] of entries) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date) &&
      !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
    ) {
      const keys = Object.keys(v as Record<string, unknown>);
      if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
        parts.push(`${k}:${keys[0]}`);
        continue;
      }
    }
    parts.push(`${k}:eq`);
  }
  return parts.join(',');
}

/**
 * Collect SET params for update/updateMany. Mirrors buildSetClause param order.
 */
export function collectSetParams(_qi: BuilderCtx, data: Record<string, unknown>, params: unknown[]): void {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  for (const [, v] of entries) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date) &&
      !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
    ) {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 1 && UPDATE_OPERATOR_KEYS.has(keys[0]!)) {
        params.push(obj[keys[0]!]);
        continue;
      }
    }
    params.push(v);
  }
}
