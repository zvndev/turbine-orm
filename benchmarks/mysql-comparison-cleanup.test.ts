import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditMysqlProcesses, mysqlProcessSnapshot, settleMysqlArmBackends } from './mysql-comparison-cleanup.js';

test('independent cleanup audit retains PID/starttime/group identity and finds the current process', () => {
  const identity = mysqlProcessSnapshot(process.pid)!;
  assert.equal(identity.pid, process.pid);
  assert.equal(identity.uid, process.getuid?.());
  assert.match(identity.starttime, /^\d+$/);
  const audit = auditMysqlProcesses([identity], '/unallocated-mysql-comparison-datadir');
  assert.ok(audit.remaining.some((p) => p.pid === process.pid && p.starttime === identity.starttime));
  assert.deepEqual(auditMysqlProcesses([], '/unallocated-mysql-comparison-datadir').remaining, []);
  assert.equal(mysqlProcessSnapshot(1073741824), null);
});

test('records server-visible sessions until native closure is observed', async () => {
  const snapshots: number[][] = [];
  let reads = 0;
  await settleMysqlArmBackends(
    async () => (++reads === 1 ? [41, 42] : []),
    (rows) => snapshots.push(rows),
  );
  assert.equal(reads, 2);
  assert.deepEqual(snapshots, [[41, 42], []]);
});

test('refuses a persistent backend and preserves the failed observation', async () => {
  const snapshots: number[][] = [];
  await assert.rejects(
    settleMysqlArmBackends(
      async () => [99],
      (rows) => snapshots.push(rows),
      0,
    ),
    /owned arm backend remained after pool close/,
  );
  assert.deepEqual(snapshots, [[99]]);
});

test('accepts immediate closure and propagates native observation errors', async () => {
  let reads = 0;
  await settleMysqlArmBackends(
    async () => {
      reads++;
      return [];
    },
    () => {},
    0,
  );
  assert.equal(reads, 1);
  const failure = new Error('native catalog unavailable');
  await assert.rejects(
    settleMysqlArmBackends(
      async () => {
        throw failure;
      },
      () => {},
    ),
    (error) => error === failure,
  );
});
