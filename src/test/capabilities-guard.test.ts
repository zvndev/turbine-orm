/**
 * turbine-orm, explicit engine capabilities: the guards.
 *
 * Every engine dialect is built by spreading `postgresDialect`, so a flag on
 * PostgreSQL is inherited by every engine that does not override it. The
 * `capabilities` object closes that for the questions it answers, and these
 * tests keep it closed:
 *
 *  1. Every engine dialect sets its OWN `capabilities` (not inherited, not
 *     PostgreSQL's object), frozen, with exactly the same keys.
 *  2. The values are pinned per engine, so flipping one is a decision made
 *     here as well as in the engine file.
 *  3. A source scan refuses a new engine-name comparison (`dialect.name ===`,
 *     `switch (dialect.name)`, `Set.has(dialect.name)`, `MAP[dialect.name]`, a
 *     comparison with an engine-name literal) outside the commented allowlist.
 *  4. A hand-built dialect without `capabilities` is refused at construction.
 *  5. A dialect that keeps an engine's capabilities under another name builds
 *     the same SQL, so the name decides nothing the builder emits.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TurbineClient } from '../client.js';
import { type Dialect, type EngineCapabilities, postgresDialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { powdbDialect } from '../powdb.js';
import { QueryInterface } from '../query/index.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { sqliteDialect } from '../sqlite.js';

const ENGINES: Record<string, Dialect> = {
  postgresql: postgresDialect,
  sqlite: sqliteDialect,
  mysql: mysqlDialect,
  mssql: mssqlDialect,
  powdb: powdbDialect,
};

const INF = Number.POSITIVE_INFINITY;

// One column per engine, in ENGINES order: postgresql, sqlite, mysql, mssql, powdb.
const EXPECTED: { [K in keyof EngineCapabilities]: readonly EngineCapabilities[K][] } = {
  distinctOn: [true, false, false, false, false],
  positionalJson: [true, false, false, false, false],
  nullsOrderingClause: [true, true, false, false, false],
  nullsSortHigh: [true, false, false, false, false],
  insensitiveInList: [true, false, false, false, false],
  jsonDocumentEquality: ['jsonb', 'text', 'exact', 'text', 'text'],
  jsonExtractTyped: [false, true, false, false, false],
  jsonExactNumericCast: [true, false, false, false, false],
  numericTextComparison: [false, false, true, false, false],
  enforcesForeignKeys: [true, false, true, true, true],
  partitionLimitPushdown: [true, false, false, false, false],
  utcTimestampRewrite: [true, false, false, false, false],
  paramTypeCasts: [true, false, false, false, false],
  namedEnumTypes: [true, false, false, false, false],
  structuredValueColumns: ['pg-scalars', 'scalars', 'scalars-and-text', 'scalars', 'scalars'],
  maxBindParameters: [65535, 32766, 65535, 2098, INF],
  maxInsertRows: [INF, INF, INF, 1000, INF],
  upsertConflictTarget: ['explicit', 'explicit', 'any-unique-key', 'explicit', 'explicit'],
  setClauseOrder: ['snapshot', 'snapshot', 'left-to-right', 'snapshot', 'snapshot'],
  reselectLocksRows: [false, false, true, false, false],
  integerDivision: ['/', '/', 'DIV', '/', '/'],
  updateExpressions: [true, true, true, true, false],
  bulkUpsertAppliesRepeatedKeys: [false, true, true, false, false],
  readOnlyTransactions: [true, false, true, false, false],
  connectionParameters: [true, false, false, false, false],
  backendCancel: [true, false, false, false, false],
  idleTransactionTimeout: [true, false, false, false, false],
  abortsTransactionOnError: [true, false, false, false, false],
  connectionDriver: ['pg-compatible', 'engine-driver', 'engine-driver', 'engine-driver', 'none'],
  preparesEveryStatement: [false, false, true, false, false],
  statementSyntax: ['postgresql', 'sqlite', 'mysql', 'mssql', null],
  inlineForeignKeys: [true, true, false, true, true],
  unboundedTextKeys: [true, true, false, false, true],
};

describe('every engine dialect states its own capabilities', () => {
  const pgKeys = Object.keys(postgresDialect.capabilities).sort();

  for (const [engine, dialect] of Object.entries(ENGINES)) {
    it(`${engine}: capabilities is an own, frozen object with every key`, () => {
      assert.ok(
        Object.hasOwn(dialect, 'capabilities'),
        `${engine}Dialect inherits \`capabilities\` through the spread of postgresDialect. ` +
          `Give it its own \`capabilities: Object.freeze({ ... } satisfies EngineCapabilities)\`.`,
      );
      if (dialect !== postgresDialect) {
        assert.notEqual(
          dialect.capabilities,
          postgresDialect.capabilities,
          `${engine}Dialect.capabilities is PostgreSQL's object. State every capability for ${engine} in a fresh literal.`,
        );
      }
      assert.ok(Object.isFrozen(dialect.capabilities), `${engine}Dialect.capabilities is not frozen`);
      assert.deepEqual(Object.keys(dialect.capabilities).sort(), pgKeys, `${engine} has a different key set`);
    });
  }

  it('covers every engine dialect that spreads postgresDialect', () => {
    // A new engine dialect must be added to ENGINES, or none of the above
    // asserts anything about it.
    assert.deepEqual(Object.keys(ENGINES).sort(), ['mssql', 'mysql', 'postgresql', 'powdb', 'sqlite']);
    assert.ok(pgKeys.length >= 30, `only ${pgKeys.length} capabilities: the list is not being read`);
  });

  it('pins every value per engine', () => {
    assert.deepEqual(Object.keys(EXPECTED).sort(), pgKeys, 'EXPECTED does not list every capability');
    const names = Object.keys(ENGINES);
    for (const [key, values] of Object.entries(EXPECTED)) {
      names.forEach((engine, i) => {
        const actual = (ENGINES[engine]!.capabilities as unknown as Record<string, unknown>)[key];
        assert.equal(actual, values[i], `${engine}.capabilities.${key} is ${String(actual)}, expected ${values[i]}`);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_NAME = "'(?:postgresql|mysql|sqlite|mssql|powdb)'";
const NAME_REF = '(?:[\\w$]+\\??\\.)*dialect\\??\\.name';

const RULES: { rule: string; re: RegExp }[] = [
  { rule: 'dialect.name comparison', re: new RegExp(`${NAME_REF}\\s*[!=]==?|[!=]==?\\s*${NAME_REF}\\b`) },
  { rule: 'switch on dialect.name', re: new RegExp(`switch\\s*\\(\\s*${NAME_REF}\\s*\\)`) },
  { rule: 'Set.has(dialect.name)', re: new RegExp(`\\.has\\(\\s*${NAME_REF}\\s*\\)`) },
  { rule: 'lookup keyed by dialect.name', re: new RegExp(`\\[\\s*${NAME_REF}\\s*\\]`) },
  {
    rule: 'comparison with an engine name',
    re: new RegExp(`[!=]==?\\s*${ENGINE_NAME}|${ENGINE_NAME}\\s*[!=]==?|case\\s+${ENGINE_NAME}\\s*:`),
  },
];

/**
 * The engine-name comparisons that are not capability questions. Each entry
 * names a file, a fragment of the matching line, and why. An entry that no
 * longer matches anything fails the scan, so the list cannot go stale.
 */
