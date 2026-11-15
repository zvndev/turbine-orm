/** Portable SQLite SQL generation shared by binding adapters and native SQLite. */
import {
  type BuiltStatement,
  type BulkInsertStatementInput,
  type BulkUpsertStatementInput,
  type ColumnDefinitionInput,
  type ColumnTypeInput,
  type CreateIndexStatementInput,
  type CreateTableStatementInput,
  type DefaultValuesInsertStatementInput,
  type Dialect,
  type EngineCapabilities,
  type InsertStatementInput,
  type JsonWireRule,
  type LimitOffsetInput,
  onConflictAction,
  postgresDialect,
  type ReturningSelection,
  type StreamableConnection,
  type UpsertStatementInput,
} from '../dialect.js';
import { UnsupportedFeatureError } from '../errors.js';

type SqliteParam = null | number | bigint | string | Uint8Array;
type ColumnDecode = 'boolean' | 'json';
export interface PortableSqliteDialectOptions {
  declaredTypes?: () => boolean;
  decodeBlob?: (hex: string) => Uint8Array;
  recordBulkInsert?: (params: unknown[], sql: string) => void;
}
function decodeHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}
export function toSqliteParam(value: unknown): SqliteParam {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      // `node:sqlite` binds every JS number as REAL, so `views / 2` divided as
      // floats (75 / 2 = 37.5, stored in an INTEGER column) and an integral
      // number written to a TEXT column was stored as '3.0'. Binding a safe
      // integer as an INTEGER gives the arithmetic and text PostgreSQL gives.
      // -0 stays REAL: as an integer it would lose its sign.
      return Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : value;
    case 'bigint':
    case 'string':
      return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value; // also covers Buffer
  return JSON.stringify(value);
}

function sqliteInListJson(values: readonly unknown[]): string {
  const parts = values.map((value): string => {
    if (value === undefined || value === null) return 'null';
    switch (typeof value) {
      case 'boolean':
        return value ? '1' : '0';
      case 'number':
        if (Number.isFinite(value)) return JSON.stringify(value);
        if (Number.isNaN(value)) return 'null';
        return value > 0 ? '9e999' : '-9e999';
      case 'bigint':
        return value.toString();
      case 'string':
        return JSON.stringify(value);
    }
    if (value instanceof Uint8Array) {
      let hex = '';
      for (const byte of value) hex += byte.toString(16).padStart(2, '0');
      return `{"b":"${hex}"}`;
    }
    const bound = toSqliteParam(value);
    return JSON.stringify(bound);
  });
  return `[${parts.join(',')}]`;
}

export function sqliteValueDecode(type: string): ColumnDecode | undefined {
  const t = type.toUpperCase();
  if (t.includes('BOOL')) return 'boolean';
  if (t === 'JSON' || t === 'JSONB') return 'json';
  return undefined;
}

const SQLITE_NUMBER_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * The text SQLite's INTEGER, REAL and NUMERIC affinities convert to a number,
 * measured against SQLite 3.51: an optional sign, a decimal integer or float,
 * an optional exponent, and ASCII whitespace around it. Anything else
 * (`'abc'`, `''`, `'Infinity'`, `'0x10'`, `'1_000'`) is stored as TEXT in the
 * numeric column. Linear for the same reason as {@link SQLITE_NUMBER_TEXT}.
 */
const SQLITE_NUMERIC_LITERAL = /^[ \t\n\v\f\r]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[ \t\n\v\f\r]*$/i;

/**
 * Declared column types whose SQLite affinity is numeric (INTEGER, REAL or
 * NUMERIC), boolean included (stored 1/0). Matched whole, not by SQLite's own
 * "contains INT" rule: the type a schema records for a column can be an enum's
 * name (`point_kind`), which that rule reads as INTEGER while the column is
 * TEXT. A type this misses is written as SQLite always wrote it, so a miss
 * costs a refusal, never a wrong one.
 */
