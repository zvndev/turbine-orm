/** Run from a no-.git installed consumer with mandatory pg and optional native libSQL. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const load = process.env.LIBSQL_SEED_FORMAT === 'cjs' ? async (id) => require(id) : (id) => import(id);
const { defineLibsqlSeed, runLibsqlSeed } = await load('turbine-orm/libsql/seed');
const { introspectLibsql } = await load('turbine-orm/libsql/introspect');
const { createClient } = await import('@libsql/client/node');
const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-seed-package-'));
const url = `file:${join(dir, 'data.db')}`;
const native = createClient({ url, intMode: 'bigint' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (!native.closed) native.close();
    await rm(dir, { recursive: true, force: true });
    process.exit(1);
  });
}
try {
  await native.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT)');
  const schema = await introspectLibsql({ client: native, url });
  let called = false;
  const seed = defineLibsqlSeed(async (tx) => {
    called = true;
    await tx.table('items').create({ data: { id: 9007199254740993n, label: 'installed' } });
    await tx.$transaction(async (inner) => {
      await inner.raw`INSERT INTO items VALUES (${2}, ${'nested'})`;
    });
  });
  assert.equal(called, false);
  await runLibsqlSeed({ client: native, url }, schema, seed, { logger: {} });
  assert.equal(native.closed, false);
  native.close();
  let escaped;
  const rejection = { arbitrary: true };
  await assert.rejects(
    runLibsqlSeed(
      url,
      schema,
      async (tx) => {
        escaped = tx;
        await tx.raw`INSERT INTO items VALUES (${3}, ${'rollback'})`;
        throw rejection;
      },
      { logger: {} },
    ),
    (error) => error === rejection,
  );
  await assert.rejects(escaped.raw`SELECT 1`, /ended|rolled back/);
  const verify = createClient({ url, intMode: 'bigint' });
  try {
    assert.deepEqual(
      (await verify.execute('SELECT id FROM items ORDER BY id')).rows.map((row) => row[0]),
      [2n, 9007199254740993n],
    );
  } finally {
    verify.close();
  }
  console.log(
    JSON.stringify({
      version: process.version,
      format: process.env.LIBSQL_SEED_FORMAT ?? 'esm',
      installed: true,
      native: true,
      persistence: true,
      rollback: true,
    }),
  );
} finally {
  if (!native.closed) native.close();
  await rm(dir, { recursive: true, force: true });
}
