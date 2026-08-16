/**
 * How much is there to win by replacing node-postgres's type decoding?
 *
 * THIS FILE ANSWERS A GATE QUESTION, NOT A DESIGN QUESTION. Streaming is
 * Turbine's only remaining loss to Drizzle, and `PROFILE-0.70.0.md` attributes
 * roughly half the active JS self-time in that path to `postgres-date`'s
 * `parseDate` + `timeZoneOffset` and to `utf8Slice`, i.e. to code that is not
 * Turbine's. The tempting conclusion is "write our own decoders". Before
 * anyone does that, the CEILING has to exist as a number: drain the identical
 * rows with type decoding removed and see what is actually left on the table.
 *
 * NOTHING HERE IS A PROPOSED IMPLEMENTATION. It is a throwaway measurement
 * rig. It imports no Turbine code at all, deliberately: `TurbineClient`
 * registers an int8 parser with `pg.types.setTypeParser`, which is
 * PROCESS-GLOBAL, so merely constructing one would move the "stock pg"
 * baseline underneath the experiment and the arms would stop meaning what
 * their names say.
 *
 * METHOD. Every arm drains the SAME 50,000 rows with the SAME SQL through the
 * SAME driver. Arms differ in exactly one thing: the `types` object handed to
 * the pool, which is where node-postgres looks up per-OID parsers. The
 * difference between two arms is therefore the decode cost of the OIDs that
 * differ between them, and nothing else. Server time, wire bytes, protocol
 * round trips and row-object construction are identical across arms and
 * cancel.
 *
 * Arms are INTERLEAVED, rotating within each round, for the reason
 * `PROFILE-0.70.0.md` records: measured contiguously an operation can cost
 * half what it costs when other arms evict its working set between calls, so
 * quantities that will be subtracted from one another must be measured in one
 * regime.
 *
 * TWO STRUCTURAL FACTS ABOUT node-postgres, verified in its source here rather
 * than assumed, because they bound the answer before any timing runs:
 *
 *   1. `parseDataRowMessage` (pg-protocol/dist/parser.js) does
 *        `fields[i] = len === -1 ? null : reader.string(len)`
 *      unconditionally, and `reader.string` is `buffer.toString(...)`. EVERY
 *      cell is materialised as a JavaScript string before any type parser is
 *      consulted. So `utf8Slice` is charged whatever the parsers do, and no
 *      per-OID decoder can remove it.
 *
 *   2. Binary format is not an escape hatch: the Parser constructor throws
 *      `new Error('Binary mode not supported yet')` when `mode === 'binary'`.
 *
 *   Together these say the maximum any decoder rewrite can win INSIDE
 *   node-postgres is the type-PARSING half only. The string-materialisation
 *   half is only reachable by replacing the protocol parser, which is a
 *   different and much larger project.
 *
 * Usage:
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx decode-ceiling.ts
 */

import os from 'node:os';
import pg from 'pg';
import pgTypes from 'pg-types';

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const ROUNDS = Number(process.env.ROUNDS ?? 7);
const WARMUP = Number(process.env.WARMUP ?? 2);
const BATCH = 1000;

/** OIDs present in the `comments` fixture. */
const OID = {
  int8: 20,
  int4: 23,
  text: 25,
  timestamptz: 1184,
  timestamp: 1114,
  date: 1082,
  numeric: 1700,
  float8: 701,
  bool: 16,
  uuid: 2950,
  json: 114,
  jsonb: 3802,
} as const;

const identity = (v: string) => v;

/**
 * A `types` object in the shape node-postgres expects (`pg/lib/type-overrides.js`
 * calls `this._types.getTypeParser(oid, format)`), which returns the identity
 * function for the named OIDs and defers to stock pg-types for everything else.
 * `null` means "identity for every OID".
 */
function typesWithIdentityFor(oids: number[] | null) {
  if (oids === null) {
    return { getTypeParser: () => identity };
  }
  const set = new Set(oids);
  return {
    getTypeParser: (oid: number, format?: string) =>
      set.has(oid) ? identity : (pgTypes as any).getTypeParser(oid, format),
  };
}

/** What Turbine actually installs: int8 -> number. timestamptz is left stock. */
function turbineTypes() {
  return {
    getTypeParser: (oid: number, format?: string) =>
      oid === OID.int8
        ? (v: string) => Number.parseInt(v, 10)
        : (pgTypes as any).getTypeParser(oid, format),
  };
}

