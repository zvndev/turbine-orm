/**
 * turbine-orm: Turbine's column readings on a caller-supplied `pg.Pool`,
 * against a live PostgreSQL.
 *
 * Turbine registers its int8 and temporal parsers on the pg module only for a
 * pool it opens. On a supplied pool its own queries carry them instead, on
 * every path: table accessors, `raw`/`rawUnsafe`/`sql`, transactions,
 * pipelines, cursor streams, `turbineHttp`, and replicas. The caller's own
 * queries on the same pool keep the driver's parsers.
 *
 * Each case runs a probe in a child process under `TZ=America/New_York`: the
 * zone has to be set at process start, and the process must hold no client on
 * a Turbine-owned pool, whose global registration would hide this path.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/client-v090-supplied-pool.integration.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'fixtures', 'supplied-pool-types-probe.ts');

type Row = { ts: unknown; d: unknown; tss: unknown; ds: unknown; big: unknown; tstz: unknown };
interface Probe {
  findUnique: Row;
  rawUnsafe: Row;
  sql: Row;
  raw: Row;
  transaction: { findUnique: Row; raw: Row; sql: Row; connection: Row };
  pipeline: Row;
  stream: Row;
  http: Row;
  replica: Row;
  callerPool: Row;
  unsafeBig: unknown;
  dbPoolIsCallers: boolean;
  globalTimestampParserIsTurbines: boolean;
  globalInt8ParserIsTurbines: boolean;
  rawBind: { ts: string; d: string; tss: string; tstz: boolean };
  rawUnsafeBind: string;
  txBind: string;
  bcBind: string;
  invalidDate: string;
}

const probed = new Map<boolean, Probe>();
function probe(utc: boolean): Probe {
  const known = probed.get(utc);
  if (known) return known;
  const out = execFileSync(
    process.execPath,
    [path.join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), PROBE],
    { env: { ...process.env, TZ: 'America/New_York', PROBE_UTC: utc ? '1' : '0' }, encoding: 'utf8' },
  );
  const result = JSON.parse(out.trim().split('\n').at(-1) as string) as Probe;
  probed.set(utc, result);
  return result;
}

/** The row as stored: 12:00 on 2026-07-01, the calendar day 2026-07-21. */
const UTC_ROW: Row = {
  ts: '2026-07-01T12:00:00.000Z',
  d: '2026-07-21T00:00:00.000Z',
  tss: ['2026-07-01T12:00:00.000Z'],
  ds: ['2026-07-21T00:00:00.000Z'],
  big: 9007199254740991,
  tstz: '2026-07-01T12:00:00.000Z',
};
/** The same row through the driver's defaults in New York (UTC-4 in July). */
const DRIVER_ROW: Row = {
  ts: '2026-07-01T16:00:00.000Z',
  d: '2026-07-21T04:00:00.000Z',
  tss: ['2026-07-01T16:00:00.000Z'],
  ds: ['2026-07-21T04:00:00.000Z'],
  big: '9007199254740991',
  tstz: '2026-07-01T12:00:00.000Z',
};

describe('supplied pool readings (live Postgres, America/New_York)', () => {
  it('reads int8 as a number and zone-less temporals as UTC on every path', () => {
    const p = probe(true);
    const paths: Array<[string, Row]> = [
      ['findUnique', p.findUnique],
      ['rawUnsafe', p.rawUnsafe],
      ['sql', p.sql],
      ['raw', p.raw],
      ['$transaction findUnique', p.transaction.findUnique],
      ['$transaction raw', p.transaction.raw],
      ['$transaction sql', p.transaction.sql],
      ['pipeline', p.pipeline],
      ['findManyStream', p.stream],
      ['turbineHttp', p.http],
      ['owned replica next to a supplied primary', p.replica],
    ];
    for (const [name, row] of paths) assert.deepEqual(row, UTC_ROW, name);
    assert.equal(p.unsafeBig, '9007199254740993', 'an int8 past 2^53 stays the exact string');
  });

  it("leaves the caller's own queries and the pg module's parsers alone", () => {
    const p = probe(true);
    assert.deepEqual(p.callerPool, DRIVER_ROW);
    assert.deepEqual(p.transaction.connection, DRIVER_ROW, 'tx.$connection() is the driver connection');
    assert.equal(p.dbPoolIsCallers, true, '`db.pool` is the pool the caller passed');
    assert.equal(p.globalTimestampParserIsTurbines, false);
    assert.equal(p.globalInt8ParserIsTurbines, false);
  });

  it('binds a raw Date as its UTC fields, in arrays and transactions too, and refuses an Invalid Date', () => {
    const p = probe(true);
    assert.deepEqual(p.rawBind, {
      ts: '2026-07-02 08:30:00',
      d: '2026-07-22',
      tss: '{"2026-07-02 08:30:00",NULL}',
      tstz: true,
    });
    assert.equal(p.rawUnsafeBind, '2026-07-03 01:02:03.004');
    assert.equal(p.txBind, '2026-07-04 05:06:07');
    assert.equal(p.bcBind, '0044-03-15 00:00:00 BC');
    assert.match(
      p.invalidDate,
      /^ValidationError: .*raw: parameter \$1 is an Invalid Date.*Pass a valid Date, or null/,
    );
  });

  it('utcTimestamps: false keeps the driver temporal readings and binds, and still reads int8 as a number', () => {
    const p = probe(false);
    assert.deepEqual(p.findUnique, { ...DRIVER_ROW, big: 9007199254740991 });
    assert.deepEqual(p.transaction.raw, { ...DRIVER_ROW, big: 9007199254740991 });
    assert.equal(p.rawBind.ts, '2026-07-02 04:30:00', 'the driver renders a Date in the process zone');
    assert.equal(p.txBind, '2026-07-04 01:06:07');
  });
});