const ALLOWLIST: { file: string; contains: string; why: string }[] = [
  // Rendering: which SQL text an engine spells, not what it can do. These
  // become per-engine hooks once engines stop spreading postgresDialect (a
  // hook added to PostgreSQL today is inherited by every engine).
  { file: 'query/expr.ts', contains: 'switch (qi.dialect.name)', why: 'GREATEST / LEAST and now() rendering' },
  { file: 'query/expr.ts', contains: "case 'postgresql':", why: 'GREATEST / LEAST and now() rendering' },
  { file: 'query/expr.ts', contains: "case 'mssql':", why: 'GREATEST / LEAST rendering' },
  { file: 'query/expr.ts', contains: "case 'mysql':", why: 'now() rendering' },
  { file: 'query/expr.ts', contains: "case 'sqlite':", why: 'now() rendering' },
  { file: 'query/expr.ts', contains: "qi.dialect.name === 'sqlite' ? (kind", why: 'max / min spelling' },
  { file: 'schema-sql.ts', contains: 'switch (dialect.name)', why: 'column DEFAULT spelling (DDL)' },
  { file: 'schema-sql.ts', contains: "case 'sqlite':", why: 'column DEFAULT spelling (DDL)' },
  { file: 'schema-sql.ts', contains: "case 'mysql':", why: 'column DEFAULT spelling (DDL)' },
  { file: 'schema-sql.ts', contains: "case 'mssql':", why: 'column DEFAULT spelling (DDL)' },
  {
    file: 'schema-sql.ts',
    contains: "dialect.name === 'mysql' ? dialect.buildColumnType",
    why: 'input to that DDL switch',
  },
  // Error text: the engine's name selects a hint, it decides nothing.
  { file: 'query/aggregates.ts', contains: 'PERCENTILE_HINT[qi.dialect.name]', why: 'error hint lookup' },
  { file: 'query/row-lock.ts', contains: 'ENGINE_HINT[dialect.name]', why: 'error hint lookup' },
  // Lexers: inside a statement scanner, a branch on the syntax it was handed
  // (`capabilities.statementSyntax`, or an engine entry's own constant) is
  // grammar, not an engine test.
  { file: 'sql-placeholders.ts', contains: 'syntax', why: 'placeholder lexer keyed by syntax' },
  { file: 'transaction-control.ts', contains: 'syntax', why: 'transaction-control lexer keyed by syntax' },
];

