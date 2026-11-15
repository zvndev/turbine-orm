import assert from 'node:assert/strict';
import { auditNative, openEngine } from './engines.mjs';
import { digest, EXPECTED_DRAIN } from './workload.mjs';

// Deliberate real-server fault, isolated to this process. Its nonzero exit must
// invalidate the gate even though independently consumed cells are exact.
const context = await openEngine(process.argv[2]);
assert.ok(!context.unavailable, 'Fault control requires its native service');
try {
  const arm = { name: 'materialized-fault', native: () => context.rawTransaction(async query => {
    const sink = digest();
    for (const row of await query('SELECT id, label, value, note FROM evidence_items ORDER BY id ASC')) sink.row(row);
    const value = sink.finish();
    assert.deepEqual(value, EXPECTED_DRAIN);
    return value;
  }) };
  await auditNative(context, arm);
} finally { await context.close(); }
