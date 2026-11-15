/**
 * turbine-orm, CLI files that were checked by name and then used by name.
 *
 * The local D1, libSQL and MySQL project commands looked at a file (`lstat`,
 * `existsSync`) and then read or appended to it by name. Between the two the
 * name can be replaced: a symlink or a hard link planted there was read or
 * written through, and a `.gitignore` that appeared after the look was skipped,
 * leaving the next file the command wrote unignored. Each test stages that
 * replacement at the first open, read or write of the name, which is the
 * window, and pins the behavior that replaced the look:
 *
 *   - the D1 marker, plan and seed, and libSQL migration inputs, are checked
 *     and read through one descriptor opened without following a symlink;
 *   - libSQL init appends to `.gitignore` through such a descriptor, and adds
 *     its lines to a `.gitignore` that appeared after it looked;
 *   - MySQL init gives a `.gitignore` that appeared after it looked the `/.env`
 *     rule before `.env` is written.
 *
 * Run: npx tsx --test src/test/cli-file-races.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, {
  chmodSync,
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { D1_MARKER, type D1Context, requireD1State, resolveD1Context } from '../cli/d1-local.js';
import { readD1Plan } from '../cli/d1-migrations.js';
import { D1SeedError, readD1Seed } from '../cli/d1-seed.js';
import { migrateLibsqlDeploy } from '../cli/libsql-migrate.js';
import { initLibsqlProject, type LibsqlProjectConfig } from '../cli/libsql-project.js';
import { ignoreEnvFile } from '../cli/mysql-project.js';
import { openNoFollow } from '../cli/no-follow.js';

const canLink = process.platform !== 'win32';
// Permission bits do not stop root, and Windows has no mode bits to clear.
const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0;
const TSX_LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const D1_MIGRATIONS = new URL('../cli/d1-migrations.ts', import.meta.url).href;
const USES = ['openSync', 'readFileSync', 'writeFileSync', 'appendFileSync'] as const;

/**
 * Run `run` with `stage` called just before the first open, read or write of
 * `target` by name: the moment after any separate check and before the use.
 */
