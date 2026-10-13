/**
 * Refusals in the schema file and in `columnTypes`.
 *
 * A `tsType` or a `columnTypes` value is written verbatim into `types.ts`, so it
 * has to stay one type: a `//` swallows the rest of the line and a `; }` closes
 * the interface. `defineSchema` also refuses the shapes that used to vanish
 * without a word: a `__proto__` name (the prototype setter) and an index that
 * declares both `columns` and `docField`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generatorColumnTypes } from '../cli/index.js';
import { TurbineErrorCode, ValidationError } from '../errors.js';
import { generate, generateTypes, resolveColumnTypeOverrides } from '../generate.js';
import { mysqlTypeToTs } from '../mysql.js';
import { pgTypeToTs, pgTypeToTsInput } from '../schema.js';
import { column, defineSchema, table, tsTypeTextProblem } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';

/** Types the documentation shows, and the shapes a JSON column is typed with. */
const ACCEPTED = [
  'string',
  '{ theme: string }',
  '{ theme: string; beta?: boolean }',
  "import('../src/types.js').Settings",
  "import('../src/types.js').OrderMeta",
  'Record<string, number>',
  'Array<{ id: number; tags: string[] }>',
  'string[]',
  '[number, string]',
  "'a' | 'b' | 'c'",
  '"quoted" | 1 | -1 | true',
  'Partial<Pick<Foo, "a" | "b">>',
  '(a: string, b?: number) => void',
  '{ [key: string]: unknown }',
  '{ readonly a: 1; b: Foo<Bar<Baz>> }',
  'A extends B ? C : D',
  'keyof typeof thing',
  '{ [K in keyof T]?: T[K] }',
  '{ -readonly [K in keyof T]-?: T[K] }',
  "'it\\'s' | 'a;b' | 'x//y' | 'z/*w'",
  '{ naïve: string }',
  'ReturnType<typeof import("./x.js").make>',
];

/** Each with the part of the reason that must name what is wrong. */
const REFUSED: Array<[text: string, reason: RegExp]> = [
  ['', /empty/],
  ['   ', /empty/],
  ['string\nexport const x = 1', /control or line-separator/],
  ['string x', /control or line-separator/],
  ['string // trailing comment', /"\/" cannot appear/],
  ['string /* c */', /"\/" cannot appear/],
  ['string; }', /";" outside any brackets/],
  ['string, b: number', /"," outside any brackets/],
  ['string } export const x = 1; {', /"\}" closes a bracket that was never opened/],
  ['{ a: string', /bracket is not closed/],
  ['{ a: string ]', /"\]" closes a bracket that was never opened/],
  ['Array<string', /bracket is not closed/],
  ['"unterminated', /string literal is not closed/],
  ["'a\\", /string literal is not closed/],
  ["'a */ b'", /contains "\*\/"/],
  [`\`template $\{x}\``, /template literal/],
  ['string @decorator', /"@" cannot appear/],
  ['string # x', /"#" cannot appear/],
  ['string \\ x', /"\\" cannot appear/],
  ['a ~ b', /"~" cannot appear/],
  ['a % b', /"%" cannot appear/],
  ['a * b', /"\*" cannot appear/],
];

describe('tsTypeTextProblem', () => {
  for (const text of ACCEPTED) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      assert.equal(tsTypeTextProblem(text), null);
    });
  }

  for (const [text, reason] of REFUSED) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      const problem = tsTypeTextProblem(text);
      assert.ok(problem, `${JSON.stringify(text)} was accepted`);
      assert.match(problem, reason);
    });
  }

  it('accepts every type the generator maps a database type to', () => {
    const dbTypes = [
      'int2',
      'int4',
      'int8',
      'float4',
      'float8',
      'oid',
      'numeric',
      'money',
      'bool',
      'text',
      'varchar',
      'char',
      'bpchar',
      'name',
      'uuid',
      'citext',
      'xml',
      'timestamptz',
      'timestamp',
      'date',
      'time',
      'timetz',
      'interval',
      'json',
      'jsonb',
      'bytea',
      'inet',
      'cidr',
      'macaddr',
      'macaddr8',
      'bit',
      'varbit',
      'point',
      'circle',
      'line',
      'lseg',
      'box',
      'path',
      'polygon',
      'tsvector',
      'tsquery',
      'int4range',
      'int8range',
      'numrange',
      'tsrange',
      'tstzrange',
      'daterange',
      'int4multirange',
      'vector',
      'hstore',
      'ltree',
      'some_user_type',
    ];
    let checked = 0;
    for (const t of dbTypes) {
      for (const nullable of [false, true]) {
        for (const wire of [t, `_${t}`]) {
          for (const text of [pgTypeToTs(wire, nullable), pgTypeToTsInput(wire, nullable)]) {
            assert.equal(tsTypeTextProblem(text), null, `${wire} -> ${text}`);
            checked++;
          }
        }
      }
    }
    for (const t of ['int', 'tinyint', 'bigint', 'varchar', 'json', 'datetime', 'blob', 'decimal', 'enum', 'text']) {
      assert.equal(tsTypeTextProblem(mysqlTypeToTs(t, true)), null, `mysql ${t}`);
      checked++;
    }
    assert.ok(checked > 400, `only ${checked} types were checked`);
  });
});