const SQLITE_NUMERIC_COLUMN_TYPE =
  /^(?:(?:tiny|small|medium|big)?int(?:eger)?|int[248]|(?:small|big)?serial|unsigned big int|real|float[48]?|double(?: precision)?|numeric|decimal|money|bool(?:ean)?)(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?$/i;

/**
 * Decode a REAL / NUMERIC cell carried as text through a `with` join back to
 * the value a direct read returns: an integer by the safe-integer policy, a
 * double as the number its 17 digits name, `Inf` / `-Inf` as infinities.
 */
function decodeRealText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (/^-?\d+$/.test(value)) {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value;
  }
  if (value === 'Inf') return Number.POSITIVE_INFINITY;
  if (value === '-Inf') return Number.NEGATIVE_INFINITY;
  return SQLITE_NUMBER_TEXT.test(value) ? Number(value) : value;
}

/** Read a JSON column's stored text as its value; text that is not JSON is returned as stored. */
export function parseJsonCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function sqliteTypeToTs(declaredType: string, nullable: boolean): string {
  const t = declaredType.toLowerCase();
  let base: string;
  if (/int/.test(t)) base = 'number';
  else if (/(real|floa|doub)/.test(t)) base = 'number';
  else if (/bool/.test(t)) base = 'boolean';
  else if (/(timestamp|datetime|date)/.test(t)) base = 'Date';
  else if (/(char|clob|text)/.test(t)) base = 'string';
  else if (/blob/.test(t)) base = 'Uint8Array';
  else if (/(numeric|decimal)/.test(t)) base = 'string';
  else if (t === '')
    base = 'unknown'; // no declared affinity (BLOB affinity)
  else base = 'unknown';
  return nullable ? `${base} | null` : base;
}

function sqliteColumnAffinity(type: string): string {
  const t = type.toUpperCase();
  if (/SERIAL|INT/.test(t)) return 'INTEGER';
  if (/REAL|FLOAT|DOUBLE/.test(t)) return 'REAL';
  if (/NUMERIC|DECIMAL|MONEY/.test(t)) return 'NUMERIC';
  if (/BLOB|BYTEA/.test(t)) return 'BLOB';
  if (/BOOL/.test(t)) return 'INTEGER';
  // TEXT, VARCHAR, CHAR, UUID, JSON(B), TIMESTAMP(TZ), DATE, TIME, ENUM, …
  return 'TEXT';
}

