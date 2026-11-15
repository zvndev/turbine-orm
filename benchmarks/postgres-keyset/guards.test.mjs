import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootDriver } from './driver.mjs';
import { nativeExecutions, assertNativeRoute } from './native-route.mjs';
import { digest } from '../postgres-pagination/corpus.mjs';
import { compileTuple, quote } from './candidate.mjs';
import { ARMS, CASES, METHODS, MODES, REFUSALS, planFacts, statements, verifyTrace } from './workload.mjs';
import { comparisons, validate, verifySample } from './validate.mjs';

const request = (direction = 'asc') => ({
  keys: ['score', 'part', 'id'].map((column) => ({ column, direction, nullable: false })),
  cursor: { score: 7, part: 4, id: 99 }, uniqueSuffix: ['part', 'id'], start: 3,
});
test('tuple compiler preserves complete composite suffix, direction and parameter positions', () => {
  for (const [direction, operator] of [['asc', '>'], ['desc', '<']]) {
    assert.deepEqual(compileTuple(request(direction)), { supported: true,
      sql: `("score", "part", "id") ${operator} ($3, $4, $5)`, params: [7, 4, 99] });
  }
  assert.equal(quote('a"b'), '"a""b"');
  assert.throws(() => quote('a\u0000b'), /Invalid column/);
  const r = request(); r.keys[0].column = 'a"b'; r.cursor['a"b'] = "λ'\\";
  assert.deepEqual(compileTuple(r).params, ["λ'\\", 4, 99]);
  assert.ok(!compileTuple(r).sql.includes("λ'\\"), 'Values must remain bound');
});

test('unsupported semantics refuse explicitly without partial SQL', () => {
  for (const refusal of REFUSALS) assert.deepEqual(Object.keys(compileTuple(refusal)), ['supported', 'reason']);
  const mutations = [
    (r) => { r.keys = Array(1); }, (r) => { r.uniqueSuffix = Array(1); },
    (r) => { delete r.keys[1]; }, (r) => { r.uniqueSuffix = [null]; },
    (r) => { r.keys = []; }, (r) => { r.keys = null; },
    (r) => { r.keys[0].column = ''; }, (r) => { r.keys[0].column = 'a\u0000b'; },
    (r) => { r.keys[0].column = 'id'; }, (r) => { delete r.keys[0].nullable; },
    (r) => { r.keys[0].direction = 'up'; }, (r) => { r.keys[0].direction = 'desc'; },
    (r) => { r.uniqueSuffix = []; }, (r) => { r.uniqueSuffix = ['id', 'part']; },
    (r) => { r.uniqueSuffix = ['x', 'score', 'part', 'id']; }, (r) => { delete r.cursor.part; },
    (r) => { r.cursor.part = null; }, (r) => { r.cursor.part = undefined; },
    (r) => { r.cursor.part = NaN; }, (r) => { r.cursor.part = {}; },
    (r) => { r.cursor.part = Infinity; }, (r) => { r.cursor = []; },
    (r) => { r.start = 0; }, (r) => { r.start = 65535; }, (r) => { r.start = 1.5; },
  ];
  assert.ok(mutations.length > 15);
  for (const mutate of mutations) {
    const r = request(); mutate(r);
    const result = compileTuple(r);
    assert.equal(result.supported, false); assert.ok(result.reason); assert.equal(result.sql, undefined);
  }
});

test('wire templates independently pin expansion, tuple and lookup parameters', () => {
  const c = CASES.find((c) => c.id === 'deep');
  assert.deepEqual(c.cursor, { score: 237, id: 12950 });
  const tuple = statements(c, 'tuple', 'provided')[0];
  assert.equal(tuple.sql, 'SELECT "id", "score", "bucket", "label" FROM "items" WHERE "score" IS NOT NULL AND "bucket" >= $1 AND ("score", "id") > ($2, $3) ORDER BY "score" ASC, "id" ASC LIMIT $4');
  assert.deepEqual(tuple.params, [0, 237, 12950, 11]);
  const expanded = statements(c, 'expanded-or', 'provided')[0];
  assert.equal(expanded.sql, 'SELECT "id", "score", "bucket", "label" FROM "items" WHERE "score" IS NOT NULL AND "bucket" >= $1 AND (("score" > $2) OR ("score" = $3 AND "id" > $4)) ORDER BY "score" ASC, "id" ASC LIMIT $5');
  assert.deepEqual(expanded.params, [0, 237, 237, 12950, 11]);
  assert.deepEqual(statements(c, 'tuple', 'locate')[0], { role: 'lookup',
    sql: 'SELECT "score", "id" FROM "items" WHERE "score" IS NOT NULL AND "bucket" >= $1 ORDER BY "score" ASC, "id" ASC LIMIT $2 OFFSET $3', params: [0, 1, 18002] });
  assert.equal(CASES.length, 8); assert.equal(CASES.find((c) => c.id === 'empty').expected.length, 0);
});

