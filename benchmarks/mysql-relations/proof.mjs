import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function canonical(value) {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('hex') };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export const exact = (value) => JSON.stringify(canonical(value));
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const fileHash = (path) => hash(readFileSync(path));
export function treeHashes(root) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), key = prefix + name;
      if (statSync(path).isDirectory()) visit(path, `${key}/`);
      else result[key] = fileHash(path);
    }
  }
  visit(root);
  return { files: result, sha256: hash(JSON.stringify(result)) };
}
export function assertValues(actual, expected) {
  assert.ok(expected.length > 0 && expected.some((p) => p.children.length > 0), 'oracle prerequisite: nonempty nested values');
  assert.equal(exact(actual), exact(expected), 'exact nested values/windows differ');
}
export function assertOrder(args, names) {
  assert.deepEqual(args.orderBy, [{ weight: 'asc' }, { id: 'desc' }], 'parent tie-breaker omitted');
  assert.deepEqual(args.with[names.children].orderBy, [{ weight: 'asc' }, { id: 'desc' }], 'child tie-breaker omitted');
}
export function assertRoute(route, strategy, legacy) {
  assert.ok(route.length > 0, 'missing native command proof');
  assert.match(route[0].sql, /^(START TRANSACTION|BEGIN)/i, 'missing native transaction start');
  assert.match(route.at(-1).sql, /^COMMIT/i, 'missing native transaction commit');
  const selects = route.filter((r) => /^SELECT\b/i.test(r.sql));
  assert.ok(selects.length > 0 && selects.every((r) => r.ended && r.callback && r.nativeRows > 0 && r.materializedRows > 0 && r.decodedBytes > 0 && r.commandClass), 'incomplete native materialization proof');
  assert.ok(selects.every((r) => r.commandClass === 'Execute'), 'compared SELECTs must use native mysql2 prepared binding');
  assert.equal(new Set(route.map((r) => r.threadId)).size, 1, 'transaction changed native backend');
  const orders = selects.flatMap((r) => [...r.sql.matchAll(/ORDER BY\s+(?:`?\w+`?\.)?`?weight`? ASC,\s*(?:`?\w+`?\.)?`?id`? DESC/gi)]);
  assert.ok(orders.length >= 2, 'native SQL omitted parent/child tie-breakers');
  if (strategy === 'raw') assert.equal(selects.length, 4, 'raw reference must use four flat SELECTs');
  else if (strategy === 'batched') {
    assert.ok(selects.length >= 4, 'batched route did not execute relation follow-ups');
    assert.ok(selects.every((r) => !/JSON_ARRAYAGG|JSON_OBJECT|LEFT JOIN/i.test(r.sql)), 'batched route used a nested or flatten plan');
  } else {
    assert.equal(selects.length, 1, 'join/flatten must execute one SELECT');
    assert.match(selects[0].sql, /JSON_ARRAYAGG/i, 'missing nested to-many native SQL');
    if (strategy === 'flatten' && !legacy) assert.match(selects[0].sql, /LEFT JOIN\s+\(SELECT[\s\S]+FROM `profiles`/i, 'flatten route claim lacks unique-FK LEFT JOIN');
    else assert.doesNotMatch(selects[0].sql, /LEFT JOIN/i, 'unexpected flatten route');
  }
}
export function assertProtocol(protocol, logicalStatements) {
  assert.ok(protocol.length >= logicalStatements && logicalStatements >= 3, 'missing native protocol exchange proof');
  assert.ok(protocol.every((p) => [3, 22, 23].includes(p.opcode) && p.completed && p.packetBytes > 4 && p.commandClass), 'incomplete native protocol exchange');
  assert.equal(new Set(protocol.map((p) => p.threadId)).size, 1, 'protocol changed native backend');
}
export function assertSuccess(report) {
  assert.equal(report.status, 'success', 'report is not successful');
  assert.deepEqual(report.failures, [], 'successful report retained failures');
  assert.deepEqual(report.signals, [], 'successful report retained OS signals');
  assert.ok(report.cleanup?.complete, 'cleanup incomplete');
  assert.ok(report.proof?.cases?.length > 0, 'missing nonempty exact proof');
  for (const key of ['harness', 'source', 'lock']) assert.match(report.provenance?.[key]?.sha256 ?? '', /^[a-f0-9]{64}$/, `missing ${key} provenance`);
  for (const c of report.proof.cases) {
    assert.match(c.oracleHash ?? '', /^[a-f0-9]{64}$/, 'missing oracle hash');
    assert.equal(c.oracleHash, c.resultHash, 'exact proof digest mismatch');
    assert.match(c.inputHash ?? '', /^[a-f0-9]{64}$/, 'missing source input hash');
    assertRoute(c.route, c.arm, c.legacy);
    assertProtocol(c.protocol, c.route.length);
  }
  assert.equal(report.proof.clientCleanup, true, 'native client cleanup incomplete');
  assert.ok(report.proof.effects?.length === 4, 'missing complete fixture effect oracle');
  for (const effect of report.proof.effects) {
    assert.match(effect.expected ?? '', /^[a-f0-9]{64}$/, 'missing effect oracle hash');
    assert.equal(effect.before, effect.expected, 'stored fixture differs from source input');
    assert.equal(effect.after, effect.expected, 'read workload mutated stored fixture');
  }
}
