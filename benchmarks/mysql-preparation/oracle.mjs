import assert from 'node:assert/strict';

export const CAPACITY = 8;
export const ARMS = ['text', 'text-control', 'execute', 'prepared', 'turbine-shim', 'turbine-orm'];
export const SHAPES = ['connection', 'pool'];
export const CASES = ['read', 'rollback'];
export const DRIVER_VERSION = '3.24.5';
export const ARTIFACT_SHA = '4b4836254f41d658696639ec65e51a5f5ff7ea25095433cb34c6e8807ba63beb';
export const FLAGS = Object.freeze({
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  dateStrings: false,
  timezone: 'Z',
  charset: 'utf8mb4',
  maxPreparedStatements: CAPACITY,
  connectionLimit: 2,
  connectTimeout: 2000,
});
export const DDL = [
  'CREATE TABLE items(id INT PRIMARY KEY, enabled TINYINT(1), huge BIGINT, amount DECIMAL(30,9), payload JSON, nullable TEXT, stamp DATETIME(3), bytes VARBINARY(32), label VARCHAR(128))',
  'CREATE TABLE effects(id INT PRIMARY KEY, n INT NOT NULL)',
  'INSERT INTO effects VALUES(1, 0)',
];
// Expected values are computed without the SQL builder, driver, decoder, or result under test.
export function expected(id, decoded = false) {
  return {
    id,
    enabled: decoded ? id % 2 === 1 : id % 2,
    huge: String(9007199254740993n + BigInt(id)),
    amount: `${id}234567890123456789.123456789`,
    payload: id === 3 ? null : { id, nested: [null, true, '雪😀'], exact: '9007199254740993' },
    nullable: id % 2 ? null : `row-${id}`,
    stamp: new Date(`2024-02-0${id}T12:34:56.789Z`),
    bytes: Buffer.from([id, 0, 255, 92, 39]),
    label: `雪😀 quote' slash\\ ${id}`,
  };
}
export function checkRows(rows, id, decoded = false) {
  assert.equal(rows.length, 1, 'exact result cardinality');
  assert.deepStrictEqual({ ...rows[0] }, expected(id, decoded), 'independent exact row oracle');
}
export function checkEffect(rows, n) {
  assert.equal(rows.length, 1, 'effect row cardinality');
  assert.equal(rows[0].n, n, 'independent exact effect oracle');
}
export async function seed(conn) {
  for (const sql of DDL) await conn.query(sql);
  for (let id = 1; id <= 4; id++) {
    const row = expected(id);
    // Binary bindings avoid text-escaping differences in the fixture itself.
    await conn.execute('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?)', [
      row.id,
      row.enabled,
      row.huge,
      row.amount,
      row.payload === null ? null : JSON.stringify(row.payload),
      row.nullable,
      row.stamp,
      row.bytes,
      row.label,
    ]);
  }
}
export function shuffled(values, seed) {
  const out = [...values];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
export function median(values) {
  assert.ok(values.length, 'nonempty measurement series');
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function comparisons(samples) {
  return SHAPES.flatMap((shape) =>
    CASES.flatMap((name) =>
      ARMS.filter((a) => a !== 'text').map((arm) => {
        const series = (a) =>
          samples
            .filter((s) => s.shape === shape && s.name === name && s.arm === a && s.phase === 'warm')
            .sort((a, b) => a.round - b.round)
            .map((s) => s.ms);
        const base = series('text'),
          candidate = series(arm),
          control = series('text-control');
        assert.equal(base.length, candidate.length);
        assert.equal(base.length, control.length);
        const deltas = base.map((v, i) => v - candidate[i]),
          noise = base.map((v, i) => v - control[i]);
        return {
          shape,
          name,
          arm,
          baselineMedianMs: median(base),
          candidateMedianMs: median(candidate),
          pairedTextMinusArmMs: deltas,
          identicalTextMinusControlMs: noise,
          pairedMedianMs: median(deltas),
          noiseMedianMs: median(noise),
          deltaRangeMs: [Math.min(...deltas), Math.max(...deltas)],
          noiseRangeMs: [Math.min(...noise), Math.max(...noise)],
        };
      }),
    ),
  );
}
export async function finalize(report, cleanup, save) {
  // Persist both original and cleanup failures, including interrupted runs.
  report.cleanupErrors ??= [];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      report.cleanupErrors.push(String(error.stack ?? error));
    }
  }
  report.status = report.failure || report.cleanupErrors.length ? 'failed' : 'passed';
  try {
    await save(report);
  } catch (error) {
    report.status = 'failed';
    report.cleanupErrors.push(`report write: ${error.message}`);
    throw error;
  }
  return report.status === 'passed';
}
