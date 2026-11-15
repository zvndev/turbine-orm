import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { d1CleanupResolved, resolveD1Context, withLocalD1 } from '../cli/d1-local.js';
import { inspectD1Migrations } from '../cli/d1-migrations.js';
import { deployD1Project, generateD1Project, initD1Project, statusD1Project } from '../cli/d1-project.js';
import { type D1Migration, D1MigrationError } from '../d1/migrate.js';
import { withNative } from './fixtures/d1-introspection/native.js';

const dependencies = fileURLToPath(new URL('../../node_modules', import.meta.url));
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function project(check: (config: ReturnType<typeof resolveConfig>) => Promise<void>) {
  const original = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'd1-admission-'));
  try {
    // The source loader resolves Miniflare's executable from the consumer project.
    symlinkSync(dependencies, join(root, 'node_modules'), 'dir');
    process.chdir(root);
    const inheritedUrl = process.env.DATABASE_URL;
    let config: ReturnType<typeof resolveConfig>;
    try {
      // Isolate only this synchronous local config read; native PG tests keep their URL.
      delete process.env.DATABASE_URL;
      config = resolveConfig(
        {
          engine: 'd1',
          d1: { binding: 'DB', databaseId: 'source-admission', persist: './state' },
          out: './generated',
          migrationsDir: './migrations',
        },
        {},
      );
    } finally {
      if (inheritedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = inheritedUrl;
    }
    console.info(`D1 source admission owned project before launch: ${root}; loopback/inspector ports allocated.`);
    await check(config);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}

test('D1 source fixture preserves the ambient PG URL and the production refusal', async () => {
  const original = process.env.DATABASE_URL;
  const cwd = process.cwd();
  const url = 'postgres://127.0.0.1:1/d1_fixture_regression';
  const sentinel = new Error('fixture callback failure');
  try {
    process.env.DATABASE_URL = url;
    assert.throws(
      () => resolveConfig({ engine: 'd1', d1: { binding: 'DB', databaseId: 'fixture', persist: './state' } }, {}),
      /Remove url and DATABASE_URL for local D1/,
    );
    await project(async (config) => {
      assert.equal(config.url, '');
      assert.equal(process.env.DATABASE_URL, url);
    });
    await assert.rejects(
      project(async () => {
        throw sentinel;
      }),
      (error) => error === sentinel,
    );
    assert.equal(process.env.DATABASE_URL, url);
    assert.equal(process.cwd(), cwd);
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

test(
  'native D1 source project reopens committed effects, refuses drift, and preserves generated output',
  { timeout: 120_000 },
  () =>
    project(async (config) => {
      const context = resolveD1Context(config);
      const plan: D1Migration[] = [
        {
          id: '0001_items',
          statements: [
            'CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL UNIQUE)',
            "INSERT INTO items VALUES (1,'first')",
          ],
        },
      ];
      await initD1Project(config);
      assert.equal(existsSync(context.out), false);
      assert.deepEqual(JSON.parse(readFileSync(context.planPath, 'utf8')), []);
      await assert.rejects(initD1Project(config), /fresh persistence/);
      assert.deepEqual(await statusD1Project(config), { historyState: 'uninitialized', applied: [], pending: [] });
      await withLocalD1(context, async (binding) => {
        assert.deepEqual(
          (await binding.prepare("SELECT name FROM sqlite_schema WHERE name='_turbine_d1_migrations'").all()).results,
          [],
        );
      });
      await assert.rejects(generateD1Project(config), /no selected user tables/);
      assert.equal(existsSync(context.out), false);
      writeFileSync(context.planPath, JSON.stringify(plan));
      assert.deepEqual(await statusD1Project(config), {
        historyState: 'uninitialized',
        applied: [],
        pending: ['0001_items'],
      });
      assert.deepEqual(await deployD1Project(config), { applied: ['0001_items'], alreadyApplied: [] });
      assert.deepEqual(await deployD1Project(config), { applied: [], alreadyApplied: ['0001_items'] });
      const generated = await generateD1Project(config, { noTimestamp: true });
      assert.deepEqual(Object.keys(generated.schema.tables), ['items']);
      assert(generated.files.includes('index.ts') && generated.files.includes('metadata.ts'));
      assert.doesNotMatch(readFileSync(join(context.out, 'index.ts'), 'utf8'), /_turbine_d1_migrations/);
      const generatedHashes = Object.fromEntries(
        readdirSync(context.out).map((name) => [name, sha(join(context.out, name))]),
      );
      await assert.rejects(generateD1Project(config), /fresh --out/);
      for (const [name, hash] of Object.entries(generatedHashes)) assert.equal(sha(join(context.out, name)), hash);
      const drift = structuredClone(plan);
      drift[0]!.statements = [plan[0]!.statements[0]!, "INSERT INTO items VALUES (1,'changed')"];
      writeFileSync(context.planPath, JSON.stringify(drift));
      await assert.rejects(statusD1Project(config), /changed checksum/);
      await assert.rejects(deployD1Project(config), /drift|checksum/);
      writeFileSync(context.planPath, JSON.stringify(plan));
      const failed = {
        id: '0002_duplicate',
        statements: ["INSERT INTO items VALUES (2,'second')", "INSERT INTO items VALUES (3,'first')"],
      };
      writeFileSync(context.planPath, JSON.stringify([...plan, failed]));
      await assert.rejects(deployD1Project(config), (error: unknown) => {
        assert(error instanceof D1MigrationError);
        assert.equal(error.phase, 'dispatch');
        assert.equal(error.outcome, 'unknown');
        assert.match(String(error.cause), /UNIQUE/);
        return true;
      });
      assert.deepEqual(await statusD1Project(config), {
        historyState: 'initialized',
        applied: ['0001_items'],
        pending: ['0002_duplicate'],
      });
      await withLocalD1(context, async (binding) => {
        assert.deepEqual((await binding.prepare('SELECT id,label FROM items ORDER BY id').all()).results, [
          { id: 1, label: 'first' },
        ]);
      });
      assert.equal(d1CleanupResolved(context), true);
      assert.equal(existsSync(join(context.persist, '.turbine-d1.lock')), false);
    }),
);

test(
  'native D1 source admission preserves aliased sidecars, caller bytes and another owner lock',
  { timeout: 120_000 },
  () =>
    project(async (config) => {
      await initD1Project(config);
      const context = resolveD1Context(config);
      const marker = JSON.parse(readFileSync(join(context.persist, '.turbine-d1.json'), 'utf8'));
      const caller = resolve('caller-owned.bin');
      writeFileSync(caller, Buffer.alloc(65_536, 0x41));
      const hash = sha(caller);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = join(context.persist, marker.databaseFile) + suffix;
        const originalSidecar = existsSync(sidecar) ? readFileSync(sidecar) : undefined;
        rmSync(sidecar, { force: true });
        linkSync(caller, sidecar);
        try {
          await assert.rejects(statusD1Project(config), /sidecar.*private regular/);
          assert.equal(sha(caller), hash);
          assert.equal(sha(sidecar), hash);
          assert.equal(existsSync(join(context.persist, '.turbine-d1.lock')), false);
        } finally {
          rmSync(sidecar);
          if (originalSidecar !== undefined) writeFileSync(sidecar, originalSidecar);
        }
      }
      const lock = join(context.persist, '.turbine-d1.lock');
      writeFileSync(lock, 'caller-owner\n');
      await assert.rejects(statusD1Project(config), /in use or has a stale lock/);
      assert.equal(readFileSync(lock, 'utf8'), 'caller-owner\n');
      rmSync(lock);
      assert.deepEqual(await statusD1Project(config), { historyState: 'uninitialized', applied: [], pending: [] });
      assert.equal(sha(caller), hash);
      assert.equal(existsSync(lock), false);
    }),
);

test('native D1 source status refuses an incompatible journal without changing caller data', {
  timeout: 120_000,
}, async () => {
  await withNative(async (binding) => {
    await binding.prepare('CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT)').all();
    await binding.prepare("INSERT INTO items VALUES (1,'caller')").all();
    await binding.prepare('CREATE TABLE _turbine_d1_migrations(position INTEGER,id TEXT,checksum TEXT)').all();
    const before = (await binding.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all())
      .results;
    await assert.rejects(inspectD1Migrations(binding, []), /journal schema mismatch/);
    assert.deepEqual(
      (await binding.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()).results,
      before,
    );
    assert.deepEqual((await binding.prepare('SELECT * FROM items').all()).results, [{ id: 1, label: 'caller' }]);
  });
});
