import assert from 'node:assert/strict';
import { it } from 'node:test';
import { auditNative, openEngine } from './engines.mjs';
import { digest, EXPECTED_DRAIN } from './workload.mjs';
const available = Boolean(process.env.EVIDENCE_PG_ADMIN_URL);
if (!available && (process.env.EVIDENCE_REQUIRE_ENGINES ?? '').split(',').includes('postgresql')) {
  throw new Error('EVIDENCE_PG_ADMIN_URL is required for native PostgreSQL audit controls');
}
it('observes bounded native PostgreSQL rows and rejects materialized cursor substitutes', { skip: !available && 'EVIDENCE_PG_ADMIN_URL unavailable' }, async () => {
  const context = await openEngine('postgresql');
  try {
    for (const arm of context.arms.filter(arm => arm.native)) {
      const result = await auditNative(context, arm);
      assert.deepEqual(result.value, EXPECTED_DRAIN);
      assert.equal(result.route.commands.filter(command => command.sql.startsWith('FETCH')).reduce((n,command)=>n+command.rows,0), EXPECTED_DRAIN.count);
    }
    for (const mode of ['ALL','2048','decorative']) {
      const arm = { name: `negative-${mode}`, native: async () => context.rawTransaction(async query => {
        const sink = digest();
        await query('DECLARE evidence_cursor NO SCROLL CURSOR FOR SELECT id, label, value, note FROM evidence_items ORDER BY id ASC');
        if (mode === 'decorative') {
          for (;;) { const rows = await query('FETCH 128 FROM evidence_cursor'); if (!rows.length) break; }
          for (const row of await query('SELECT id, label, value, note FROM evidence_items ORDER BY id ASC')) sink.row(row);
        } else for (const row of await query(`FETCH ${mode} FROM evidence_cursor`)) sink.row(row);
        await query('CLOSE evidence_cursor');
        const value = sink.finish(); assert.deepEqual(value, EXPECTED_DRAIN); return value;
      }) };
      await assert.rejects(auditNative(context, arm), /Unsupported PostgreSQL|bounded batch size/);
      assert.deepEqual((await auditNative(context, context.arms[0])).value, EXPECTED_DRAIN, 'the borrowed native pool remains usable');
    }
  } finally { await context.close(); }
});
