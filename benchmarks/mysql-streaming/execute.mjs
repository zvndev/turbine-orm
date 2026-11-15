import assert from 'node:assert/strict';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groupAlive, ownedProcess, stopOwned } from '../mysql-preparation/native.mjs';
// Independent controller session queries after the worker exits. It observes effects
// and sessions rather than relying on the worker's cleanup booleans.
export async function execute({ node, path, config, identity, identityPath, observer, fault, onChild }) {
  const args = ['--import', 'tsx', fileURLToPath(new URL('./worker.mjs', import.meta.url)), path, config.id];
  const child = ownedProcess(node, args, {
    env: {
      ...process.env,
      MYSQL_STREAM_IDENTITY: identityPath,
      ...(fault ? { MYSQL_STREAM_FAULT: fault } : {}),
    },
  });
  onChild(child);
  const record = { pid: child.process.pid, node, args, output: path, fault: fault ?? null };
  identity.children.push(record);
  const save = () => writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  save();
  const log = createWriteStream(path + '.log');
  child.process.stdout.pipe(log, { end: false });
  child.process.stderr.pipe(log, { end: false });
  let force;
  const timeout = setTimeout(() => {
    record.timedOut = true;
    if (groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGTERM');
    force = setTimeout(() => {
      if (groupAlive(child.process.pid)) process.kill(-child.process.pid, 'SIGKILL');
    }, 3000);
  }, 30000);
  try {
    await child.done;
    record.exit = child.exit;
    if (child.error) throw child.error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
    await stopOwned(child);
    record.groupAbsent = !groupAlive(child.process.pid);
    onChild(null);
    await new Promise((r) => log.end(r));
    save();
  }
  const sample = JSON.parse(readFileSync(path));
  const [sessions] = await observer.query('SHOW PROCESSLIST');
  const remainingSessions = sessions.filter((r) => sample.sessionIds.includes(r.Id)).map((r) => r.Id);
  const [databases] = await observer.execute(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
    [sample.database],
  );
  const cleanup = {
    workerPid: child.process.pid,
    database: sample.database,
    sessionIds: sample.sessionIds,
    remainingSessions,
    remainingDatabases: databases.length,
  };
  assert.deepEqual(remainingSessions, [], 'independent controller: worker sessions remain');
  assert.equal(databases.length, 0, 'independent controller: database remains');
  return { sample, exit: record.exit, cleanup };
}
