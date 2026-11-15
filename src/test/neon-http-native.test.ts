import { test } from 'node:test';
import pg from 'pg';
import { turbineNeonHttp } from '../neon-http.js';
import { loadNeonDriver } from './fixtures/neon-http/driver.js';
// @ts-expect-error Plain JS fixture is shared verbatim with actual installed ESM/CJS consumers.
import { nativeContract } from './fixtures/neon-http/native-contract.mjs';

const required = process.env.TURBINE_REQUIRE_NEON_HTTP_NATIVE === '1';
test('native PostgreSQL through real Neon HTTP and a test-only loopback bridge', {
  skip: !required && !process.env.NEON_HTTP_NATIVE_URL,
}, async (t) => {
  const { neon, neonConfig } = await loadNeonDriver();
  await nativeContract({ turbineNeonHttp, neon, neonConfig, pg, test: t.test.bind(t), scope: 'source' });
});