async function raceAtFirstUse<T>(
  target: string,
  stage: () => void,
  run: () => T | Promise<T>,
): Promise<{ staged: boolean; result: PromiseSettledResult<T> }> {
  const real = Object.fromEntries(USES.map((name) => [name, fs[name]])) as Record<string, unknown>;
  const at = resolve(target);
  let staged = false;
  for (const name of USES) {
    (fs as unknown as Record<string, unknown>)[name] = function patched(this: unknown, ...args: unknown[]) {
      if (!staged && typeof args[0] === 'string' && resolve(args[0]) === at) {
        staged = true;
        stage();
      }
      return (real[name] as (...a: unknown[]) => unknown).apply(fs, args);
    };
  }
  syncBuiltinESMExports();
  try {
    const [result] = await Promise.allSettled([Promise.resolve().then(run)]);
    return { staged, result: result! };
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
}

/** Replace `path` with a link to `target`, a symbolic one or a hard one. */
const replaceWithLink = (path: string, target: string, kind: 'symlink' | 'hardlink') => () => {
  rmSync(path);
  if (kind === 'symlink') symlinkSync(target, path);
  else linkSync(target, path);
};

/** Run `fn` inside a throwaway directory, always restoring the original cwd. */
async function inTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-cli-races-'));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    await fn(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

function d1Context(): D1Context {
  return resolveD1Context({
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
    d1: { binding: 'DB', databaseId: 'race-check', persist: './state' },
  });
}

describe('local D1 inputs are checked and read as one file', { skip: !canLink }, () => {
  it('requireD1State refuses a marker replaced by a symlink after it was checked', () =>
    inTempDir(async (dir) => {
      const context = d1Context();
      const databaseFile = `miniflare-D1DatabaseObject/${'a'.repeat(64)}.sqlite`;
      mkdirSync(join(context.persist, 'miniflare-D1DatabaseObject'), { recursive: true });
      writeFileSync(join(context.persist, databaseFile), 'never opened here');
      const marker = join(context.persist, D1_MARKER);
      const body = JSON.stringify({
        version: 1,
        runtime: 'miniflare@4.20260730.0',
        binding: 'DB',
        databaseId: 'race-check',
        databaseFile,
      });
      writeFileSync(marker, body);
      assert.doesNotThrow(() => requireD1State(context));
      // A valid marker elsewhere: read through the link, it would be accepted.
      const planted = join(dir, 'planted.json');
      writeFileSync(planted, body);

      const { staged, result } = await raceAtFirstUse(marker, replaceWithLink(marker, planted, 'symlink'), () =>
        requireD1State(context),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'rejected', 'the marker was read through the symlink');
      assert.match(String((result as PromiseRejectedResult).reason), /uninitialized or its identity differs/);
    }));

  for (const kind of ['symlink', 'hardlink'] as const) {
    it(`readD1Plan refuses a plan replaced by a ${kind} after it was checked`, () =>
      inTempDir(async (dir) => {
        const plan = join(dir, 'plan.json');
        const planted = join(dir, 'planted.json');
        writeFileSync(plan, JSON.stringify([{ id: '0001_items', statements: ['CREATE TABLE items(id INTEGER)'] }]));
        writeFileSync(planted, JSON.stringify([{ id: '0001_other', statements: ['CREATE TABLE other(id INTEGER)'] }]));
        assert.equal(readD1Plan(plan)[0]?.id, '0001_items');

        const { staged, result } = await raceAtFirstUse(plan, replaceWithLink(plan, planted, kind), () =>
          readD1Plan(plan),
        );
        assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
        assert.equal(result.status, 'rejected', `the plan was read through the ${kind}`);
        assert.match(String((result as PromiseRejectedResult).reason), /regular, unaliased file/);
      }));
  }

  it('readD1Plan refuses a FIFO without waiting for a writer', { skip: process.platform === 'win32' }, () =>
    inTempDir((dir) => {
      const plan = join(dir, 'plan.json');
      execFileSync('mkfifo', [plan]);
      // In a child process: an open that waits for a writer blocks the whole
      // process, so in this one it would hang instead of failing.
      const script = `import { readD1Plan } from ${JSON.stringify(D1_MIGRATIONS)};
try { readD1Plan(${JSON.stringify(plan)}); } catch (error) { console.log(error.message); }`;
      const child = spawnSync(process.execPath, ['--import', TSX_LOADER, '--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      assert.equal(child.error, undefined, 'the open waited for a writer');
      assert.match(child.stdout, /regular, unaliased file/, child.stderr);
    }),
  );

  it('readD1Seed refuses a seed replaced by a symlink after it was checked', () =>
    inTempDir(async (dir) => {
      const context = d1Context();
      mkdirSync(context.migrations, { recursive: true });
      const seed = join(context.migrations, 'seed.json');
      const planted = join(dir, 'planted.json');
      const plan = (table: string) =>
        JSON.stringify({ version: 1, operations: [{ table, columns: ['id'], rows: [[1]] }] });
      writeFileSync(seed, plan('items'));
      writeFileSync(planted, plan('other'));
      assert.equal(readD1Seed(context)[0]?.table, 'items');

      const { staged, result } = await raceAtFirstUse(seed, replaceWithLink(seed, planted, 'symlink'), () =>
        readD1Seed(context),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'rejected', 'the seed was read through the symlink');
      const reason = (result as PromiseRejectedResult).reason;
      assert.ok(reason instanceof D1SeedError, String(reason));
      assert.match(reason.message, /private regular file/);
    }));
});

describe('local libSQL deploy reads each migration once', { skip: !canLink }, () => {
  it('refuses a migration replaced by a symlink after it was checked, before opening the database', () =>
    inTempDir(async (dir) => {
      const database = join(dir, 'local.sqlite');
      writeFileSync(database, '');
      const migrations = join(dir, 'migrations');
      mkdirSync(migrations);
      const input = join(migrations, '20260101000000_first.sql');
      writeFileSync(input, '-- UP\nCREATE TABLE first(id INTEGER PRIMARY KEY);\n-- DOWN\nDROP TABLE first;\n');
      const planted = join(dir, 'planted.sql');
      writeFileSync(planted, '-- UP\nCREATE TABLE planted(id INTEGER PRIMARY KEY);\n-- DOWN\nDROP TABLE planted;\n');

      const { staged, result } = await raceAtFirstUse(input, replaceWithLink(input, planted, 'symlink'), () =>
        migrateLibsqlDeploy(database, migrations),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'rejected', 'the migration was read through the symlink and deployed');
      assert.match(String((result as PromiseRejectedResult).reason), /migration inputs must be regular files/);
      assert.equal(readFileSync(database).length, 0, 'the database was opened');
    }));
});

describe('local libSQL init and .gitignore', { skip: !canLink }, () => {
  const config: LibsqlProjectConfig = {
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
  };

  it('never appends through a symlink planted after the .gitignore check', () =>
    inTempDir(async (dir) => {
      writeFileSync('.gitignore', 'keep-me\n');
      const victim = join(dir, 'victim');
      writeFileSync(victim, 'victim\n');

      const { staged, result } = await raceAtFirstUse(
        '.gitignore',
        replaceWithLink('.gitignore', victim, 'symlink'),
        () => initLibsqlProject(config, { noTimestamp: true, skipGenerate: true }),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(readFileSync(victim, 'utf8'), 'victim\n', '.gitignore lines were appended through the symlink');
      assert.equal(result.status, 'rejected');
      assert.match(String((result as PromiseRejectedResult).reason), /\.gitignore must be a regular file/);
    }));

  it('adds its lines to a .gitignore that appears after it looked', () =>
    inTempDir(async () => {
      const { staged, result } = await raceAtFirstUse(
        '.gitignore',
        () => writeFileSync('.gitignore', 'mine\n'),
        () => initLibsqlProject(config, { noTimestamp: true, skipGenerate: true }),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
      assert.equal(readFileSync('.gitignore', 'utf8'), 'mine\n.env\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n');
      assert.equal(
        (result as PromiseFulfilledResult<{ created: string[] }>).value.created.includes('.gitignore'),
        false,
      );
    }));
});

describe('MySQL init and the /.env rule', () => {
  it('creates .gitignore with the rule when nothing is there, and reports it', () =>
    inTempDir(() => {
      const created: string[] = [];
      ignoreEnvFile(created);
      assert.deepEqual(created, ['.gitignore']);
      assert.equal(readFileSync('.gitignore', 'utf8'), '# Local database credentials\n/.env\n');
      ignoreEnvFile(created);
      assert.equal(readFileSync('.gitignore', 'utf8'), '# Local database credentials\n/.env\n');
      assert.deepEqual(created, ['.gitignore']);
    }));

  it('appends the rule to an existing .gitignore once', () =>
    inTempDir(() => {
      writeFileSync('.gitignore', '/venv');
      const created: string[] = [];
      ignoreEnvFile(created);
      ignoreEnvFile(created);
      assert.deepEqual(created, []);
      assert.equal(readFileSync('.gitignore', 'utf8'), '/venv\n# Local database credentials\n/.env\n');
    }));

  it('stops at a dangling .gitignore symlink instead of skipping the rule', { skip: !canLink }, () =>
    inTempDir((dir) => {
      symlinkSync(join(dir, 'missing'), '.gitignore');
      const created: string[] = [];
      assert.throws(() => ignoreEnvFile(created), /\.gitignore cannot be read or created \(a dangling symlink\?\)/);
      assert.deepEqual(created, []);
    }),
  );

  it('gives a .gitignore that appears after it looked the rule', () =>
    inTempDir(async () => {
      const created: string[] = [];
      const { staged, result } = await raceAtFirstUse(
        '.gitignore',
        () => writeFileSync('.gitignore', 'node_modules\n'),
        () => ignoreEnvFile(created),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
      assert.equal(
        readFileSync('.gitignore', 'utf8'),
        'node_modules\n\n# Local database credentials\n/.env\n',
        '.env would be written with no ignore rule for it',
      );
      assert.deepEqual(created, []);
    }));
});

/**
 * Run `run` with `stage` called the first time a descriptor opened on `target`
 * is used (its fstat or a read): after the name was admitted and before its
 * bytes are read or appended to. Anything that goes back to the name after
 * that point sees what `stage` put there instead of the admitted file.
 */
async function raceAfterOpen<T>(
  target: string,
  stage: () => void,
  run: () => T | Promise<T>,
): Promise<{ staged: boolean; result: PromiseSettledResult<T> }> {
  const names = ['openSync', 'fstatSync', 'readFileSync'] as const;
  const real = Object.fromEntries(names.map((name) => [name, fs[name]])) as Record<string, unknown>;
  const call = (name: string, args: unknown[]) => (real[name] as (...a: unknown[]) => unknown).apply(fs, args);
  const at = resolve(target);
  let opened: number | undefined;
  let staged = false;
  const patched = fs as unknown as Record<string, unknown>;
  patched.openSync = (...args: unknown[]) => {
    const fd = call('openSync', args);
    if (opened === undefined && typeof args[0] === 'string' && resolve(args[0]) === at) opened = fd as number;
    return fd;
  };
  for (const name of ['fstatSync', 'readFileSync'] as const) {
    patched[name] = (...args: unknown[]) => {
      if (!staged && opened !== undefined && args[0] === opened) {
        staged = true;
        stage();
      }
      return call(name, args);
    };
  }
  syncBuiltinESMExports();
  try {
    const [result] = await Promise.allSettled([Promise.resolve().then(run)]);
    return { staged, result: result! };
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
}

/** Move the admitted file at `path` aside to `aside` and put `replacement` at its name. */
const replaceAfterAdmission = (path: string, aside: string, replacement: string) => () => {
  renameSync(path, aside);
  writeFileSync(path, replacement);
};

describe('admitted files are read and appended through their descriptor', { skip: !canLink }, () => {
  it('readD1Plan reads the bytes of the file it admitted, not a file renamed into its place', () =>
    inTempDir(async (dir) => {
      const plan = join(dir, 'plan.json');
      writeFileSync(plan, JSON.stringify([{ id: '0001_checked', statements: ['CREATE TABLE a(id INTEGER)'] }]));
      const replaced = JSON.stringify([{ id: '0001_replaced', statements: ['CREATE TABLE b(id INTEGER)'] }]);
      const { staged, result } = await raceAfterOpen(
        plan,
        replaceAfterAdmission(plan, join(dir, 'admitted.json'), replaced),
        () => readD1Plan(plan),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
      const read = (result as PromiseFulfilledResult<ReturnType<typeof readD1Plan>>).value;
      assert.equal(read[0]?.id, '0001_checked', 'the plan was read by name after it was admitted');
    }));

  it('libSQL init appends to the .gitignore it admitted, not to a file renamed into its place', () =>
    inTempDir(async () => {
      writeFileSync('.gitignore', 'keep-me\n');
      const { staged, result } = await raceAfterOpen(
        '.gitignore',
        replaceAfterAdmission('.gitignore', 'admitted', 'other\n'),
        () =>
          initLibsqlProject(
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
            { noTimestamp: true, skipGenerate: true },
          ),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
      assert.equal(readFileSync('admitted', 'utf8'), 'keep-me\n.env\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n');
      assert.equal(readFileSync('.gitignore', 'utf8'), 'other\n', 'the lines went to the file renamed into place');
    }));

  it('MySQL init appends the rule to the .gitignore it opened, not to a file renamed into its place', () =>
    inTempDir(async () => {
      writeFileSync('.gitignore', 'node_modules\n');
      const created: string[] = [];
      const { staged, result } = await raceAfterOpen(
        '.gitignore',
        replaceAfterAdmission('.gitignore', 'admitted', 'other\n'),
        () => ignoreEnvFile(created),
      );
      assert.equal(staged, true, 'the race was never staged, so this test proves nothing');
      assert.equal(result.status, 'fulfilled', String((result as PromiseRejectedResult).reason));
      assert.equal(readFileSync('admitted', 'utf8'), 'node_modules\n\n# Local database credentials\n/.env\n');
      assert.equal(readFileSync('.gitignore', 'utf8'), 'other\n', 'the rule went to the file renamed into place');
    }));
});

describe('a read-only .gitignore that already has every line', { skip: !canDenyWrites }, () => {
  it('MySQL init leaves it alone, and still refuses one that lacks the rule', () =>
    inTempDir(() => {
      const complete = '# Local database credentials\n/.env\n';
      writeFileSync('.gitignore', complete);
      chmodSync('.gitignore', 0o444);
      const created: string[] = [];
      ignoreEnvFile(created);
      assert.equal(readFileSync('.gitignore', 'utf8'), complete);
      assert.deepEqual(created, []);

      chmodSync('.gitignore', 0o644);
      writeFileSync('.gitignore', 'node_modules\n');
      chmodSync('.gitignore', 0o444);
      assert.throws(() => ignoreEnvFile(created), { code: 'EACCES' });
      assert.equal(readFileSync('.gitignore', 'utf8'), 'node_modules\n');
    }));

  it('libSQL init leaves it alone', () =>
    inTempDir(async () => {
      const complete = '.env\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n';
      writeFileSync('.gitignore', complete);
      chmodSync('.gitignore', 0o444);
      await initLibsqlProject(
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
        { noTimestamp: true, skipGenerate: true },
      );
      assert.equal(readFileSync('.gitignore', 'utf8'), complete);
    }));
});

/** Run `open`, returning what it threw and every descriptor it opened. */
function opening(open: () => number): { error: unknown; fds: number[] } {
  const real = fs.openSync;
  const fds: number[] = [];
  (fs as unknown as Record<string, unknown>).openSync = (...args: Parameters<typeof real>) => {
    const fd = real.apply(fs, args);
    fds.push(fd);
    return fd;
  };
  syncBuiltinESMExports();
  try {
    fds.push(open());
    return { error: undefined, fds };
  } catch (error) {
    return { error, fds };
  } finally {
    fs.openSync = real;
    syncBuiltinESMExports();
  }
}

const isClosed = (fd: number) => {
  try {
    fs.fstatSync(fd);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EBADF';
  }
};

/** Call `stage` just before the first lstat of `target`. */
function beforeLstat<T>(target: string, stage: () => void, run: () => T): T {
  const real = fs.lstatSync;
  const patched = fs as unknown as Record<string, unknown>;
  const at = resolve(target);
  let staged = false;
  patched.lstatSync = (...args: Parameters<typeof real>) => {
    if (!staged && typeof args[0] === 'string' && resolve(args[0]) === at) {
      staged = true;
      stage();
    }
    return real.apply(fs, args);
  };
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    patched.lstatSync = real;
    syncBuiltinESMExports();
  }
}

describe('the open for platforms without O_NOFOLLOW', { skip: !canLink }, () => {
  const fallback = (path: string) => openNoFollow(path, constants.O_RDONLY, 0);

  it('keeps the descriptor of a plain file', () =>
    inTempDir((dir) => {
      const file = join(dir, 'plan.json');
      writeFileSync(file, 'plain');
      const { error, fds } = opening(() => fallback(file));
      assert.equal(error, undefined);
      assert.equal(readFileSync(fds.at(-1)!, 'utf8'), 'plain');
      fs.closeSync(fds.at(-1)!);
    }));

  it('refuses a symlink and closes what it opened', () =>
    inTempDir((dir) => {
      writeFileSync(join(dir, 'victim'), 'victim');
      symlinkSync(join(dir, 'victim'), join(dir, 'plan.json'));
      const { error, fds } = opening(() => fallback(join(dir, 'plan.json')));
      assert.equal((error as NodeJS.ErrnoException).code, 'ELOOP');
      assert.ok(fds.length > 0 && fds.every(isClosed), 'a descriptor was left open');
    }));

  it('refuses a name that no longer names the file it opened, and closes it', () =>
    inTempDir((dir) => {
      const file = join(dir, 'plan.json');
      writeFileSync(file, 'opened');
      const { error, fds } = beforeLstat(file, replaceAfterAdmission(file, join(dir, 'aside'), 'replaced'), () =>
        opening(() => fallback(file)),
      );
      assert.equal((error as NodeJS.ErrnoException).code, 'ELOOP', 'the descriptor of a different file was kept');
      assert.ok(fds.length > 0 && fds.every(isClosed), 'a descriptor was left open');
    }));

  it('closes what it opened when the name disappears before it is checked', () =>
    inTempDir((dir) => {
      const file = join(dir, 'plan.json');
      writeFileSync(file, 'opened');
      const { error, fds } = beforeLstat(
        file,
        () => rmSync(file),
        () => opening(() => fallback(file)),
      );
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      assert.ok(fds.length > 0 && fds.every(isClosed), 'a descriptor was left open');
    }));
});

describe('a socket where a D1 input belongs', { skip: process.platform === 'win32' }, () => {
  it('readD1Plan refuses it with the usual validation error', () =>
    inTempDir(async (dir) => {
      const plan = join(dir, 'plan.json');
      const server = createServer();
      await new Promise<void>((done) => server.listen(plan, done));
      try {
        assert.throws(() => readD1Plan(plan), /regular, unaliased file/);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    }));
});
