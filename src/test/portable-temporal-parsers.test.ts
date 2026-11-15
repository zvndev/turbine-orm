import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  createFastTimestamptzParser,
  createUtcDateParser,
  createUtcDateParserGeneral,
  createUtcTimestampParser,
  createUtcTimestampParserGeneral,
  parseUtcTimestampText,
} from '../query/temporal-parsers.js';

type Parser = (text: string) => unknown;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORTABLE = 'src/query/temporal-parsers.ts';

/** Reject imports before tree shaking, including unused imports and #pg aliases. */
async function portableBundle(entry: string, format: 'esm' | 'cjs') {
  return build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'neutral',
    format,
    logLevel: 'silent',
    plugins: [
      {
        name: 'portable-import-boundary',
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => ({
            errors: [{ text: `Portable parser cannot import ${path} from ${relative(ROOT, importer)}` }],
          }));
        },
      },
    ],
  });
}

describe('portable temporal parser import boundary', () => {
  it('rejects the PG registration module as a control before accepting the portable leaf', async () => {
    await assert.rejects(portableBundle('src/query/pg-type-parsers.ts', 'esm'), /Portable parser cannot import #pg/);
    for (const format of ['esm', 'cjs'] as const) {
      const result = await portableBundle(PORTABLE, format);
      assert.deepEqual(Object.keys(result.metafile.inputs), [PORTABLE], 'the portable leaf has no transitive imports');
      assert.equal(result.outputFiles.length, 1);
      assert.ok(result.outputFiles[0]!.text.length > 1000, 'a nonempty parser implementation was bundled');
    }
  });

  it('imports and parses from ESM and CJS bundles where pg cannot be resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portable-temporal-'));
    try {
      for (const [format, extension] of [
        ['esm', 'mjs'],
        ['cjs', 'cjs'],
      ] as const) {
        const result = await portableBundle(PORTABLE, format);
        writeFileSync(join(dir, `temporal.${extension}`), result.outputFiles[0]!.text);
      }
      // This process imports only the isolated bundles. Both resolver controls
      // must establish that pg is absent, rather than relying on this repository's install.
      writeFileSync(
        join(dir, 'probe.mjs'),
        `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
assert.throws(() => require('pg'), { code: 'MODULE_NOT_FOUND' });
await assert.rejects(import('pg'), { code: 'ERR_MODULE_NOT_FOUND' });
for (const file of ['./temporal.mjs', './temporal.cjs']) {
  const loaded = await import(file);
  const parsers = file.endsWith('.cjs') ? loaded.default : loaded;
  assert.deepEqual(Object.keys(parsers).sort(), [
    'createFastTimestamptzParser', 'createUtcDateParser', 'createUtcDateParserGeneral',
    'createUtcTimestampParser', 'createUtcTimestampParserGeneral', 'parseUtcTimestampText',
  ]);
  const fallback = (text) => text === 'infinity' ? Infinity : text;
  assert.equal(parsers.createUtcDateParser(fallback)('0000-02-29').toISOString(), '0000-02-29T00:00:00.000Z');
  assert.equal(parsers.createUtcTimestampParser(fallback)('0044-03-15 12:00:00 BC').toISOString(), '-000043-03-15T12:00:00.000Z');
  assert.equal(parsers.createFastTimestamptzParser(fallback)('2026-11-05 12:30:00+05:30').toISOString(), '2026-11-05T07:00:00.000Z');
  assert.equal(parsers.createUtcDateParser(fallback)('infinity'), Infinity);
}
process.stdout.write('portable ESM/CJS parsers ran without pg');
`,
      );
      const output = execFileSync(process.execPath, [join(dir, 'probe.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
        timeout: 10_000,
      });
      assert.equal(output, 'portable ESM/CJS parsers ran without pg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const unexpectedFallback: Parser = (text) => {
  throw new Error(`Unexpected fallback for ${JSON.stringify(text)}`);
};

function assertIso(parse: Parser, text: string, expected: string): void {
  const result = parse(text);
  assert.ok(result instanceof Date, `expected a Date for ${JSON.stringify(text)}`);
  assert.equal(result.toISOString(), expected, text);
}

describe('portable temporal parser output characterization', () => {
  it('retains UTC calendar readings for ordinary, low, wide, BC and year-zero dates', () => {
    const cases = [
      ['2026-11-05', '2026-11-05T00:00:00.000Z'],
      ['0000-02-29', '0000-02-29T00:00:00.000Z'],
      ['0001-01-01', '0001-01-01T00:00:00.000Z'],
      ['0044-03-15', '0044-03-15T00:00:00.000Z'],
      ['0099-12-31', '0099-12-31T00:00:00.000Z'],
      ['0100-01-01', '0100-01-01T00:00:00.000Z'],
      ['12026-11-05', '+012026-11-05T00:00:00.000Z'],
      ['0001-01-01 BC', '0000-01-01T00:00:00.000Z'],
      ['0044-03-15 BC', '-000043-03-15T00:00:00.000Z'],
      // Existing parsers normalize overflowing fields. Extraction must not
      // silently add stricter validation for text the old factory accepted.
      ['2024-02-30', '2024-03-01T00:00:00.000Z'],
    ] as const;
    for (const factory of [createUtcDateParser, createUtcDateParserGeneral]) {
      for (const [text, expected] of cases) assertIso(factory(unexpectedFallback), text, expected);
    }
  });

  it('retains timestamp separators, fractions and unusual years without 1900 remapping', () => {
    const cases = [
      ['2026-11-05 12:30:00', '2026-11-05T12:30:00.000Z'],
      ['2026-11-05T12:30:00.1', '2026-11-05T12:30:00.100Z'],
      ['2026-11-05 12:30:00.12', '2026-11-05T12:30:00.120Z'],
      ['2026-11-05 12:30:00.123456', '2026-11-05T12:30:00.123Z'],
      ['2026-11-05 12:30:00.123456789', '2026-11-05T12:30:00.123Z'],
      ['0000-02-29 12:30:00', '0000-02-29T12:30:00.000Z'],
      ['0099-12-31 23:59:59', '0099-12-31T23:59:59.000Z'],
      ['12026-11-05 12:30:00', '+012026-11-05T12:30:00.000Z'],
      ['0044-03-15 12:30:00 BC', '-000043-03-15T12:30:00.000Z'],
    ] as const;
    for (const factory of [createUtcTimestampParser, createUtcTimestampParserGeneral]) {
      for (const [text, expected] of cases) assertIso(factory(unexpectedFallback), text, expected);
    }
  });

  it('keeps recognized out-of-range years as Invalid Date rather than delegating them', () => {
    for (const factory of [createUtcDateParser, createUtcDateParserGeneral]) {
      const value = factory(unexpectedFallback)('999999-01-01');
      assert.ok(value instanceof Date);
      assert.ok(Number.isNaN(value.getTime()));
    }
    for (const factory of [createUtcTimestampParser, createUtcTimestampParserGeneral]) {
      const value = factory(unexpectedFallback)('999999-01-01 00:00:00');
      assert.ok(value instanceof Date);
      assert.ok(Number.isNaN(value.getTime()));
    }
  });

  it('decodes only the fast timestamptz shapes whose interpretation is unambiguous', () => {
    const parse = createFastTimestamptzParser(unexpectedFallback);
    for (const [text, expected] of [
      ['2026-11-05 12:30:00Z', '2026-11-05T12:30:00.000Z'],
      ['2026-11-05 12:30:00+05', '2026-11-05T07:30:00.000Z'],
      ['2026-11-05 12:30:00.123456+05:30', '2026-11-05T07:00:00.123Z'],
      ['2026-11-05 12:30:00-03:30', '2026-11-05T16:00:00.000Z'],
      ['1850-01-01 00:00:00+00:19:32', '1849-12-31T23:40:28.000Z'],
    ] as const) {
      assertIso(parse, text, expected);
    }
  });

  it('delegates unrecognized text verbatim and preserves the exact fallback return or throw', () => {
    const cases = [
      [createUtcDateParser, ['', 'infinity', '-infinity', 'epoch', '2026-1-5', '044-03-15', '2026-11-05 00:00:00']],
      [
        createUtcTimestampParser,
        ['', 'infinity', '-infinity', '2026-11-05', '2026-11-05 00:00:00.', '2026-11-05 00:00:00Z'],
      ],
      [
        createFastTimestamptzParser,
        [
          '',
          'infinity',
          '-infinity',
          '2026-11-05T00:00:00+00',
          '2026-11-05 00:00:00',
          '2026-11-05 00:00:00+0530',
          '0044-03-15 12:00:00+00',
          '12026-11-05 12:00:00+00',
          '0044-03-15 12:00:00+00 BC',
        ],
      ],
    ] as const;
    for (const [factory, texts] of cases) {
      const seen: string[] = [];
      const sentinel = { reading: 'caller-owned' };
      const parse = factory((text) => {
        seen.push(text);
        return sentinel;
      });
      assert.deepEqual(seen, [], 'factory construction must not invoke the fallback');
      for (const text of texts) assert.equal(parse(text), sentinel, text);
      assert.deepEqual(seen, [...texts]);
      const error = new Error('caller parser rejected input');
      assert.throws(
        () =>
          factory(() => {
            throw error;
          })('infinity'),
        (caught) => caught === error,
      );
    }
  });

  it('leaves infinity policy and null readings to the supplied fallback', () => {
    for (const factory of [createUtcDateParser, createUtcTimestampParser, createFastTimestamptzParser]) {
      const parse = factory((text) => (text === 'infinity' ? Infinity : text === '-infinity' ? -Infinity : null));
      assert.equal(parse('infinity'), Infinity);
      assert.equal(parse('-infinity'), -Infinity);
      assert.equal(parse('unrecognized'), null);
    }
  });

  it('keeps the known-shape convenience parser separate from fallback-aware factories', () => {
    assert.equal(parseUtcTimestampText('2026-11-05 12:30:00.123456').toISOString(), '2026-11-05T12:30:00.123Z');
    assert.ok(Number.isNaN(parseUtcTimestampText('infinity').getTime()));
  });
});
