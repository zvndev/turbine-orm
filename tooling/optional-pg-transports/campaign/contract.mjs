import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const base = '6052829e9c83e8549fca48932b30e9448cafcc9f';
export const pins = {
  pg: '8.23.1', 'pg-cursor': '2.15.3',
  '@neondatabase/serverless': '1.2.0', ws: '8.18.3',
  'drizzle-orm': '0.45.4', 'drizzle-rc': 'npm:drizzle-orm@1.0.0-rc.5',
  prisma: '7.10.1', '@prisma/client': '7.10.1',
  '@prisma/adapter-pg': '7.10.1', '@prisma/adapter-neon': '7.10.1',
  typescript: '6.0.3', '@types/node': '22.20.4', '@types/pg': '8.15.6',
};
export const spec = {
  schemaVersion: 1, table: 'transport_rows', rows: 128, tenant: 1, resultCount: 64,
  payloadBytes: 64, poolMax: 1, cursorBatchSize: 16, liveConsumers: 8,
  select: ['id', 'title'], orderBy: 'id ASC',
  buffered: 'call entry to resolved, decoded full array; first result equals full drain',
  cursor: 'iterator construction to first yielded row and iterator done; validation outside interval',
  notification: 'same-process monotonic timestamp immediately before COMMIT call to typed snapshot delivery; includes commit acknowledgement; not server commit timestamp',
  cold: 'first operation on fresh arm client in a warm process/server; excludes imports/install; not process cold start',
  warm: 'rotated serial rounds after explicit warmups, one operation per arm per round',
  resourceScope: 'client process CPU/RSS/heap/FD and pool counts per operation; RSS is before/after, not peak or isolated allocation; bridge is in client, PG is separate',
};
export const unsupported = [
  { contract: 'session/interactive transaction/cursor/LISTEN', arms: ['raw-http', 'turbine-http', 'drizzle-stable-http', 'drizzle-rc-http', 'prisma7-http'], reason: 'stateless HTTP contract; Prisma7 official PrismaNeonHttp executes reads but refuses transactions' },
  { contract: 'noninteractive transaction batch', arms: ['prisma7-http'], reason: 'exact official adapter 7.10.1 startTransaction refuses HTTP mode; read arm retained separately' },
  { contract: 'session/transaction/cursor/LISTEN', arms: ['turbine-core'], reason: 'supplied-transport core explicitly refuses session APIs' },
  { contract: 'native cursor', arms: ['prisma7-pg', 'prisma7-ws', 'drizzle-stable-pg', 'drizzle-rc-pg', 'drizzle-stable-ws', 'drizzle-rc-ws'], reason: 'no native cursor arm in this exact adapter contract; no page emulation substituted' },
  { contract: 'built-in live query', arms: ['raw', 'drizzle-stable', 'drizzle-rc', 'prisma7'], reason: 'application composition over native PG hub, separately labelled; no built-in equivalent claimed' },
  { contract: 'CDC/durable replay/cross-engine subscriptions/hosted provider/TLS/auth/pooler/cancellation certification', arms: ['all'], reason: 'outside local volatile invalidation/refetch and loopback bridge evidence' },
  { contract: 'process cold start/install/type/server peak CPU and RSS/concurrent throughput', arms: ['all'], reason: 'unavailable in this runner; type/install use existing consumer-cost harness; serial throughput is derived only from retained individual calls' },
];
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function treeIdentity(root) {
  const files = {};
  function walk(path, relative = '') {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) walk(join(path, item.name), name);
      else files[name] = hash(readFileSync(join(path, item.name)));
    }
  }
  walk(root);
  return { sha256: hash(JSON.stringify(files)), files, symlinks: 'excluded, never used for source imports' };
}
export function expectedRows() {
  return Array.from({ length: spec.resultCount }, (_, i) => ({ id: i * 2 + 1, title: 'x'.repeat(spec.payloadBytes) }));
}
export function verifyRows(rows) { assert.deepEqual(rows, expectedRows(), 'Exact ordered payload/count/projection/tenant mismatch'); }
export function verifyCommittedRows(rows) {
  const expected = Array.from({ length: spec.rows }, (_, index) => {
    const id = index + 1;
    return { id, tenant_id: id % 2,
      title: [1, 3].includes(id) ? 'committed-control' : 'x'.repeat(spec.payloadBytes), secret: 'private' };
  });
  assert.deepEqual(rows, expected, 'Exact complete native row identities and two-write effects');
}
export async function verifyCallerPool(pool, name) {
  assert.equal(pool.ended, false, `${name}: facade ended caller pool`);
  assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n, 1, `${name}: caller query after facade close`);
}
export function summarize(samples) {
  assert.ok(samples.length > 0);
  const sorted = samples.map((sample) => sample.fullDrainMs).sort((a, b) => a - b);
  assert.ok(sorted.every((value) => Number.isFinite(value) && value >= 0));
  const n = sorted.length, mean = sorted.reduce((a, b) => a + b, 0) / n;
  return { n, method: 'individual retained calls; p50 midpoint median; p95/p99 nearest rank',
    median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    avg: mean, min: sorted[0], p50: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    p95: n >= 20 ? sorted[Math.ceil(n * .95) - 1] : null,
    p99: n >= 100 ? sorted[Math.ceil(n * .99) - 1] : null,
    percentileScope: n < 20 ? 'p95/p99 unavailable: small n' : n < 100 ? 'p99 unavailable: small n; p95 unstable tail estimate' : 'empirical tails; no confidence interval',
    serialCallsPerSecond: 1000 / mean, serialRowsPerSecond: spec.resultCount * 1000 / mean };
}
export function summarizeFanout(samples, rounds) {
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
  assert.equal(samples.length, rounds * spec.liveConsumers);
  const roundSamples = Array.from({ length: rounds }, (_, round) => {
    const fanout = samples.filter((sample) => sample.round === round);
    assert.deepEqual(fanout.map((sample) => sample.consumer).sort((a, b) => a - b),
      Array.from({ length: spec.liveConsumers }, (_, index) => index), 'Every round needs every consumer');
    assert.ok(fanout.every((sample) => Number.isFinite(sample.fullDrainMs) && sample.fullDrainMs >= 0));
    return { fullDrainMs: Math.max(...fanout.map((sample) => sample.fullDrainMs)) };
  });
  const { serialCallsPerSecond, serialRowsPerSecond, ...statistics } = summarize(roundSamples);
  void [serialCallsPerSecond, serialRowsPerSecond];
  return { ...statistics,
    unit: 'maximum snapshot delivery latency for a complete eight-consumer round',
    correlation: 'eight consumer deliveries form one round, not eight independent iterations',
    derivedFromRetainedSamples: true };
}
export function options(argv) {
  const parsed = { mode: 'preflight', rounds: 0, warmup: 3 };
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--artifact', '--sha256', '--out', '--scratch', '--mode', '--rounds', '--warmup', '--lock'].includes(argv[i]), `Unknown option ${argv[i]}`);
    const key = argv[i].slice(2);
    assert.ok(argv[i + 1] && !Object.hasOwn(parsed, key + 'Seen'), `Missing/duplicate ${argv[i]}`);
    parsed[key] = ['rounds', 'warmup'].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
    parsed[key + 'Seen'] = true;
  }
  for (const key of ['artifact', 'sha256', 'out', 'scratch']) assert.ok(parsed[key], `Explicit --${key} required`);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  assert.ok(['preflight', 'collect'].includes(parsed.mode));
  assert.ok(Number.isSafeInteger(parsed.rounds) && parsed.rounds >= 0 && parsed.rounds <= 1000);
  assert.ok(Number.isSafeInteger(parsed.warmup) && parsed.warmup >= 0 && parsed.warmup <= 100);
  if (parsed.mode === 'collect') assert.ok(parsed.lock && parsed.rounds >= 2, 'Collection needs explicit prepared --lock and --rounds >= 2');
  else assert.equal(parsed.rounds, 0, 'Preflight never collects comparative timing samples');
  return parsed;
}
