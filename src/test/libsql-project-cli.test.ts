/** Required local native libSQL prerequisite. No node:sqlite fallback or skipped gate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client/node';
import {
  assertLibsqlProjectArguments,
  generateLibsqlProject,
  initLibsqlProject,
  introspectLibsqlProject,
  type LibsqlProjectConfig,
  libsqlProjectUrl,
  resolveLibsqlProjectContext,
} from '../cli/libsql-project.js';
import { generateLibsqlFiles } from '../libsql/generate.js';
import { turbineLibsql } from '../libsql.js';

async function fixture(check: (config: LibsqlProjectConfig, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-libsql-project-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    await check(
      {
        engine: 'libsql',
        url: 'file:./local.sqlite',
        out: './generated',
        schema: 'main',
        include: [],
        exclude: [],
        migrationsDir: './migrations',
        schemaFile: './schema.ts',
        keepColumnNames: false,
        legacyToManyUniques: false,
        importExtension: 'js',
      },
      dir,
    );
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  }
}

function snapshot(dir = '.'): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).flatMap((name): [string, string][] => {
      const path = join(dir, name);
      // O_NOFOLLOW keeps the old lstat semantics: a symlink is recorded as a
      // link, never followed; kind and bytes then come from one descriptor.
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') return [[path, `link:${readlinkSync(path)}`]];
        throw error;
      }
      try {
        if (fstatSync(fd).isDirectory()) return [[path, 'directory'], ...Object.entries(snapshot(path))];
        return [[path, createHash('sha256').update(readFileSync(fd)).digest('hex')]];
      } finally {
        closeSync(fd);
      }
    }),
  );
}

async function assertCatalogRetained(config: LibsqlProjectConfig): Promise<void> {
  const client = createClient({ url: resolveLibsqlProjectContext(config).url, intMode: 'bigint' });
  try {
    const result = await client.execute('SELECT display_name FROM parents');
    assert.equal(result.rows[0]!.display_name, 'large');
  } finally {
    client.close();
    assert.equal(client.closed, true);
  }
}
async function catalog(config: LibsqlProjectConfig) {
  const client = createClient({ url: resolveLibsqlProjectContext(config).url, intMode: 'bigint' });
  try {
    await client.executeMultiple(`
      CREATE TABLE parents(id INTEGER PRIMARY KEY, display_name TEXT, payload BLOB, price DECIMAL);
      CREATE TABLE profiles(id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE REFERENCES parents(id), label TEXT);
      CREATE TABLE ignored(id INTEGER PRIMARY KEY, secret TEXT);
      INSERT INTO parents VALUES(9007199254740993,'large',x'0102',1.5);
      INSERT INTO profiles VALUES(7,9007199254740993,'one');
    `);
  } finally {
    client.close();
    assert.equal(client.closed, true);
  }
}

test('init makes a persistent runnable empty project and preserves all existing files on repeat', async () => {
  await fixture(async (config) => {
    writeFileSync('.gitignore', 'keep-me\n');
    const result = await initLibsqlProject(config, { noTimestamp: true });
    assert.equal(result.existingDatabase, false);
    assert.ok(readFileSync('local.sqlite').length > 0);
    assert.equal(existsSync('.env'), false);
    assert.equal(existsSync('migrations'), false);
    assert.equal(existsSync('schema.ts'), false);
    assert.match(readFileSync('.gitignore', 'utf8'), /^keep-me\n.env\n/);
    assert.match(readFileSync('turbine.config.ts', 'utf8'), /engine: 'libsql'/);
    assert.match(readFileSync('libsql-example.ts', 'utf8'), /await turbine\("file:.\/local.sqlite"\)/);
    const snapshots = new Map(
      [
        'turbine.config.ts',
        'libsql-example.ts',
        '.gitignore',
        'generated/index.ts',
        'generated/types.ts',
        'generated/metadata.ts',
      ].map((path) => [path, readFileSync(path)]),
    );
    const db = await turbineLibsql(config.url, await introspectLibsqlProject(config), { logger: {} });
    await db.disconnect();
    const second = await initLibsqlProject(config, { force: true, noTimestamp: true });
    assert.equal(second.existingDatabase, true);
    assert.equal(second.generated, undefined);
    assert.deepEqual(second.created, []);
    for (const [path, before] of snapshots) assert.deepEqual(readFileSync(path), before);
  });
});

test('native catalog, generation options and large integers survive the project path', async () => {
  await fixture(async (config) => {
    await catalog(config);
    for (const keepColumnNames of [false, true])
      for (const legacyToManyUniques of [false, true]) {
        const effective = {
          ...config,
          keepColumnNames,
          legacyToManyUniques,
          columnTypes: { 'parents.display_name': "'large' | 'small'" },
        };
        const result = await generateLibsqlProject(effective, { noTimestamp: true });
        const expected = generateLibsqlFiles(result.schema, {
          noTimestamp: true,
          importExt: '.js',
          importMode: 'js',
          columnTypes: effective.columnTypes,
        });
        for (const [name, text] of Object.entries(expected))
          assert.equal(readFileSync(join('generated', name), 'utf8'), text);
        const parent = result.schema.tables.parents!;
        // The to-one is named with the singular; the opt-out keeps the plural array.
        const profileKey = legacyToManyUniques ? 'profiles' : 'profile';
        assert.equal(parent.relations[profileKey]!.type, legacyToManyUniques ? 'hasMany' : 'hasOne');
        assert.equal(
          parent.columns.find((c) => c.name === 'display_name')!.field,
          keepColumnNames ? 'display_name' : 'displayName',
        );
        const types = readFileSync('generated/types.ts', 'utf8');
        assert.match(types, /Uint8Array/);
        assert.match(types, /number \| string/);
        assert.match(types, /'large' \| 'small'/);
        assert.match(readFileSync('generated/index.ts', 'utf8'), /turbine-orm\/libsql/);
        const db = await turbineLibsql(config.url, result.schema, { logger: {}, warnOnUnlimited: false });
        try {
          const rows = await db.table('parents').findMany({ with: { [profileKey]: true } });
          assert.equal(rows[0]!.id, '9007199254740993');
          assert.deepEqual(rows[0]!.payload, new Uint8Array([1, 2]));
          assert.equal(Array.isArray(rows[0]![profileKey]), legacyToManyUniques);
        } finally {
          await db.disconnect();
        }
      }
  });
});

test('filtered overrides are validated against the full catalog and bad overrides never replace output', async () => {
  await fixture(async (config) => {
    await catalog(config);
    const effective = { ...config, include: ['parents'], columnTypes: { 'ignored.secret': 'string' } };
    await generateLibsqlProject(effective, { noTimestamp: true });
    const before = readFileSync('generated/types.ts');
    await assert.rejects(
      generateLibsqlProject({ ...effective, columnTypes: { 'ignored.secert': 'string' } }),
      /names no column/,
    );
    assert.deepEqual(readFileSync('generated/types.ts'), before);
    await assert.rejects(generateLibsqlProject({ ...config, include: ['absent'] }), /matched 0 tables/);
    assert.deepEqual(readFileSync('generated/types.ts'), before);
    await generateLibsqlProject({ ...config, include: ['absent'] }, { allowEmpty: true, noTimestamp: true });
    assert.doesNotMatch(readFileSync('generated/types.ts', 'utf8'), /interface Parent/);
  });
});

test('generation and init refuse every database/output collision, including escaped URLs and real hardlinks', async () => {
  for (const name of ['metadata.ts', 'types.ts', 'index.ts']) {
    for (const kind of ['direct', 'normalized', 'absolute', 'hardlink', 'ancestor-alias']) {
      await fixture(async (config, dir) => {
        mkdirSync('generated');
        const url =
          kind === 'hardlink'
            ? config.url
            : kind === 'normalized'
              ? `file:./g%65nerated/../generated/${name.replaceAll('.', '%2E')}`
              : kind === 'absolute'
                ? pathToFileURL(join(dir, 'generated', name)).href
                : kind === 'ancestor-alias'
                  ? `file:./catalog/${name}`
                  : `file:./generated/${name}`;
        if (kind === 'ancestor-alias') symlinkSync('generated', 'catalog', 'dir');
        const effective = { ...config, url };
        await catalog(effective);
        if (kind === 'hardlink') {
          linkSync('local.sqlite', join('generated', name));
          const database = lstatSync('local.sqlite');
          const output = lstatSync(join('generated', name));
          assert.equal(database.ino, output.ino);
          assert.equal(database.dev, output.dev);
        }
        for (const other of ['metadata.ts', 'types.ts', 'index.ts'])
          if (other !== name) writeFileSync(join('generated', other), `caller output ${other}\n`);
        const before = snapshot();
        for (const operation of [generateLibsqlProject, initLibsqlProject]) {
          await assert.rejects(operation(effective, { noTimestamp: true }), /collid|alias/, `${kind}: ${name}`);
          assert.deepEqual(snapshot(), before, `${kind}: ${name}`);
          await assertCatalogRetained(effective);
          assert.deepEqual(snapshot(), before, `${kind}: ${name}: native reopen`);
        }
      });
    }
  }
});

test('missing database collisions and output links refuse before any persistent native or scaffold effects', async () => {
  for (const name of ['metadata.ts', 'types.ts', 'index.ts'])
    await fixture(async (config) => {
      mkdirSync('generated');
      symlinkSync('generated', 'catalog', 'dir');
      const before = snapshot();
      for (const url of [`file:./generated/${name}`, `file:./catalog/${name}`, `file:./generated/${name}/db`]) {
        await assert.rejects(initLibsqlProject({ ...config, url }), /collid/);
        assert.deepEqual(snapshot(), before);
      }
    });
  for (const kind of ['leaf', 'dangling-leaf', 'ancestor', 'hardlinked-outputs'])
    await fixture(async (config) => {
      await catalog(config);
      mkdirSync('generated');
      let out = config.out;
      if (kind === 'ancestor') {
        symlinkSync('generated', 'output-alias', 'dir');
        out = './output-alias/nested';
      } else if (kind === 'hardlinked-outputs') {
        writeFileSync('generated/index.ts', 'retained output\n');
        linkSync('generated/index.ts', 'generated/metadata.ts');
      } else symlinkSync(kind === 'leaf' ? '../local.sqlite' : '../missing.sqlite', 'generated/metadata.ts');
      const before = snapshot();
      for (const operation of [generateLibsqlProject, initLibsqlProject]) {
        await assert.rejects(operation({ ...config, out }));
        assert.deepEqual(snapshot(), before);
        await assertCatalogRetained(config);
      }
    });
});

test('native databases with a TypeScript filename remain supported when output is disjoint', async () => {
  await fixture(async (config) => {
    const effective = { ...config, url: 'file:./local%20catalog.ts' };
    await catalog(effective);
    const before = readFileSync('local catalog.ts');
    await generateLibsqlProject(effective, { noTimestamp: true });
    assert.deepEqual(readFileSync('local catalog.ts'), before);
    await assertCatalogRetained(effective);
  });
});

test('invalid init generation renders before persistent effects and preserves all caller files', async () => {
  for (const existing of [false, true])
    for (const callerFiles of [false, true])
      await fixture(async (config) => {
        const effective = { ...config, url: 'file:./nested/new.sqlite' };
        if (existing) {
          mkdirSync('nested');
          await catalog(effective);
        }
        writeFileSync('fixture-label.txt', 'Owned no-.git native failure fixture\n');
        writeFileSync('package.json', '{"type":"module"}\n');
        writeFileSync('turbine.config.mjs', 'export default { engine: "libsql" };\n');
        if (callerFiles) {
          writeFileSync('.gitignore', 'caller-rule\n');
          writeFileSync('libsql-example.ts', 'caller example\n');
          mkdirSync('generated');
          writeFileSync('generated/caller.txt', 'caller output directory\n');
        }
        const before = snapshot();
        const invalid: Partial<LibsqlProjectConfig>[] = [
          { columnTypes: { 'absent.col': 'string' } },
          { include: ['parents'], columnTypes: { 'absent.col': 'string' } },
          { columnTypes: { malformed: 'string' } },
          ...(existing
            ? [
                { columnTypes: { 'parents.absent': 'string' } },
                { columnTypes: { 'parents.display_name': 'string; injected' } },
              ]
            : []),
        ];
        for (const extra of invalid) {
          await assert.rejects(initLibsqlProject({ ...effective, ...extra }, { noTimestamp: true }));
          assert.deepEqual(snapshot(), before);
          if (existing) await assertCatalogRetained(effective);
          assert.deepEqual(snapshot(), before);
        }
        assert.equal(existsSync('turbine.config.ts'), false);
        assert.equal(existsSync('generated/metadata.ts'), false);
        if (!existing) assert.equal(existsSync('nested'), false);
      });
});

test('relation renames and explicit sibling import modes are forwarded without reinterpretation', async () => {
  await fixture(async (config) => {
    await catalog(config);
    for (const [importExtension, ext] of [
      ['ts', '.ts'],
      ['none', ''],
      ['auto', '.js'],
    ] as const) {
      const result = await generateLibsqlProject(
        { ...config, importExtension, relationNames: { parents: { profile: 'ownProfile' } } },
        { noTimestamp: true },
      );
      assert.ok(result.schema.tables.parents!.relations.ownProfile);
      assert.match(
        readFileSync('generated/index.ts', 'utf8'),
        new RegExp(`from '\\./metadata${ext.replace('.', '\\.')}'`),
      );
    }
  });
});

test('catalog reads and missing-file refusals never create databases or migration tracking', async () => {
  await fixture(async (config) => {
    await assert.rejects(introspectLibsqlProject(config), /existing regular file/);
    await assert.rejects(generateLibsqlProject(config), /existing regular file/);
    assert.deepEqual(readdirSync('.'), []);
    await catalog(config);
    const before = readFileSync('local.sqlite');
    await introspectLibsqlProject(config);
    assert.deepEqual(readFileSync('local.sqlite'), before);
    const client = createClient({ url: config.url });
    try {
      const result = await client.execute("SELECT name FROM sqlite_master WHERE name = '_turbine_migrations'");
      assert.equal(result.rows.length, 0);
    } finally {
      client.close();
    }
  });
});

test('remote, ephemeral, configured and malformed paths fail before init effects', async () => {
  await fixture(async (config) => {
    for (const url of [
      ':memory:',
      'file::memory:',
      'libsql://host/db',
      'https://host',
      'file://remote/db',
      'file:',
      'file:db?sync=1',
      'file:db#fragment',
      'file:%00',
      'file:%zz',
      'file:%3F',
      './local.sqlite',
    ]) {
      await assert.rejects(initLibsqlProject({ ...config, url }), Error, url);
      assert.deepEqual(readdirSync('.'), [], url);
    }
    for (const extra of [
      { authToken: 'refused' },
      { syncUrl: 'file:other' },
      { replicas: [] },
      { turso: true },
      { remote: false },
      { credentials: {} },
      { encryptionKey: 'refused' },
      { schemaFileConfigured: true },
      { adapter: {} },
      { schema: 'public' },
    ]) {
      await assert.rejects(initLibsqlProject({ ...config, ...extra } as LibsqlProjectConfig));
      assert.deepEqual(readdirSync('.'), []);
    }
    assert.equal(libsqlProjectUrl('file:./space%20name.sqlite').databasePath.endsWith('/space name.sqlite'), true);
  });
});

test('output and ignore symlinks, traversal and unsupported options fail without writes', async () => {
  await fixture(async (config) => {
    symlinkSync('.', 'escape', 'dir');
    for (const out of ['../outside', './escape/generated']) {
      await assert.rejects(initLibsqlProject({ ...config, out }));
      assert.equal(existsSync('local.sqlite'), false);
    }
    symlinkSync('missing-ignore', '.gitignore');
    // Dangling links must be refused before persistent initialization effects.
    await assert.rejects(initLibsqlProject(config));
    assert.equal(existsSync('local.sqlite'), false);
    assert.equal(existsSync('missing-ignore'), false);
  });
});

test('closed command and flag admission rejects lifecycle and remote flags before effects', () => {
  for (const command of [
    'migrate',
    'migration',
    'm',
    'push',
    'schema',
    'doctor',
    'diff',
    'mcp',
    'capabilities',
    'compile',
    'seed',
    's',
  ])
    assert.throws(() => assertLibsqlProjectArguments(command, [command]), /unsupported/);
  for (const raw of [
    ['init', '--url'],
    ['pull', '--url', '--out'],
    ['init', '--auth-token', 'x'],
    ['generate', '--sync-url', 'file:db'],
    ['generate', '--replicas', '[]'],
    ['init', '--with-schema'],
    ['status', '--exit-code'],
    ['generate', '--zod'],
    ['pull', 'unexpected'],
  ])
    assert.throws(() => assertLibsqlProjectArguments(raw[0]!, raw));
  assertLibsqlProjectArguments('pull', ['pull', '--engine', 'libsql', '--url', 'file:db', '--no-timestamp']);
});