export function createPortableSqliteDialect(options: PortableSqliteDialectOptions = {}): Dialect {
  return {
    ...postgresDialect,
    name: 'sqlite',
    capabilities: Object.freeze({
      distinctOn: false,
      tupleCursorPredicate: false,
      positionalJson: false,
      jsonObjectKeysAsWritten: true,
      // NULLS FIRST / LAST since 3.30; NULL is the smallest value.
      nullsOrderingClause: true,
      nullsSortHigh: false,
      insensitiveInList: false,
      jsonDocumentEquality: 'text',
      jsonExtractTyped: true,
      jsonExactNumericCast: false,
      numericTextComparison: false,
      // Enforced only on a connection that turned `foreign_keys` on.
      enforcesForeignKeys: false,
      partitionLimitPushdown: false,
      utcTimestampRewrite: false,
      paramTypeCasts: false,
      namedEnumTypes: false,
      structuredValueColumns: 'scalars',
      // The default SQLITE_MAX_VARIABLE_NUMBER.
      maxBindParameters: 32766,
      maxInsertRows: Number.POSITIVE_INFINITY,
      // Measured: 40,000 rows insert 70 to 140 times faster in statements of 250
      // parameters than of 32,766 (named-parameter lookup is a linear search).
      chunkBindParameters: 250,
      upsertConflictTarget: 'explicit',
      setClauseOrder: 'snapshot',
      reselectLocksRows: false,
      integerDivision: '/',
      updateExpressions: true,
      bulkUpsertAppliesRepeatedKeys: true,
      skipDuplicatesCountsSkipped: false,
      readOnlyTransactions: false,
      connectionParameters: false,
      backendCancel: false,
      idleTransactionTimeout: false,
      abortsTransactionOnError: false,
      classifiesCommitAnswer: false,
      connectionDriver: 'engine-driver',
      preparesEveryStatement: false,
      statementSyntax: 'sqlite',
      inlineForeignKeys: true,
      unboundedTextKeys: true,
    } satisfies EngineCapabilities),
    resultStrategy: 'returning', // SQLite ≥ 3.35 has RETURNING
    supportsReturning: true,
    supportsILike: false,
    supportsVector: false,
    supportsJsonContains: false,
    // FTS5 is a virtual-table feature with its own MATCH syntax, not the
    // `to_tsvector @@ to_tsquery` shape Turbine's `search` filter emits.
    supportsFullTextSearch: false,
    // No array column type (a JSON column is not an array column).
    supportsArrayColumns: false,
    supportsListenNotify: false,
    supportsRLS: false,
    supportsAdvisoryLock: false,
    // No FROM-clause LATERAL: the opt-in lateral pick plan is Postgres-only.
    supportsLateralJoin: false,
    supportsPlanCacheMode: false,
    // No row locks: a write transaction locks the whole database.
    rowLockModes: [],
    // percentile_cont / percentile_disc exist only in builds compiled with
    // SQLITE_ENABLE_PERCENTILE, which node:sqlite cannot be assumed to have.
    supportsPercentileAggregates: false,
    // INSERT ... ON CONFLICT (cols) DO UPDATE ... RETURNING (3.24 + 3.35).
    supportsBulkUpsert: true,
    // SQLite explains a compiled query with `EXPLAIN QUERY PLAN` (four columns:
    // id, parent, notused, detail), overriding the inherited Postgres `EXPLAIN`.
    explainQuery: { prefix: 'EXPLAIN QUERY PLAN' },
    // json_group_array / json_object have no inline ORDER BY argument, so every
    // ordered to-many relation is forced through the inner-subquery rewrite.
    aggSupportsInlineOrderBy: false,
    jsonPathSupport: 'function',
    emptyJsonArrayLiteral: "json('[]')",
    nullJsonLiteral: 'NULL',

    // Named placeholders (`:p1`, `:p2`, …), NOT positional `?`. Turbine pushes
    // params in 1-indexed generation order but may EMIT them in a different SQL
    // text position (e.g. a `with`-relation LIMIT lands in the SELECT list, ahead
    // of the outer WHERE). Postgres reconciles this via numbered `$N`; positional
    // `?` cannot. SQLite named parameters bind by name, so `:pN` ↔ `params[N-1]`
    // exactly mirrors Postgres' `$N` semantics regardless of text order. The
    // driver binds via a `{ p1, p2, … }` object built from the positional array.
    paramPlaceholder(index: number): string {
      return `:p${index}`;
    },

    quoteIdentifier(name: string): string {
      return `"${name.replace(/"/g, '""')}"`;
    },

    buildJsonObject(pairs: [key: string, expr: string][]): string {
      const args = pairs.map(([key, expr]) => `'${this.escapeStringLiteral(key)}', ${expr}`);
      return `json_object(${args.join(', ')})`;
    },

    buildJsonArrayAgg(jsonObjectExpr: string, orderBy?: string): string {
      // json() wraps each aggregated object so SQLite stores real JSON, not an
      // escaped string; COALESCE handles the empty-group NULL.
      const suffix = orderBy ? ` ${orderBy}` : '';
      return `COALESCE(json_group_array(json(${jsonObjectExpr}))${suffix}, json('[]'))`;
    },

    /**
     * SQLite's `json_group_array` double-encodes nested objects unless each nested
     * subresult is `json(...)`-wrapped. This is the whole point of the hook: it
     * keeps `users[0].posts[0].author.name` a real parsed tree instead of a string
     * containing a string containing JSON.
     */
    wrapJsonSubresult(subquery: string, fallback: string): string {
      return `COALESCE(json((${subquery})), ${fallback})`;
    },

    jsonWireRule(columnType: string): JsonWireRule | undefined {
      // SQLite's storage classes, as introspection records them.
      const t = columnType.toUpperCase();

      // INTEGER is 64-bit, and `json_object` renders it as a JSON number, which
      // is an IEEE double: 9007199254740993 came back through a `with` join as
      // …992 while a top-level read and the batched loader both returned the
      // exact decimal string. Carry the text and re-apply the SAME safe-integer
      // policy `normalizeValue` applies to the driver's bigint, so all three
      // paths agree for both small and large values.
      if (t.includes('INT')) {
        return {
          sql: (ref) => `CAST(${ref} AS TEXT)`,
          decode: (value) => {
            if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return value;
            const asNumber = Number(value);
            return Number.isSafeInteger(asNumber) ? asNumber : value;
          },
        };
      }

      // A declared-boolean column is 1/0 in storage, and the driver shim turns
      // that back into true/false on every direct read (see
      // resultColumnDecoders). `json_object` sees the raw integer and has no
      // decltype to consult, so the join strategy alone would have kept handing
      // back 1/0 while the top-level read, the batched loader and the flatten
      // plan returned booleans, which is the same strategy-dependent type flip
      // the bigint rule above exists to prevent. No cast is needed, only the
      // decode: the JSON number IS the stored value, it just has to be read the
      // same way.
      //
      // Gated on the SAME capability the direct-read half feature-detects (see
      // driverReportsDeclaredTypes). Without it the shim cannot name a boolean
      // result column, so 1/0 is the answer everywhere; converting here alone
      // would put the flip back, pointing the other way.
      const decode = sqliteValueDecode(columnType);
      if (decode === 'boolean' && (options.declaredTypes?.() ?? true)) {
        return {
          // Carried as TEXT because that is how the decode half is reached at
          // all: the parser only runs `decode` on a string cell, so a rule that
          // left the JSON number alone would never fire. The CASE narrows the
          // carrier to EXACTLY the two values that mean true/false, so anything
          // else a declared-boolean column happens to hold (SQLite does not
          // enforce the type) stays in its own JSON form and reads back as the
          // driver would have returned it, rather than being stringified.
          sql: (ref) => `CASE WHEN ${ref} IN (0, 1) THEN CAST(${ref} AS TEXT) ELSE ${ref} END`,
          decode: (value) => (value === '1' ? true : value === '0' ? false : value),
        };
      }

      // A json/jsonb column is JSON text in storage, which the shim parses on
      // every direct read (see resultColumnDecoders). `json_object` embeds the
      // same text as a JSON string, so the decode is the same parse. No cast: the
      // column reference already yields the text. Gated like the boolean rule,
      // since the direct-read half needs the same driver capability.
      if (decode === 'json' && (options.declaredTypes?.() ?? true)) {
        return { sql: (ref) => ref, decode: parseJsonCell };
      }

      // `json_object` renders a REAL with 15 significant digits on the SQLite
      // that Node 22 and 24 bundle (3.47 to 3.51; 3.53 renders 17), so 0.1 + 0.2
      // came back 0.3 through a join and a NUMERIC past 15 digits was rounded
      // again on top of its REAL storage, while the top-level read and the
      // batched loader return the stored double. `printf('%!.17g')` prints every
      // double with enough digits to rebuild it, on every version; an INTEGER in
      // the same column is carried as its text and decoded by the safe-integer
      // policy above; text and NULL pass through as stored.
      if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL|MONEY/.test(t)) {
        return {
          sql: (ref) =>
            `CASE typeof(${ref}) WHEN 'real' THEN printf('%!.17g', ${ref}) ` +
            `WHEN 'integer' THEN CAST(${ref} AS TEXT) ELSE ${ref} END`,
          decode: decodeRealText,
        };
      }

      // A BLOB cannot go into JSON at all: SQLite raises "JSON cannot hold BLOB
      // values" and the whole query fails with a raw SQL logic error, where the
      // batched loader returns the row fine. Carry hex and rebuild the bytes.
      if (t.includes('BLOB') || t === 'BYTEA') {
        return {
          sql: (ref) => `CASE WHEN ${ref} IS NULL THEN NULL ELSE hex(${ref}) END`,
          decode: (value) => (typeof value === 'string' ? (options.decodeBlob ?? decodeHex)(value) : value),
        };
      }

      return undefined;
    },

    castAggregate(expr: string, target: 'int' | 'float'): string {
      return `CAST(${expr} AS ${target === 'int' ? 'INTEGER' : 'REAL'})`;
    },

    // SQLite's grammar only allows OFFSET after LIMIT, so `offset` without
    // `limit` (valid on Postgres, which the default path is written for) is a
    // syntax error here. A negative LIMIT is SQLite's documented "no upper
    // bound", so that shape becomes `LIMIT -1 OFFSET n`. The other shapes emit
    // byte-identically to the default path.
    buildLimitOffset(input: LimitOffsetInput): string {
      const { limitPlaceholder, offsetPlaceholder } = input;
      if (limitPlaceholder === undefined && offsetPlaceholder === undefined) return '';
      if (limitPlaceholder === undefined) return ` LIMIT -1 OFFSET ${offsetPlaceholder}`;
      let s = ` LIMIT ${limitPlaceholder}`;
      if (offsetPlaceholder !== undefined) s += ` OFFSET ${offsetPlaceholder}`;
      return s;
    },

    // No `= ANY(array)` in SQLite. `json_each` expands a single JSON-array param
    // into a row set, keeping ONE placeholder (so the SQL cache stays valid
    // regardless of list length) and handling the empty-list case correctly.
    // `x IN (SELECT ...)` compares like `x = ?`: the column's affinity and
    // collation apply to each element, as they do to a bound operand. JSON has no
    // bytes, so a binary element travels as `{"b": "<hex>"}` and is decoded back
    // to a BLOB here (see sqliteInListJson).
    buildInClause(expr: string, paramRef: string, negated: boolean): string {
      return (
        `${expr} ${negated ? 'NOT IN' : 'IN'} ` +
        `(SELECT CASE WHEN type = 'object' THEN unhex(json_extract(value, '$.b')) ELSE value END ` +
        `FROM json_each(${paramRef}))`
      );
    },

    inClauseParam(values: unknown[]): unknown {
      return sqliteInListJson(Array.isArray(values) ? values : []);
    },

    /**
     * A string written to a numeric or boolean column. SQLite's type affinity
     * keeps text it cannot convert as TEXT in that column, where PostgreSQL
     * refuses it at the server: `'abc'` in an INTEGER column, or `'true'` in a
     * boolean one (stored 1/0), which `{ flag: true }` then never matches. A
     * string that is a number (`'12.5'`, `'9007199254740993'`, `' 7 '`) is
     * accepted and converted by SQLite, as before.
     */
    checkTextWrite(table: string, column: string, columnType: string, value: string): string | undefined {
      if (!SQLITE_NUMERIC_COLUMN_TYPE.test(columnType.trim())) return undefined;
      if (SQLITE_NUMERIC_LITERAL.test(value)) return undefined;
      const boolean = /BOOL/i.test(columnType);
      return (
        `The string written to "${column}" on "${table}", a column of type ${columnType}, is not a number, so SQLite ` +
        `would store it as text in that column; PostgreSQL refuses it. ` +
        (boolean ? 'Write true or false.' : 'Write a number, or a string holding one, such as "12.5".')
      );
    },

    buildReturningClause(selection: ReturningSelection = '*'): string {
      if (selection !== '*' && selection.length === 0) return '';
      return ` RETURNING ${selection === '*' ? '*' : selection.join(', ')}`;
    },

    buildInsertStatement(input: InsertStatementInput): string {
      return (
        `INSERT INTO ${input.table} (${input.columns.join(', ')}) ` +
        `VALUES (${input.valuePlaceholders.join(', ')})${this.buildReturningClause(input.returning)}`
      );
    },

    buildBulkInsertStatement(input: BulkInsertStatementInput) {
      // No UNNEST in SQLite, emit multi-row VALUES with flattened, named
      // placeholders (`:p1`, `:p2`, …) matching the flat param order.
      let n = 0;
      let exactNames = true;
      const placeholders = input.rowValues
        .map(
          (row) =>
            `(${row
              .map(() => {
                const index = ++n;
                const placeholder = this.paramPlaceholder(index);
                exactNames &&= placeholder === `:p${index}`;
                return placeholder;
              })
              .join(', ')})`,
        )
        .join(', ');
      const conflict = input.skipDuplicates ? ' ON CONFLICT DO NOTHING' : '';
      const prefix = `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES `;
      const suffix = `${conflict}${this.buildReturningClause(input.returning)}`;
      const sql = `${prefix}${placeholders}${suffix}`;
      const params = input.rowValues.flat();
      if (params.length > 0 && exactNames) {
        options.recordBulkInsert?.(params, sql);
      }
      return { sql, params };
    },

    buildBulkUpsertStatement(input: BulkUpsertStatementInput): BuiltStatement {
      // VALUES, not `INSERT ... SELECT`: after a SELECT, SQLite cannot tell a
      // trailing `ON CONFLICT` from the SELECT's own clauses. The rest is the
      // PostgreSQL grammar (3.24 upsert, 3.35 RETURNING), `excluded` included.
      let n = 0;
      const tuples = input.rowValues
        .map((row) => `(${row.map(() => this.paramPlaceholder(++n)).join(', ')})`)
        .join(', ');
      const params = input.rowValues.flat();
      return {
        sql:
          `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${tuples} ` +
          `ON CONFLICT (${input.conflictColumns.join(', ')}) ` +
          onConflictAction(input, params, { target: input.table, incoming: 'excluded' }) +
          this.buildReturningClause(input.returning),
        params,
      };
    },

    buildDefaultValuesInsertStatement(input: DefaultValuesInsertStatementInput): string {
      // SQLite's `DEFAULT VALUES` inserts exactly one row and the engine accepts
      // neither `VALUES (DEFAULT, …)` nor MySQL's empty `VALUES ()` tuple, so
      // there is no multi-row all-defaults statement to emit.
      if (input.rowCount !== 1) {
        throw new UnsupportedFeatureError(
          `createMany with ${input.rowCount} empty data rows`,
          'sqlite',
          'SQLite INSERT … DEFAULT VALUES inserts a single row and has no multi-row form; ' +
            'issue one create({ data: {} }) per row.',
        );
      }
      const conflict = input.skipDuplicates ? ' ON CONFLICT DO NOTHING' : '';
      return `INSERT INTO ${input.table} DEFAULT VALUES${conflict}${this.buildReturningClause(input.returning)}`;
    },

    buildUpsertStatement(input: UpsertStatementInput): string {
      return (
        `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})` +
        ` ON CONFLICT (${input.conflictColumns.join(', ')}) DO UPDATE SET ${input.updateSetClauses.join(', ')}` +
        // SQLite's upsert takes the same trailing conflict-UPDATE predicate as
        // Postgres, so `supportsUpsertUpdateWhere` (inherited true) is honest and
        // global filters restrict the UPDATE branch here too.
        (input.updateWhere ? ` WHERE ${input.updateWhere}` : '') +
        this.buildReturningClause(input.returning)
      );
    },

    // A SQLite transaction is always SERIALIZABLE, which satisfies every level
    // `$transaction({ isolationLevel })` can ask for, and the inherited
    // `BEGIN ISOLATION LEVEL ...` is a syntax error here.
    beginStatement(): string {
      return 'BEGIN';
    },

    buildInsensitiveLike(column: string, paramRef: string): string {
      // COLLATE NOCASE is ASCII-only (no Unicode case folding), documented limit.
      return `${column} LIKE ${paramRef} COLLATE NOCASE`;
    },

    // UNREACHABLE while `supportsJsonContains` is false, and kept deliberately:
    // it is the emulation this dialect would use if the encoding mismatch were
    // repaired, and deleting it would delete the record of what was tried. The
    // param is bound as JSON text (`'"gold"'`) while `json_each.value` yields the
    // decoded SQL value (`gold`), so this predicate never holds for ANY operand.
    // See `supportsJsonContains` in dialect.ts for the measurements and the shape
    // a faithful version needs (`json_each.type` alongside the value).
    buildJsonContains(column: string, paramRef: string): string {
      return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ${paramRef})`;
    },

    buildJsonPathExtract(column: string, pathParamRef: string): string {
      return `json_extract(${column}, ${pathParamRef})`;
    },

    // ---- Type mapping -------------------------------------------------------

    typeToTypeScript(dialectType: string, nullable: boolean): string {
      return sqliteTypeToTs(dialectType, nullable);
    },

    // SQLite has no true array columns; bulk insert uses multi-row VALUES, so no
    // array cast is ever needed. Returning undefined disables the UNNEST path.
    arrayType: undefined,

    // ---- DDL ----------------------------------------------------------------

    buildColumnType(input: ColumnTypeInput): string {
      return sqliteColumnAffinity(input.type);
    },

    /** SQLite has no enum type: a TEXT column, and a CHECK that admits only the labels (compared exactly, BINARY collation). */
    buildEnumColumn(column: string, labels: readonly string[]): { type: string; check: string } {
      const literals = labels.map((label) => `'${label.replace(/'/g, "''")}'`);
      return { type: 'TEXT', check: `${column} IN (${literals.join(', ')})` };
    },

    buildColumnDefinition(input: ColumnDefinitionInput): string {
      const isSerial = /serial/i.test(input.type);
      const parts: string[] = [input.name];
      if (input.primaryKey && isSerial) {
        // The canonical SQLite auto-increment PK (implicitly NOT NULL).
        parts.push('INTEGER PRIMARY KEY AUTOINCREMENT');
      } else {
        parts.push(this.buildColumnType(input));
        if (input.primaryKey) parts.push('PRIMARY KEY');
        if (input.unique && !input.primaryKey) parts.push('UNIQUE');
        if (input.notNull) parts.push('NOT NULL');
      }
      if (input.defaultValue != null) parts.push(`DEFAULT ${input.defaultValue}`);
      if (input.references) parts.push(`REFERENCES ${input.references.table}(${input.references.column})`);
      return parts.join(' ');
    },

    buildCreateIndexStatement(input: CreateIndexStatementInput): string {
      return `CREATE INDEX IF NOT EXISTS ${input.name} ON ${input.table}(${input.columns.join(', ')});`;
    },

    buildCreateTableStatement(input: CreateTableStatementInput): string {
      const body = input.definitions.map((d) => `    ${d}`).join(',\n');
      return `CREATE TABLE ${input.table} (\n${body}\n);`;
    },

    // ---- Migration tracking -------------------------------------------------
    // buildMigrationSelectApplied / UpdateChecksum / InsertApplied / DeleteApplied
    // are inherited from postgresDialect: they call `this.paramPlaceholder(n)`
    // (→ `?`) and `ON CONFLICT (name) DO NOTHING`, both valid SQLite. Only the
    // tracking-table DDL (SERIAL / TIMESTAMPTZ) needs a SQLite-specific override.

    buildMigrationTrackingTable(table: string): string {
      return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
    },

    // ---- Streaming ----------------------------------------------------------

    /**
     * Resolve native iteration on the connection, including transaction and idle
     * wrappers. A query-only shim cannot promise incremental reads.
     *
     * `StatementSync.iterate()` steps synchronously, so return()/timers take
     * effect between pulls and cannot interrupt a running SQLite operation.
     * Batches bound row count, not a row's BLOB/JSON bytes, nested relation
     * fanout, or SQLite's sort workspace; nested data is never truncated.
     * Other callers on this pool wait (up to busyTimeoutMs) until the iterator
     * closes. Use return() on cancellation, or a separate handle for concurrent
     * work. A supplied DatabaseSync remains the caller's to close.
     */
    async *openStream(
      connection: StreamableConnection,
      sql: string,
      params: unknown[],
      batchSize: number,
    ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
      if (!connection.streamBatches)
        throw new UnsupportedFeatureError(
          'Native incremental streaming',
          'sqlite',
          'Use a node:sqlite connection with StatementSync.iterate(); query-only connections cannot stream incrementally.',
        );
      yield* connection.streamBatches(sql, params, batchSize);
    },
  };
}
