// Narrow extension of the existing SQLite fixture, exact validator, and Bench.
import { Bench, median, pct } from './bench-harness.ts';
import { assertExact } from './equivalence.ts';
import { column, decodeRow, fields, fixtureRow, volumes } from './sqlite-seed.ts';

export const arms = ['Raw', 'Turbine', 'Drizzle 0.45.4', 'Drizzle RC 1.0.0-rc.5', 'Prisma 7.10.1'];
export const operations = [
  'flat-100',
  'pk-1',
  'nullable-17',
  'insert-returning',
  'update-returning',
  'delete-returning',
];
export const seedTables = ['organizations', 'users', 'bench_tiny'];
export const catalog = 'optional-local-sqlite-contract-v1';
export const controlIds = {
  d1: [
    'raw-native-batch-order-rollback',
    'Turbine/native-batch-rollback',
    'Drizzle 0.45.4/native-batch-rollback',
    'Drizzle RC 1.0.0-rc.5/native-batch-rollback',
    'Drizzle 0.45.4/interactive-refused',
    'Drizzle RC 1.0.0-rc.5/interactive-refused',
    'turbine-interactive-refused',
    'turbine-stream-refused',
    'turbine-pre-dispatch-abort',
    'prisma7-d1-interactive-refused',
    'prisma7-d1-no-rollback-guarantee',
    'turbine-caller-binding-ownership',
  ],
  libsql: [
    'raw-native-rollback',
    ...arms.slice(1).map((arm) => `${arm}/callback-rollback`),
    'native-exact-int64',
    'remote-and-sync-refused',
    'native-stream-inflight-cancel-and-forced-close-unavailable',
    'callback-timeout-rolls-back-late-work-refused',
    'caller-client-ownership',
    'owned-client-disconnect',
  ],
};
export { assertExact, column, decodeRow, fields, fixtureRow, volumes };

export function assertContractReport(report, platform, options) {
  assertExact('contract identity', report.catalog, catalog);
  assertExact('dimension availability ledger', report.dimensions, dimensions());
  assertExact('known execution mode', ['preflight', 'campaign'].includes(options.mode), true);
  assertExact(
    'required operation/arm cells',
    report.preflight.map((cell) => `${cell.operation}/${cell.arm}`).sort(),
    operations.flatMap((operation) => arms.map((arm) => `${operation}/${arm}`)).sort(),
  );
  for (const cell of report.preflight) {
    assertExact('exact values and persisted effects required', [cell.exact, cell.effectExact], [true, true]);
    assertExact(
      'required delivered values',
      cell.values,
      cell.operation === 'flat-100' ? 700 : cell.operation === 'nullable-17' ? 68 : 7,
    );
  }
  assertExact(
    'required guarantee/refusal controls',
    report.controls.map((control) => control.id).sort(),
    [...controlIds[platform]].sort(),
  );
  for (const control of report.controls) assertExact(`control ${control.id}`, control.passed, true);
  if (options.mode === 'preflight')
    assertExact('preflight contains no timing', [report.samples, report.results], [[], []]);
  else {
    if (!Number.isSafeInteger(options.rounds) || options.rounds <= 0) throw new Error('Invalid declared rounds');
    assertExact(
      'required timing cells',
      report.samples.map((cell) => `${cell.operation}/${cell.arm}`).sort(),
      operations.flatMap((operation) => arms.map((arm) => `${operation}/${arm}`)).sort(),
    );
    for (const cell of report.samples) {
      assertExact('retained sample count', cell.milliseconds.length, options.rounds);
      if (cell.milliseconds.some((sample) => !Number.isFinite(sample) || sample < 0))
        throw new Error('Invalid retained timing sample');
      if (!(cell.milliseconds.reduce((a, b) => a + b, 0) > 0)) throw new Error('Unmeasurable timing sample sum');
    }
    assertExact(
      'required result cells',
      report.results.map((cell) => `${cell.operation}/${cell.arm}`).sort(),
      operations.flatMap((operation) => arms.map((arm) => `${operation}/${arm}`)).sort(),
    );
    for (const cell of report.samples) {
      const result = report.results.find((row) => row.operation === cell.operation && row.arm === cell.arm);
      assertExact('sample-derived result', result, resultFor(cell.operation, cell.arm, cell.milliseconds));
    }
  }
}

export function seedStatements() {
  return seedTables.flatMap((table) =>
    Array.from({ length: volumes[table] }, (_, i) => {
      const row = fixtureRow(table, i + 1);
      return {
        sql: `INSERT INTO ${table} (${fields[table].map(column).join(',')}) VALUES (${fields[table].map(() => '?').join(',')})`,
        args: fields[table].map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
      };
    }),
  );
}
export const selectedUsers = {
  id: true,
  orgId: true,
  email: true,
  name: true,
  avatarUrl: true,
  lastLoginAt: true,
  createdAt: true,
};
export const selectSql = 'id,org_id,email,name,avatar_url,last_login_at,created_at';
export const writeData = {
  id: 1,
  orgId: 1,
  slug: 'optional-owned',
  label: 'initial',
  amount: 7,
  active: true,
  createdAt: new Date('2023-11-14T22:13:20.000Z'),
};
export const writeSql =
  "INSERT INTO bench_writes(id,org_id,slug,label,amount,active,created_at) VALUES(1,1,'optional-owned','initial',7,1,'2023-11-14T22:13:20.000Z')";
