import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

// Explicit prerequisite; absence fails, never silently skips.
const runtimePath = process.argv[2];
assert.ok(
  runtimePath && existsSync(runtimePath),
  'Pass the installed miniflare module path; a real workerd runtime is required',
);
const output = resolve(process.argv[3] ?? '/tmp/turbine-live-query-edge');
mkdirSync(output, { recursive: true });
const { Miniflare } = await import(pathToFileURL(resolve(runtimePath)).href);
const report = {
  compatibilityDate: '2026-08-06',
  scope: 'local workerd runtime, callback subscription fixture; no PostgreSQL driver or hosted edge endpoint',
  runtimePath,
  pids: [],
};
let runtime;
function descendants() {
  const records = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      records.push({
        pid: Number(name),
        ppid: Number(status.match(/^PPid:\s+(\d+)/m)[1]),
        name: status.match(/^Name:\s+(.*)/m)[1],
      });
    } catch {}
  }
  const owned = new Set([process.pid]);
  for (let i = 0; i < records.length; i++) {
    let added = false;
    for (const record of records)
      if (owned.has(record.ppid) && !owned.has(record.pid)) {
        owned.add(record.pid);
        added = true;
      }
    if (!added) break;
  }
  return records.filter((record) => owned.has(record.pid) && record.pid !== process.pid);
}
try {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import { liveQuery } from './dist/live-query.js';
export default { async fetch() {
  let invalidate, hooks, unsubscribed = 0, calls = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const live = liveQuery({
    subscribe(handler, callbacks) { invalidate = handler; hooks = callbacks; return { unsubscribe() { unsubscribed++; } }; },
    async query() { const call = ++calls; if (call === 1) await barrier; return [{id:call}]; },
  });
  await live.ready;
  const pending = live.next();
  for (let i=0;i<10000;i++) invalidate();
  release();
  const first = await pending;
  hooks.onReconnect();
  const afterReconnect = await live.next();
  const cancelled = live.next();
  await live.dispose();
  invalidate();
  const end = await cancelled;
  let cleanedFailure = 0;
  const failed = liveQuery({ subscribe() { return {unsubscribe() {cleanedFailure++;}}; }, query() { throw new Error('worker query failed'); } });
  let error;
  try { await failed.next(); } catch (failure) { error = failure.message; }
  try { await failed.closed; } catch {}
  return Response.json({first, afterReconnect, end, calls, unsubscribed, cleanedFailure, error});
}};`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    metafile: true,
  });
  report.inputs = Object.keys(bundled.metafile.inputs);
  assert.ok(report.inputs.some((name) => name.endsWith('dist/live-query.js')));
  runtime = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-06' });
  const response = await runtime.dispatchFetch('http://live-query.fixture/');
  assert.equal(response.status, 200);
  report.response = await response.json();
  assert.deepEqual(report.response, {
    first: { done: false, value: [{ id: 2 }] },
    afterReconnect: { done: false, value: [{ id: 3 }] },
    end: { done: true },
    calls: 3,
    unsubscribed: 1,
    cleanedFailure: 1,
    error: 'worker query failed',
  });
  report.pids = descendants();
  assert.ok(
    report.pids.some(({ name }) => /workerd/.test(name)),
    'actual workerd child must be observed',
  );
} finally {
  try {
    await runtime?.dispose();
  } catch (error) {
    report.disposeError = error.message;
  }
  await stop();
  // Child-process close delivery can trail the dispose acknowledgment.
  const deadline = Date.now() + 5000;
  while (report.pids.some(({ pid }) => existsSync(`/proc/${pid}`)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  report.cleanup = report.pids.map((record) => ({ ...record, absent: !existsSync(`/proc/${record.pid}`) }));
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.disposeError, undefined, 'runtime disposal must succeed');
  assert.ok(
    report.cleanup.every(({ absent }) => absent),
    'owned runtime children must exit',
  );
}
