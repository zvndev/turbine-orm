import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditNative, openEngine } from './engines.mjs';
import { engineRun } from './run.mjs';
import { digest, EXPECTED, EXPECTED_DRAIN } from './workload.mjs';

// Explicit live command: absence of a disposable service fails, never skips.
async function open() {
  const context = await openEngine('mysql');
  assert.ok(!context.unavailable, 'test:mysql requires EVIDENCE_DISPOSABLE=1 and EVIDENCE_MYSQL_ADMIN_URL');
  return context;
}

describe('live MySQL evidence refusal boundaries', () => {
  it('audits both actual native routes and verifies all arms, effects and cleanup', async () => {
    const context = await open();
    const result = await engineRun(context, { rounds: 2, warmup: 1 });
    assert.equal(result.correctness.everyMeasuredEffect, true);
    assert.equal(result.scenarios[3].arms.filter((arm) => arm.status === 'complete').length, 2);
    for (const name of ['raw', 'turbine-source']) {
      assert.equal(result.controls.nativeRoutes[name].driver, 'mysql2');
      assert.ok(result.controls.nativeRoutes[name].pauseCalls > 0);
    }
    await assert.rejects(() => context.query('SELECT 1'), /closed/i);
  });
  for (const name of ['raw', 'turbine-source']) {
    it(`rejects ${name} materialization even with a correct independently consumed digest; restores audit methods`, async () => {
      const context = await open();
      const client = await context.native.getConnection();
      const connection = client.connection;
      const query = connection.query;
      const getConnection = context.native.getConnection;
      client.release();
      try {
        const arm = context.arms.find((candidate) => candidate.name === name);
        arm.native = async () => context.rawTransaction(async (tx) => {
          const sink = digest();
          for (const row of await tx('SELECT id, label, value, note FROM evidence_items ORDER BY id ASC')) sink.row(row);
          const result = sink.finish();
          assert.deepEqual(result, EXPECTED_DRAIN);
          return result;
        });
        await assert.rejects(() => auditNative(context, arm), /backpressure|materializing result callback/);
        assert.equal(connection.query, query);
        assert.equal(context.native.getConnection, getConnection);
        assert.equal((await context.query('SELECT 1 AS ready'))[0].ready, 1);
      } finally { await context.close(); }
    });
  }
  it('rejects a forged correct digest without observing any driver command', async () => {
    const context = await open();
    try {
      context.arms[0].native = async () => EXPECTED_DRAIN;
      await assert.rejects(() => auditNative(context, context.arms[0]), /backpressure/);
    } finally { await context.close(); }
  });
  it('rejects native corruption introduced only during the timed repetition and cleans up', async () => {
    const context = await open();
    const native = context.arms[0].native;
    let calls = 0;
    context.arms[0].native = async (...args) => {
      const value = await native(...args);
      return ++calls === 3 ? { ...value, sha256: '0'.repeat(64) } : value;
    };
    await assert.rejects(() => engineRun(context, { rounds: 1, warmup: 1 }), /native exact digest/);
    assert.equal(calls, 3);
    await assert.rejects(() => context.query('SELECT 1'), /closed/i);
  });
  it('rejects plausible transaction returns with a different real committed effect', async () => {
    const context = await open();
    const transaction = context.arms[0].transaction;
    context.arms[0].transaction = async (rollback) => {
      if (rollback) return transaction(true);
      await context.rawTransaction((query) => query('UPDATE evidence_items SET value=value+1 WHERE id=3'));
      return structuredClone(EXPECTED.transaction);
    };
    await assert.rejects(() => engineRun(context, { rounds: 1, warmup: 1 }), /commit actual effects/);
    await assert.rejects(() => context.query('SELECT 1'), /closed/i);
  });
  it('discards only the failed raw checkout after a consumer error and recovers the shared pool', async () => {
    const context = await open();
    try {
      await assert.rejects(() => context.arms[0].native(0, () => { throw new Error('consumer failure control'); }), /consumer failure control/);
      assert.equal((await context.query('SELECT 1 AS ready'))[0].ready, 1);
      assert.deepEqual(await context.arms[0].native(0, () => {}), EXPECTED_DRAIN);
    } finally { await context.close(); }
  });
});
