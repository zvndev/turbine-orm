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
 *  3. A source scan refuses every way of testing a dialect's name outside the
 *     commented allowlist: a comparison (`===`, `Object.is`), a switch, a
 *     membership or own-key test (`.has`, `.includes`, `Object.hasOwn`, `in`),
 *     a keyed lookup, a value read off the name, the name destructured or
 *     aliased, a dialect held under a name the scan cannot follow, and a
 *     comparison with, or a collection of, engine-name literals. Each allowlist
 *     entry pins how many sites it covers, so a new site in an exempt file
 *     fails, and so does an entry whose sites are gone.
 *  4. A hand-built dialect without `capabilities` is refused with the same E003
 *     by every public entry point that takes a dialect.
 *  5. A dialect that keeps an engine's capabilities under another name builds
 *     the same SQL and runs the same `$transaction({ readOnly: true })`, so the
 *     name decides nothing.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TurbineClient } from '../client.js';
import { type Dialect, type EngineCapabilities, postgresDialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { powdbDialect } from '../powdb.js';
import { col } from '../query/column-ref.js';
import { expr } from '../query/expr.js';
import { QueryInterface } from '../query/index.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL, schemaToSQLString } from '../schema-sql.js';
import { turbineHttp } from '../serverless.js';
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
  enforcesForeignKeys: [true, false, true, true, false],
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
  inlineForeignKeys: [true, true, false, true, false],
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
const ENGINE = '(?:postgresql|mysql|sqlite|mssql|powdb)';
const ENGINE_NAME = `['"\`]${ENGINE}['"\`]`;
// A dialect: a property chain ending in an identifier that ends in `dialect`
// or `Dialect` (`dialect`, `this.dialect`, `qi.dialect`, `ctx?.dialect`,
// `sqliteDialect`; `(pool as P).dialect` matches from `dialect` on).
const DIALECT = '(?:[\\w$]+\\??\\.)*[\\w$]*[dD]ialect';
// Its name, dotted, optional-chained or bracketed.
const NAME_REF = `${DIALECT}(?:\\??\\.name(?![\\w$])|\\??\\.?\\[\\s*['"\`]name['"\`]\\s*\\])`;
// A one-line parenthesized expression the dialect is read off: `(pool as P).`
const CAST = '(?:\\([^;\\n]*?\\)\\s*\\??\\.)?';
// An identifier the NAME_REF and DIALECT patterns cannot follow.
const OTHER_NAME = '(?![\\w$]*[dD]ialect(?![\\w$]))[\\w$]+';

/**
 * Every way of testing a dialect's name. The rules run over the whole file, so
 * a test wrapped across lines is still found. The name-shaped rules catch a
 * test of `dialect.name` itself; the alias rules catch the name, or the
 * dialect, moved into a binding the scan cannot follow; the literal rules
 * catch a test of an alias the scan never saw, which has to compare with,
 * switch on, or look up in a collection of engine-name literals.
 */
const RULES: { rule: string; re: RegExp }[] = (
  [
    [
      'dialect.name comparison',
      `${NAME_REF}\\s*[!=]==?|[!=]==?\\s*${NAME_REF}|\\bObject\\.is\\(\\s*(?:[^;]*?,\\s*)?${NAME_REF}`,
    ],
    ['switch on dialect.name', `\\bswitch\\s*\\(\\s*${NAME_REF}`],
    [
      'membership test of dialect.name',
      `\\.(?:has|get|includes|indexOf|lastIndexOf|test|exec|match|search|startsWith|endsWith)\\(\\s*${NAME_REF}`,
    ],
    [
      'own-key test of dialect.name',
      `(?:\\bhasOwn|\\bhasOwnProperty(?:\\.call)?|\\bReflect\\.has)\\s*\\(\\s*(?:[^;]*?,\\s*)?${NAME_REF}`,
    ],
    ['`in` test of dialect.name', `${NAME_REF}\\s+in\\b`],
    ['lookup keyed by dialect.name', `\\[\\s*${NAME_REF}(?=\\s*\\])`],
    ['value derived from dialect.name', `${NAME_REF}\\s*\\??\\.\\s*[\\w$]|${NAME_REF}\\s*\\??\\.?\\[`],
    [
      'dialect.name destructured',
      // `const { name } = dialect`, `({ name }: Dialect)`, `{ dialect: { name } } = qi`
      `\\{[^{}]*\\bname\\b[^{}]*\\}\\s*(?::\\s*[^=;{}()]*?\\bDialect(?![\\w$])|=(?![=>])\\s*${CAST}${DIALECT}(?![\\w$])(?!\\s*\\??[.[]))` +
        `|\\b[dD]ialect\\s*:\\s*\\{[^{}]*\\bname\\b[^{}]*\\}\\s*\\}\\s*(?:=(?![=>])|:)`,
    ],
    [
      'dialect.name aliased',
      // The name as a value: assigned, a property, a default, a ternary arm, a
      // fallback, returned. Passed as an argument (error text) is not an alias.
      `(?:(?:^|[^=!<>])=(?![=>])|=>|\\?(?![.?])|(?<![?:]):(?![:/])|\\breturn\\b|\\?\\?|\\|\\||&&)\\s*${CAST}${NAME_REF}`,
    ],
    [
      'dialect held under another name',
      `\\b(?:const|let|var)\\s+${OTHER_NAME}\\s*(?::[^=;]+)?=(?![=>])\\s*${CAST}${DIALECT}(?![\\w$])(?:\\([^;()]*\\))?` +
        `(?=\\s*(?:[;,)]|\\?\\?|\\|\\||$))` +
        `|\\b(?:const|let|var)\\s*\\{[^{}]*\\b[dD]ialect\\s*:\\s*${OTHER_NAME}` +
        `|\\b${OTHER_NAME}\\??\\s*:\\s*Dialect(?![\\w$])`,
    ],
    [
      'comparison with an engine name',
      `[!=]==?\\s*${ENGINE_NAME}|${ENGINE_NAME}\\s*[!=]==?|\\bcase\\s+${ENGINE_NAME}\\s*:`,
    ],
    [
      'collection of engine names',
      `\\[\\s*${ENGINE_NAME}\\s*[,\\]]|${ENGINE_NAME}\\s*,\\s*${ENGINE_NAME}` +
        `|^[ \\t]*(?:${ENGINE_NAME}|${ENGINE})[ \\t]*\\??:(?![:/])|[{,][ \\t]*(?:${ENGINE_NAME}|\\b${ENGINE})[ \\t]*\\??:(?![:/])`,
    ],
  ] as const
).map(([rule, source]) => ({ rule, re: new RegExp(source, 'gm') }));

/**
 * The engine-name tests that are not capability questions. Each entry names a
 * file, the rule its sites match (and a fragment of the line, when the rule
 * alone would cover other sites in that file), EXACTLY how many lines it
 * covers, and why. The count is the pin: a new site in an exempt file fails
 * the scan the same as one anywhere else, and so does an entry whose sites
 * are gone.
 */
const ALLOWLIST: { file: string; rule: string; contains?: string; count: number; why: string }[] = [
  // Rendering: which SQL text an engine spells, not what it can do. These
  // become per-engine hooks once engines stop spreading postgresDialect (a
  // hook added to PostgreSQL today is inherited by every engine).
  {
    file: 'query/expr.ts',
    rule: 'switch on dialect.name',
    contains: 'switch (qi.dialect.name)',
    count: 2,
    why: 'GREATEST / LEAST and now() rendering',
  },
  {
    file: 'query/expr.ts',
    rule: 'comparison with an engine name',
    contains: "case '",
    count: 8,
    why: 'the cases of those two switches',
  },
  {
    file: 'query/expr.ts',
    rule: 'dialect.name comparison',
    contains: "qi.dialect.name === 'sqlite' ? (kind",
    count: 1,
    why: 'max / min spelling',
  },
  {
    file: 'schema-sql.ts',
    rule: 'switch on dialect.name',
    contains: 'switch (dialect.name)',
    count: 1,
    why: 'column DEFAULT spelling (DDL)',
  },
  {
    file: 'schema-sql.ts',
    rule: 'comparison with an engine name',
    contains: "case '",
    count: 3,
    why: 'the cases of that switch',
  },
  {
    file: 'schema-sql.ts',
    rule: 'dialect.name comparison',
    contains: "dialect.name === 'mysql' ? dialect.buildColumnType",
    count: 1,
    why: 'input to that DDL switch',
  },
  // Error text: the engine's name selects a hint or names the engine in a
  // message, it decides nothing.
  {
    file: 'query/aggregates.ts',
    rule: 'lookup keyed by dialect.name',
    contains: 'PERCENTILE_HINT[qi.dialect.name]',
    count: 1,
    why: 'error hint lookup',
  },
  { file: 'query/aggregates.ts', rule: 'collection of engine names', count: 3, why: 'the PERCENTILE_HINT keys' },
  {
    file: 'query/row-lock.ts',
    rule: 'lookup keyed by dialect.name',
    contains: 'ENGINE_HINT[dialect.name]',
    count: 1,
    why: 'error hint lookup',
  },
  { file: 'query/row-lock.ts', rule: 'collection of engine names', count: 4, why: 'the ENGINE_HINT keys' },
  {
    file: 'checkout.ts',
    rule: 'dialect.name aliased',
    contains: '.dialect?.name;',
    count: 1,
    why: 'the engine named in E017 when a pool cannot check out a connection',
  },
  {
    file: 'client.ts',
    rule: 'dialect.name aliased',
    contains: 'dialect: dialect.name,',
    count: 1,
    why: 'resolveSqlComment names the engine in its E017',
  },
  {
    file: 'query/builder.ts',
    rule: 'dialect.name aliased',
    contains: 'dialect: this.dialect.name,',
    count: 1,
    why: 'resolveSqlComment names the engine in its E017',
  },
  // A dialect under another name, read for its transaction keywords only.
  {
    file: 'pipeline.ts',
    rule: 'dialect held under another name',
    contains: 'const candidate =',
    count: 1,
    why: "the pool's own dialect, read for BEGIN / COMMIT / ROLLBACK",
  },
  {
    file: 'powql.ts',
    rule: 'dialect held under another name',
    contains: 'const d = this.options.dialect;',
    count: 1,
    why: 'read for begin / commit / rollback',
  },
  // Lexers: inside a statement scanner, a branch on the syntax it was handed
  // (`capabilities.statementSyntax`, or an engine entry's own constant) is
  // grammar, not an engine test.
  {
    file: 'sql-placeholders.ts',
    rule: 'comparison with an engine name',
    contains: 'syntax',
    count: 9,
    why: 'placeholder lexer keyed by syntax',
  },
  {
    file: 'transaction-control.ts',
    rule: 'comparison with an engine name',
    contains: 'syntax',
    count: 5,
    why: 'transaction-control lexer keyed by syntax',
  },
  {
    file: 'transaction-control.ts',
    rule: 'collection of engine names',
    count: 4,
    why: 'the per-syntax rule table of that lexer',
  },
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

/**
 * The engine-name tests in `text`. Comment lines are blanked (so line numbers
 * hold) and every rule runs over the whole file. A hit is reported once per
 * line, on the line where its match ends (the one holding the name or the
 * engine literal), under the first rule that matched there.
 */
export function scanSource(file: string, text: string): Hit[] {
  const lines = text.split('\n');
  const code = lines.map((line) => (/^\s*(?:\/\/|\/?\*)/.test(line) ? '' : line)).join('\n');
  const ruleAt = new Map<number, string>();
  for (const { rule, re } of RULES) {
    for (const m of code.matchAll(re)) {
      const end = m.index + m[0].trimEnd().length - 1;
      const line = code.slice(0, end + 1).split('\n').length - 1;
      if (!ruleAt.has(line)) ruleAt.set(line, rule);
    }
  }
  return [...ruleAt]
    .sort(([a], [b]) => a - b)
    .map(([line, rule]) => ({ file, line: line + 1, text: lines[line]!.trim(), rule }));
}

/** The allowlist entry that covers `hit`, if any. */
function exemptionFor(hit: Hit): (typeof ALLOWLIST)[number] | undefined {
  return ALLOWLIST.find(
    (a) => a.file === hit.file && a.rule === hit.rule && (a.contains === undefined || hit.text.includes(a.contains)),
  );
}

describe('source scan: no engine-name tests outside the allowlist', () => {
  const files = sourceFiles(SRC);
  const hits = files.flatMap((path) =>
    scanSource(relative(SRC, path).split('\\').join('/'), readFileSync(path, 'utf8')),
  );
  const pinned = ALLOWLIST.reduce((sum, a) => sum + a.count, 0);

  it('reads the tree', () => {
    assert.ok(files.length >= 50, `only ${files.length} source files: SRC is not src/`);
    assert.ok(hits.length >= pinned, `only ${hits.length} hits for ${pinned} pinned sites: the scan is not matching`);
  });

  it('every engine-name test is a capability, or is allowlisted with a reason', () => {
    const offenders = hits.filter((h) => exemptionFor(h) === undefined);
    assert.deepEqual(
      offenders.map((h) => `${h.file}:${h.line} (${h.rule}): ${h.text}`),
      [],
      'Testing the engine name brings back the inheritance trap: a PostgreSQL-compatible dialect, or a new ' +
        'engine, gets whichever side of the test its name falls on. Ask `dialect.capabilities` instead (add a key ' +
        'to EngineCapabilities in dialect.ts and set it in every engine dialect), or, for rendering, error text or ' +
        'a lexer, add an ALLOWLIST entry here that says why.',
    );
  });

  it('every allowlist entry covers exactly the sites it pins', () => {
    const known = new Set(RULES.map((r) => r.rule));
    const wrong: string[] = [];
    for (const entry of ALLOWLIST) {
      assert.ok(known.has(entry.rule), `ALLOWLIST names an unknown rule: ${entry.rule}`);
      assert.ok(entry.count >= 1, `${entry.file} (${entry.rule}): a count below 1 pins nothing`);
      const covered = hits.filter((h) => exemptionFor(h) === entry);
      if (covered.length !== entry.count) {
        const label = `${entry.file} (${entry.rule}${entry.contains ? `, "${entry.contains}"` : ''})`;
        const sites = covered.map((h) => `\n    ${h.line}: ${h.text}`).join('');
        wrong.push(`${label}: pinned ${entry.count}, found ${covered.length}${sites}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      'An allowlisted file gained or lost a site. A new engine-name test in an exempt file is still an ' +
        'engine-name test: ask a capability instead. If it is rendering, error text or lexer grammar, change the ' +
        'count here and say why; if a site is gone, lower the count or remove the entry.',
    );
  });

  it('flags each shape it is meant to catch, under the rule that names it', () => {
    const shapes: [string, string][] = [
      ["if (qi.dialect.name === 'mysql') return x;", 'dialect.name comparison'],
      ["if ('sqlite' !== this.dialect.name) return;", 'dialect.name comparison'],
      ["if (dialect?.name == 'mysql') return;", 'dialect.name comparison'],
      ["if (Object.is(ctx.dialect.name, 'mysql')) return;", 'dialect.name comparison'],
      ["if (dialect['name'] === 'mysql') return;", 'dialect.name comparison'],
      ['if (this.dialect?.name === other) return;', 'dialect.name comparison'],
      ['if (sqliteDialect.name === engine) return;', 'dialect.name comparison'],
      ['switch (dialect.name) {', 'switch on dialect.name'],
      ['switch (this.dialect?.name) {', 'switch on dialect.name'],
      ['if (ENGINES.has(qi.dialect.name)) return;', 'membership test of dialect.name'],
      ['if (LOCKLESS.includes(dialect.name)) return;', 'membership test of dialect.name'],
      ['if (LOCKLESS.indexOf(ctx.dialect.name) >= 0) return;', 'membership test of dialect.name'],
      ['const limit = LIMITS.get(this.dialect.name);', 'membership test of dialect.name'],
      ['if (/sql/.test(dialect.name)) return;', 'membership test of dialect.name'],
      ['if (Object.hasOwn(HINTS, qi.dialect.name)) return;', 'own-key test of dialect.name'],
      ['if (HINTS.hasOwnProperty(dialect.name)) return;', 'own-key test of dialect.name'],
      ['if (Object.prototype.hasOwnProperty.call(HINTS, dialect.name)) return;', 'own-key test of dialect.name'],
      ['if (Reflect.has(HINTS, ctx.dialect.name)) return;', 'own-key test of dialect.name'],
      ['if (dialect.name in HINTS) return;', '`in` test of dialect.name'],
      ['if (this.dialect?.name in HINTS) return;', '`in` test of dialect.name'],
      ['const n = LIMITS[dialect.name];', 'lookup keyed by dialect.name'],
      ["const n = LIMITS[dialect['name']];", 'lookup keyed by dialect.name'],
      ["if (dialect.name.startsWith('my')) return;", 'value derived from dialect.name'],
      ['const upper = qi.dialect.name.toUpperCase();', 'value derived from dialect.name'],
      ['const { name } = dialect;', 'dialect.name destructured'],
      ['const { name: engine, capabilities } = this.dialect;', 'dialect.name destructured'],
      ['function engineOf({ name }: Dialect) {', 'dialect.name destructured'],
      ['const { dialect: { name } } = qi;', 'dialect.name destructured'],
      ['const engine = dialect.name;', 'dialect.name aliased'],
      ['const engine = qi.dialect?.name ?? "postgresql";', 'dialect.name aliased'],
      ['this.engine = ctx.dialect.name;', 'dialect.name aliased'],
      ['return dialect.name;', 'dialect.name aliased'],
      ['const engineOf = (qi) => qi.dialect.name;', 'dialect.name aliased'],
      ['resolve({ engine: this.dialect.name });', 'dialect.name aliased'],
      ['const label = known ? dialect.name : "other";', 'dialect.name aliased'],
      ['const d = qi.dialect;', 'dialect held under another name'],
      ['const target = (pool as { dialect?: unknown }).dialect;', 'dialect held under another name'],
      ['let current = options?.dialect ?? postgresDialect;', 'dialect held under another name'],
      ['const { dialect: d } = options;', 'dialect held under another name'],
      ['function begin(target: Dialect) {', 'dialect held under another name'],
      ["if (engineName === 'postgresql') return;", 'comparison with an engine name'],
      ["case 'mssql':", 'comparison with an engine name'],
      ['case `powdb`:', 'comparison with an engine name'],
      ["const LOCKLESS = new Set(['sqlite', 'powdb']);", 'collection of engine names'],
      ["const ONLY = ['mssql'];", 'collection of engine names'],
      ["const HINTS = { mysql: 'a', sqlite: 'b' };", 'collection of engine names'],
      ["  postgresql: 'hint',", 'collection of engine names'],
      ["  'mssql': 'hint',", 'collection of engine names'],
    ];
    for (const [shape, rule] of shapes) {
      const found = scanSource('x.ts', shape);
      assert.deepEqual(
        found.map((h) => h.rule),
        [rule],
        `${shape}\n  expected one hit under "${rule}", got ${JSON.stringify(found.map((h) => h.rule))}`,
      );
    }
  });

  it('finds a test wrapped across lines, on the line holding the name', () => {
    const wrapped: [string, number, string][] = [
      ['if (\n  SOME_LONG_SET_OF_ENGINES.has(\n    qi.dialect.name,\n  )\n) {', 3, 'membership test of dialect.name'],
      ['const engine =\n  this.dialect.name;', 2, 'dialect.name aliased'],
      ['const {\n  name,\n  capabilities,\n} = dialect;', 4, 'dialect.name destructured'],
      ['switch (\n  dialect.name\n) {', 2, 'switch on dialect.name'],
      ["const HINTS = {\n  mysql: 'a',\n  sqlite: 'b',\n};", 2, 'collection of engine names'],
    ];
    for (const [shape, line, rule] of wrapped) {
      const found = scanSource('x.ts', shape);
      assert.deepEqual(
        found.slice(0, 1).map((h) => [h.line, h.rule]),
        [[line, rule]],
        `${JSON.stringify(shape)}: got ${JSON.stringify(found)}`,
      );
    }
  });

  it('leaves alone what is not an engine-name test', () => {
    const quiet = [
      '// dialect.name === "mysql" in a comment',
      " * if (ENGINES.has(dialect.name)) in a doc comment, case 'mysql':",
      "throw new UnsupportedFeatureError('x', qi.dialect.name, 'hint');",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal, scanned as text
      'throw new UnsupportedFeatureError(`over the ${qi.dialect.name} limit`);',
      "const message = 'the ' + dialect.name + ' engine';",
      'const caps = this.dialect.capabilities;',
      'const dialect = options?.dialect ?? postgresDialect;',
      'const sqliteDialect = { ...postgresDialect, name: "sqlite" };',
      'constructor(feature: string, dialect: string, hint?: string) {',
      'const config = { dialect: true, pool: true };',
      'if (dialect.capabilities.readOnlyTransactions) return;',
      "const text = rewritePositionalPlaceholders(sql, 'mysql', values.length);",
      "export type DialectName = 'postgresql' | 'mysql' | 'sqlite';",
      "const url = 'postgresql://u:p@localhost:5432/db';",
      'const table = { name: "users" };',
    ];
    for (const shape of quiet) {
      assert.deepEqual(scanSource('x.ts', shape), [], `flagged: ${shape}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('a dialect without capabilities', () => {
  const schema = { tables: {}, enums: {} };
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}), end: async () => {}, on: () => {} };
  const usersDef = defineSchema({ users: { id: { type: 'serial', primaryKey: true } } } as never);
  const usersMeta = schemaDefToMetadata(usersDef);
  // Nothing listens on port 1: an entry point that skipped the check would
  // fail here with a connection error instead of E003.
  const unreachable = 'postgresql://u:p@127.0.0.1:1/none';

  // Every public entry point that takes a dialect. A dialect written against
  // the shape before `capabilities` existed must be refused by each one, with
  // the same E003 and the same words, before anything reads it (a TypeError)
  // or opens a connection.
  const entryPoints: [string, (dialect: Dialect) => unknown][] = [
    ['new TurbineClient', (dialect) => new TurbineClient({ pool, dialect } as never, schema)],
    ['turbineHttp', (dialect) => turbineHttp(pool as never, schema, { dialect })],
    ['new QueryInterface', (dialect) => new QueryInterface(null as never, 'users', usersMeta, undefined, { dialect })],
    ['schemaToSQL', (dialect) => schemaToSQL(usersDef, { dialect })],
    ['schemaToSQLString', (dialect) => schemaToSQLString(usersDef, { dialect })],
    ['introspect', (dialect) => introspect({ connectionString: unreachable, dialect })],
  ];

  async function refusal(enter: () => unknown): Promise<Error | undefined> {
    try {
      await enter();
    } catch (err) {
      return err as Error;
    }
    return undefined;
  }

  const { capabilities: _dropped, ...bare } = postgresDialect;
  const handmade = { ...bare, name: 'handmade' } as unknown as Dialect;
  // The docs link follows the text, so the comparison stops at the text.
  const expected =
    '[TURBINE_E003] The dialect "handmade" has no `capabilities` object, which says what the engine can do. ' +
    'Build it from an engine dialect (`{ ...postgresDialect, name, capabilities: { ... } }`) and state every ' +
    'EngineCapabilities key.';

  for (const [label, enter] of entryPoints) {
    it(`${label} refuses it with E003`, async () => {
      const err = await refusal(() => enter(handmade));
      assert.ok(err instanceof ValidationError, `${label}: expected ValidationError (E003), got ${String(err)}`);
      assert.equal(err.code, 'TURBINE_E003');
      assert.equal(err.message.slice(0, expected.length), expected, `${label}: a different message`);
    });
  }

  it('a null `capabilities` is refused the same way', async () => {
    const nulled = { ...bare, name: 'handmade', capabilities: null } as unknown as Dialect;
    for (const [label, enter] of entryPoints) {
      const err = await refusal(() => enter(nulled));
      assert.ok(err instanceof ValidationError, `${label}: expected ValidationError (E003), got ${String(err)}`);
      assert.equal(err.message.slice(0, expected.length), expected, `${label}: a different message`);
    }
  });

  it('a dialect built from an engine dialect is accepted', () => {
    const mine = { ...sqliteDialect, name: 'mine' } as unknown as Dialect;
    const db = new TurbineClient({ pool, dialect: mine } as never, schema);
    assert.equal((db as unknown as { dialect: Dialect }).dialect.capabilities, sqliteDialect.capabilities);
    new QueryInterface(null as never, 'users', usersMeta, undefined, { dialect: mine });
    assert.ok(schemaToSQL(usersDef, { dialect: mine }).length > 0);
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
    ['expr add', (q) => q.buildUpdate({ where: { id: 1 }, data: { age: expr.add(col('age'), 1) } } as never)],
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

  // The documented exception: expr.now(), expr.greatest() and expr.least() are
  // spelled per engine name, so a renamed dialect is refused (E017) rather than
  // handed another engine's spelling. The fallback used to be SQL Server's.
  const spelledByName: [string, (q: QueryInterface<Record<string, unknown>>) => unknown][] = [
    ['now', (q) => q.buildUpdate({ where: { id: 1 }, data: { born: expr.now() } } as never)],
    ['greatest', (q) => q.buildUpdate({ where: { id: 1 }, data: { age: expr.greatest(col('age'), 1) } } as never)],
    ['least', (q) => q.buildUpdate({ where: { id: 1 }, data: { age: expr.least(col('age'), 1) } } as never)],
  ];
  for (const [engine, dialect] of Object.entries(ENGINES)) {
    if (!dialect.capabilities.updateExpressions) continue;
    it(`${engine}: expr.now / greatest / least build under the engine name and refuse under another`, () => {
      const renamed = { ...dialect, name: `${engine}-compatible` } as unknown as Dialect;
      for (const [label, op] of spelledByName) {
        const shipped = build(dialect, op) as { sql?: string };
        assert.equal(typeof shipped.sql, 'string', `${engine} ${label}: the shipped dialect should build it`);
        assert.deepEqual(build(renamed, op), { error: 'TURBINE_E017' }, `${engine} ${label}: renamed must be E017`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The name decides no transaction
// ---------------------------------------------------------------------------

describe("a dialect renamed from an engine dialect runs that engine's transactions", () => {
  /** What `$transaction({ readOnly: true })` sends on `dialect`, or the code it fails with. */
  async function readOnlyTransaction(dialect: Dialect): Promise<{ sent: string[] } | { error: string }> {
    const sent: string[] = [];
    const query = async (sql: string) => {
      sent.push(sql);
      return { rows: [], rowCount: 0 };
    };
    const client = { query, release: () => {} };
    const pool = { query, connect: async () => client, end: async () => {}, on: () => {} };
    try {
      const db = new TurbineClient({ pool, dialect } as never, { tables: {}, enums: {} });
      await db.$transaction(async () => {}, { readOnly: true });
      return { sent };
    } catch (err) {
      // The engine name appears in the E017 message, so compare the code and
      // the refused feature, which also shows the refusal came from `readOnly`.
      const { code, feature } = err as { code?: string; feature?: string };
      return { error: `${code ?? (err as Error).name}${feature ? `: ${feature}` : ''}` };
    }
  }

  // What each shipped engine does, so a renamed copy agreeing with a broken
  // original cannot pass: PostgreSQL and MySQL open a read-only transaction,
  // the engines without one refuse it.
  const SHIPPED: Record<string, { sent: string[] } | { error: string }> = {
    postgresql: { sent: ['BEGIN READ ONLY', 'COMMIT'] },
    mysql: { sent: ['START TRANSACTION READ ONLY', 'COMMIT'] },
    sqlite: { error: 'TURBINE_E017: $transaction({ readOnly: true })' },
    mssql: { error: 'TURBINE_E017: $transaction({ readOnly: true })' },
    powdb: { error: 'TURBINE_E017: $transaction({ readOnly: true })' },
  };

  for (const [engine, dialect] of Object.entries(ENGINES)) {
    it(`${engine}: $transaction({ readOnly: true }) follows readOnlyTransactions, not the name`, async () => {
      assert.deepEqual(await readOnlyTransaction(dialect), SHIPPED[engine], `${engine}: the shipped dialect`);
      const renamed = { ...dialect, name: `${engine}-compatible` } as unknown as Dialect;
      assert.deepEqual(
        await readOnlyTransaction(renamed),
        SHIPPED[engine],
        `${engine}-compatible: the name changed what the transaction did`,
      );
    });
  }
});
