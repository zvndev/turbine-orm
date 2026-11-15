/**
 * turbine-orm, CLI TypeScript loader registration against fake tsx installs
 *
 * `registerTsLoader()` resolves `tsx` from the user's current working
 * directory and prefers its programmatic APIs, with fallbacks for older or
 * differently-shaped installs (a legacy side-effect entry, a manifest whose
 * ESM entry is spelled as a string or as `{ default }`, a manifest that is
 * not exported at all, and installs whose API entry exports no `register()`).
 * Each test lays out a fake `tsx` package under a temporary project
 * directory, points the process cwd at it, and asserts which entry the
 * loader picked by the marker files the fake register functions write.
 *
 * Run: npx tsx --test src/test/cli-loader-tsx-fallbacks.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { _resetTsLoaderStateForTests, getTsLoaderError, registerTsLoader } from '../cli/loader.js';

interface FakeProject {
  dir: string;
  /** Marker file names a fake register function may write, keyed by label. */
  marker(label: string): string;
  /** The marker contents for `label`, or null if that entry never ran. */
  read(label: string): string | null;
}

/**
 * Write a fake `tsx` package into `dir/node_modules/tsx` with the supplied
 * `exports` map and dist files. The fake `register()` bodies write their
 * label into a marker file instead of registering a real loader, so which
 * entry the loader selected is observable without side effects on this
 * process (the one exception is the legacy `module.register('tsx/esm')`
 * path, whose hooks module below exports only an empty `initialize`).
 */
function makeFakeProject(exportsMap: Record<string, unknown>): FakeProject {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-loader-fake-tsx-'));
  const pkgDir = join(dir, 'node_modules', 'tsx');
  const dist = join(pkgDir, 'dist');
  mkdirSync(dist, { recursive: true });

  const marker = (label: string): string => join(dir, `marker-${label}.txt`);
  const esmRegister = (label: string): string =>
    `import { writeFileSync } from 'node:fs';\n` +
    `export function register() { writeFileSync(${JSON.stringify(marker(label))}, ${JSON.stringify(label)}); }\n`;
  const cjsRegister = (label: string): string =>
    `const { writeFileSync } = require('node:fs');\n` +
    `exports.register = () => { writeFileSync(${JSON.stringify(marker(label))}, ${JSON.stringify(label)}); };\n`;

  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'tsx', version: '0.0.0-fake', exports: exportsMap }, null, 2),
  );
  // The ESM entry selected through the manifest, and the one plain
  // require-resolution lands on. They write different markers so a test can
  // tell which of the two the loader actually imported.
  writeFileSync(join(dist, 'esm-api.mjs'), esmRegister('esm-import'));
  writeFileSync(join(dist, 'esm-api-require.mjs'), esmRegister('esm-require'));
  writeFileSync(join(dist, 'esm-api-string.mjs'), esmRegister('esm-string'));
  writeFileSync(join(dist, 'esm-api-plain.mjs'), esmRegister('esm-plain'));
  writeFileSync(join(dist, 'esm-api-no-register.mjs'), 'export const notRegister = 1;\n');
  writeFileSync(
    join(dist, 'esm-api-throws.mjs'),
    "export function register() { throw new Error('fake esm register boom'); }\n",
  );
  writeFileSync(
    join(dist, 'esm-api-throws-string.mjs'),
    "export function register() { throw 'fake esm string boom'; }\n",
  );
  writeFileSync(join(dist, 'cjs-api.cjs'), cjsRegister('cjs'));
  writeFileSync(join(dist, 'cjs-api-no-register.cjs'), 'exports.notRegister = 1;\n');
  writeFileSync(
    join(dist, 'cjs-api-throws-string.cjs'),
    "exports.register = () => { throw 'fake cjs string boom'; };\n",
  );
  writeFileSync(
    join(dist, 'cjs-index.cjs'),
    `const { writeFileSync } = require('node:fs');\n` +
      `writeFileSync(${JSON.stringify(marker('cjs-legacy'))}, 'cjs-legacy');\n`,
  );
  // A hooks module that registers no resolve/load hooks: loading it through
  // module.register() succeeds and leaves later imports untouched.
  writeFileSync(join(dist, 'esm-hooks.mjs'), 'export async function initialize() {}\n');

  return {
    dir,
    marker,
    read(label) {
      const path = marker(label);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
  };
}