/**
 * A THROWAWAY fast-path timestamptz decoder, present only to price the
 * ACHIEVABLE win rather than the theoretical one.
 *
 * The `identity ALL` arm is a floor that no shipping implementation can stand
 * on, because it returns the raw string and the caller is promised a `Date`.
 * The number that actually matters to a build-or-not decision is what a
 * hand-written parser costs that still produces the SAME `Date`. That is what
 * this measures.
 *
 * It is deliberately narrow: it recognises exactly the shape PostgreSQL emits
 * for a `timestamptz` at this server's settings, `YYYY-MM-DD HH:MM:SS[.ffffff]
 * (+|-)HH[:MM]`, and DELEGATES everything else to `postgres-date`. That
 * delegation is not a convenience, it is the whole safety argument: `infinity`,
 * `-infinity`, BC dates, 5-digit years and non-ISO DateStyle output all fall
 * through to the parser that already handles them. It is the same shape the
 * repo already uses for `createUtcTimestampParser`.
 *
 * NOT PRODUCTION CODE. No `src/` change is proposed by this file.
 */
const stockDateParser = (pgTypes as any).getTypeParser(OID.timestamptz) as (v: string) => unknown;

function fastTimestamptz(v: string): unknown {
  // Fast path requires: at least "YYYY-MM-DD HH:MM:SS" and a leading 4-digit
  // year followed by '-'. Anything else (infinity, BC, 5-digit year, a
  // DateStyle that is not ISO) fails this test and is delegated.
  if (v.length < 19 || v.charCodeAt(4) !== 45 /* '-' */) return stockDateParser(v);

  const d0 = v.charCodeAt(0) - 48;
  const d1 = v.charCodeAt(1) - 48;
  const d2 = v.charCodeAt(2) - 48;
  const d3 = v.charCodeAt(3) - 48;
  if (d0 < 0 || d0 > 9 || d1 < 0 || d1 > 9 || d2 < 0 || d2 > 9 || d3 < 0 || d3 > 9) {
    return stockDateParser(v);
  }
  const year = d0 * 1000 + d1 * 100 + d2 * 10 + d3;
  const month = (v.charCodeAt(5) - 48) * 10 + (v.charCodeAt(6) - 48);
  const day = (v.charCodeAt(8) - 48) * 10 + (v.charCodeAt(9) - 48);
  const hour = (v.charCodeAt(11) - 48) * 10 + (v.charCodeAt(12) - 48);
  const min = (v.charCodeAt(14) - 48) * 10 + (v.charCodeAt(15) - 48);
  const sec = (v.charCodeAt(17) - 48) * 10 + (v.charCodeAt(18) - 48);

  let i = 19;
  let ms = 0;
  if (v.charCodeAt(i) === 46 /* '.' */) {
    i++;
    let frac = 0;
    let digits = 0;
    while (i < v.length) {
      const c = v.charCodeAt(i) - 48;
      if (c < 0 || c > 9) break;
      if (digits < 3) frac = frac * 10 + c;
      digits++;
      i++;
    }
    while (digits < 3 && digits > 0) {
      frac *= 10;
      digits++;
    }
    ms = frac;
  }

  // Timezone offset. A bare 'Z' or end-of-string means UTC.
  //
  // BUG FOUND BY PART 3, ROUND 1, and kept documented because it is the point
  // of this whole file: the first version consumed the offset and then
  // returned, so a trailing ' BC' was silently DISCARDED and
  // `4713-01-01 00:00:00+00 BC` decoded as AD 4713 -- off by 9,424 years, with
  // no error. The offset is not the end of the string.
  let offsetMin = 0;
  if (i < v.length) {
    const sign = v.charCodeAt(i);
    if (sign === 43 /* '+' */ || sign === 45 /* '-' */) {
      const oh = (v.charCodeAt(i + 1) - 48) * 10 + (v.charCodeAt(i + 2) - 48);
      let om = 0;
      i += 3;
      if (v.charCodeAt(i) === 58 /* ':' */) {
        om = (v.charCodeAt(i + 1) - 48) * 10 + (v.charCodeAt(i + 2) - 48);
        i += 3;
      }
      offsetMin = (oh * 60 + om) * (sign === 45 ? -1 : 1);
    } else if (sign === 90 /* 'Z' */) {
      i += 1;
    } else {
      // Something unrecognised (a named zone). Delegate.
      return stockDateParser(v);
    }
  }
  // Anything at all left over -- ' BC', a second offset field, trailing
  // whitespace -- means this is not the shape the fast path claims to handle.
  if (i !== v.length) return stockDateParser(v);

  const t = Date.UTC(year, month - 1, day, hour, min, sec, ms) - offsetMin * 60_000;

  // BUG FOUND BY PART 3, ROUND 1 (second of two). `Date.UTC` maps years 0-99
  // onto 1900-1999, so `0044-03-15` decoded as 1944 and `0001-01-01` as 1901.
  // postgres-date avoids this by assembling through `setUTCFullYear`, which is
  // exactly why `createUtcTimestampParser` in src/query/utils.ts does the same.
  // A decoder that skips this is wrong on every year before 100 AD.
  if (year < 100) {
    const d = new Date(t);
    d.setUTCFullYear(year);
    return d;
  }
  return new Date(t);
}

