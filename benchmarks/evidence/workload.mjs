import { createHash } from 'node:crypto';
import { assertExact, canonical } from '../equivalence.ts';

export const SEMANTICS = 'cross-engine-exact-effects-v2';
export const ENGINES = ['sqlite', 'postgresql', 'mysql', 'mssql'];
export const ROW_COUNT = 2048;
export const BATCH_SIZE = 128;
// Input data is independent of all ORM query builders and server result decoders.
export const FIXTURE = Object.freeze(Array.from({ length: ROW_COUNT }, (_, n) => Object.freeze({
  id: n + 1,
  label: `item:${n + 1}:λ'\\`,
  value: n * 3 - 7,
  note: n % 5 === 0 ? null : `note:${n % 11}`,
})));
export const EXPECTED = {
  page: FIXTURE.slice(16, 80),
  point: (round) => [FIXTURE[round % 16]],
  transaction: FIXTURE.map((row) => row.id <= 2 ? { ...row, value: row.value + 1 } : row),
};

export function checkRows(label, actual, expected) {
  assertExact(label, actual, expected);
}

// Consume every column in order. Timed native drains retain only this digest,
// never a materialized copy of the rows. The same consumer runs on every arm.
export function digest() {
  const hash = createHash('sha256');
  let count = 0;
  return {
    row(row) {
      hash.update(JSON.stringify(canonical(row)));
      hash.update('\n');
      count++;
    },
    finish() { return { count, sha256: hash.digest('hex') }; },
  };
}
const expectedDigest = digest();
for (const row of FIXTURE) expectedDigest.row(row);
export const EXPECTED_DRAIN = Object.freeze(expectedDigest.finish());

export function positiveInteger(value, name, maximum = 100000) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer in [1, ${maximum}]`);
  }
  return Number(value);
}

export function requiredEngines(value = '') {
  const engines = value ? value.split(',') : [];
  if (engines.some((engine) => !ENGINES.includes(engine)) || new Set(engines).size !== engines.length) {
    throw new Error('EVIDENCE_REQUIRE_ENGINES contains unknown or duplicate engines');
  }
  return engines;
}

export function scratchName(name) {
  if (!/^turbine_evidence_[a-f0-9]{16}$/.test(name)) throw new Error('Refusing a database without an exact disposable evidence name');
  return name;
}