// Synthetic validator data only; never persisted or used as native evidence.
function sample(c, arm, method, mode, round) {
  const trace = (start) => statements(c, arm, method).map((q, i) => {
    const rows = structuredClone(q.role === 'lookup' ? [c.cursor] : c.expected);
    return { ...q, start: start + i, end: start + i + 1, elapsedMs: 1, rows, rowCount: rows.length, command: 'SELECT', resultSha256: digest(rows) };
  });
  const measured = trace(10);
  return { case: c.id, arm, method, mode, round, position: round % 2 === 0 ? ARMS.indexOf(arm) : 1 - ARMS.indexOf(arm),
    iterations: 1, backendPid: 321, start: 10, end: 20, elapsedMs: 10, trace: measured,
    warmupTrace: mode === 'warm' ? Array.from({ length: 6 }, () => trace(0)).flat() : [],
    queryCount: measured.length, fetchedRows: measured.reduce((n, q) => n + q.rowCount, 0) };
}
function synthetic() {
  const samples = [], plans = [];
  for (const c of CASES) for (const method of METHODS) for (const arm of ARMS) {
    for (const mode of MODES) for (let round = 0; round < 4; round++) samples.push(sample(c, arm, method, mode, round));
    const queries = statements(c, arm, method).map((statement) => {
      const document = [{ Plan: { 'Node Type': 'Limit', 'Actual Rows': statement.role === 'lookup' ? 1 : c.expected.length, 'Actual Loops': 1 }, 'Execution Time': 1, 'Planning Time': 1 }];
      if (c.id === 'deep' && arm === 'tuple' && method === 'provided') document[0].Plan.Plans = [{ 'Node Type': 'Index Scan', 'Index Name': 'items_score_id', 'Index Cond': 'ROW(items.score, items.id) > ROW(237,12950)', 'Actual Rows': c.expected.length, 'Actual Loops': 1 }];
      return { statement, document, facts: planFacts(document) };
    });
    plans.push({ case: c.id, method, arm, queries });
  }
  const sha = 'a'.repeat(64);
  const sourceFiles = { 'src/client.ts': sha }, harnessFiles = { 'benchmarks/postgres-keyset/candidate.mjs': sha };
  const nativeExecutions = samples.flatMap(s => [...s.warmupTrace, ...s.trace].map(q => ({ backendPid: s.backendPid, name: '<unnamed>', sql: q.sql, parameters: q.params.map(String) })));
  return { format: 'postgres-keyset-v1', status: 'passed', config: { rounds: 4, iterations: 1 },
    nativeExecutions, serverLogSha256: sha, setup: { settings: ['fsync', 'synchronous_commit', 'full_page_writes'].map(name => ({ name, setting: 'on' })) },
    identity: { sourceHead: 'a'.repeat(40), branch: 'test', worktree: '/synthetic', command: ['node', 'run.mjs', '--out'],
      runtime: { node: 'v22.16.0', executable: '/synthetic/node', versions: { node: '22.16.0', v8: '12' }, sha256: sha }, lockSha256: sha, serverBinarySha256: sha, initdbSha256: sha,
      sourceFiles, harnessFiles, sourceSha256: digest(sourceFiles), harnessSha256: digest(harnessFiles),
      driver: { version: '8.22.0', lockedVersion: '8.22.0', resolvedEntry: '/synthetic/node_modules/pg/lib/index.js', resolvedSha256: sha, files: { 'node_modules/pg/package.json': sha } },
      driverDependencies: { pg: { version: '8.22.0', lockedVersion: '8.22.0', files: { 'node_modules/pg/package.json': sha } } }, tsx: { version: '4.23.15', lockedVersion: '4.23.15', files: { 'node_modules/tsx/package.json': sha } }, artifact: null },
    refusals: REFUSALS.map((request) => ({ request, result: compileTuple(request) })),
    corpus: CASES.map((c) => ({ ...c, expectedSha256: digest(c.expected), statements: Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(METHODS.map((method) => [method, statements(c, arm, method)]))])) })),
    services: [{ pid: 123, server_version: '18.6', stopped: true }], samples, plans, comparisons: comparisons(samples), failures: [],
    cleanup: { errors: [], ownedPids: [123, 321], processesAbsent: true, portClosed: true, datadirAbsent: true, socketAbsent: true, rootAbsent: true } };
}

test('dependency-free sample validator catches omitted query, tie-breaker, binds and lookup cost', () => {
  const c = CASES[0]; const valid = sample(c, 'tuple', 'locate', 'warm', 0);
  verifySample(valid, c);
  const mutations = [
    (s) => { s.trace.shift(); },
    (s) => { s.trace[1].sql = s.trace[1].sql.replace('("score", "id")', '("score")'); },
    (s) => { s.trace[1].params.pop(); },
    (s) => { s.trace[1].rows[0].label = 'wrong'; },
    (s) => { s.trace[0].start = 8; s.trace[0].end = 9; },
    (s) => { s.queryCount--; }, (s) => { s.fetchedRows--; },
    (s) => { s.warmupTrace.pop(); }, (s) => { s.position = 0; },
    (s) => { s.elapsedMs = -1; }, (s) => { s.backendPid = 0; },
  ];
  for (const mutate of mutations) { const s = structuredClone(valid); mutate(s); assert.throws(() => verifySample(s, c)); }
  const omitted = structuredClone(valid.trace); omitted.shift();
  assert.throws(() => verifyTrace(omitted, c, 'tuple', 'locate', 1), /Charged lookup\/page query count/);
});