/** Run one registration against a fake project, restoring cwd and state. */
async function registerIn(project: FakeProject) {
  _resetTsLoaderStateForTests();
  const originalCwd = process.cwd();
  try {
    process.chdir(project.dir);
    const status = await registerTsLoader();
    return { status, error: getTsLoaderError() };
  } finally {
    process.chdir(originalCwd);
    _resetTsLoaderStateForTests();
  }
}

function remove(project: FakeProject) {
  rmSync(project.dir, { recursive: true, force: true });
}

/** A current tsx manifest shape: ESM entry as `{ import: { default } }`. */
function modernExports(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    './package.json': './package.json',
    './esm': './dist/esm-hooks.mjs',
    './esm/api': {
      import: { default: './dist/esm-api.mjs' },
      require: './dist/esm-api-require.mjs',
    },
    './cjs': './dist/cjs-index.cjs',
    './cjs/api': './dist/cjs-api.cjs',
    ...overrides,
  };
}

describe('registerTsLoader() against fake tsx installs', () => {
  it('registers through the modern ESM and CommonJS APIs', async () => {
    const project = makeFakeProject(modernExports());
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'registered');
      assert.equal(error, null);
      // The manifest's import entry is preferred over the require-resolved one.
      assert.equal(project.read('esm-import'), 'esm-import');
      assert.equal(project.read('esm-require'), null);
      assert.equal(project.read('cjs'), 'cjs');
      assert.equal(project.read('cjs-legacy'), null);
    } finally {
      remove(project);
    }
  });

  it('selects an ESM entry the manifest spells as a plain string', async () => {
    const project = makeFakeProject(
      modernExports({
        './esm/api': {
          import: './dist/esm-api-string.mjs',
          require: './dist/esm-api-require.mjs',
        },
      }),
    );
    try {
      const { status } = await registerIn(project);
      assert.equal(status, 'registered');
      assert.equal(project.read('esm-string'), 'esm-string');
      assert.equal(project.read('esm-require'), null);
    } finally {
      remove(project);
    }
  });

  it('keeps the require-resolved API when the manifest is not exported', async () => {
    const exportsMap = modernExports();
    delete exportsMap['./package.json'];
    const project = makeFakeProject(exportsMap);
    try {
      const { status } = await registerIn(project);
      assert.equal(status, 'registered');
      assert.equal(project.read('esm-require'), 'esm-require');
      assert.equal(project.read('esm-import'), null);
      assert.equal(project.read('cjs'), 'cjs');
    } finally {
      remove(project);
    }
  });

  it('keeps the require-resolved API when the manifest names no import entry', async () => {
    const project = makeFakeProject(modernExports({ './esm/api': './dist/esm-api-plain.mjs' }));
    try {
      const { status } = await registerIn(project);
      assert.equal(status, 'registered');
      assert.equal(project.read('esm-plain'), 'esm-plain');
    } finally {
      remove(project);
    }
  });

  it('keeps the require-resolved API when the manifest import path is not package-relative', async () => {
    const project = makeFakeProject(
      modernExports({
        './esm/api': {
          import: 'dist/esm-api-string.mjs',
          require: './dist/esm-api-require.mjs',
        },
      }),
    );
    try {
      const { status } = await registerIn(project);
      assert.equal(status, 'registered');
      assert.equal(project.read('esm-require'), 'esm-require');
      assert.equal(project.read('esm-string'), null);
    } finally {
      remove(project);
    }
  });

  it('fails with the real reason when tsx/cjs/api exports no register()', async () => {
    const project = makeFakeProject(modernExports({ './cjs/api': './dist/cjs-api-no-register.cjs' }));
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'failed');
      assert.match(error ?? '', /tsx\/cjs\/api resolved at .*exports no register\(\) function/);
      // The CommonJS registration runs first, so the ESM one never starts.
      assert.equal(project.read('esm-import'), null);
    } finally {
      remove(project);
    }
  });

  it('falls back to the legacy tsx/cjs entry when tsx/cjs/api cannot be resolved', async () => {
    const exportsMap = modernExports();
    delete exportsMap['./cjs/api'];
    const project = makeFakeProject(exportsMap);
    try {
      const { status } = await registerIn(project);
      assert.equal(status, 'registered');
      assert.equal(project.read('cjs-legacy'), 'cjs-legacy');
      assert.equal(project.read('cjs'), null);
      assert.equal(project.read('esm-import'), 'esm-import');
    } finally {
      remove(project);
    }
  });

  it('fails with the real reason when tsx/esm/api exports no register()', async () => {
    const project = makeFakeProject(
      modernExports({
        './esm/api': {
          import: { default: './dist/esm-api-no-register.mjs' },
          require: './dist/esm-api-require.mjs',
        },
      }),
    );
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'failed');
      assert.match(error ?? '', /tsx\/esm\/api resolved at .*exports no register\(\) function/);
      // The missing register() is refused before the CommonJS one runs.
      assert.equal(project.read('cjs'), null);
    } finally {
      remove(project);
    }
  });

  it('reports the underlying message when the ESM register() throws', async () => {
    const project = makeFakeProject(
      modernExports({
        './esm/api': {
          import: { default: './dist/esm-api-throws.mjs' },
          require: './dist/esm-api-require.mjs',
        },
      }),
    );
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'failed');
      assert.equal(error, 'fake esm register boom');
      assert.equal(project.read('cjs'), 'cjs');
    } finally {
      remove(project);
    }
  });

  it('stringifies a non-Error thrown by the ESM register()', async () => {
    const project = makeFakeProject(
      modernExports({
        './esm/api': {
          import: { default: './dist/esm-api-throws-string.mjs' },
          require: './dist/esm-api-require.mjs',
        },
      }),
    );
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'failed');
      assert.equal(error, 'fake esm string boom');
    } finally {
      remove(project);
    }
  });

  it('clears a recorded error once a later registration succeeds', async () => {
    const failing = makeFakeProject(
      modernExports({
        './esm/api': {
          import: { default: './dist/esm-api-throws.mjs' },
          require: './dist/esm-api-require.mjs',
        },
      }),
    );
    const working = makeFakeProject(modernExports());
    try {
      assert.equal((await registerIn(failing)).status, 'failed');
      const second = await registerIn(working);
      assert.equal(second.status, 'registered');
      assert.equal(second.error, null);
    } finally {
      remove(failing);
      remove(working);
    }
  });

  it('registers an old tsx with no tsx/esm/api through module.register()', async () => {
    const exportsMap = modernExports();
    delete exportsMap['./esm/api'];
    const project = makeFakeProject(exportsMap);
    try {
      const { status, error } = await registerIn(project);
      const nodeModule = (await import('node:module')) as { register?: unknown };
      if (typeof nodeModule.register === 'function') {
        assert.equal(status, 'registered');
        assert.equal(error, null);
        assert.equal(project.read('cjs'), 'cjs');
      } else {
        assert.equal(status, 'unsupported');
      }
    } finally {
      remove(project);
    }
  });

  it('registers an old tsx with neither programmatic API through both legacy entries', async () => {
    const exportsMap = modernExports();
    delete exportsMap['./esm/api'];
    delete exportsMap['./cjs/api'];
    const project = makeFakeProject(exportsMap);
    try {
      const { status } = await registerIn(project);
      const nodeModule = (await import('node:module')) as { register?: unknown };
      if (typeof nodeModule.register === 'function') {
        assert.equal(status, 'registered');
        assert.equal(project.read('cjs-legacy'), 'cjs-legacy');
      } else {
        assert.equal(status, 'unsupported');
      }
    } finally {
      remove(project);
    }
  });

  it('stringifies a non-Error thrown through the legacy path', async () => {
    const exportsMap = modernExports({ './cjs/api': './dist/cjs-api-throws-string.cjs' });
    delete exportsMap['./esm/api'];
    const project = makeFakeProject(exportsMap);
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'failed');
      assert.equal(error, 'fake cjs string boom');
    } finally {
      remove(project);
    }
  });

  it('fails through the legacy path when its CommonJS registration refuses', async () => {
    const exportsMap = modernExports({ './cjs/api': './dist/cjs-api-no-register.cjs' });
    delete exportsMap['./esm/api'];
    const project = makeFakeProject(exportsMap);
    try {
      const { status, error } = await registerIn(project);
      assert.equal(status, 'failed');
      assert.match(error ?? '', /tsx\/cjs\/api resolved at .*exports no register\(\) function/);
    } finally {
      remove(project);
    }
  });
});