/** turbine-like parsers, but with the fast timestamptz decoder swapped in. */
function fastDecodeTypes() {
  return {
    getTypeParser: (oid: number, format?: string) => {
      if (oid === OID.int8) return (v: string) => Number.parseInt(v, 10);
      if (oid === OID.timestamptz) return fastTimestamptz;
      return (pgTypes as any).getTypeParser(oid, format);
    },
  };
}

// ---------------------------------------------------------------------------
// Machine gate. CPU idle, never load average: this box idles at load 4-6 while
// 85% idle, so a load gate never opens. Sampled from os.cpus() cumulative
// counters rather than by spawning `top` in a loop, because the sampler must
// not itself be a load source -- an earlier round on this machine was
// contaminated by its own wait loop spinning at 78% CPU.
// ---------------------------------------------------------------------------
function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function idlePct(windowMs = 1000): Promise<number> {
  const a = cpuTotals();
  await sleep(windowMs);
  const b = cpuTotals();
  const dTotal = b.total - a.total;
  if (dTotal <= 0) return 100;
  return ((b.idle - a.idle) / dTotal) * 100;
}

async function waitQuiet(minIdle = Number(process.env.QUIET_IDLE ?? 82), hold = 6, timeoutMs = 900_000) {
  const started = Date.now();
  let held = 0;
  for (;;) {
    const idle = await idlePct();
    if (idle >= minIdle) {
      held++;
      if (held >= hold) {
        console.log(`  [gate] quiet: ${held} consecutive samples, idle ${idle.toFixed(1)}%`);
        return idle;
      }
    } else {
      if (held > 0) console.log(`  [gate] contention at hold=${held} (idle ${idle.toFixed(1)}%), resetting`);
      held = 0;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for a quiet machine');
    }
  }
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface Arm {
  name: string;
  note: string;
  pool: pg.Pool;
  rowMode?: 'array';
}

/** Drain all 50K comments by keyset, exactly as the raw control arm does. */
async function drainComments(arm: Arm): Promise<number> {
  let n = 0;
  let lastId = 0;
  for (;;) {
    const res = await arm.pool.query({
      text: 'SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2',
      values: [lastId, BATCH],
      ...(arm.rowMode ? { rowMode: 'array' as const } : {}),
    });
    const rows = res.rows as any[];
    if (rows.length === 0) break;
    for (const row of rows) {
      n++;
      // Column 0 is `id` in both object and array row modes.
      lastId = Number(arm.rowMode ? row[0] : row.id);
    }
    if (rows.length < BATCH) break;
  }
  return n;
}

async function timeArm(fn: () => Promise<number>): Promise<{ ms: number; rows: number }> {
  const t0 = performance.now();
  const rows = await fn();
  return { ms: performance.now() - t0, rows };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Decode ceiling: what is there to win by replacing pg type parsers? ===\n');
  console.log(`node ${process.version}, pg ${(pg as any).version ?? 'unknown'}`);
  console.log(`rounds=${ROUNDS} warmup=${WARMUP} batch=${BATCH}\n`);

  console.log('Waiting for a quiet machine before any timing...');
  const idleBefore = await waitQuiet();

  // ---- Part 1: the real fixture, 50K comments -----------------------------
  // comments = id int8, post_id int8, user_id int8, body text, created_at timestamptz
  const armSpecs: { name: string; note: string; types: any; rowMode?: 'array' }[] = [
    {
      name: 'stock pg',
      note: 'pg defaults: int8->string, text->string, timestamptz->Date',
      types: undefined,
    },
    {
      name: 'turbine-like',
      note: 'int8->Number (what TurbineClient registers), timestamptz stock',
      types: turbineTypes(),
    },
    {
      name: 'fast timestamptz -> Date',
      note: 'ACHIEVABLE: hand-written decoder that still returns a Date',
      types: fastDecodeTypes(),
    },
    {
      name: 'identity ALL',
      note: 'every OID returns raw text: the parse-free floor',
      types: typesWithIdentityFor(null),
    },
    {
      name: 'identity timestamptz',
      note: 'only 1184 identity, everything else stock',
      types: typesWithIdentityFor([OID.timestamptz]),
    },
    {
      name: 'identity int8',
      note: 'only 20 identity, everything else stock',
      types: typesWithIdentityFor([OID.int8]),
    },
    {
      name: 'identity text',
      note: 'only 25 identity: NEGATIVE CONTROL, pg text parser is already identity',
      types: typesWithIdentityFor([OID.text]),
    },
    {
      name: 'rowMode=array, stock',
      note: 'skips row-object key materialisation, parsers unchanged',
      types: undefined,
      rowMode: 'array',
    },
    {
      name: 'rowMode=array, identity ALL',
      note: 'absolute floor reachable inside node-postgres text protocol',
      types: typesWithIdentityFor(null),
      rowMode: 'array',
    },
  ];

  const arms: Arm[] = armSpecs.map((s) => ({
    name: s.name,
    note: s.note,
    rowMode: s.rowMode,
    pool: new pg.Pool({ connectionString: URL, max: 1, ...(s.types ? { types: s.types } : {}) }),
  }));

  // Correctness / shape check before anything is timed. An arm that decodes to
  // a different shape is not measuring the same work.
  console.log('Arm shape check (first comments row, created_at + id):');
  for (const arm of arms) {
    const res = await arm.pool.query({
      text: 'SELECT * FROM comments ORDER BY id LIMIT 1',
      ...(arm.rowMode ? { rowMode: 'array' as const } : {}),
    });
    const row: any = res.rows[0];
    const id = arm.rowMode ? row[0] : row.id;
    const ts = arm.rowMode ? row[4] : row.created_at;
    console.log(
      `  ${arm.name.padEnd(28)} id=${JSON.stringify(id)} (${typeof id})  created_at=${
        ts instanceof Date ? `Date(${ts.toISOString()})` : JSON.stringify(ts)
      } (${ts instanceof Date ? 'Date' : typeof ts})`,
    );
  }
  console.log();

  const samples = new Map<string, number[]>(arms.map((a) => [a.name, []]));

  for (let round = 0; round < ROUNDS + WARMUP; round++) {
    // Rotate arm order every round so no arm is permanently first (and
    // permanently paying cold-cache costs for the others).
    const order = arms.map((_, i) => arms[(i + round) % arms.length]!);
    for (const arm of order) {
      const { ms, rows } = await timeArm(() => drainComments(arm));
      if (rows !== 50_000) {
        console.error(`ARM ${arm.name} drained ${rows} rows, expected 50000. Refusing to report.`);
        process.exit(1);
      }
      if (round >= WARMUP) samples.get(arm.name)!.push(ms);
    }
    if (round === WARMUP - 1) console.log('(warmup complete)\n');
  }

  const results = arms.map((a) => ({ arm: a, ms: median(samples.get(a.name)!) }));
  const stock = results.find((r) => r.arm.name === 'stock pg')!.ms;
  const turbineLike = results.find((r) => r.arm.name === 'turbine-like')!.ms;
  const floor = results.find((r) => r.arm.name === 'identity ALL')!.ms;

  console.log('=== Part 1: 50,000 comments (3x int8, 1x text, 1x timestamptz) ===');
  console.log('median ms to drain 50K rows, all arms interleaved\n');
  console.log(`  ${'arm'.padEnd(30)} ${'median'.padStart(9)}  ${'vs stock'.padStart(9)}`);
  for (const r of results) {
    const delta = r.ms - stock;
    console.log(
      `  ${r.arm.name.padEnd(30)} ${r.ms.toFixed(2).padStart(6)} ms  ${
        (delta >= 0 ? '+' : '') + delta.toFixed(2)
      } ms`,
    );
  }

  const fast = results.find((r) => r.arm.name === 'fast timestamptz -> Date')!.ms;

  // INTERNAL VALIDITY GATE, and it is a better instrument than the CPU gate.
  // pg registers NO parser for text (OID 25), so `identity text` and `stock pg`
  // execute byte-identical work and must land on top of each other. If they do
  // not, something moved underneath the run and every subtraction below is
  // suspect. This caught a contaminated run (a runaway Finder process) that the
  // 75%-idle gate had let through: the control came in 7.77 ms apart, on two
  // arms that cannot differ.
  const negControl = results.find((r) => r.arm.name === 'identity text')!.ms;
  const negDelta = Math.abs(negControl - stock);
  const negPct = (negDelta / stock) * 100;
  if (negPct > 3) {
    console.log(
      `\n  *** NEGATIVE CONTROL FAILED: 'identity text' and 'stock pg' differ by ` +
        `${negDelta.toFixed(2)} ms (${negPct.toFixed(1)}%), on arms that do identical work.`,
    );
    console.log('  *** This run was contaminated. Numbers below are NOT reportable.');
  } else {
    console.log(
      `\n  negative control ok: 'identity text' within ${negDelta.toFixed(2)} ms ` +
        `(${negPct.toFixed(1)}%) of 'stock pg', as it must be.`,
    );
  }

  console.log('\n  THE BUDGET:');
  console.log(`    stock pg parsers                  ${stock.toFixed(2)} ms`);
  console.log(`    turbine-like parsers (today)      ${turbineLike.toFixed(2)} ms`);
  console.log(`    fast timestamptz, still a Date    ${fast.toFixed(2)} ms   <- ACHIEVABLE`);
  console.log(`    all parsing removed (returns str) ${floor.toFixed(2)} ms   <- theoretical floor`);
  console.log(
    `\n    theoretical budget  ${(turbineLike - floor).toFixed(2)} ms ` +
      `(${(((turbineLike - floor) / turbineLike) * 100).toFixed(1)}% of the drain), but it returns the WRONG TYPE`,
  );
  console.log(
    `    achievable win      ${(turbineLike - fast).toFixed(2)} ms ` +
      `(${(((turbineLike - fast) / turbineLike) * 100).toFixed(1)}% of the drain) while still returning a Date`,
  );
  console.log(
    `\n    For scale: the gap from findManyStreamBatches (45.81 ms) to Drizzle 0.45 (39.49 ms) is 6.32 ms.`,
  );

  for (const arm of arms) await arm.pool.end();

  // ---- Part 2: per-type decode cost, isolated -----------------------------
  // Same 50K rows x 5 columns of ONE type per shape, measured stock vs
  // identity. Server generation cost is identical between the two arms of a
  // pair and cancels, so the delta is purely client-side decode for that type.
  console.log('\n=== Part 2: per-type decode cost, 50,000 rows x 5 columns ===');
  console.log('delta = (stock parser) - (identity parser) on the identical query\n');

  const shapes: { label: string; oid: number; sql: string }[] = [
    {
      label: 'int8',
      oid: OID.int8,
      sql: `SELECT i::int8 a, i::int8 b, i::int8 c, i::int8 d, i::int8 e FROM generate_series(1,50000) i`,
    },
    {
      label: 'int4',
      oid: OID.int4,
      sql: `SELECT i::int4 a, i::int4 b, i::int4 c, i::int4 d, i::int4 e FROM generate_series(1,50000) i`,
    },
    {
      label: 'text (short, ~12B)',
      oid: OID.text,
      sql: `SELECT ('body_'||i)::text a, ('body_'||i)::text b, ('body_'||i)::text c, ('body_'||i)::text d, ('body_'||i)::text e FROM generate_series(1,50000) i`,
    },
    {
      label: 'text (long, ~120B)',
      oid: OID.text,
      sql: `SELECT (repeat('x',110)||i)::text a, (repeat('x',110)||i)::text b, (repeat('x',110)||i)::text c, (repeat('x',110)||i)::text d, (repeat('x',110)||i)::text e FROM generate_series(1,50000) i`,
    },
    {
      label: 'timestamptz',
      oid: OID.timestamptz,
      sql: `SELECT t a, t b, t c, t d, t e FROM (SELECT '2024-01-01Z'::timestamptz + (i * interval '1 second') t FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'timestamp',
      oid: OID.timestamp,
      sql: `SELECT t a, t b, t c, t d, t e FROM (SELECT '2024-01-01'::timestamp + (i * interval '1 second') t FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'date',
      oid: OID.date,
      sql: `SELECT t a, t b, t c, t d, t e FROM (SELECT '2024-01-01'::date + i t FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'numeric',
      oid: OID.numeric,
      sql: `SELECT n a, n b, n c, n d, n e FROM (SELECT (i::numeric / 7) n FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'float8',
      oid: OID.float8,
      sql: `SELECT n a, n b, n c, n d, n e FROM (SELECT (i::float8 / 7) n FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'bool',
      oid: OID.bool,
      sql: `SELECT b a, b b2, b c, b d, b e FROM (SELECT (i % 2 = 0) b FROM generate_series(1,50000) i) s`,
    },
    {
      // Server-side generation must stay CHEAP relative to the decode being
      // measured. A first pass used md5(i::text)::uuid and
      // jsonb_build_object(...), which cost ~120 ms server-side and buried a
      // real client-side decode inside their own run-to-run variance: jsonb
      // came out at 4 ns/cell against an isolated JSON.parse measurement of
      // 91 ns/cell. Constant literals keep the server cost near the other
      // shapes so the subtraction has signal. See the `signal` column.
      label: 'uuid',
      oid: OID.uuid,
      sql: `SELECT u a, u b, u c, u d, u e FROM (SELECT '550e8400-e29b-41d4-a716-446655440000'::uuid u FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'jsonb',
      oid: OID.jsonb,
      sql: `SELECT j a, j b, j c, j d, j e FROM (SELECT '{"id":12345,"name":"row 12345"}'::jsonb j FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'json',
      oid: OID.json,
      sql: `SELECT j a, j b, j c, j d, j e FROM (SELECT '{"id":12345,"name":"row 12345"}'::json j FROM generate_series(1,50000) i) s`,
    },
    {
      label: 'int8[] (5 elems)',
      oid: 1016,
      sql: `SELECT arr a, arr b, arr c, arr d, arr e FROM (SELECT ARRAY[1,2,3,4,5]::int8[] arr FROM generate_series(1,50000) i) s`,
    },
  ];

  const stockPool = new pg.Pool({ connectionString: URL, max: 1 });
  const idPool = new pg.Pool({ connectionString: URL, max: 1, types: typesWithIdentityFor(null) });

  console.log(
    `  ${'type'.padEnd(20)} ${'stock'.padStart(8)} ${'identity'.padStart(9)} ${'decode'.padStart(8)} ${'ns/cell'.padStart(8)}  signal`,
  );

  const perType: { label: string; stock: number; id: number; decode: number }[] = [];

  for (const shape of shapes) {
    const sSamples: number[] = [];
    const iSamples: number[] = [];
    for (let round = 0; round < ROUNDS + WARMUP; round++) {
      // Alternate which pool goes first, so neither is systematically warmed
      // by the other.
      const first = round % 2 === 0;
      const runStock = async () => {
        const t = performance.now();
        const r = await stockPool.query(shape.sql);
        const ms = performance.now() - t;
        if (r.rows.length !== 50_000) throw new Error(`${shape.label}: ${r.rows.length} rows`);
        return ms;
      };
      const runId = async () => {
        const t = performance.now();
        const r = await idPool.query(shape.sql);
        const ms = performance.now() - t;
        if (r.rows.length !== 50_000) throw new Error(`${shape.label}: ${r.rows.length} rows`);
        return ms;
      };
      const a = first ? await runStock() : await runId();
      const b = first ? await runId() : await runStock();
      if (round >= WARMUP) {
        sSamples.push(first ? a : b);
        iSamples.push(first ? b : a);
      }
    }
    const s = median(sSamples);
    const i = median(iSamples);
    const decode = s - i;
    perType.push({ label: shape.label, stock: s, id: i, decode });
    // Signal quality: how big is the thing being measured against the floor it
    // is being subtracted from. Below ~10% the subtraction is inside the
    // shape's own variance and the number must not be quoted.
    const ratio = decode / s;
    const signal = Math.abs(ratio) < 0.1 ? 'LOW (do not quote)' : 'ok';
    console.log(
      `  ${shape.label.padEnd(20)} ${s.toFixed(2).padStart(6)}ms ${i.toFixed(2).padStart(7)}ms ${
        (decode >= 0 ? '+' : '') + decode.toFixed(2)
      }ms ${((decode * 1e6) / 250_000).toFixed(0).padStart(7)}  ${signal}`,
    );
  }

  console.log('\n  (ns/cell is over 250,000 cells = 50,000 rows x 5 columns)');
  console.log('  types pg does not parse at all (text, numeric, uuid) are the negative controls');
  console.log('  and must land near 0; they are how this method is known to be working.');

  // ---- Part 3: differential correctness of the fast decoder ---------------
  // The whole reason this is a gate and not a green light. A decoder is only
  // worth its speed if it is right, and "right" here means byte-identical to
  // what pg's parser already returns on values this fixture does not contain.
  console.log('\n=== Part 3: differential correctness, fast decoder vs postgres-date ===');
  console.log('every value pg can emit for a timestamptz, not just the ones in the fixture\n');

  const edgeValues = [
    '2026-08-15 12:25:43.476603-04',
    '2024-01-01 00:00:00+00',
    '2024-06-30 23:59:59.999999+05:30',
    '1970-01-01 00:00:00+00',
    'infinity',
    '-infinity',
    '0044-03-15 12:00:00+00',
    '0001-01-01 00:00:00+00',
    '12024-01-01 00:00:00+00',
    '2024-01-01 00:00:00-08',
    '4713-01-01 00:00:00+00 BC',
    '2024-02-29 12:00:00+00',
    '2024-01-01 00:00:00.1+00',
    '2024-01-01 00:00:00.12+00',
    '2024-01-01 00:00:00.123456+00',
  ];

  // Drizzle's actual timestamptz decoder, for reference: `pg-core/codecs.js`
  // defines `textToDate = (v) => new Date(v)` with no infinity / BC /
  // year-range handling. Priced here for CORRECTNESS, not speed, to show what
  // "just use new Date()" costs in fidelity.
  const drizzleStyle = (v: string) => new Date(v);

  const norm = (x: unknown) =>
    x instanceof Date ? (Number.isNaN(x.getTime()) ? 'Invalid Date' : x.toISOString()) : String(x);

  let mismatches = 0;
  let drizzleMismatches = 0;
  console.log(`  ${'value'.padEnd(30)} ${'pg (postgres-date)'.padEnd(26)} ${'fast'.padEnd(26)} drizzle-style`);
  for (const v of edgeValues) {
    const run = (f: (s: string) => unknown) => {
      try {
        return norm(f(v));
      } catch (e) {
        return `THREW ${(e as Error).message}`;
      }
    };
    const a = run(stockDateParser);
    const b = run(fastTimestamptz);
    const c = run(drizzleStyle);
    if (a !== b) mismatches++;
    if (a !== c) drizzleMismatches++;
    const flag = a === b ? (a === c ? 'ok  ' : 'DRZ ') : 'DIFF';
    console.log(`  ${flag} ${v.padEnd(28)} ${a.padEnd(26)} ${b.padEnd(26)} ${c}`);
  }
  console.log(
    `\n  fast decoder:    ${mismatches} mismatch(es) across ${edgeValues.length} edge values` +
      (mismatches === 0 ? '  <- delegation is doing the work' : '  <- SILENT CORRUPTION'),
  );
  console.log(
    `  drizzle-style:   ${drizzleMismatches} mismatch(es) across ${edgeValues.length} edge values` +
      (drizzleMismatches > 0 ? '  <- what "just use new Date()" costs' : ''),
  );

  // ---- Part 4: is the fixture representative, or is it flattering? --------
  // The `comments` fixture is 5 narrow columns, one of which is a timestamptz.
  // A decoder that wins there and loses on a wide table of numerics is not a
  // win, so the shapes a real schema actually produces are priced here rather
  // than argued about. Each shape is measured stock vs identity; what matters
  // is the decode SHARE of the whole drain, because that is what bounds any
  // rewrite for a table of that shape.
  console.log('\n=== Part 4: does the answer survive a different column mix? ===');
  console.log('decode share of total drain, 50,000 rows, by realistic table shape\n');

  const N = 50_000;
  const tableShapes: { label: string; cols: string; sql: string }[] = [
    {
      label: 'fixture: comments',
      cols: '3 int8, 1 text(12B), 1 timestamptz',
      sql: `SELECT i::int8 id, i::int8 post_id, i::int8 user_id, ('body_'||i)::text body,
            ('2024-01-01Z'::timestamptz + (i * interval '1 second')) created_at
            FROM generate_series(1,${N}) i`,
    },
    {
      label: 'typical: +updated_at',
      cols: '3 int8, 1 text(12B), 2 timestamptz',
      sql: `SELECT i::int8 id, i::int8 post_id, i::int8 user_id, ('body_'||i)::text body,
            ('2024-01-01Z'::timestamptz + (i * interval '1 second')) created_at,
            ('2024-01-01Z'::timestamptz + (i * interval '2 seconds')) updated_at
            FROM generate_series(1,${N}) i`,
    },
    {
      label: 'analytics: wide numeric',
      cols: '10 int4, 4 float8, no temporal',
      sql: `SELECT i::int4 a, i::int4 b, i::int4 c, i::int4 d, i::int4 e,
            i::int4 f, i::int4 g, i::int4 h, i::int4 j, i::int4 k,
            (i/7.0)::float8 m, (i/3.0)::float8 n, (i/11.0)::float8 o, (i/13.0)::float8 p
            FROM generate_series(1,${N}) i`,
    },
    {
      label: 'content: wide text',
      cols: '1 int8, 1 timestamptz, 1 text(~2KB)',
      sql: `SELECT i::int8 id,
            ('2024-01-01Z'::timestamptz + (i * interval '1 second')) created_at,
            (repeat('lorem ipsum dolor sit amet ', 74)||i)::text body
            FROM generate_series(1,${N}) i`,
    },
    {
      label: 'lookup: no temporal',
      cols: '2 int8, 3 text(12B)',
      sql: `SELECT i::int8 id, i::int8 ref, ('a_'||i)::text a, ('b_'||i)::text b, ('c_'||i)::text c
            FROM generate_series(1,${N}) i`,
    },
  ];

  const stockPool2 = new pg.Pool({ connectionString: URL, max: 1 });
  const idPool2 = new pg.Pool({ connectionString: URL, max: 1, types: typesWithIdentityFor(null) });

  console.log(
    `  ${'shape'.padEnd(24)} ${'columns'.padEnd(34)} ${'stock'.padStart(8)} ${'identity'.padStart(9)} ${'decode'.padStart(8)} ${'share'.padStart(7)}`,
  );

  for (const shape of tableShapes) {
    const sS: number[] = [];
    const iS: number[] = [];
    for (let round = 0; round < ROUNDS + WARMUP; round++) {
      const first = round % 2 === 0;
      const run = async (pool: pg.Pool) => {
        const t = performance.now();
        const r = await pool.query(shape.sql);
        const ms = performance.now() - t;
        if (r.rows.length !== N) throw new Error(`${shape.label}: ${r.rows.length} rows`);
        return ms;
      };
      const a = first ? await run(stockPool2) : await run(idPool2);
      const b = first ? await run(idPool2) : await run(stockPool2);
      if (round >= WARMUP) {
        sS.push(first ? a : b);
        iS.push(first ? b : a);
      }
    }
    const s = median(sS);
    const i2 = median(iS);
    const decode = s - i2;
    const share = (decode / s) * 100;
    console.log(
      `  ${shape.label.padEnd(24)} ${shape.cols.padEnd(34)} ${s.toFixed(2).padStart(6)}ms ${i2
        .toFixed(2)
        .padStart(7)}ms ${(decode >= 0 ? '+' : '') + decode.toFixed(2)}ms ${share.toFixed(1).padStart(6)}%`,
    );
  }

  await stockPool2.end();
  await idPool2.end();

  console.log(
    '\n  "share" is the fraction of the whole drain that ANY decoder rewrite could compete for.',
  );

  await stockPool.end();
  await idPool.end();

  const idleAfter = await idlePct();
  console.log(`\n=== Machine: idle ${idleBefore.toFixed(1)}% before, ${idleAfter.toFixed(1)}% after ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