test('whole-report validator rejects missing/duplicate scopes, false plans and cleanup', () => {
  assert.equal(validate(synthetic()), true);
  const mutations = [
    (r) => { r.signal = 'SIGTERM'; }, (r) => { r.config.fault = 'missing-predicate'; },
    (r) => { r.setup.settings[0].setting = 'off'; }, (r) => { delete r.identity.driver.version; },
    (r) => { delete r.identity.driverDependencies; }, (r) => { delete r.identity.tsx; }, (r) => { delete r.serverLogSha256; },
    (r) => { r.plans.find(p => p.case === 'deep' && p.arm === 'tuple' && p.method === 'provided').queries[0].document[0].Plan.Plans = []; for (const p of r.plans) for (const q of p.queries) q.facts = planFacts(q.document); },
    (r) => { r.plans[0].queries[0].document[0]['Execution Time'] = -1; },
    (r) => { r.plans[0].queries[0].document[0].Plan['Actual Loops'] = -1; },
    (r) => { r.nativeExecutions[0].name = 'named'; }, (r) => { r.nativeExecutions.pop(); },
    (r) => { r.samples.pop(); }, (r) => { r.samples.push(r.samples[0]); },
    (r) => { r.plans.pop(); }, (r) => { r.plans.push(r.plans[0]); },
    (r) => { r.plans[0].queries[0].facts.nodes[0].rows++; },
    (r) => { r.plans[0].queries[0].statement.params[0]++; },
    (r) => { r.plans[0].queries[0].document[0].Plan['Actual Rows']++; r.plans[0].queries[0].facts = planFacts(r.plans[0].queries[0].document); },
    (r) => { r.samples[0].round = 99; }, (r) => { r.samples[0].case = 'unknown'; },
    (r) => { r.services[0].server_version = '17'; }, (r) => { r.config.rounds = 3; },
    (r) => { r.failures.push({ message: 'wrong' }); },
    (r) => { r.cleanup.processesAbsent = false; }, (r) => { r.cleanup.ownedPids = []; },
    (r) => { r.cleanup.errors.push('failed cleanup'); },
    (r) => { delete r.identity; }, (r) => { r.identity.sourceFiles = {}; },
    (r) => { r.identity.harnessSha256 = '0'.repeat(64); }, (r) => { r.identity.runtime.node = 'v20'; },
    (r) => { r.refusals.pop(); }, (r) => { r.corpus[0].expectedSha256 = '0'.repeat(64); },
    (r) => { r.comparisons.pairs.pop(); }, (r) => { r.comparisons.lookupCharges[0].locateQueriesPerOperation = 1; },
  ];
  for (const mutate of mutations) { const r = synthetic(); mutate(r); assert.throws(() => validate(r)); }
});


test('native execution verifier requires server-observed names, binds and counts', () => {
  const s = sample(CASES[0], 'tuple', 'locate', 'warm', 0);
  const log = [...s.warmupTrace, ...s.trace].map(q =>
    `[321] LOG:  execute <unnamed>: ${q.sql}\n[321] DETAIL:  Parameters: ${q.params.map((v,i) => `$${i+1} = '${v}'`).join(', ')}`).join('\n');
  const actual = nativeExecutions(log, [s]);
  assert.equal(assertNativeRoute(actual, [s]), true);
  assert.throws(() => nativeExecutions(log.replace('execute <unnamed>', 'execute named'), [s]), /must be unnamed/);
  assert.throws(() => nativeExecutions(log.replace("$1 = '0'", "$1 = '1'"), [s]), /SQL\/binds\/counts/);
  assert.throws(() => nativeExecutions(log.split('\n').slice(2).join('\n'), [s]), /SQL\/binds\/counts/);
});

test('root driver identity rejects stale versions and ignores a benchmark-local shadow', () => {
  const root = mkdtempSync(join(tmpdir(), 'keyset-driver-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/pg': { version: '8.22.0' } } }));
    for (const [directory, origin] of [['node_modules', 'root'], ['benchmarks/node_modules', 'shadow']]) {
      const path = join(root, directory, 'pg'); mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'pg', version: '8.22.0', main: 'index.cjs' }));
      writeFileSync(join(path, 'index.cjs'), `module.exports = { origin: '${origin}' };`);
    }
    assert.equal(rootDriver(root).driver.origin, 'root');
    writeFileSync(join(root, 'node_modules/pg/package.json'), JSON.stringify({ name: 'pg', version: '0.0.0', main: 'index.cjs' }));
    assert.throws(() => rootDriver(root), /must match root lock/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
