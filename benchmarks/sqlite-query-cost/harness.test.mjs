import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { campaignReport } from './report.mjs';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-query-report-'));
  const path = join(root, 'report.json');
  try {
    await run(path, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const db = () => ({
  isOpen: true,
  close() {
    this.isOpen = false;
  },
});
test('fresh atomic report replaces stale success before setup and retains checked samples on failure', async () =>
  fixture(async (path, root) => {
    writeFileSync(path, JSON.stringify({ status: 'passed', runId: 'old' }));
    const lifecycle = campaignReport(path, { samples: [] });
    const started = JSON.parse(readFileSync(path));
    assert.equal(started.status, 'running');
    assert.notEqual(started.runId, 'old');
    lifecycle.report.samples.push({ checkedResults: 2, checkedRows: 3 });
    lifecycle.fail(new Error('primary query failure'));
    assert.equal(await lifecycle.finish(), false);
    const report = JSON.parse(readFileSync(path));
    assert.match(report.failure, /primary query failure/);
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.counts, {
      samples: 1,
      checkedResults: 2,
      checkedRows: 3,
      fail: 1,
      skip: 0,
    });
    assert.deepEqual(readdirSync(root), ['report.json']);
  }));
for (const phase of ['native setup', 'pool construction'])
  test(`closes native handle when ${phase} fails`, async () =>
    fixture(async (path) => {
      const lifecycle = campaignReport(path, { samples: [] });
      const native = db();
      lifecycle.own(native, phase);
      lifecycle.fail(new Error(phase));
      await lifecycle.finish();
      assert.equal(native.isOpen, false);
      const report = JSON.parse(readFileSync(path));
      assert.equal(report.cleanup.allHandlesClosed, true);
      assert.match(report.failure, new RegExp(phase));
    }));
test('retains primary and teardown errors; does not claim failed native close succeeded', async () =>
  fixture(async (path) => {
    const lifecycle = campaignReport(path, { samples: [] });
    const resource = lifecycle.own(
      {
        isOpen: true,
        close() {
          throw new Error('native close failed');
        },
      },
      'fixture',
    );
    resource.pool = {
      async end() {
        throw new Error('pool end failed');
      },
    };
    lifecycle.fail(new Error('primary oracle failed'));
    await lifecycle.finish();
    const report = JSON.parse(readFileSync(path));
    assert.match(report.failure, /primary oracle failed/);
    assert.equal(report.cleanupErrors.length, 2);
    assert.match(report.cleanupErrors[0], /pool end failed/);
    assert.match(report.cleanupErrors[1], /native close failed/);
    assert.equal(report.cleanup.allHandlesClosed, false);
  }));
test('pool teardown failure still attempts native closure and discards closed handle references', async () =>
  fixture(async (path) => {
    const lifecycle = campaignReport(path, { samples: [] });
    const native = db();
    const resource = lifecycle.own(native, 'fixture');
    resource.pool = {
      async end() {
        throw new Error('pool end failed');
      },
    };
    assert.equal(await lifecycle.finish(), false);
    assert.equal(native.isOpen, false);
    assert.equal(resource.db, null);
    assert.equal(resource.pool, null);
    assert.equal(JSON.parse(readFileSync(path)).cleanup.allHandlesClosed, true);
  }));
for (const signal of ['SIGTERM', 'SIGINT'])
  test(`retains ${signal} and closes a handle despite a pending cleanup promise`, async () =>
    fixture(async (path, root) => {
      const script = join(root, 'signal.mjs');
      writeFileSync(
        script,
        `import {campaignReport} from ${JSON.stringify(new URL('./report.mjs', import.meta.url).href)};
      const run=campaignReport(process.argv[2],{samples:[{checkedResults:1,checkedRows:1}]});
      const resource=run.own({isOpen:true,close(){this.isOpen=false;}},'pending');
      resource.pool={end:()=>new Promise(()=>{})}; process.send('ready'); await run.close(resource);`,
      );
      const child = fork(script, [path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const exited = once(child, 'exit');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        await once(child, 'message');
        child.kill(signal);
        assert.deepEqual(await exited, [null, signal]);
        const report = JSON.parse(readFileSync(path));
        assert.equal(report.status, 'failed');
        assert.equal(report.interrupted, signal);
        assert.match(report.failure, /Campaign interrupted/);
        assert.equal(report.cleanup.allHandlesClosed, true);
        assert.equal(report.counts.fail, 1);
        assert.equal(report.counts.checkedRows, 1);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    }));
