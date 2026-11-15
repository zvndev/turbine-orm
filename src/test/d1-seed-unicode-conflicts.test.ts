import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { resolveD1Context, withLocalD1 } from '../cli/d1-local.js';
import { deployD1Project, initD1Project, seedD1Project } from '../cli/d1-project.js';
import { captureD1Seed, D1SeedError } from '../cli/d1-seed.js';

const plan = (table: string, rows: unknown[][]) => ({
  version: 1,
  operations: [{ table, columns: ['id', 'label'], rows }],
});

test('rejects every unpaired surrogate before dispatch while preserving valid Unicode capture', () => {
  for (const label of ['\ud800', '\udfff', 'a\ud800b', '\udc00x', '\ud800\ud800', '\udc00\ud800']) {
    assert.throws(
      () => captureD1Seed(JSON.parse(JSON.stringify(plan('items', [[1, label]])))),
      (error: unknown) => {
        assert(error instanceof D1SeedError);
        assert.equal(error.phase, 'admission');
        assert.equal(error.outcome, 'not-dispatched');
        assert.match(error.message, /well-formed UTF-16/);
        return true;
      },
    );
  }
  for (const label of ['', '\0', 'snow☃', 'a\ud800\udc00b', '\udbff\udfff', '�', 'e\u0301']) {
    assert.deepEqual(captureD1Seed(plan('items', [[1, label]]))[0]?.params, [1, label]);
  }
});

test('native seed overrides schema conflict policies and preserves complete state after rejection', {
  timeout: 120_000,
}, async () => {
  const beforeCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'd1-seed-corrections-'));
  const dependencies = fileURLToPath(new URL('../../node_modules', import.meta.url));
  const statements = [
    'CREATE TABLE replacing(id INTEGER PRIMARY KEY,label TEXT UNIQUE ON CONFLICT REPLACE)',
    'CREATE TABLE ignoring(id INTEGER PRIMARY KEY,label TEXT UNIQUE ON CONFLICT IGNORE)',
    "CREATE TABLE notnulls(id INTEGER PRIMARY KEY,label TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'fallback')",
    'CREATE TABLE primary_replacing(id INTEGER PRIMARY KEY ON CONFLICT REPLACE,label TEXT)',
  ];
  try {
    symlinkSync(dependencies, join(root, 'node_modules'), 'dir');
    process.chdir(root);
    console.info(`D1 seed Unicode/conflict project ${root}; loopback0 runtime ports allocated.`);
    const inheritedUrl = process.env.DATABASE_URL;
    let config: ReturnType<typeof resolveConfig>;
    try {
      // Isolate only this synchronous local config read; native PG tests keep their URL.
      delete process.env.DATABASE_URL;
      config = resolveConfig(
        {
          engine: 'd1',
          d1: { binding: 'DB', databaseId: 'corrections', persist: './state' },
          migrationsDir: './migrations',
          out: './generated',
        },
        {},
      );
    } finally {
      if (inheritedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = inheritedUrl;
    }
    await initD1Project(config);
    writeFileSync('migrations/plan.json', JSON.stringify([{ id: '0001_conflicts', statements }]));
    await deployD1Project(config);
    const context = resolveD1Context(config);
    for (const table of ['replacing', 'ignoring', 'notnulls', 'primary_replacing']) {
      writeFileSync('migrations/seed.json', JSON.stringify(plan(table, [[100, 'resident']])));
      assert.deepEqual(await seedD1Project(config), { insertedRows: 1, statements: 1 });
    }
    const scenarios: [string, unknown[][]][] = [
      [
        'replacing',
        [
          [1, 'same'],
          [2, 'same'],
        ],
      ],
      [
        'replacing',
        [
          [1, 'fresh'],
          [2, 'resident'],
        ],
      ],
      [
        'ignoring',
        [
          [1, 'fresh'],
          [2, 'resident'],
        ],
      ],
      [
        'notnulls',
        [
          [1, 'fresh'],
          [2, null],
        ],
      ],
      [
        'primary_replacing',
        [
          [1, 'fresh'],
          [100, 'overwrite'],
        ],
      ],
    ];
    for (const [table, rows] of scenarios) {
      writeFileSync('migrations/seed.json', JSON.stringify(plan(table, rows)));
      await assert.rejects(seedD1Project(config), (error: unknown) => {
        assert(error instanceof D1SeedError);
        assert.equal(error.phase, 'dispatch');
        assert.equal(error.outcome, 'unknown');
        assert.match(String(error.cause), /UNIQUE|NOT NULL/);
        return true;
      });
      await withLocalD1(context, async (db) => {
        assert.deepEqual((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results, [
          { id: 100, label: 'resident' },
        ]);
      });
    }
    const unicode = ['\0snow☃', '\ud800\udc00', '\udbff\udfff', '�', 'e\u0301'];
    writeFileSync(
      'migrations/seed.json',
      JSON.stringify(
        plan(
          'replacing',
          unicode.map((value, i) => [i + 1, value]),
        ),
      ),
    );
    assert.deepEqual(await seedD1Project(config), { insertedRows: unicode.length, statements: unicode.length });
    await withLocalD1(context, async (db) => {
      assert.deepEqual(
        (await db.prepare('SELECT id,label,hex(label) AS bytes FROM replacing WHERE id < 100 ORDER BY id').all())
          .results,
        unicode.map((label, i) => ({ id: i + 1, label, bytes: Buffer.from(label).toString('hex').toUpperCase() })),
      );
    });
    const seed = join(root, 'migrations/seed.json');
    writeFileSync(seed, JSON.stringify(plan('replacing', [[9, 'lone-\ud800-tail']])));
    const bytes = readFileSync(seed);
    const original = process.env.MINIFLARE_WORKERD_PATH;
    process.env.MINIFLARE_WORKERD_PATH = join(root, 'no-such-workerd');
    try {
      await assert.rejects(seedD1Project(config), /well-formed UTF-16/);
    } finally {
      if (original === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
      else process.env.MINIFLARE_WORKERD_PATH = original;
    }
    assert.deepEqual(readFileSync(seed), bytes);
    assert.equal(existsSync('state/.turbine-d1.lock'), false);
  } finally {
    process.chdir(beforeCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
