/**
 * turbine-orm, `$on('query')` failure events survive a production minifier.
 *
 * Next.js minifies server bundles with SWC, and SWC's compressor rewrites
 *
 *     try { ... } catch (err) { error = wrap(err); throw error; }
 *     finally { report(error); }
 *
 * to `catch (err) { throw wrap(err) }`: it treats `error` as a single-use
 * temporary and drops the assignment, although the `finally` still reads it.
 * The statement reporter used exactly that shape, so inside any Next.js app
 * that bundled turbine-orm (the default) every failed raw statement,
 * `$transaction(fn)` statement and `$transaction([...])` slot was reported to
 * query listeners with no `error`, i.e. as a success. Unminified code, tsx and
 * a plain `node` import were all correct, which is why no other test saw it.
 *
 * This file compiles every module under src/ with SWC (TypeScript stripped,
 * then compress + mangle, the same passes Next.js applies), loads the minified
 * client, and asserts each failure path still carries the caller's error. The
 * first test is the control: it proves the pinned SWC still performs the
 * rewrite, so a green run means the reporters are immune rather than that the
 * minifier stopped minifying.
 *
 * Run: npx tsx --test src/test/minified-events.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { minify, transform } from '@swc/core';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the minified module is untyped
type Any = any;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SRC, '..');
// Inside the repo so the minified modules resolve `pg` from its node_modules.
const OUT = join(REPO, 'node_modules', '.cache', `turbine-minified-events-${process.pid}`);

/** The compress + mangle settings Next.js passes to SWC for server bundles. */
const MINIFY = { compress: true, mangle: true } as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'test') out.push(...sourceFiles(path));
    } else if (/\.c?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

async function buildMinifiedTree(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // The package's own `imports` map, so `#pg` resolves here as it does from src/.
  const { imports } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module', imports }));
  for (const file of sourceFiles(SRC)) {
    const cjs = file.endsWith('.cts');
    const { code } = await transform(readFileSync(file, 'utf8'), {
      filename: file,
      minify: true,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022', minify: MINIFY },
      module: { type: cjs ? 'commonjs' : 'es6' },
    });
    const target = join(OUT, relative(SRC, file))
      .replace(/\.cts$/, '.cjs')
      .replace(/\.ts$/, '.js');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
  }
}

function mockPool(failOn: string) {
  const query = async (sql: string) => {
    if (sql.toLowerCase().includes(failOn.toLowerCase())) throw Object.assign(new Error('boom'), { code: '42P01' });
    return { rows: [{ id: 1 }], rowCount: 1, fields: [] };
  };
  return { query, connect: async () => ({ query, release: () => {} }), end: async () => {} };
}

let TurbineClient: Any;

function client(failOn: string): { db: Any; events: Any[] } {
  const schema = { enums: {}, tables: { users: mockTable('users', [{ name: 'id', field: 'id' }]) } };
  const db = new TurbineClient({ pool: mockPool(failOn), errorMessages: 'verbose' }, schema);
  const events: Any[] = [];
  db.$on('query', (e: Any) => events.push(e));
  return { db, events };
}

/** Run `fn`, which must reject, and return what it rejected with. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to reject');
}

describe('query events from SWC-minified code', () => {
  before(async () => {
    await buildMinifiedTree();
    ({ TurbineClient } = await import(pathToFileURL(join(OUT, 'client.js')).href));
  });
  after(() => rmSync(OUT, { recursive: true, force: true }));

  it('control: the pinned SWC drops an assignment a finally block reads', async () => {
    const { code } = await minify(
      'export async function f(run, wrap, sink) { let e; try { return await run(); } ' +
        'catch (err) { e = wrap(err); throw e; } finally { sink(e); } }',
      { ...MINIFY, module: true },
    );
    assert.match(code, /catch\((\w+)\)\{throw \w+\(\1\)\}/, `SWC no longer performs the rewrite: ${code}`);
  });

  it('db.raw failure carries the error the caller gets', async () => {
    const { db, events } = client('missing_table');
    const thrown = await caught(() => db.raw`SELECT * FROM missing_table`);
    assert.equal(events.length, 1);
    assert.equal(events[0].error, thrown);
  });

  it('db.sql failure carries an error', async () => {
    const { db, events } = client('missing_table');
    const thrown = await caught(() => db.sql`SELECT * FROM missing_table`);
    assert.equal(events.length, 1);
    assert.equal(events[0].error, thrown);
  });

  it('tx.raw failure inside $transaction(fn) carries an error', async () => {
    const { db, events } = client('pg_sleep');
    await caught(() =>
      db.$transaction(async (tx: Any) => {
        await tx.raw`SELECT pg_sleep(1)`;
      }),
    );
    const failed = events.filter((e) => e.sql === 'SELECT pg_sleep(1)');
    assert.equal(failed.length, 1);
    assert.ok(failed[0].error instanceof Error);
    assert.equal(failed[0].error.code, '42P01');
  });

  it('a failing $transaction([...]) slot carries an error', async () => {
    const { db, events } = client('count(');
    await caught(() => db.$transaction([db.users.buildFindMany({ limit: 1 }), db.users.buildCount()]));
    const batch = events.filter((e) => e.batch === 'transaction');
    assert.equal(batch.length, 2);
    assert.equal(batch[0].error, undefined);
    assert.ok(batch[1].error instanceof Error);
  });

  it('a failing pipeline slot carries an error', async () => {
    const { db, events } = client('count(');
    await caught(() =>
      db.pipeline([db.users.buildFindMany({ limit: 1 }), db.users.buildCount()], { transactional: false }),
    );
    const byAction = Object.fromEntries(events.map((e) => [e.action, e]));
    assert.equal(byAction.findMany?.error, undefined);
    assert.ok(byAction.count?.error instanceof Error);
  });

  it('a failing model query carries an error', async () => {
    const { db, events } = client('from "users"');
    const thrown = await caught(() => db.users.findMany({ limit: 1, orderBy: { id: 'asc' } }));
    assert.equal(events.length, 1);
    assert.equal(events[0].error, thrown);
  });
});
