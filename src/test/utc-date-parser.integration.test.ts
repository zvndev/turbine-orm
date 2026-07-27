/**
 * turbine-orm, live `date` round trip under a non-UTC process zone.
 *
 * Before the OID 1082 parser existed, a `date` column read back at the
 * process's LOCAL midnight while the write side already rendered UTC
 * components, so east of UTC every read-modify-write cycle moved the stored
 * calendar day one day earlier. Recorded pre-fix output, TZ=Europe/Berlin:
 *
 *   driver d  2026-07-20T22:00:00.000Z
 *   selfMatch 0                       (the row could not find itself)
 *   cycles    stored 2026-07-20 → 2026-07-19 → 2026-07-18
 *
 * Everything asserted about stored values is read back as `::text` through a
 * raw pg client, so no type parser can flatter the result.
 *
 * Requires DATABASE_URL. Run: npx tsx --test src/test/utc-date-parser.integration.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const gate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'fixtures', 'utc-date-roundtrip-probe.ts');
const TSX = path.join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface RoundTrip {
  tz: string;
  driver: { d: string; ds: string[]; ts: string; tss: string[] };
  join: { d: string; childD: string };
  batched: { d: string; childD: string };
  selfMatch: number;
  cycles: { read: string; stored: string }[];
  storedFinal: { d: string; ds: string; ts: string };
}

/**
 * The probe creates and drops its own tables, so the zones run one at a time
 * rather than concurrently.
 */
function roundTrip(tz: string): RoundTrip {
  const out = execFileSync(process.execPath, [TSX, PROBE], {
    env: { ...process.env, TZ: tz, DATABASE_URL },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1) as string) as RoundTrip;
}

describe('date columns under a non-UTC process zone', () => {
  for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo']) {
    gate.it(`reads UTC midnight on every path under TZ=${tz}`, () => {
      const r = roundTrip(tz);
      assert.equal(r.driver.d, '2026-07-21T00:00:00.000Z', 'driver path');
      assert.deepEqual(r.driver.ds, ['2026-07-21T00:00:00.000Z'], 'date[] agrees with date');
      assert.equal(r.driver.ts, '2026-07-21T09:30:00.000Z', 'timestamp path');
      assert.deepEqual(r.driver.tss, ['2026-07-21T09:30:00.000Z'], 'timestamp[] agrees with timestamp');
      assert.equal(r.join.d, '2026-07-21T00:00:00.000Z', 'join strategy parent');
      assert.equal(r.join.childD, '2026-07-21T00:00:00.000Z', 'join strategy relation');
      assert.equal(r.batched.d, '2026-07-21T00:00:00.000Z', 'batched strategy parent');
      assert.equal(r.batched.childD, '2026-07-21T00:00:00.000Z', 'batched strategy relation');
    });

    gate.it(`a row found by the Date it returned matches itself under TZ=${tz}`, () => {
      assert.equal(roundTrip(tz).selfMatch, 1);
    });

    gate.it(`read-modify-write does not drift the stored day under TZ=${tz}`, () => {
      const r = roundTrip(tz);
      for (const cycle of r.cycles) {
        assert.equal(cycle.stored, '2026-07-21', `stored day after a write-back cycle (${JSON.stringify(cycle)})`);
        assert.equal(cycle.read, '2026-07-21T00:00:00.000Z');
      }
      assert.equal(r.storedFinal.d, '2026-07-21');
      assert.equal(r.storedFinal.ds, '{2026-07-21}');
      assert.equal(r.storedFinal.ts, '2026-07-21 09:30:00');
    });
  }
});
