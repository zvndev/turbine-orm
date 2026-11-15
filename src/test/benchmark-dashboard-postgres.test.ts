import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import type { DeferredQuery } from '../query/index.js';
import { skipGate } from './helpers.js';

const { turbineDashboard } = await import(new URL('../../benchmarks/dashboard.ts', import.meta.url).href);
const { it } = skipGate(!process.env.DATABASE_URL, 'DATABASE_URL not set');
type Probe = { xid: string; backend: number };
const queries = (): DeferredQuery<Probe>[] =>
  Array.from({ length: 5 }, () => ({
    sql: 'SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS backend',
    params: [],
    transform: (result) => result.rows[0] as Probe,
    tag: 'dashboard-transaction-probe',
  }));

describe('actual benchmark Turbine dashboard transaction boundaries', () => {
  it('uses distinct transactions for independent reads and one for transaction reads', async () => {
    const db = new TurbineClient(
      { connectionString: process.env.DATABASE_URL!, logging: false },
      { tables: {}, enums: {} },
    );
    try {
      for (const mode of ['independent', 'transaction'] as const) {
        const result = (await turbineDashboard(db, queries(), mode)) as Probe[];
        assert.equal(result.length, 5);
        assert.ok(result.every((r) => /^\d+$/.test(r.xid) && r.backend > 0));
        assert.equal(new Set(result.map((r) => r.xid)).size, mode === 'independent' ? 5 : 1);
        assert.equal(new Set(result.map((r) => r.backend)).size, 1, 'pipeline/transaction stays on one connection');
      }
      // Negative control: the legacy rest overload really is transactional.
      const legacy = await db.pipeline(...queries());
      assert.equal(new Set(legacy.map((r) => r.xid)).size, 1);
    } finally {
      await db.disconnect();
    }
  });
});
