import assert from 'node:assert/strict';
import { route } from './workload.mjs';

export async function memory(arm) {
  assert.equal(typeof global.gc, 'function', 'run with --expose-gc');
  const snapshots = [];
  const snapshot = (phase, r) => {
    for (let i = 0; i < 3; i++) global.gc();
    snapshots.push({ phase, ...process.memoryUsage(), preparation: r?.preparation.stats() ?? null });
  };
  snapshot('before-fixture');
  const r = route(arm);
  try {
    snapshot('fixture', r);
    for (let start = 0; start < 8192; start += 4096) {
      for (let i = start; i < start + 4096; i++) {
        const value = await r.query(`SELECT :p1 AS n /* retained-shape ${i} */`, [BigInt(i)]);
        assert.deepStrictEqual(value.rows, [{ n: r.pooled ? i : BigInt(i) }]);
      }
      snapshot(`after-${start + 4096}-shapes`, r);
    }
    r.preparation.invalidate();
    snapshot('references-cleared', r);
  } finally {
    await r.close();
  }
  snapshot('handle-closed', r);
  return {
    arm,
    checkedResults: 8192,
    snapshots,
    limitation:
      'Map bounds references only. StatementSync has no explicit finalize API here; GC/RSS and SQLite allocator retention are observations, not a hard native-byte bound.',
  };
}
