/**
 * turbine-orm: registering the UTC temporal parsers warns once when it is
 * overwriting somebody ELSE's parser.
 *
 * `pg.types.setTypeParser` is process-global, which is documented. The sharper
 * part is that it is RETROACTIVE: there is one parser table and it is consulted
 * per row at decode time, so installing a parser changes how every `pg.Pool` in
 * the process decodes that OID, including pools that were constructed and were
 * already querying before any Turbine client existed. When the OID was still on
 * pg's own default that is the intended trade. When another module had already
 * customized it, Turbine is silently replacing a reading it cannot see the
 * origin of, and which one wins depends on module evaluation order (unstable
 * under lazy route imports). This suite pins the warning that says so.
 *
 * No database needed. Registration is process-global, so this file mutates the
 * pg parser table for its own process only (node:test runs each file in one).
 *
 * Run: npx tsx --test src/test/parser-overwrite-warning.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { isDefaultTextParser, registerUtcTemporalParsers, warnParserOverwrite } from '../query/utils.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';

const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (v: string) => unknown;
const setParser = pg.types.setTypeParser as unknown as (oid: number, parse: (v: string) => unknown) => void;

function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => {
    seen.push(String(msg));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

describe('pg type parser overwrite detection', () => {
  it("recognises pg's own default parsers as default", () => {
    // The four OIDs Turbine registers, straight off a fresh pg module.
    for (const oid of [1082, 1114, 1115, 1182]) {
      assert.equal(isDefaultTextParser(oid, getParser(oid, 'text')), true, `OID ${oid}`);
    }
    assert.equal(isDefaultTextParser(20, getParser(20, 'text')), true, 'OID 20');
  });

  it('recognises a foreign parser as non-default, including one that throws', () => {
    assert.equal(
      isDefaultTextParser(1114, () => 'whatever a third-party parser returns'),
      false,
    );
    assert.equal(
      isDefaultTextParser(1114, () => {
        throw new Error('a parser that rejects the probe is not the default either');
      }),
      false,
    );
    // An OID with no probe is never guessed at, so it never warns.
    assert.equal(
      isDefaultTextParser(99999, () => 'anything'),
      true,
    );
  });

  it('says nothing when every OID is still on the driver default', () => {
    resetWarnOnce(WARN_NS.parserOverwrite);
    const warnings = captureWarnings(() => registerUtcTemporalParsers());
    assert.deepEqual(warnings, []);
  });

  it('warns once per OID when another module already customized it', () => {
    resetWarnOnce(WARN_NS.parserOverwrite);
    // Stand in for a third-party module (or the application itself) that reads
    // `timestamp` its own way and registered before Turbine was constructed.
    setParser(1114, (text: string) => `custom:${text}`);
    const first = captureWarnings(() => registerUtcTemporalParsers());
    assert.equal(first.length, 1, `expected one warning, got ${first.length}`);
    assert.match(first[0]!, /OID 1114 \(timestamp\)/);
    // The consequence a caller needs to know, in the text.
    assert.match(first[0]!, /pools that already exist/);

    // Once per process, even though the parser it would replace is now
    // Turbine's own (which is itself non-default for the probe).
    const second = captureWarnings(() => registerUtcTemporalParsers());
    assert.deepEqual(second, []);
  });

  it('offers a remedy that applies to the OID it is warning about', () => {
    // The message is shared, but `utcTimestamps: false` governs the four
    // TEMPORAL OIDs only. Offering it for int8 would name a setting that does
    // nothing for the OID in the warning.
    resetWarnOnce(WARN_NS.parserOverwrite);
    setParser(1114, (text: string) => `custom:${text}`);
    setParser(20, (text: string) => `custom:${text}`);

    const temporal = captureWarnings(() => warnParserOverwrite(1114, 'timestamp'));
    assert.equal(temporal.length, 1);
    assert.match(temporal[0]!, /`utcTimestamps: false` leaves the four temporal OIDs/);

    const int8 = captureWarnings(() => warnParserOverwrite(20, 'int8'));
    assert.equal(int8.length, 1);
    assert.doesNotMatch(int8[0]!, /utcTimestamps/);
    assert.match(int8[0]!, /no opt-out for this OID/);
  });

  it('fires under NODE_ENV=production, because import order is what production changes', () => {
    // Deliberately NOT dev-only, matching the temporal-infinity warning. A
    // parser overwrite is decided by which module calls setTypeParser last, and
    // evaluation order is precisely what differs between a dev process and a
    // bundled / lazily imported production one. A process can therefore be
    // clean in dev and wrong in production from import order alone, so the case
    // that matters most was the case that used to be silent.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      resetWarnOnce(WARN_NS.parserOverwrite);
      setParser(1114, (text: string) => `custom:${text}`);
      const warnings = captureWarnings(() => warnParserOverwrite(1114, 'timestamp'));
      assert.equal(warnings.length, 1, `expected the warning under production, got ${warnings.length}`);
      assert.match(warnings[0]!, /OID 1114 \(timestamp\)/);
      // The message must not still claim it is dev-only.
      assert.doesNotMatch(warnings[0]!, /Dev-only/);
      assert.match(warnings[0]!, /fires under `NODE_ENV=production` too/);

      // Still once per OID per process, production included.
      const second = captureWarnings(() => warnParserOverwrite(1114, 'timestamp'));
      assert.deepEqual(second, []);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('stays silent under production when the parser is still the driver default', () => {
    // The production change widens WHEN the warning is allowed to fire, not
    // WHAT it fires on: an untouched OID is still not a warning.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      resetWarnOnce(WARN_NS.parserOverwrite);
      // Earlier tests in this file already replaced the process-global `date`
      // parser, so put a parser back that BEHAVES like pg's default (and is not
      // tagged as Turbine's own, which has its own early return). That is the
      // state the detector reports as "still the default".
      setParser(1082, (text: string) => {
        const [y, m, d] = text.split('-').map(Number);
        return new Date(y!, m! - 1, d!);
      });
      const warnings = captureWarnings(() => warnParserOverwrite(1082, 'date'));
      assert.deepEqual(warnings, []);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