interface Hit {
  file: string;
  line: number;
  text: string;
  rule: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test') out.push(...sourceFiles(path));
    } else if (/\.(?:ts|cts|mts)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Engine-name comparisons in `text`, comment lines skipped. */
export function scanSource(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
    for (const { rule, re } of RULES) {
      if (re.test(line)) {
        hits.push({ file, line: i + 1, text: line, rule });
        break;
      }
    }
  });
  return hits;
}

function allowed(hit: Hit): boolean {
  return ALLOWLIST.some((a) => a.file === hit.file && hit.text.includes(a.contains));
}

describe('source scan: no engine-name branches outside the allowlist', () => {
  const hits = sourceFiles(SRC).flatMap((path) =>
    scanSource(relative(SRC, path).split('\\').join('/'), readFileSync(path, 'utf8')),
  );

  it('finds the allowlisted sites, so the scan is reading the tree', () => {
    assert.ok(hits.length >= ALLOWLIST.length, `only ${hits.length} hits: the scan matched nothing it should`);
  });

  it('every engine-name branch is a capability, or is allowlisted with a reason', () => {
    const offenders = hits.filter((h) => !allowed(h));
    assert.deepEqual(
      offenders.map((h) => `${h.file}:${h.line} (${h.rule}): ${h.text}`),
      [],
      'Branching on the engine name brings back the inheritance trap: a PostgreSQL-compatible dialect, or a new ' +
        'engine, gets whichever side of the test its name falls on. Ask `dialect.capabilities` instead (add a key ' +
        'to EngineCapabilities in dialect.ts and set it in every engine dialect), or, for rendering, error text or ' +
        'a lexer, add an ALLOWLIST entry here that says why.',
    );
  });

  it('every allowlist entry still matches a site', () => {
    const stale = ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && h.text.includes(a.contains)));
    assert.deepEqual(stale, [], 'Remove allowlist entries whose site is gone.');
  });

  it('flags each shape it is meant to catch', () => {
    const shapes = [
      "if (qi.dialect.name === 'mysql') return x;",
      "if ('sqlite' !== this.dialect.name) return;",
      'switch (dialect.name) {',
      'if (ENGINES.has(qi.dialect.name)) return;',
      'const n = LIMITS[dialect.name];',
      "if (engineName === 'postgresql') return;",
      "case 'mssql':",
    ];
    for (const shape of shapes) {
      assert.equal(scanSource('x.ts', shape).length, 1, `not flagged: ${shape}`);
    }
    assert.equal(scanSource('x.ts', '// dialect.name === "mysql" in a comment').length, 0);
    assert.equal(scanSource('x.ts', "throw new UnsupportedFeatureError('x', qi.dialect.name, 'hint');").length, 0);
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('a dialect without capabilities', () => {
  const schema = { tables: {}, enums: {} };
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}), end: async () => {}, on: () => {} };

  it('is refused at construction with E003', () => {
    const { capabilities: _dropped, ...bare } = postgresDialect;
    assert.throws(
      () => new TurbineClient({ pool, dialect: { ...bare, name: 'handmade' } as unknown as Dialect } as never, schema),
      (err: unknown) =>
        err instanceof ValidationError && /"handmade" has no `capabilities` object/.test((err as Error).message),
    );
  });

  it('a dialect built from an engine dialect is accepted', () => {
    const db = new TurbineClient({ pool, dialect: { ...sqliteDialect, name: 'mine' } } as never, schema);
    assert.equal((db as unknown as { dialect: Dialect }).dialect.capabilities, sqliteDialect.capabilities);
  });
});

