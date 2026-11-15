import assert from 'node:assert/strict';

/** Reconcile server-observed extended-protocol calls, outside measured intervals. */
export function assertNativeRoute(observed, samples) {
  const expected = new Map();
  for (const sample of samples) {
    const queries = expected.get(sample.backendPid) ?? [];
    for (const q of [...sample.warmupTrace, ...sample.trace]) queries.push({ name: '<unnamed>', sql: q.sql, parameters: q.params.map(String) });
    expected.set(sample.backendPid, queries);
  }
  const actual = new Map();
  assert.ok(Array.isArray(observed) && observed.length, 'Native execution observations required');
  for (const record of observed) {
    assert.ok(expected.has(record.backendPid), 'Unexpected observed backend');
    assert.equal(record.name, '<unnamed>', 'Native page/lookup execution must be unnamed');
    const queries = actual.get(record.backendPid) ?? [];
    queries.push({ name: record.name, sql: record.sql, parameters: record.parameters });
    actual.set(record.backendPid, queries);
  }
  assert.equal(actual.size, expected.size, 'Native backend count must match samples');
  for (const [pid, queries] of expected) {
    assert.equal(actual.get(pid)?.length, queries.length, 'Native SQL/binds/counts must match every warmup and measured call');
    for (const [index, query] of queries.entries()) assert.deepEqual(actual.get(pid)[index], query, 'Native SQL/binds/counts must match every warmup and measured call');
  }
  return true;
}

export function nativeExecutions(log, samples) {
  const pids = new Set(samples.map(s => s.backendPid));
  const records = [], latest = new Map();
  for (const line of log.split('\n')) {
    const match = /\[(\d+)\]\s+(LOG|DETAIL):\s+(.*)$/.exec(line);
    if (!match || !pids.has(Number(match[1]))) continue;
    const backendPid = Number(match[1]), text = match[3];
    if (match[2] === 'LOG' && /^(execute |statement:)/.test(text)) {
      const query = /^execute (.*?): (.*)$/.exec(text);
      assert.ok(query, 'Native page/lookup must use extended protocol');
      const record = { backendPid, name: query[1], sql: query[2], parameters: null };
      records.push(record); latest.set(backendPid, record);
    } else if (match[2] === 'DETAIL' && /^parameters: /i.test(text)) {
      const record = latest.get(backendPid);
      assert.ok(record && record.parameters === null, 'Unexpected native parameter record');
      const values = text.slice(12), params = [];
      const pattern = /\$(\d+) = ('(?:[^']|'')*'|NULL)(?:, |$)/gy;
      let position = 0, parameter;
      while ((parameter = pattern.exec(values))) {
        assert.equal(Number(parameter[1]), params.length + 1, 'Native bind sequence');
        params.push(parameter[2] === 'NULL' ? null : parameter[2].slice(1, -1).replaceAll("''", "'"));
        position = pattern.lastIndex;
      }
      assert.equal(position, values.length, 'Complete native parameter record required');
      record.parameters = params;
    }
  }
  assertNativeRoute(records, samples);
  return records;
}
