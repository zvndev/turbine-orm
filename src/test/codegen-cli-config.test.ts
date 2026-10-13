/**
 * Config precedence for the database URL, and the `--import-ext` surface.
 *
 * An exported-but-empty `DATABASE_URL=` is how "not configured" is usually
 * spelled (a shell profile, a `.env` template, a CI secret that was never set).
 * It must not beat a literal `url:` in `turbine.config.ts`, and it must not
 * block the value in a `.env` file either.
 *
 * Run: npx tsx --test src/test/codegen-cli-config.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { firstNonEmpty, resolveConfig } from '../cli/config.js';
import { bootstrapCliConfig, loadDotEnvForCli, parseArgs } from '../cli/index.js';
import { resolveImportExtension } from '../generate.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Run `fn` with `DATABASE_URL` set to `value` (`undefined` = unset), restoring it after. */
async function withDatabaseUrl<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.DATABASE_URL;
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
}

describe('firstNonEmpty', () => {
  it('skips undefined, empty and whitespace-only candidates', () => {
    assert.equal(firstNonEmpty(undefined, '', '   ', '\t\n', 'postgres://x'), 'postgres://x');
  });
  it('returns the first non-blank candidate, not the last', () => {
    assert.equal(firstNonEmpty('a', 'b'), 'a');
  });
  it('returns undefined when nothing is set', () => {
    assert.equal(firstNonEmpty(undefined, '', ' '), undefined);
    assert.equal(firstNonEmpty(), undefined);
  });
});

describe('resolveConfig: DATABASE_URL precedence', () => {
  it('an empty DATABASE_URL does not beat a literal url in the config file', async () => {
    await withDatabaseUrl('', () => {
      const config = resolveConfig({ url: 'postgres://from-file/db' }, {});
      assert.equal(config.url, 'postgres://from-file/db');
    });
  });

  it('a whitespace DATABASE_URL does not beat a literal url in the config file', async () => {
    await withDatabaseUrl('   ', () => {
      assert.equal(resolveConfig({ url: 'postgres://from-file/db' }, {}).url, 'postgres://from-file/db');
    });
  });

  it('a set DATABASE_URL still beats the config file', async () => {
    await withDatabaseUrl('postgres://from-env/db', () => {
      assert.equal(resolveConfig({ url: 'postgres://from-file/db' }, {}).url, 'postgres://from-env/db');
    });
  });

  it('--url beats both, and an empty --url beats neither', async () => {
    await withDatabaseUrl('postgres://from-env/db', () => {
      assert.equal(
        resolveConfig({ url: 'postgres://from-file/db' }, { url: 'postgres://flag/db' }).url,
        'postgres://flag/db',
      );
      assert.equal(resolveConfig({ url: 'postgres://from-file/db' }, { url: '' }).url, 'postgres://from-env/db');
    });
  });

  it('with nothing set anywhere the url is empty, which requireUrl reports', async () => {
    await withDatabaseUrl('', () => {
      assert.equal(resolveConfig({}, {}).url, '');
      assert.equal(resolveConfig({ url: '' }, {}).url, '');
    });
  });

  it('bootstrapCliConfig reads the literal url from turbine.config.js when DATABASE_URL is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-cfg-empty-env-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'turbine.config.js'), "export default { url: 'postgres://literal/db' };\n", 'utf-8');
    const original = process.cwd();
    process.chdir(dir);
    try {
      await withDatabaseUrl('', async () => {
        const boot = await bootstrapCliConfig({ command: 'generate', demo: undefined }, {});
        assert.equal(boot.loadError, undefined);
        assert.equal(boot.config.url, 'postgres://literal/db');
      });
    } finally {
      process.chdir(original);
    }
  });
});

describe('loadDotEnvForCli: an empty DATABASE_URL does not block the .env value', () => {
  /** A loader that behaves like `process.loadEnvFile`: it never overrides a set variable. */
  const fakeLoader = (env: NodeJS.ProcessEnv) => (_path: string) => {
    if (env.DATABASE_URL === undefined) env.DATABASE_URL = 'postgres://from-dotenv/db';
  };

  it('control: a real loader leaves an exported-but-empty variable in place', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: '' };
    fakeLoader(env)('.env');
    assert.equal(env.DATABASE_URL, '', 'the fake loader must model process.loadEnvFile for this test to mean anything');
  });

  it('loads the .env value over an empty variable and reports it as dotenv-sourced', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: '' };
    const result = loadDotEnvForCli({
      env,
      cwd: '/nowhere',
      fileExists: () => true,
      loadEnvFile: fakeLoader(env),
    });
    assert.equal(env.DATABASE_URL, 'postgres://from-dotenv/db');
    assert.equal(result.loaded, true);
    assert.equal(result.databaseUrlProvenance, 'dotenv');
  });

  it('a non-empty shell variable still wins over the .env value', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://from-shell/db' };
    const result = loadDotEnvForCli({
      env,
      cwd: '/nowhere',
      fileExists: () => true,
      loadEnvFile: fakeLoader(env),
    });
    assert.equal(env.DATABASE_URL, 'postgres://from-shell/db');
    assert.equal(result.databaseUrlProvenance, 'shell');
  });

  it('with no .env file an empty variable is left alone and not called a shell URL', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: '' };
    const result = loadDotEnvForCli({ env, cwd: '/nowhere', fileExists: () => false, loadEnvFile: null });
    assert.equal(result.fileExists, false);
    assert.equal(result.databaseUrlProvenance, 'none');
  });
});

describe('--import-ext ts', () => {
  it('parses to the ts mode', () => {
    assert.equal(parseArgs(['generate', '--import-ext', 'ts']).importExtension, 'ts');
  });

  it('the other modes still parse', () => {
    for (const mode of ['js', 'none', 'auto'] as const) {
      assert.equal(parseArgs(['generate', '--import-ext', mode]).importExtension, mode);
    }
  });

  it('resolveConfig carries it from the config file and lets the flag override it', () => {
    assert.equal(resolveConfig({ importExtension: 'ts' }, {}).importExtension, 'ts');
    assert.equal(resolveConfig({ importExtension: 'ts' }, { importExtension: 'js' }).importExtension, 'js');
    assert.equal(resolveConfig({}, {}).importExtension, 'auto');
  });

  it('resolves to .ts specifiers, and auto never picks it', () => {
    assert.deepEqual(resolveImportExtension('./generated/turbine', 'ts'), { ext: '.ts', mode: 'ts' });
    assert.notEqual(resolveImportExtension('./generated/turbine', 'auto').ext, '.ts');
    assert.equal(resolveImportExtension('./generated/turbine', 'js').ext, '.js');
  });
});