// ---------------------------------------------------------------------------
// The name decides no emitted SQL
// ---------------------------------------------------------------------------

describe("a dialect renamed from an engine dialect builds that engine's SQL", () => {
  const meta = schemaDefToMetadata(
    defineSchema(
      {
        users: {
          id: { type: 'serial', primaryKey: true },
          email: { type: 'text', notNull: true, unique: true },
          name: { type: 'text', nullable: true },
          age: { type: 'integer', nullable: true },
          born: { type: 'date', nullable: true },
          meta: { type: 'jsonb', nullable: true },
          status: { type: 'enum', enumName: 'user_status', nullable: true },
          orgId: { type: 'integer', nullable: true, references: 'orgs.id' },
        },
        orgs: { id: { type: 'serial', primaryKey: true }, slug: { type: 'text', notNull: true, unique: true } },
        posts: {
          id: { type: 'serial', primaryKey: true },
          userId: { type: 'integer', notNull: true, references: 'users.id' },
          title: { type: 'text', notNull: true },
        },
      } as never,
      { enums: { user_status: ['active', 'banned'] } } as never,
    ),
  );

  // Each op asks at least one capability question; none reaches an
  // allowlisted rendering switch (expr.greatest / expr.now, DDL defaults).
  const ops: [string, (q: QueryInterface<Record<string, unknown>>) => { sql: string; params: unknown[] }][] = [
    ['with', (q) => q.buildFindMany({ with: { posts: { orderBy: { title: 'asc' }, limit: 2 } }, limit: 5 } as never)],
    ['distinct', (q) => q.buildFindMany({ distinct: ['email'], orderBy: { email: 'asc' } } as never)],
    ['in insensitive', (q) => q.buildFindMany({ where: { email: { in: ['A'], mode: 'insensitive' } } } as never)],
    ['json equals', (q) => q.buildFindMany({ where: { meta: { equals: { a: 1 } } } } as never)],
    ['json path', (q) => q.buildFindMany({ where: { meta: { path: ['a'], equals: 1 } } } as never)],
    ['date', (q) => q.buildFindMany({ where: { born: { gt: new Date(0) } } } as never)],
    ['text vs number', (q) => q.buildFindMany({ where: { email: 0 } } as never)],
    [
      'cursor',
      (q) => q.buildFindMany({ cursor: { id: 3 }, orderBy: [{ name: 'asc' }, { id: 'asc' }], limit: 2 } as never),
    ],
    ['fk fold', (q) => q.buildDeleteMany({ where: { orgId: { not: null } } } as never)],
    ['create enum', (q) => q.buildCreate({ data: { email: 'a', status: 'active' } } as never)],
    ['divide', (q) => q.buildUpdate({ where: { id: 1 }, data: { age: { divide: 2 } } } as never)],
    ['upsert', (q) => q.buildUpsert({ where: { email: 'a' }, create: { email: 'a' }, update: { name: 'b' } } as never)],
    ['createMany', (q) => q.buildCreateMany({ data: [{ email: 'a' }, { email: 'b' }] } as never)],
  ];

  function build(dialect: Dialect, op: (q: QueryInterface<Record<string, unknown>>) => unknown): unknown {
    // biome-ignore lint/suspicious/noExplicitAny: build-only, no pool
    const q = new QueryInterface<Record<string, unknown>>(null as any, 'users', meta, undefined, {
      dialect,
      sqlCache: false,
      preparedStatements: false,
      warnOnUnlimited: false,
    });
    try {
      const d = op(q) as { sql: string; params: unknown[] };
      return { sql: d.sql, params: d.params };
    } catch (err) {
      // The engine name appears in some messages, so compare the code only.
      return { error: (err as { code?: string }).code ?? (err as Error).name };
    }
  }

  for (const [engine, dialect] of Object.entries(ENGINES)) {
    it(engine, () => {
      const renamed = { ...dialect, name: `${engine}-compatible` } as unknown as Dialect;
      const built = ops.map(([label, op]) => [label, build(dialect, op)]);
      const compiled = built.filter(([, out]) => typeof (out as { sql?: unknown }).sql === 'string').length;
      assert.ok(compiled >= 8, `only ${compiled} of ${ops.length} ops built SQL: the comparison is mostly vacuous`);
      for (const [label, op] of ops) {
        assert.deepEqual(build(renamed, op), build(dialect, op), `${engine} ${label}: the name changed the SQL`);
      }
    });
  }
});
