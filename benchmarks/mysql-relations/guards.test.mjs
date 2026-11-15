import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, windows, oracle, queryArgs } from './fixture.mjs';
import { exact, hash, assertValues, assertOrder, assertRoute, assertProtocol, assertSuccess } from './proof.mjs';
import { owned, deadline, stop, audit } from './lifecycle.mjs';

const names = { children: 'children', leaves: 'leaves', profiles: 'profiles' };
const input = fixture('small'), window = windows(input)[0], expected = oracle(input, window, false);
const clone = (v) => structuredClone(v);
function route(strategy = 'join') {
  const r = (sql) => ({ sql, threadId: 1, commandClass: 'Execute', callback: true, ended: true, nativeRows: 2, materializedRows: 2, decodedBytes: 40 });
  const ordering = ' ORDER BY weight ASC, id DESC /* child ORDER BY weight ASC, id DESC */';
  return [r('START TRANSACTION'), r((strategy === 'flatten' ? 'SELECT JSON_ARRAYAGG(...) FROM parents LEFT JOIN (SELECT id FROM `profiles`) f ON ...' : 'SELECT JSON_ARRAYAGG(...) FROM parents') + ordering), r('COMMIT')];
}
function successful() {
  return { status: 'success', failures: [], signals: [], cleanup: { complete: true },
    provenance: Object.fromEntries(['harness', 'source', 'lock'].map((k) => [k, { sha256: hash(k) }])),
    proof: { clientCleanup: true, effects: Array.from({ length: 4 }, () => ({ expected: hash('fixture'), before: hash('fixture'), after: hash('fixture') })),
      cases: [{ arm: 'join', legacy: false, oracleHash: hash(exact(expected)), resultHash: hash(exact(expected)), inputHash: hash(exact(input)), route: route(),
        protocol: Array.from({ length: 3 }, () => ({ opcode: 3, completed: true, packetBytes: 8, commandClass: 'Query', threadId: 1 })) }] } };
}

test('fixture oracle is populated across fanouts, exact boundaries and both unique FK shapes', () => {
  for (const name of ['small', 'large', 'skewed', 'wide']) {
    const f = fixture(name);
    for (const w of windows(f)) for (const legacy of [false, true]) {
      const value = oracle(f, w, legacy);
      assertValues(value, value);
      assert.ok(value.every((p) => legacy ? Array.isArray(p.profiles) : !Array.isArray(p.profiles)));
      assert.ok(value.flatMap((p) => p.children).every((c) => c.leaves.length === 1 && c.binaryValue instanceof Uint8Array && c.day instanceof Date));
    }
  }
  assert.match(exact(input), /18446744073709551615/);
  assert.match(exact(input), /1234567890123456789012.12345678/);
  assert.notEqual(hash(exact(input)), hash(exact(fixture('wide'))));
});
for (const kind of ['missing', 'duplicate', 'window', 'decimal', 'binary', 'date', 'json']) test(`exact value guard rejects ${kind}`, () => {
  assertValues(expected, expected);
  const actual = clone(expected), p = actual.find((p) => p.children.length > 1), c = p.children[0];
  if (kind === 'missing') p.children.shift();
  if (kind === 'duplicate') p.children.push(clone(c));
  if (kind === 'window') p.children.reverse();
  if (kind === 'decimal') c.amount = '0.00000000';
  if (kind === 'binary') c.binaryValue[0] = 42;
  if (kind === 'date') c.day = new Date('2000-01-01Z');
  if (kind === 'json') c.doc.array[0] = 'null';
  assert.throws(() => assertValues(actual, expected), /exact nested values\/windows differ/);
});
test('tie-breaker assertions fail for omitted parent and child terms', () => {
  const args = queryArgs(window, 'join', names); assertOrder(args, names);
  const parent = clone(args); parent.orderBy.pop();
  assert.throws(() => assertOrder(parent, names), /parent tie-breaker omitted/);
  const child = clone(args); child.with.children.orderBy.pop();
  assert.throws(() => assertOrder(child, names), /child tie-breaker omitted/);
});
test('route assertion observes SQL, materialization and transaction backend', () => {
  assertRoute(route(), 'join', false); assertRoute(route('flatten'), 'flatten', false);
  assert.throws(() => assertRoute(route(), 'flatten', false), /flatten route claim/);
  assert.throws(() => assertRoute(route(), 'batched', false), /batched route/);
  assert.throws(() => assertRoute([], 'join', false), /missing native command proof/);
  const a = route(); a[1].materializedRows = 0;
  assert.throws(() => assertRoute(a, 'join', false), /materialization proof/);
  const b = route(); b[1].threadId = 2;
  assert.throws(() => assertRoute(b, 'join', false), /changed native backend/);
  const c = route(); c[1].sql = c[1].sql.replaceAll('weight ASC, id DESC', 'weight ASC');
  assert.throws(() => assertRoute(c, 'join', false), /native SQL omitted parent\/child tie-breakers/);
});
test('protocol proof distinguishes native prepare exchanges from SQL statement counts', () => {
  const protocol = successful().proof.cases[0].protocol;
  assertProtocol(protocol, 3);
  assert.throws(() => assertProtocol([], 3), /missing native protocol exchange proof/);
  protocol[1].completed = false;
  assert.throws(() => assertProtocol(protocol, 3), /incomplete native protocol exchange/);
});
for (const kind of ['empty', 'failure', 'signal', 'cleanup', 'client', 'provenance', 'oracle', 'effect']) test(`success admission rejects ${kind}`, () => {
  assertSuccess(successful());
  const report = successful();
  if (kind === 'empty') report.proof.cases = [];
  if (kind === 'failure') report.failures.push('sticky');
  if (kind === 'signal') report.signals.push('SIGTERM');
  if (kind === 'cleanup') report.cleanup.complete = false;
  if (kind === 'client') report.proof.clientCleanup = false;
  if (kind === 'provenance') delete report.provenance.source;
  if (kind === 'oracle') report.proof.cases[0].resultHash = hash('wrong');
  if (kind === 'effect') report.proof.effects[0].after = hash('mutated');
  assert.throws(() => assertSuccess(report));
});
test('destination refusal preserves successful evidence byte for byte before prerequisites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-relations-destination-'));
  try {
    const path = join(dir, 'success.json'), text = JSON.stringify(successful());
    writeFileSync(path, text);
    const child = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1); assert.match(child.stderr, /refusing to overwrite evidence/);
    assert.equal(readFileSync(path, 'utf8'), text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('real child deadline and OS-signal cleanup are observable and independently audited', async () => {
  const child = owned(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    await assert.rejects(deadline(child.done, 80, 'guard child'), /guard child deadline/);
  } finally { await stop(child); }
  assert.equal(child.signal, 'SIGTERM');
  const result = await audit({ processes: [child], removedPaths: [], port: null });
  assert.equal(result.complete, true);
});
