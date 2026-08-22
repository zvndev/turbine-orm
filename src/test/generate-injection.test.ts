/**
 * turbine-orm - code generator injection tests
 *
 * The code generator turns DATABASE CATALOG STRINGS into TypeScript that the
 * user then `import`s, i.e. EXECUTES. Postgres permits any character in a
 * double-quoted identifier up to 63 bytes, so a catalog name is attacker-
 * controlled text the moment anyone but the DBA can create an object, and three
 * emission positions used to hand it straight to the parser:
 *
 *   - object-KEY position, `{ name: v }` with `name` interpolated raw. A key
 *     inside brackets is a COMPUTED key, evaluated when the object literal is
 *     constructed, so an enum type named `[Function('...')()+'x']` ran its
 *     payload on import. Reproduced end to end before this fix.
 *   - string-LITERAL position, wrapped in quotes but escaped only for `\` and
 *     `'`, so a raw newline left the literal unterminated and put the rest of
 *     the name on a new source LINE.
 *   - JSDoc position, where a name containing the block-comment terminator
 *     closed the comment and put the rest in code position.
 *
 * Every assertion here is written to fail if the fix is reverted, and the
 * detector itself carries a POSITIVE CONTROL (`runs a computed key when it is
 * actually there`) so "no payload fired" can never mean "nothing ran".
 *
 * Run: npx tsx --test src/test/generate-injection.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { generateIndex, generateMetadata, generateTypes, generateZod } from '../generate.js';
import { assertSafeCatalogSchema } from '../introspect.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** Prefix of every global a payload tries to set. Never legitimately emitted. */
const MARKER = '__TURBINE_INJECTION_MARKER';

interface Payload {
  /** Short label for test names. */
  readonly kind: string;
  /** The hostile catalog string. */
  readonly text: string;
  /** The global this payload sets IF it reaches expression position. */
  readonly marker: string;
}

/**
 * The four escape primitives, each carrying a marker unique to the slot it is
 * planted in, so a fired payload identifies both WHICH sink leaked and HOW.
 */
function payloadsFor(slot: string): Payload[] {
  const mark = (kind: string) => `${MARKER}_${slot}_${kind}`;
  return [
    {
      kind: 'computed-key',
      marker: mark('computed'),
      // The reproduced exploit: brackets around an IIFE in object-key position.
      text: `[Function('globalThis.${mark('computed')}=1')()+'x']`,
    },
    {
      kind: 'single-quote',
      marker: mark('quote'),
      // Closes a hand-quoted key or value and reopens in expression position.
      text: `a': (globalThis.${mark('quote')} = 1), 'b`,
    },
    {
      kind: 'block-comment-terminator',
      marker: mark('comment'),
      // Ends a JSDoc line early, putting the payload in code position.
      text: `x*/ globalThis.${mark('comment')} = 1; /*y`,
    },
    {
      kind: 'newline',
      marker: mark('newline'),
      // Unterminates a single-quoted literal and starts a new source line.
      text: `p\nglobalThis.${mark('newline')} = 1;\nq`,
    },
  ];
}

/** The five catalog slots the generator reads names from. */
const SLOTS = ['table', 'column', 'enumType', 'enumLabel', 'relation'] as const;
type Slot = (typeof SLOTS)[number];

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

function col(name: string, field = name, pgType = 'text', tsType = 'string'): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '' };
}

