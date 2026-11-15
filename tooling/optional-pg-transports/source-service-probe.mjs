// Read-only source fixture exercise. Caller supplies a disposable service explicitly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startNative } from '../../src/test/fixtures/neon-ws-native.ts';
import { turbineNeonWs } from '../../src/neon-ws.ts';
const native = await startNative('');
try {
  const db = await turbineNeonWs({ connection: native.connection, driver: native.driver }, { tables: {}, enums: {} }, { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false });
  try { assert.deepEqual(await db.raw`SELECT 31 AS n`, [{ n: 31 }]); }
  finally { await db.disconnect(); }
} finally { await native.close(); }
const audit = JSON.parse(readFileSync(`${native.root}/audit.json`, 'utf8'));
assert.equal(audit.ownership, 'database-only');
assert.equal(audit.databaseRemoved, true);
assert.equal(audit.connectionsClosed, true);
assert.equal(audit.socketCount, 0);
assert.equal(audit.activeWebSockets, 0);
console.log(JSON.stringify({ sourceFixture: true, actualDriver: true, audit }));
