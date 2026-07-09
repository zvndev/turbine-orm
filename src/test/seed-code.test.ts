/**
 * turbine-orm — seed-as-code unit tests
 *
 * Run: npx tsx --test src/test/seed-code.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { resolveConfig, resolveSeedFile } from '../cli/config.js';
import { getSeedExecutionPlan } from '../cli/index.js';
import { defineSeed } from '../seed.js';

describe('seed-as-code config resolution', () => {
  it('supports the new `seed` config field and keeps `seedFile` as an alias', () => {
    assert.equal(resolveConfig({ seed: './db/seed.js' }, {}).seedFile, './db/seed.js');
    assert.equal(resolveConfig({ seedFile: './legacy/seed.sql' }, {}).seedFile, './legacy/seed.sql');
  });

  it('resolves default seed.ts, seed.js, seed.sql candidates in order', () => {
    const dir = join(tmpdir(), `turbine-seed-resolve-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'seed.sql'), 'SELECT 1;');
      writeFileSync(join(dir, 'seed.js'), 'export default async function seed() {}');
      assert.equal(resolveSeedFile({}, dir), resolve(dir, 'seed.js'));

      writeFileSync(join(dir, 'seed.ts'), 'import { defineSeed } from "turbine-orm";');
      assert.equal(resolveSeedFile({}, dir), resolve(dir, 'seed.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses explicit config seed path even when the file does not exist yet', () => {
    const dir = join(tmpdir(), `turbine-seed-explicit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.equal(resolveSeedFile({ seed: './custom/seed.ts' }, dir), resolve(dir, './custom/seed.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seed-as-code execution plan', () => {
  it('runs TypeScript seeds through npx tsx only', () => {
    assert.deepEqual(getSeedExecutionPlan('/tmp/seed.ts'), {
      kind: 'tsx',
      command: 'npx',
      args: ['tsx', '/tmp/seed.ts'],
    });
  });

  it('imports JavaScript seeds and executes SQL seeds directly', () => {
    assert.deepEqual(getSeedExecutionPlan('/tmp/seed.js'), { kind: 'js', file: '/tmp/seed.js' });
    assert.deepEqual(getSeedExecutionPlan('/tmp/seed.sql'), { kind: 'sql', file: '/tmp/seed.sql' });
  });

  it('defineSeed returns an executable seed function', async () => {
    let called = false;
    const run = defineSeed(async () => {
      called = true;
    });
    assert.equal(typeof run, 'function');
    // Clear DATABASE_URL so the missing-URL rejection path is exercised even
    // when the suite runs in an integration environment with a real database.
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(run(), /DATABASE_URL/);
      assert.equal(called, false);
    } finally {
      if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    }
  });
});
