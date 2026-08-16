/**
 * turbine-orm, who owns the `timestamptz` parser slot.
 *
 * The fast `timestamptz` decode path (OIDs 1184 / 1185) is the first parser
 * Turbine registers that changes NO reading: it produces the same `Date`
 * `postgres-date` produces, only sooner. That difference in kind drives a
 * difference in policy, and this file is where the policy is pinned.
 *
 *   the four zone-less OIDs (1114, 1082, 1115, 1182) OVERWRITE whatever is
 *     registered, warning once. They must: they exist to replace a reading,
 *     and a process where half the temporal columns read local-zone and half
 *     read UTC is broken in a way no warning fixes.
 *
 *   1184 / 1185 DECLINE when somebody else's parser is already there. They
 *     exist only to be faster, so overwriting a caller's own `timestamptz`
 *     reading (strings, Luxon, a Temporal instant) would trade their
 *     correctness for our speed. Turbine had never touched 1184 before this,
 *     so declining is also what keeps that promise.
 *
 * And they are declined TOGETHER: registering the array half over a caller's
 * customized scalar half would leave `timestamptz` and `timestamptz[]`
 * disagreeing in one process, which is worse than leaving both slow.
 *
 * Every scenario is a separate process, because `pg.types.setTypeParser` is
 * process-global and Turbine's registration is gated by one-shot statics, so
 * "what the FIRST client does" can only be asked once per process.
 *
 * Run: npx tsx --test src/test/fast-temporal-registration.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'fixtures', 'fast-temporal-registration-probe.ts');
const TSX = path.join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface Probe {
  mode: string;
  replaced1184: boolean;
  replaced1185: boolean;
  replaced1114: boolean;
  replaced1082: boolean;
  decoded1184: string;
  decoded1185: string;
  reference1184: string;
  reference1185: string;
}

function probe(mode: string): Probe {
  const out = execFileSync(process.execPath, [TSX, PROBE], {
    // DATABASE_URL is irrelevant here (pg.Pool connects lazily and nothing
    // queries), but it is cleared so a stray one cannot make the probe dial out.
    env: { ...process.env, PROBE_MODE: mode, DATABASE_URL: '' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').at(-1) as string) as Probe;
}

describe('timestamptz fast-parser registration', () => {
  it('installs over pg defaults, and decodes identically to what it replaced', () => {
    const p = probe('default');
    assert.equal(p.replaced1184, true, '1184 should be registered on an owned pool');
    assert.equal(p.replaced1185, true, '1185 should follow its scalar');
    // The whole justification for replacing them is that nothing changes.
    assert.equal(p.decoded1184, p.reference1184);
    assert.equal(p.decoded1185, p.reference1185);
    assert.equal(p.decoded1184, 'Date(2026-08-15T12:25:43.476Z)');
    assert.equal(p.decoded1185, '[Date(2026-08-15T12:25:43.476Z)]');
  });

  it('declines when somebody else already owns 1184, and declines 1185 with it', () => {
    const p = probe('custom');
    assert.equal(p.replaced1184, false, "a caller's own timestamptz parser must survive");
    assert.equal(p.decoded1184, 'string(CUSTOM_PARSER_RESULT)');
    // The array half is on pg's DEFAULT in this scenario, so nothing but the
    // paired decision stops it being registered. It must not be: a process
    // where `timestamptz` is the caller's reading and `timestamptz[]` is
    // Turbine's is the failure this pairing exists to prevent.
    assert.equal(p.replaced1185, false, '1185 must not be registered when 1184 was declined');
    assert.equal(p.decoded1185, p.reference1185);
    // The four zone-less OIDs are unaffected by any of this: they still
    // overwrite, because they carry a reading rather than a speed-up.
    assert.equal(p.replaced1114, true);
    assert.equal(p.replaced1082, true);
  });

  it('declines 1185 on its own when only the array half is customized', () => {
    const p = probe('custom-array-only');
    assert.equal(p.replaced1184, true, '1184 is on pg default here, so it is claimed');
    assert.equal(p.replaced1185, false, "a caller's own timestamptz[] parser must survive");
    assert.equal(p.decoded1185, 'string(CUSTOM_PARSER_RESULT)');
  });

  it('registers nothing at all under utcTimestamps: false', () => {
    // The flag reads as "leave pg's temporal parser table alone". 1184 / 1185
    // are gated with the other four even though they carry no reading, because
    // the alternative is a second place that writes to a process-global table.
    // The cost is that opting out of the UTC reading also opts out of the
    // speed-up, and that cost is deliberate and documented.
    const p = probe('opt-out');
    assert.equal(p.replaced1184, false);
    assert.equal(p.replaced1185, false);
    assert.equal(p.replaced1114, false);
    assert.equal(p.replaced1082, false);
  });

  it('registers nothing on an externally supplied pool', () => {
    // Same ownership rule the int8 and zone-less parsers already follow: an
    // external pool's parser configuration belongs to whoever built it, and
    // registration is process-global, so flipping it would reach into their
    // pool too.
    const p = probe('external');
    assert.equal(p.replaced1184, false);
    assert.equal(p.replaced1185, false);
    assert.equal(p.replaced1114, false);
    assert.equal(p.replaced1082, false);
  });
});
