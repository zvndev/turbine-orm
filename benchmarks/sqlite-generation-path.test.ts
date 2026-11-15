/** Fresh native setup from the documented benchmark working directory. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
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
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const seed = readFileSync(join(root, 'benchmarks/sqlite-seed.ts'), 'utf8');
for (const omission of [false, true]) {
  test(
    omission
      ? 'old cwd-relative generation cannot supply the imported native factory'
      : 'fresh benchmark-directory setup generates and executes the intended factory',
    (t) => {
      const fixture = mkdtempSync(join(tmpdir(), 'sqlite-generation-path-'));
      t.after(() => rmSync(fixture, { recursive: true, force: true }));
      const directory = join(fixture, 'benchmarks');
      mkdirSync(directory);
      writeFileSync(join(fixture, 'package.json'), '{"type":"module"}\n');
      symlinkSync(join(root, 'dist'), join(fixture, 'dist'), 'dir');
      symlinkSync(join(root, 'benchmarks/node_modules'), join(directory, 'node_modules'), 'dir');
      const source = omission
        ? seed.replace(
            "fileURLToPath(new URL('./generated/sqlite-turbine', import.meta.url))",
            "resolve('benchmarks/generated/sqlite-turbine')",
          )
        : seed;
      if (omission) assert.notEqual(source, seed, 'omission must change the seed path');
      writeFileSync(join(directory, 'sqlite-seed.ts'), source);
      copyFileSync(
        join(root, 'benchmarks/sqlite-comparison-identity.ts'),
        join(directory, 'sqlite-comparison-identity.ts'),
      );
      const file = join(fixture, 'fixture.sqlite');
      const loader = join(root, 'benchmarks/node_modules/tsx/dist/loader.mjs');
      const run = (args: string[]) =>
        spawnSync(process.execPath, ['--import', loader, ...args], {
          cwd: directory,
          env: { ...process.env, SQLITE_FILE: file },
          encoding: 'utf8',
          timeout: 30000,
        });
      const seeded = run(['sqlite-seed.ts']);
      assert.ifError(seeded.error);
      assert.equal(seeded.status, 0, seeded.stderr);
      const expected = join(directory, 'generated/sqlite-turbine/index.ts');
      assert.equal(existsSync(expected), !omission);
      assert.equal(existsSync(join(directory, 'benchmarks/generated/sqlite-turbine/index.ts')), omission);
      writeFileSync(
        join(directory, 'consume.mjs'),
        `
      import assert from 'node:assert/strict';
      const { turbine } = await import('./generated/sqlite-turbine/index.ts');
      const db = turbine(process.env.SQLITE_FILE, { logging: false });
      try { assert.equal(await db.table('users').count(), 1000); }
      finally { await db.disconnect(); }
    `,
      );
      const consumed = run(['consume.mjs']);
      assert.ifError(consumed.error);
      assert.equal(consumed.status, omission ? 1 : 0, consumed.stderr);
      if (omission) assert.match(consumed.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    },
  );
}
