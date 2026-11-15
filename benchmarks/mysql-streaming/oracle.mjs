import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export const ARMS = ['raw-stream', 'turbine-rows', 'turbine-batches'];
export const FLAGS = {
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  timezone: 'Z',
  charset: 'utf8mb4',
  connectionLimit: 1,
  maxPreparedStatements: 8,
  connectTimeout: 2000,
};
export const COLUMNS = 'id, enabled, huge, amount, prefs, stamp, bytes, label, payload';
export const SQL = `SELECT ${COLUMNS} FROM items ORDER BY id ASC`;
export const BATCH = 32;
export function cases() {
  const out = [];
  for (const count of [129, 1025, 4097]) {
    for (const cadence of ['fast', 'slow'])
      for (const arm of ARMS)
        out.push({
          arm,
          kind: 'full',
          count,
          payloadSize: 256,
          batchSize: BATCH,
          cadence,
          ownership: 'pool',
        });
    out.push({
      arm: 'materialized-reference',
      kind: 'full',
      count,
      payloadSize: 256,
      batchSize: BATCH,
      cadence: 'fast',
      ownership: 'pool',
    });
  }
  for (const arm of ARMS) {
    out.push({
      arm,
      kind: 'large-row',
      count: 17,
      payloadSize: 131072,
      batchSize: 8,
      cadence: 'slow',
      ownership: 'pool',
    });
    for (const kind of ['early', 'abort', 'driver-error', 'tx-success', 'tx-rollback', 'tx-abort'])
      out.push({
        arm,
        kind,
        count: 1025,
        payloadSize: 256,
        batchSize: BATCH,
        cadence: 'fast',
        ownership: kind.startsWith('tx-') ? 'caller-connection' : 'pool',
      });
  }
  // Factory ownership changes sql_mode by contract; these are separate lifecycle controls.
  for (const arm of ARMS.slice(1))
    out.push({
      arm,
      kind: 'full',
      count: 129,
      payloadSize: 256,
      batchSize: BATCH,
      cadence: 'fast',
      ownership: 'factory',
    });
  return out.map((c, i) => ({ ...c, id: String(i).padStart(2, '0') }));
}
export function expected(id, size) {
  return {
    id,
    enabled: id % 2 === 1,
    huge: String(9007199254740993n + BigInt(id)),
    amount: `${id}.123456789`,
    prefs: { id, values: [null, true, '雪😀'] },
    stamp: new Date('2024-02-03T12:34:56.789Z'),
    bytes: Buffer.from([id % 256, 0, 255, 92, 39]),
    label: "雪😀 quote' slash\\",
    payload: 'x'.repeat(size),
  };
}
export function canonical(row) {
  return JSON.stringify([
    row.id,
    row.enabled,
    row.huge,
    row.amount,
    row.prefs,
    row.stamp.toISOString(),
    [...row.bytes],
    row.label,
    row.payload,
  ]);
}
export function sink() {
  const hash = createHash('sha256');
  let rows = 0,
    payloadBytes = 0,
    maxRowBytes = 0;
  return {
    add(row) {
      const value = canonical(row),
        bytes = Buffer.byteLength(value);
      hash.update(value);
      rows++;
      payloadBytes += bytes;
      maxRowBytes = Math.max(maxRowBytes, bytes);
    },
    finish() {
      return { rows, payloadBytes, maxRowBytes, sha256: hash.digest('hex') };
    },
  };
}
export function expectedDigest(count, size) {
  const s = sink();
  for (let id = 1; id <= count; id++) s.add(expected(id, size));
  return s.finish();
}
export function checkRow(row, id, size, raw) {
  assert.deepEqual(
    { ...row },
    { ...expected(id, size), ...(raw ? { enabled: id % 2 } : {}) },
    'independent exact selected value/order/decoding oracle',
  );
  return raw ? { ...row, enabled: row.enabled === 1 } : row;
}
export function admittedRuntime(version) {
  assert.ok(
    ['v22.16.0', 'v24.10.0'].includes(version),
    'native measurement requires exact Node22.16.0 or Node24.10.0',
  );
}
export async function finalize(report, steps, path) {
  report.cleanupErrors ??= [];
  report.status = 'finalizing';
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  for (const step of steps)
    try {
      await step();
    } catch (e) {
      report.cleanupErrors.push(String(e.stack ?? e));
    }
  report.status = report.failure || report.cleanupErrors.length ? 'failed' : 'passed';
  // Write checkpoints before validation and again after it, retaining primary failures.
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return report.status === 'passed';
}
