/**
 * turbine-orm: `disconnect(options)` and `end(options)` on the engine
 * factories that own their pool pass the options through and return the
 * client's result, as on PostgreSQL. They used to drop both, so
 * `disconnect({ timeoutMs })` resolved `undefined` where the type promises
 * `{ timedOut, forcedConnections }`.
 *
 * PowDB runs embedded (in-process). MySQL needs MYSQL_URL, and only connects
 * to the database it names.
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db npx tsx --test src/test/client-v090-engine-disconnect.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import type { DisconnectResult } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const schema: SchemaMetadata = { tables: {}, enums: {} };
const DONE: DisconnectResult = { timedOut: false, forcedConnections: 0 };

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const powdb = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysql = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('engine disconnect options', () => {
  powdb.it('PowDB, owned: options reach the client and the result comes back', async () => {
    const { turbinePowDB } = await import('../powdb.js');
    const dirs = [1, 2, 3].map((n) => mkdtempSync(join(tmpdir(), `powdb-disconnect-${n}-`)));
    try {
      const [a, b, c] = await Promise.all(dirs.map((dir) => turbinePowDB({ embedded: dir }, schema)));
      // Every client closes before any assertion, so a failure cannot leave one open.
      const results = [
        await a!.disconnect({ timeoutMs: 1000 }),
        await b!.disconnect(),
        await c!.end({ timeoutMs: 1000 }),
      ];
      assert.deepEqual(results, [DONE, undefined, DONE]);
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  powdb.it('PowDB, injected pool: the pool stays open and the result still comes back', async () => {
    const { PowdbPool, turbinePowDB } = await import('../powdb.js');
    let ended = false;
    const clientPool = {
      end: async () => {
        ended = true;
      },
    };
    const db = await turbinePowDB(new PowdbPool(clientPool as never), schema);
    assert.deepEqual(await db.disconnect({ timeoutMs: 50 }), DONE);
    assert.equal(await db.disconnect(), undefined);
    assert.equal(ended, false);
  });

  mysql.it('MySQL, owned: options reach the client, the result comes back, and the pool is closed', async () => {
    const { turbineMysql } = await import('../mysql.js');
    const a = await turbineMysql(MYSQL_URL, schema);
    const b = await turbineMysql(MYSQL_URL, schema);
    const c = await turbineMysql(MYSQL_URL, schema);
    // Every client closes before any assertion, so a failure cannot leave a pool holding the process open.
    const results = [await a.disconnect({ timeoutMs: 1000 }), await b.disconnect(), await c.end({ timeoutMs: 1000 })];
    assert.deepEqual(results, [DONE, undefined, DONE]);
    await assert.rejects(a.rawUnsafe('SELECT 1'), 'the pool was closed');
  });
});
