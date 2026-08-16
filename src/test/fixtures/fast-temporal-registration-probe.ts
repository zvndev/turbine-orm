/**
 * Child-process probe for src/test/fast-temporal-registration.test.ts.
 *
 * `pg.types.setTypeParser` is process-global and Turbine's registration is
 * gated by one-shot statics, so "what happens when the FIRST client in a
 * process is constructed like this" can only be asked once per process. Each
 * mode below is therefore its own process, and the parent reads the JSON on
 * the last stdout line.
 *
 * Run indirectly. PROBE_MODE selects the scenario.
 */

import pg from 'pg';
import { type PgCompatPool, TurbineClient } from '../../client.js';
import type { SchemaMetadata } from '../../schema.js';
import { mockColumn, mockTable } from '../helpers.js';

const getParser = (oid: number): ((value: string) => unknown) =>
  (pg.types.getTypeParser as unknown as (id: number, format: 'text') => (value: string) => unknown)(oid, 'text');

/** Comparable rendering, so a Date and a marker string are both reportable. */
function render(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : `Date(${value.toISOString()})`;
  }
  if (Array.isArray(value)) return `[${value.map(render).join(', ')}]`;
  if (value === null) return 'null';
  if (typeof value === 'number') return `number(${value})`;
  return `${typeof value}(${String(value)})`;
}

const SCHEMA: SchemaMetadata = {
  tables: { events: mockTable('events', [mockColumn('id', 'id', 'int4')]) },
  enums: {},
};

const externalPool = (): PgCompatPool =>
  ({
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    connect: () => Promise.reject(new Error('not used')),
    end: () => Promise.resolve(),
  }) as unknown as PgCompatPool;

const TS = '2026-08-15 12:25:43.476603+00';
const TS_ARRAY = `{"${TS}"}`;

const mode = process.env.PROBE_MODE ?? 'default';

// pg's own parser for 1184, held for the `reference*` fields. Captured first
// because the `custom` modes are about to overwrite the slot.
const pgDefault1184 = getParser(1184);
const pgDefault1185 = getParser(1185);

const CUSTOM = 'CUSTOM_PARSER_RESULT';
if (mode === 'custom' || mode === 'custom-array-only') {
  // A third party's own reading. The array half is deliberately left on pg's
  // default in the `custom` mode, so the test can prove Turbine declines it
  // too rather than leaving a scalar and its array disagreeing.
  const oid = mode === 'custom' ? 1184 : 1185;
  (pg.types.setTypeParser as unknown as (id: number, parse: (v: string) => unknown) => void)(oid, () => CUSTOM);
}

// The baseline for "did Turbine replace it" is the table as it stands
// IMMEDIATELY BEFORE the client is constructed, which in the `custom` modes
// already holds the third party's parser. Capturing it any earlier would
// report the probe's own `setTypeParser` call as Turbine's work, which is
// exactly the false pass this comment exists to prevent (it happened).
// Identity, not behaviour: the fast path decodes identically to pg's parser by
// design, so behaviour cannot tell the two apart.
const before1184 = getParser(1184);
const before1185 = getParser(1185);
const before1114 = getParser(1114);
const before1082 = getParser(1082);

if (mode === 'external') {
  new TurbineClient({ pool: externalPool() }, SCHEMA);
} else if (mode === 'opt-out') {
  new TurbineClient({ connectionString: 'postgres://user:pass@127.0.0.1:1/db', utcTimestamps: false }, SCHEMA);
} else {
  new TurbineClient({ connectionString: 'postgres://user:pass@127.0.0.1:1/db' }, SCHEMA);
}

const after1184 = getParser(1184);
const after1185 = getParser(1185);

console.log(
  JSON.stringify({
    mode,
    replaced1184: after1184 !== before1184,
    replaced1185: after1185 !== before1185,
    replaced1114: getParser(1114) !== before1114,
    replaced1082: getParser(1082) !== before1082,
    decoded1184: render(after1184(TS)),
    decoded1185: render(after1185(TS_ARRAY)),
    // What pg's OWN parser said for the same text, captured before anything in
    // this process touched the table, so agreement is asserted rather than
    // assumed.
    reference1184: render(pgDefault1184(TS)),
    reference1185: render(pgDefault1185(TS_ARRAY)),
  }),
);
