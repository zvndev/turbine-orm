/** A release failure at the sequential pipeline deadline must stay inside the promise. Fails until fixed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

for (const transactional of [true, false]) {
  it(`preserves the sequential deadline when release throws (transactional: ${transactional})`, () => {
    // A subprocess makes an uncaught exception from the timer observable
    // without taking down this test runner or another test's in-flight work.
    const source = `
      import { executePipeline } from ${JSON.stringify(new URL('../pipeline.ts', import.meta.url).href)};
      let releases = 0;
      let settles = 0;
      const sent = [];
      const client = {
        async query(text) {
          sent.push(text);
          if (text === 'SELECT 1') await new Promise(resolve => setTimeout(resolve, 80));
          return { rows: [{ n: 1 }], rowCount: 1, fields: [], command: 'SELECT' };
        },
        release() { releases++; throw new Error('release failed'); },
      };
      const error = await executePipeline({ connect: async () => client }, [
        { sql: 'SELECT 1', params: [], tag: 'slow', transform: r => r.rows },
        { sql: 'SELECT 2', params: [], tag: 'later', transform: r => r.rows },
      ], { transactional: ${transactional}, timeout: 20 }).then(
        () => { settles++; return undefined; },
        error => { settles++; return error; },
      );
      await new Promise(resolve => setTimeout(resolve, 120));
      console.log(JSON.stringify({ code: error?.code, outcome: error?.outcome, releases, settles, sent }));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(child.status, 0, `the deadline must reject its promise, not crash the process: ${child.stderr}`);
    assert.deepEqual(JSON.parse(child.stdout.trim()), {
      code: 'TURBINE_E002',
      outcome: 'unknown',
      releases: 1,
      settles: 1,
      sent: transactional ? ['BEGIN', 'SELECT 1'] : ['SELECT 1'],
    });
  });
}