describe('defineSchema refuses a tsType that is not one type', () => {
  const withType = (tsType: string) =>
    defineSchema({ accounts: { id: { type: 'serial', primaryKey: true }, settings: { type: 'jsonb', tsType } } });

  for (const [text, reason] of REFUSED) {
    it(`refuses ${JSON.stringify(text)} with E003, naming the text`, () => {
      assert.throws(
        () => withType(text),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, `thrown ${String(err)} is not a ValidationError`);
          assert.equal(err.code, TurbineErrorCode.VALIDATION);
          assert.match(err.message, /Invalid column "tsType"/);
          assert.ok(
            err.message.includes(JSON.stringify(text)),
            `the message does not show the offending text ${JSON.stringify(text)}: ${err.message}`,
          );
          assert.match(err.message, reason);
          return true;
        },
      );
    });
  }

  it('applies to the fluent form too, as the same error', () => {
    assert.throws(
      () => column.jsonb().tsType('string; }'),
      (err: unknown) => err instanceof ValidationError && /";" outside any brackets/.test(err.message),
    );
    assert.throws(
      () => defineSchema({ a: table({ id: column.serial().primaryKey(), x: column.jsonb().tsType('x // y') }) }),
      ValidationError,
    );
  });

  it('refuses a value that is not a string, and still accepts an absent one', () => {
    assert.throws(
      () => withType(null as unknown as string),
      (err: unknown) => err instanceof ValidationError,
    );
    assert.throws(() => withType(7 as unknown as string), /it is not a string/);
    assert.doesNotThrow(() =>
      defineSchema({ a: { id: { type: 'serial', primaryKey: true }, x: { type: 'jsonb', tsType: undefined } } }),
    );
  });

  for (const text of ACCEPTED) {
    it(`still accepts ${JSON.stringify(text)}`, () => {
      assert.doesNotThrow(() => withType(text));
    });
  }
});

