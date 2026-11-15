/**
 * Original 50K drain, using the shared interleaved Bench. Native PostgreSQL
 * cursor APIs and keyset page emulations remain distinct strategies.
 * --preflight runs the complete catalog without timing. No row-count oracle.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { asc, gt } from 'drizzle-orm';
import { asc as rcAsc, gt as rcGt } from 'drizzle-rc';
import { Bench, median } from './bench-harness.js';
import * as schema from './schema.js';
import * as rcSchema from './schema-rc.js';
import {
  BATCH,
  consumer,
  execute,
  fixture,
  integer,
  isMain,
  output,
  type Resources,
  type RunOptions,
  type Scenario,
  type SecondaryArm,
  STREAM_SCENARIO,
  verify,
} from './secondary-contract.js';

export async function streamCleanupControls(r: Resources): Promise<Record<string, unknown>[]> {
  const outcomes: Record<string, unknown>[] = [];
  for (const mode of ['break', 'consumer-error'] as const) {
    const stream = r.turbine.comments.findManyStreamBatches({ batchSize: BATCH, orderBy: { id: 'asc' } });
    const { trace } = await r.observer.capture(async () => {
      let seen = 0;
      try {
        for await (const rows of stream) {
          assert.equal(rows.length, BATCH);
          seen += rows.length;
          if (mode === 'break') break;
          if (mode === 'consumer-error') throw new Error('intentional stream consumer failure');
        }
        assert.equal(mode, 'break', 'Failure control did not fail');
      } catch (error) {
        assert.notEqual(mode, 'break');
        assert.match(String(error), /intentional stream consumer failure/);
      }
      assert.equal(seen, BATCH, 'Failure control must reach the cursor before failing');
    });
    assert.ok(
      trace.commands.some((c) => /^DECLARE /i.test(c.sql)),
      'Failure control never opened its cursor',
    );
    assert.ok(
      trace.commands.some((c) => /^(?:ROLLBACK|COMMIT)$/.test(c.sql)),
      'Cursor transaction was not settled',
    );
    const check = await r.pools.turbine.connect();
    try {
      assert.equal(
        (await check.query('SELECT count(*)::int AS n FROM pg_cursors')).rows[0]!.n,
        0,
        'Native cursor leaked',
      );
      await check.query('SELECT 1');
    } finally {
      check.release();
    }
    outcomes.push({ mode, passed: true, trace });
  }
  const packageRequire = createRequire(createRequire(import.meta.url).resolve('turbine-orm'));
  const nativeIdentity = r.pools.turbine instanceof packageRequire('pg').Pool;
  if (nativeIdentity) {
    const controller = new AbortController();
    const reason = new Error('intentional native stream abort');
    let delivered = 0;
    const { trace } = await r.observer.capture(async () => {
      await assert.rejects(
        async () => {
          for await (const rows of r.turbine.comments.findManyStreamBatches({
            batchSize: BATCH,
            orderBy: { id: 'asc' },
            signal: controller.signal,
          })) {
            delivered += rows.length;
            assert.equal(delivered, BATCH, 'Abort must stop further row delivery');
            controller.abort(reason);
          }
        },
        (error: unknown) => error === reason,
      );
    });
    assert.equal(delivered, BATCH, 'Native abort must reach a real cursor');
    assert.ok(trace.commands.some((c) => /^DECLARE /i.test(c.sql)));
    assert.ok(
      trace.commands.some((c) => /^(?:ROLLBACK|COMMIT)$/.test(c.sql)),
      'Aborted cursor transaction not settled',
    );
    const check = await r.pools.turbine.connect();
    try {
      assert.equal(
        (await check.query('SELECT count(*)::int AS n FROM pg_cursors')).rows[0]!.n,
        0,
        'Aborted cursor leaked',
      );
      await check.query('SELECT 1');
    } finally {
      check.release();
    }
    outcomes.push({
      mode: 'abort',
      status: 'supported',
      nativePoolIdentity: true,
      delivered,
      trace,
      scope: 'Abort after first delivered batch; does not certify cancellation during an in-flight server query.',
    });
  }
  // Preserve the native-identity refusal even when npm deduplicates the installed driver.
  const wrappedPool = {
    query: r.pools.turbine.query.bind(r.pools.turbine),
    connect: r.pools.turbine.connect.bind(r.pools.turbine),
    end: async () => {},
  };
  const foreign = nativeIdentity
    ? new TurbineClient({ pool: wrappedPool as unknown as pg.Pool, logging: false })
    : r.turbine;
  try {
    const { trace } = await r.observer.capture(async () => {
      await assert.rejects(async () => {
        for await (const _row of foreign.comments.findManyStream({
          batchSize: BATCH,
          orderBy: { id: 'asc' },
          signal: new AbortController().signal,
        }))
          assert.fail('Cancellation refusal must happen before row delivery');
      }, /TURBINE_E017.*Stream cancellation/);
    });
    assert.equal(trace.commands.length, 0, 'Unsupported cancellation emitted SQL');
    outcomes.push({
      mode: nativeIdentity ? 'abort-foreign-pool' : 'abort',
      status: 'unsupported',
      code: 'E017',
      commands: 0,
      reason: 'Native pg pool identity is required; foreign module instances and compatible wrappers are refused.',
    });
  } finally {
    if (foreign !== r.turbine) await foreign.disconnect();
  }
  return outcomes;
}

export async function runStream(options: RunOptions = {}) {
  const rounds = integer('STREAM_ROUNDS', 15);
  const warmup = integer('WARMUP', 2, 0);
  const url = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench?host=/tmp';
  return execute('stream', url, options, async (r, report, verifyOnly) => {
    const f = await fixture(r.pools.raw);
    report.fixture = { fingerprint: f.fingerprint, counts: f.counts };
    const expected = consumer();
    for (const row of f.comments) expected.row(row);
    const heaps = new Map<string, number[]>();
    const samples = new Map<string, number[]>();
    let measured = false;
    const arm = (
      name: string,
      role: SecondaryArm['role'],
      route: SecondaryArm['route'],
      strategy: string,
      drain: (consume: (row: unknown) => void, page: () => void) => Promise<void>,
    ): SecondaryArm => ({
      name,
      role,
      route,
      strategy,
      async fn(_i, observe) {
        const consume = consumer(observe);
        const start = performance.now();
        const base = process.memoryUsage().heapUsed;
        let peak = base;
        const page = () => {
          peak = Math.max(peak, process.memoryUsage().heapUsed);
        };
        await drain(consume.row, page);
        const value = consume.done();
        if (measured) {
          samples.set(name, [...(samples.get(name) ?? []), performance.now() - start]);
          heaps.set(name, [...(heaps.get(name) ?? []), (peak - base) / 1024 / 1024]);
        }
        return value;
      },
    });
    const batches = async (consume: (row: unknown) => void, page: () => void) => {
      for await (const batch of r.turbine.comments.findManyStreamBatches({
        batchSize: BATCH,
        orderBy: { id: 'asc' },
      })) {
        page();
        for (const row of batch) consume(row);
      }
    };
    const scenarios: Scenario[] = [
      {
        scenario: STREAM_SCENARIO,
        expected: expected.done(),
        stream: f.comments,
        note: 'Full ordered row values are consumed into the same SHA256 fold in every arm. T rows/batches use a native transaction cursor with a bounded speculative SELECT; competitors use keyset SELECT pages. Prisma is page emulation, not native streaming. Stable and RC are separate arms. Heap is sampled at page boundaries, not a process-wide memory bound.',
        arms: [
          arm('T rows', 'turbine', 'cursor', 'native cursor, per-row async iterator', async (consume, page) => {
            let n = 0;
            for await (const row of r.turbine.comments.findManyStream({ batchSize: BATCH, orderBy: { id: 'asc' } })) {
              consume(row);
              if (++n % BATCH === 0) page();
            }
          }),
          arm('T batches', 'turbine', 'cursor', 'native cursor, per-batch async iterator', batches),
          arm('T batches#2', 'turbine', 'cursor', 'identical native batch control', batches),
          arm('Drizzle', 'stable', 'keyset', 'keyset pages, not native streaming', async (consume, page) => {
            let last = 0;
            for (;;) {
              const rows = await r.stable
                .select()
                .from(schema.comments)
                .where(gt(schema.comments.id, last))
                .orderBy(asc(schema.comments.id))
                .limit(BATCH);
              page();
              for (const row of rows) {
                consume(row);
                last = row.id;
              }
              if (rows.length < BATCH) break;
            }
          }),
          arm(
            'Drizzle RC',
            'rc',
            'keyset',
            'keyset pages via RC SQL builder; relational JIT is not used by select()',
            async (consume, page) => {
              let last = 0;
              for (;;) {
                const rows = await r.rc
                  .select()
                  .from(rcSchema.comments)
                  .where(rcGt(rcSchema.comments.id, last))
                  .orderBy(rcAsc(rcSchema.comments.id))
                  .limit(BATCH);
                page();
                for (const row of rows) {
                  consume(row);
                  last = row.id;
                }
                if (rows.length < BATCH) break;
              }
            },
          ),
          arm(
            'Prisma 7 pages',
            'prisma',
            'keyset',
            'Prisma7 keyset page emulation, not native streaming',
            async (consume, page) => {
              let last = 0n;
              for (;;) {
                const rows = await r.prisma.comment.findMany({
                  where: { id: { gt: last } },
                  orderBy: { id: 'asc' },
                  take: BATCH,
                });
                page();
                for (const row of rows) {
                  consume(row);
                  last = row.id;
                }
                if (rows.length < BATCH) break;
              }
            },
          ),
          arm('Raw', 'raw', 'keyset', 'native pg keyset pages', async (consume, page) => {
            let last = '0';
            for (;;) {
              const { rows } = await r.pools.raw.query(
                'SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2',
                [last, BATCH],
              );
              page();
              for (const row of rows) {
                consume(row);
                last = String(row.id);
              }
              if (rows.length < BATCH) break;
            }
          }),
        ],
      },
    ];
    options.mutate?.(scenarios);
    await verify(r, scenarios, report);
    report.failureControls = await streamCleanupControls(r);
    r.observer.disable();
    if (!verifyOnly) {
      const bench = new Bench({ rounds, warmup });
      const before = await bench.driftProbe(r.pools.raw, 'head');
      // Bench's warmup is deliberately excluded from paired per-round samples.
      for (const a of scenarios[0]!.arms) for (let i = 0; i < warmup; i++) await a.fn(i);
      measured = true;
      await bench.interleave(STREAM_SCENARIO, scenarios[0]!.arms, { warmup: 0, note: scenarios[0]!.note });
      measured = false;
      const after = await bench.driftProbe(r.pools.raw, 'tail');
      bench.reportDrift([before, after]);
      report.results = bench.results;
      report.drift = { before, after, samples: bench.probes };
      report.peakHeapMb = Object.fromEntries(
        [...heaps].map(([name, xs]) => [
          name,
          {
            median: median([...xs].sort((a, b) => a - b)),
            max: Math.max(...xs),
            ...(process.env.BENCH_RETAIN_SAMPLES === '1'
              ? { samplesMb: [...xs], n: xs.length, scope: 'heapUsed snapshots during complete drains; not global RSS' }
              : {}),
          },
        ]),
      );
      report.paired = Object.fromEntries(
        ['T rows', 'T batches#2', 'Drizzle', 'Drizzle RC', 'Prisma 7 pages', 'Raw'].map((name) => {
          const a = samples.get(name)!;
          const b = samples.get('T batches')!;
          const deltas = a.map((v, i) => v - b[i]!);
          return [
            name,
            {
              baseline: 'T batches',
              n: deltas.length,
              medianDeltaMs: median([...deltas].sort((x, y) => x - y)),
              ...(process.env.BENCH_RETAIN_SAMPLES === '1'
                ? { samplesMs: [...deltas], method: 'paired per-round arm minus T batches duration' }
                : {}),
              fractionBelowBaseline: deltas.filter((d) => d < 0).length / deltas.length,
            },
          ];
        }),
      );
    }
    // Reads and failed consumers must leave the complete original fixture intact.
    assert.equal((await fixture(r.pools.raw)).fingerprint, f.fingerprint, 'Stream changed stored values');
    report.rounds = rounds;
    report.warmup = warmup;
    report.fold =
      'Length-framed canonical complete rows, SHA256; untimed preflight also compares each complete row in sequence.';
  });
}

if (isMain(import.meta.url)) {
  runStream({ verifyOnly: process.argv.includes('--preflight'), reportPath: process.env['SECONDARY_REPORT'] })
    .then(output)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