function tableOf(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
  return {
    name,
    columns,
    columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
    dateColumns: new Set<string>(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

const idCol = col('id', 'id', 'int4', 'number');

function relationTo(name: string, to: string): RelationDef {
  return { type: 'hasMany', name, from: 'things', to, foreignKey: 'thing_id', referenceKey: 'id' };
}

/** A schema with exactly ONE hostile slot, so a failure names the sink. */
function schemaWithHostile(slot: Slot, text: string): SchemaMetadata {
  switch (slot) {
    case 'table':
      return { enums: {}, tables: { [text]: tableOf(text, [idCol]) } };
    case 'column':
      return { enums: {}, tables: { things: tableOf('things', [idCol, col(text)]) } };
    case 'enumType':
      return { enums: { [text]: ['calm', 'eager'] }, tables: { things: tableOf('things', [idCol]) } };
    case 'enumLabel':
      return { enums: { mood: ['calm', text] }, tables: { things: tableOf('things', [idCol]) } };
    case 'relation':
      return {
        enums: {},
        tables: {
          things: tableOf('things', [idCol], { [text]: relationTo(text, 'things') }),
          // A second table so the relation target resolves to a real entity.
          others: tableOf('others', [idCol]),
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Rewrite a generated `metadata.ts` into runnable JavaScript and EXECUTE it in
 * a fresh vm context, returning that context.
 *
 * The three rewrites are exact strings the generator itself emits, and each one
 * is asserted to have matched. That precondition is the difference between this
 * test and a vacuous one: if the generator's preamble changes, the transform
 * fails loudly instead of silently evaluating something that is no longer the
 * generated file.
 */
function runMetadata(source: string): vm.Context {
  const typeImport = "import type { SchemaMetadata } from 'turbine-orm';\n";
  const decl = 'export const SCHEMA: SchemaMetadata = {';
  const alias = 'export const schema = SCHEMA;';
  assert.equal(source.split(typeImport).length - 1, 1, 'metadata.ts no longer opens with the type-only import');
  assert.equal(source.split(decl).length - 1, 1, 'metadata.ts no longer declares SCHEMA the way this test rewrites');
  assert.equal(source.split(alias).length - 1, 1, 'metadata.ts no longer emits the lowercase alias');

  const js = source.replace(typeImport, '').replace(decl, 'globalThis.SCHEMA = {').replace(alias, ';');
  const context = vm.createContext({});
  vm.runInContext(js, context, { timeout: 5_000 });
  return context;
}

/** Every `__TURBINE_INJECTION_MARKER*` global a run left behind. */
function firedMarkers(context: vm.Context): string[] {
  return Object.getOwnPropertyNames(context).filter((k) => k.startsWith(MARKER));
}

/**
 * Assert a snippet is syntactically valid TypeScript by running the `tsc`
 * BINARY over it. Mirrors `assertParses` in generate-compound-selectors.test.ts
 * (the compiler API moved in TypeScript 7; the binary is version-stable). Only
 * SYNTAX errors count: the generated file imports `turbine-orm`, which does not
 * resolve from a temp directory, so semantic diagnostics are expected.
 */
function assertParses(source: string, filename: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-inject-'));
  try {
    writeFileSync(join(dir, filename), source);
    const tsc = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsc');
    // `cwd: dir` matters: run from the repo root and tsc finds the repo's own
    // tsconfig.json, refuses the combination (TS5112), and checks NOTHING.
    const result = spawnSync(tsc, ['--noEmit', '--skipLibCheck', filename], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, `tsc did not run: ${result.error}`);
    const setupErrors = output.split('\n').filter((line) => /error TS[56]\d{3}:/.test(line));
    assert.deepEqual(setupErrors, [], `tsc failed before reading the source, so nothing was checked:\n${output}`);
    const syntaxErrors = output.split('\n').filter((line) => /error TS1\d{3}:/.test(line));
    assert.deepEqual(syntaxErrors, [], `expected valid TS, got:\n${syntaxErrors.join('\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Compile a generated `types.ts` and assert the EMITTED JAVASCRIPT is TYPE-ONLY.
 *
 * This is the decisive check for the types.ts sink, and it is stronger than
 * grepping the source: types.ts is supposed to contain interfaces and type
 * aliases and nothing else, so ANY statement in the compiler's JS output is an
 * injected one. Measured against the pre-fix generator, the same fixture emits
 * `globalThis.<marker> = 1;` into types.js as real, runnable code.
 *
 * `tsc` emits despite the unresolvable `turbine-orm` import (TS2307 is
 * semantic, and `noEmitOnError` is off), so the emit is available either way.
 */
function assertTypeOnlyEmit(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-emit-'));
  try {
    writeFileSync(join(dir, 'types.ts'), source);
    const tsc = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsc');
    const args = ['--skipLibCheck', '--module', 'esnext', '--target', 'es2022', '--outDir', 'out', 'types.ts'];
    const result = spawnSync(tsc, args, { cwd: dir, encoding: 'utf-8', timeout: 120_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, `tsc did not run: ${result.error}`);
    const setupErrors = output.split('\n').filter((line) => /error TS[56]\d{3}:/.test(line));
    assert.deepEqual(setupErrors, [], `tsc failed before reading the source, so nothing was checked:\n${output}`);
    const syntaxErrors = output.split('\n').filter((line) => /error TS1\d{3}:/.test(line));
    assert.deepEqual(syntaxErrors, [], `expected valid TS, got:\n${syntaxErrors.join('\n')}`);

    const emitted = readFileSync(join(dir, 'out', 'types.js'), 'utf-8');
    const runtime = emitted
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*export\s*\{\s*\};?\s*$/gm, '')
      .trim();
    assert.equal(runtime, '', `types.ts emitted RUNTIME code, so something escaped type position:\n${emitted}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Positive control
// ---------------------------------------------------------------------------

describe('injection detector (positive control)', () => {
  it('fires when a computed key IS present, so a clean run means something', () => {
    const context = vm.createContext({});
    vm.runInContext(`globalThis.out = { [Function('globalThis.${MARKER}_control=1')()+'x']: 1 };`, context, {
      timeout: 5_000,
    });
    assert.deepEqual(firedMarkers(context), [`${MARKER}_control`]);
  });

  it('rejects source that does not parse, so a clean run also means it ran', () => {
    assert.throws(() => vm.runInContext('const x = ;', vm.createContext({})), /SyntaxError/);
  });
});

// ---------------------------------------------------------------------------
// metadata.ts: every catalog name is an inert, LOSSLESS quoted literal
// ---------------------------------------------------------------------------

describe('generateMetadata: catalog names cannot reach expression position', () => {
  for (const slot of SLOTS) {
    for (const payload of payloadsFor(slot)) {
      it(`${slot} carrying a ${payload.kind} payload is inert and round-trips`, () => {
        const schema = schemaWithHostile(slot, payload.text);
        const out = generateMetadata(schema, { noTimestamp: true });

        // Runs at all => the emitted file PARSES (the newline payload broke this).
        const context = runMetadata(out);
        // Nothing executed => no payload reached expression position.
        assert.deepEqual(firedMarkers(context), [], `${slot}/${payload.kind} executed on import`);

        // Escaping must be LOSSLESS, not sanitizing: the runtime metadata has to
        // still name the real database object or every query against it breaks.
        const SCHEMA = context.SCHEMA as SchemaMetadata;
        switch (slot) {
          case 'table':
            assert.equal(SCHEMA.tables[payload.text]?.name, payload.text);
            break;
          case 'column':
            assert.equal(SCHEMA.tables.things?.columnMap[payload.text], payload.text);
            assert.equal(SCHEMA.tables.things?.reverseColumnMap[payload.text], payload.text);
            assert.ok(SCHEMA.tables.things?.allColumns.includes(payload.text));
            break;
          case 'enumType':
            // Spread: the vm builds arrays with ITS realm's Array.prototype, which
            // deepEqual treats as a different value.
            assert.deepEqual([...(SCHEMA.enums[payload.text] ?? [])], ['calm', 'eager']);
            break;
          case 'enumLabel':
            assert.deepEqual([...(SCHEMA.enums.mood ?? [])], ['calm', payload.text]);
            break;
          case 'relation':
            assert.equal(SCHEMA.tables.things?.relations[payload.text]?.name, payload.text);
            break;
        }
      });
    }
  }

  it('parses as TypeScript with every slot hostile at once', () => {
    const hostile = payloadsFor('all');
    const columns = [idCol, ...hostile.map((p) => col(`${p.text}#col`))];
    const relations = Object.fromEntries(hostile.map((p) => [`${p.text}#rel`, relationTo(`${p.text}#rel`, 'things')]));
    const schema: SchemaMetadata = {
      enums: Object.fromEntries(hostile.map((p) => [`${p.text}#enum`, hostile.map((q) => `${q.text}#label`)])),
      tables: {
        things: tableOf('things', columns, relations),
        [`${hostile[0]?.text}#table`]: tableOf(`${hostile[0]?.text}#table`, [idCol]),
      },
    };
    const out = generateMetadata(schema, { noTimestamp: true });
    assert.deepEqual(firedMarkers(runMetadata(out)), []);
    assertParses(out, 'metadata.ts');
  });
});

// ---------------------------------------------------------------------------
// types.ts / zod.ts: a hostile COLUMN name stays a quoted key
// ---------------------------------------------------------------------------

/**
 * Column names are never refused, only quoted: `2fa_enabled` is a legal column
 * and a legal object key, so the generator has to keep working for it. That
 * makes the column slot the one that must survive every payload INTACT.
 */
function hostileColumnSchema(): SchemaMetadata {
  const columns = [idCol, ...payloadsFor('column').map((p) => col(p.text))];
  return { enums: {}, tables: { things: tableOf('things', columns) } };
}

describe('generateTypes: a hostile column name is a quoted member key', () => {
  it('compiles to type-only JavaScript with every payload planted', () => {
    assertTypeOnlyEmit(generateTypes(hostileColumnSchema(), { noTimestamp: true }));
  });

  it('never lets a payload close a JSDoc comment or start a line', () => {
    const out = generateTypes(hostileColumnSchema(), { noTimestamp: true });
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('/**') || trimmed.startsWith('*')) {
        // A comment line may terminate exactly once, at its very end. The
        // terminator payload closed it mid-line and put the rest in code
        // position.
        const end = trimmed.indexOf('*/');
        assert.ok(end === -1 || end === trimmed.length - 2, `comment closed early: ${line}`);
      }
      // The newline payload must not split one emitted line into two.
      assert.ok(!line.startsWith('globalThis.'), `a newline in a column name started a new statement: ${line}`);
    }
  });

  it('quotes a column field that is not a bare identifier', () => {
    const out = generateTypes({ enums: {}, tables: { t: tableOf('t', [idCol, col('2fa_enabled')]) } }, {});
    // A leading digit is a legal column name and an ILLEGAL bare key; the old
    // rule tested only the character SET, so it emitted `2fa_enabled:` bare.
    assert.ok(out.includes("'2fa_enabled'"), out);
    assert.ok(!/^\s+2fa_enabled[?:]/m.test(out), 'a digit-leading field was emitted as a bare key');
  });
});

describe('generateZod: a hostile column name cannot execute', () => {
  it('builds the z.object argument without evaluating a payload', () => {
    const source = generateZod(hostileColumnSchema(), { noTimestamp: true });
    const zodImport = "import { z } from 'zod';";
    assert.equal(source.split(zodImport).length - 1, 1, 'zod.ts no longer imports z the way this test stubs it');
    // A chainable stub: every property access and every call yields the stub, so
    // `z.string().nullable().optional()` resolves without pulling in zod. The
    // argument OBJECT is still constructed, which is where a computed key runs.
    const stub = 'const z = new Proxy(function () {}, { get: () => z, apply: () => z });';
    const js = source.replace(zodImport, stub).replaceAll('export const ', 'const ');
    const context = vm.createContext({});
    vm.runInContext(js, context, { timeout: 5_000 });
    assert.deepEqual(firedMarkers(context), []);
  });
});

// ---------------------------------------------------------------------------
// Identifier position: refused, because there is nothing to escape it with
// ---------------------------------------------------------------------------

describe('code generation refuses names it cannot emit as identifiers', () => {
  const identifierSlots: { slot: Slot; names: RegExp }[] = [
    { slot: 'table', names: /table "/ },
    { slot: 'enumType', names: /enum type "/ },
    { slot: 'relation', names: /relation "/ },
  ];

  for (const { slot, names } of identifierSlots) {
    for (const payload of payloadsFor(slot)) {
      it(`${slot} carrying a ${payload.kind} payload is refused by every identifier emitter`, () => {
        const schema = schemaWithHostile(slot, payload.text);
        for (const emit of [generateTypes, generateIndex, generateZod]) {
          assert.throws(
            () => emit(schema, { noTimestamp: true }),
            (err: unknown) => {
              assert.ok(err instanceof Error);
              assert.equal((err as { code?: string }).code, 'TURBINE_E003');
              assert.match(err.message, names, `error does not name the offending object: ${err.message}`);
              return true;
            },
            `${emit.name} emitted code for a ${slot} named ${JSON.stringify(payload.text)}`,
          );
        }
      });
    }
  }

  it('still generates for a schema whose every name is a valid identifier', () => {
    const schema: SchemaMetadata = {
      enums: { mood: ['calm'] },
      tables: { things: tableOf('things', [idCol, col('title')], { others: relationTo('others', 'others') }) },
    };
    assert.doesNotThrow(() => generateTypes(schema, { noTimestamp: true }));
    assert.doesNotThrow(() => generateIndex(schema, { noTimestamp: true }));
    assert.doesNotThrow(() => generateZod(schema, { noTimestamp: true }));
  });

  it('accepts a non-ASCII name that IS a valid identifier', () => {
    // `café` -> `Café`, a perfectly good TypeScript identifier. The rule is the
    // Unicode identifier grammar, not `[A-Za-z_$]`, so this must not be refused.
    const schema: SchemaMetadata = { enums: {}, tables: { café: tableOf('café', [idCol]) } };
    assert.doesNotThrow(() => generateTypes(schema, { noTimestamp: true }));
  });

  it('keeps emitting metadata.ts for a schema the type layer refuses', () => {
    // metadata.ts contains no catalog-derived identifiers, only quoted keys and
    // quoted values, so it has no identifier rule to enforce. Pinned because the
    // easy "assert everywhere" refactor would silently break this.
    const schema = schemaWithHostile('table', payloadsFor('table')[0]?.text ?? '');
    assert.doesNotThrow(() => generateMetadata(schema, { noTimestamp: true }));
  });
});

// ---------------------------------------------------------------------------
// introspect.ts: the catalog boundary
// ---------------------------------------------------------------------------

describe('assertSafeCatalogSchema: control characters are refused at the source', () => {
  const cases: { what: string; schema: () => SchemaMetadata; names: RegExp }[] = [
    { what: 'a table name', schema: () => schemaWithHostile('table', 'a\nb'), names: /table "a\nb"/ },
    { what: 'a column name', schema: () => schemaWithHostile('column', 'a\nb'), names: /column "a\nb"/ },
    { what: 'an enum type name', schema: () => schemaWithHostile('enumType', 'a\nb'), names: /enum type "a\nb"/ },
    { what: 'an enum label', schema: () => schemaWithHostile('enumLabel', 'a\nb'), names: /enum type "mood"/ },
    { what: 'a relation name', schema: () => schemaWithHostile('relation', 'a\nb'), names: /relation "a\nb"/ },
  ];

  for (const { what, schema, names } of cases) {
    it(`refuses ${what} containing a newline`, () => {
      assert.throws(
        () => assertSafeCatalogSchema(schema()),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, 'TURBINE_E003');
          assert.match(err.message, /U\+000A/);
          assert.match(err.message, names, `error does not name the offending object: ${err.message}`);
          return true;
        },
      );
    });
  }

  it('refuses a NUL byte', () => {
    // Built, never written literally: a raw NUL in a source file makes
    // byte-oriented tools classify it as binary and report zero grep matches.
    const nul = String.fromCharCode(0);
    assert.throws(() => assertSafeCatalogSchema(schemaWithHostile('table', `a${nul}b`)), /U\+0000/);
  });

  it('accepts an ordinary schema', () => {
    const schema: SchemaMetadata = {
      enums: { mood: ['calm', 'eager'] },
      tables: { things: tableOf('things', [idCol, col('title')], { others: relationTo('others', 'others') }) },
    };
    assert.doesNotThrow(() => assertSafeCatalogSchema(schema));
  });

  it('accepts a name that is merely not a TypeScript identifier', () => {
    // Deliberate scope split, pinned so it is not "tightened" by accident:
    // `introspect()` also feeds Studio, the MCP server, and `doctor`, none of
    // which emit identifiers. Refusing `2fa_codes` here would break tools that
    // work today; the code generator refuses it instead, at its own boundary.
    assert.doesNotThrow(() => assertSafeCatalogSchema(schemaWithHostile('table', '2fa_codes')));
    assert.throws(
      () => generateTypes(schemaWithHostile('table', '2fa_codes'), {}),
      /not a valid TypeScript identifier/,
    );
  });

  it('does not refuse the computed-key payload, which carries no control character', () => {
    // The catalog boundary is belt-and-braces, not the fix. The fix is that the
    // generator quotes and escapes; this documents which layer stops what, so a
    // future reader does not mistake this boundary for the whole defence.
    const payload = payloadsFor('table')[0]?.text ?? '';
    assert.doesNotThrow(() => assertSafeCatalogSchema(schemaWithHostile('table', payload)));
    assert.deepEqual(firedMarkers(runMetadata(generateMetadata(schemaWithHostile('table', payload), {}))), []);
  });
});
