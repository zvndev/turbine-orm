import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertD1Config } from '../cli/d1-config.js';
import { D1_MARKER, requireD1State, resolveD1Context } from '../cli/d1-local.js';

function stateFixture(run: (context: ReturnType<typeof resolveD1Context>, database: string) => void) {
  const previous = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'd1-state-'));
  try {
    process.chdir(root);
    const context = resolveD1Context({
      engine: 'd1',
      url: '',
      schema: 'main',
      out: './generated',
      migrationsDir: './migrations',
      schemaFile: './schema.ts',
      importExtension: 'js',
      keepColumnNames: false,
      legacyToManyUniques: false,
      include: [],
      exclude: [],
      d1: { binding: 'DB', databaseId: 'state-check', persist: './state' },
    });
    const databaseFile = `miniflare-D1DatabaseObject/${'a'.repeat(64)}.sqlite`;
    const database = join(context.persist, databaseFile);
    mkdirSync(join(context.persist, 'miniflare-D1DatabaseObject'), { recursive: true });
    writeFileSync(database, 'native state is never opened by this admission test');
    writeFileSync(
      join(context.persist, D1_MARKER),
      JSON.stringify({
        version: 1,
        runtime: 'miniflare@4.20260730.0',
        binding: 'DB',
        databaseId: 'state-check',
        databaseFile,
      }),
    );
    run(context, database);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`D1 refuses aliased or non-file ${suffix} without changing caller files`, () => {
    for (const kind of ['hardlink', 'symlink', 'directory'])
      stateFixture((context, database) => {
        const caller = join(process.cwd(), 'caller');
        const bytes = Buffer.alloc(65536, 0x41);
        writeFileSync(caller, bytes);
        const sidecar = `${database}${suffix}`;
        if (kind === 'hardlink') linkSync(caller, sidecar);
        else if (kind === 'symlink') symlinkSync(caller, sidecar);
        else mkdirSync(sidecar);
        const before = lstatSync(sidecar);
        assert.throws(() => requireD1State(context), /sidecar|symbolic link/);
        assert.deepEqual(readFileSync(caller), bytes);
        const after = lstatSync(sidecar);
        assert.equal(after.ino, before.ino);
        assert.equal(after.nlink, before.nlink);
        assert.equal(existsSync(join(context.persist, '.turbine-d1.lock')), false);
      });
  });
}

test('D1 config admission retains its exact closed set of own keys', () => {
  const keys = [
    'engine',
    'url',
    'out',
    'schema',
    'include',
    'exclude',
    'relationNames',
    'columnTypes',
    'importExtension',
    'keepColumnNames',
    'exactNativeIntegers',
    'legacyToManyUniques',
    'migrationsDir',
    'seedFile',
    'seed',
    'schemaFile',
    'schemaFileConfigured',
    'adapter',
    'd1',
  ];
  for (const key of keys) {
    assert.doesNotThrow(() => assertD1Config({ [key]: undefined }));
    for (const suffix of [' ', '\n', '\r\n', '\0', 'x'])
      assert.throws(() => assertD1Config({ [key + suffix]: undefined }), TypeError);
  }
  for (const key of ['__proto__', 'constructor', 'toString', '', Symbol('d1')])
    assert.throws(() => assertD1Config({ [key]: undefined }), TypeError);
  let reads = 0;
  assert.doesNotThrow(() =>
    assertD1Config({
      get d1() {
        reads++;
        return undefined;
      },
    }),
  );
  assert.equal(reads, 0);
});

test('D1 admits missing or private regular sidecars without mutating them', () =>
  stateFixture((context, database) => {
    assert.doesNotThrow(() => requireD1State(context));
    for (const suffix of ['-wal', '-shm', '-journal']) {
      writeFileSync(`${database}${suffix}`, suffix);
      assert.doesNotThrow(() => requireD1State(context));
      assert.equal(readFileSync(`${database}${suffix}`, 'utf8'), suffix);
      assert.equal(lstatSync(`${database}${suffix}`).nlink, 1);
    }
  }));