describe('the generator refuses a type that is not one type', () => {
  const def = defineSchema({
    accounts: { id: { type: 'serial', primaryKey: true }, settings: { type: 'jsonb' }, note: { type: 'text' } },
  });
  const meta = () => schemaDefToMetadata(def);

  it('columnTypes: refuses each shape, quoting the text', () => {
    for (const [text, reason] of REFUSED) {
      assert.throws(
        () => resolveColumnTypeOverrides(meta(), { 'accounts.settings': text }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /columnTypes\["accounts\.settings"\] must be one TypeScript type on one line/);
          assert.match(err.message, reason);
          return true;
        },
        JSON.stringify(text),
      );
    }
  });

  it('columnTypes: a refused value does not reach types.ts through generateTypes', () => {
    assert.throws(
      () => generateTypes(meta(), { columnTypes: { 'accounts.settings': 'unknown; }\nexport const pwned = 1;' } }),
      ValidationError,
    );
    assert.throws(
      () => generateTypes(meta(), { columnTypes: { 'accounts.settings': 'unknown // note' } }),
      /"\/" cannot appear/,
    );
  });

  it('columnTypes: accepts the documented examples', () => {
    const out = generateTypes(meta(), {
      noTimestamp: true,
      columnTypes: {
        'accounts.settings': '{ theme: string; beta?: boolean }',
        'accounts.note': "import('./n.js').Note",
      },
    });
    assert.match(out, /\n {2}settings: \{ theme: string; beta\?: boolean \} \| null;/);
    assert.match(out, /\n {2}note: import\('\.\/n\.js'\)\.Note \| null;/);
  });

  it('hand-built metadata: a mapped tsType and a declared one are both checked', () => {
    for (const field of ['tsType', 'declaredTsType'] as const) {
      const m = meta();
      const col = m.tables.accounts?.columns.find((c) => c.name === 'settings');
      assert.ok(col);
      (col as unknown as Record<string, string>)[field] = 'unknown; }';
      assert.throws(
        () => generateTypes(m, { noTimestamp: true }),
        (err: unknown) =>
          err instanceof ValidationError &&
          /column "settings" on table "accounts"/.test(err.message) &&
          /";" outside any brackets/.test(err.message),
        field,
      );
    }
  });

  it('generate() writes nothing when a type is refused', async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    // generate() only writes inside the project root; node_modules is ignored by git.
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.fix-cli-gen-'));
    try {
      assert.throws(
        () =>
          generate({
            schema: meta(),
            outDir: dir,
            columnTypes: { 'accounts.settings': 'unknown // x' },
          }),
        ValidationError,
      );
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defineSchema refuses __proto__', () => {
  it('as a column name from JSON.parse, naming it, instead of dropping the column', () => {
    const input = JSON.parse(
      '{"accounts":{"id":{"type":"serial","primaryKey":true},"__proto__":{"type":"text"},"email":{"type":"text"}}}',
    );
    assert.ok(Object.hasOwn(input.accounts, '__proto__'), 'the fixture must carry an own __proto__ key');
    assert.throws(
      () => defineSchema(input),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === TurbineErrorCode.VALIDATION &&
        /column "accounts\.__proto__" is named "__proto__"/.test(err.message),
    );
  });

  it('as a table name from JSON.parse', () => {
    const input = JSON.parse('{"__proto__":{"id":{"type":"serial","primaryKey":true}},"ok":{"id":{"type":"serial"}}}');
    assert.ok(Object.hasOwn(input, '__proto__'));
    assert.throws(
      () => defineSchema(input),
      (err: unknown) => err instanceof ValidationError && /table "__proto__" is named "__proto__"/.test(err.message),
    );
  });

  it('and a column named after another Object.prototype member still works', () => {
    const def = defineSchema(
      JSON.parse(
        '{"accounts":{"id":{"type":"serial","primaryKey":true},"constructor":{"type":"text"},' +
          '"toString":{"type":"text"},"hasOwnProperty":{"type":"text"}}}',
      ),
    );
    assert.deepEqual(Object.keys(def.tables.accounts?.columns ?? {}).sort(), [
      'constructor',
      'hasOwnProperty',
      'id',
      'toString',
    ]);
  });
});

describe('defineSchema refuses an index that is both kinds', () => {
  it('names the table and the index position', () => {
    for (const bad of [
      { columns: ['email'], docField: 'data', path: ['a'] },
      { columns: ['email'], docField: 'data' },
      { docField: 'data', columns: [] },
    ]) {
      assert.throws(
        () =>
          defineSchema({
            accounts: {
              id: { type: 'serial', primaryKey: true },
              email: { type: 'text' },
              data: { type: 'jsonb' },
              indexes: [{ columns: ['email'] }, bad as never],
            },
          }),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.code === TurbineErrorCode.VALIDATION &&
          /index 1 of table "accounts" declares both "columns" and "docField"/.test(err.message),
        JSON.stringify(bad),
      );
    }
  });

  it('keeps accepting each kind on its own, and emits the column index to SQL', () => {
    const def = defineSchema({
      accounts: {
        id: { type: 'serial', primaryKey: true },
        email: { type: 'text' },
        data: { type: 'jsonb' },
        indexes: [
          { columns: ['email'], unique: true },
          { docField: 'data', path: ['a', 0] },
        ],
      },
    });
    const sql = schemaToSQL(def).join('\n');
    assert.match(sql, /CREATE UNIQUE INDEX "idx_accounts_email"/);
  });
});

describe('generatorColumnTypes and a misspelt table', () => {
  const schema = { tables: { users: {}, posts: {} } } as never;
  const config = (over: Record<string, unknown>) =>
    ({ include: [], exclude: [], columnTypes: {}, ...over }) as Parameters<typeof generatorColumnTypes>[1];
  const everyTable = new Set(['users', 'posts', 'audit_log']);

  it('with include set and the catalog known, a table the database lacks goes on to the generator', () => {
    const merged = generatorColumnTypes(
      null,
      config({ include: ['users'], columnTypes: { 'usrs.settings': 'X' } }),
      { tables: { users: {} } } as never,
      everyTable,
    );
    assert.deepEqual(merged, { 'usrs.settings': 'X' });
  });

  it('and the generator then names the closest table', () => {
    const merged = generatorColumnTypes(
      null,
      config({ include: ['users'], columnTypes: { 'usrs.settings': 'X' } }),
      { tables: { users: {} } } as never,
      everyTable,
    );
    const metadata = schemaDefToMetadata(defineSchema({ users: { id: { type: 'serial', primaryKey: true } } }));
    assert.throws(
      () => resolveColumnTypeOverrides(metadata, merged),
      (err: unknown) => err instanceof ValidationError && /names no table\. Did you mean "users"\?/.test(err.message),
    );
  });

  it('a real table that include leaves out is still skipped', () => {
    const merged = generatorColumnTypes(
      null,
      config({ include: ['users'], columnTypes: { 'audit_log.data': 'X', 'users.meta': 'Y' } }),
      { tables: { users: {} } } as never,
      everyTable,
    );
    assert.deepEqual(merged, { 'users.meta': 'Y' });
  });

  it('a table that exclude names is skipped even when the catalog is unknown', () => {
    const merged = generatorColumnTypes(null, config({ exclude: ['posts'], columnTypes: { 'posts.meta': 'X' } }), {
      tables: { users: {} },
    } as never);
    assert.equal(merged, undefined);
  });

  it('without a catalog the old rule stands', () => {
    const merged = generatorColumnTypes(
      null,
      config({ include: ['users'], columnTypes: { 'usrs.settings': 'X' } }),
      schema,
    );
    assert.equal(merged, undefined);
  });
});