export const rawRead = {
  'flat-100': `SELECT ${selectSql} FROM users ORDER BY id LIMIT 100`,
  'pk-1': `SELECT ${selectSql} FROM users WHERE id=1`,
  'nullable-17': 'SELECT id,score,bucket,label FROM bench_tiny ORDER BY id',
};
export function expected(id) {
  if (id === 'flat-100' || id === 'pk-1') {
    const rows = Array.from({ length: id === 'pk-1' ? 1 : 100 }, (_, i) =>
      Object.fromEntries(Object.entries(fixtureRow('users', i + 1)).filter(([key]) => selectedUsers[key])),
    );
    return id === 'pk-1' ? rows[0] : rows;
  }
  if (id === 'nullable-17') return Array.from({ length: 17 }, (_, i) => fixtureRow('bench_tiny', i + 1));
  return { ...writeData, label: id === 'insert-returning' ? 'initial' : 'updated' };
}
export function decodeRaw(id, rows) {
  if (id === 'pk-1' || id.endsWith('returning')) assertExact('raw single-row cardinality', rows.length, 1);
  // This shared workload contains only safe INTEGERs. The raw bigint-mode
  // driver needs explicit safe-number and boolean decoding before the existing
  // SQLite fixture decoder. Refuse rounding rather than accepting a cast.
  rows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (typeof value !== 'bigint') return [key, value];
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error(`Unsafe raw integer ${key}`);
        return [key, number];
      }),
    ),
  );
  if (id === 'nullable-17')
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      score: row.score === null ? null : Number(row.score),
      bucket: Number(row.bucket),
    }));
  if (id.endsWith('returning')) return decodeRow('bench_writes', rows[0]);
  const result = rows.map((row) =>
    Object.fromEntries(Object.entries(decodeRow('users', row)).filter(([key]) => selectedUsers[key])),
  );
  return id === 'pk-1' ? result[0] : result;
}
export function summary(samples) {
  if (!samples.length)
    return { n: 0, p50: null, p95: null, p99: null, method: 'unavailable: no timing samples in preflight' };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: median(sorted),
    p95: pct(sorted, 0.95),
    p99: sorted.length >= 100 ? pct(sorted, 0.99) : null,
    method: 'milliseconds; p50 middle average, tails nearest rank; p99 unavailable below n=100, unstable near n=100',
  };
}

function resultFor(operation, arm, retained) {
  return {
    operation,
    arm,
    ...summary(retained),
    throughput: {
      operationsPerSecond: (1000 * retained.length) / retained.reduce((a, b) => a + b, 0),
      scope: 'serial completed operations per sum of retained per-call durations; no concurrency claim',
    },
  };
}

export function dimensions() {
  return {
    coldImport: { available: false, reason: 'bundled integrated runner; no per-arm cold-import experiment' },
    firstQuery: { available: false, reason: 'provisioning and catalog admission precede contract reads' },
    resource: {
      available: false,
      reason: 'Worker per-arm RSS unavailable; Node process resource sample supplied separately',
    },
    typecheck: {
      available: false,
      reason: 'runtime contract only; generated declarations retained but no type performance claim',
    },
    installTiming: { available: false, reason: 'isolated install correctness only' },
  };
}

export async function runContract(lanes, reset, options) {
  assertExact(
    'required arms',
    lanes.map((lane) => lane.name),
    arms,
  );
  const preflight = [],
    samples = [],
    results = [];
  const bench = new Bench({ rounds: options.rounds, warmup: options.warmup, retainSamples: true });
  for (const operation of operations) {
    for (const lane of lanes) {
      await reset(operation);
      const value = await lane.run(operation);
      assertExact(`${operation}/${lane.name}`, value, expected(operation));
      const remaining = await reset('inspect');
      assertExact(
        `${operation}/${lane.name}/effect`,
        remaining,
        operation === 'insert-returning'
          ? [expected(operation)]
          : operation === 'update-returning'
            ? [expected(operation)]
            : [],
      );
      preflight.push({
        operation,
        arm: lane.name,
        exact: true,
        effectExact: true,
        values: operation === 'flat-100' ? 700 : operation === 'nullable-17' ? 68 : 7,
      });
    }
    if (options.mode === 'campaign') {
      const stats = await bench.interleave(
        operation,
        lanes.map((lane) => ({
          name: lane.name,
          setup: () => reset(operation),
          fn: () => lane.run(operation),
          verify: async (value) => {
            assertExact(`retained sample ${operation}/${lane.name}`, value, expected(operation));
            assertExact(
              `retained effect ${operation}/${lane.name}`,
              await reset('inspect'),
              operation === 'insert-returning' || operation === 'update-returning' ? [expected(operation)] : [],
            );
          },
        })),
        {
          note: 'Narrow optional SQLite contract, not the original full catalog. Samples exclude reset, validation and provisioning.',
        },
      );
      for (const stat of stats) {
        const arm = stat.name;
        const retained = stat.samplesMs;
        samples.push({ operation, arm, milliseconds: retained });
        results.push(resultFor(operation, arm, retained));
      }
    }
  }
  await reset('clear');
  return {
    catalog,
    preflight,
    samples,
    results,
    dimensions: dimensions(),
  };
}
