import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupAlive, portOpen } from './native.mjs';
export async function audit(root) {
  const result = [];
  for (const mode of ['default', 'ansi-no-backslash']) {
    const path = join(root, mode, 'identity.json');
    if (!existsSync(path)) continue;
    const identity = JSON.parse(readFileSync(path, 'utf8'));
    const state = {
      mode,
      status: identity.status,
      groups: {},
      portClosed: !identity.port || !(await portOpen(identity.port)),
      storageAbsent: [
        identity.data,
        identity.socket,
        `${identity.socket}.lock`,
        join(identity.root, 'mysqld.pid'),
      ].every((p) => !existsSync(p)),
    };
    for (const key of ['initializationPid', 'pid', 'childPid']) {
      const pid = identity[key];
      state.groups[key] = !groupAlive(pid);
      if (pid)
        assert.throws(
          () => process.kill(pid, 0),
          (error) => error.code === 'ESRCH',
          `owned PID ${pid} remains`,
        );
    }
    for (const record of identity.children ?? []) {
      state.groups[`runtime-${record.pid}`] = !groupAlive(record.pid);
      if (record.pid)
        assert.throws(
          () => process.kill(record.pid, 0),
          (error) => error.code === 'ESRCH',
          `owned runtime PID ${record.pid} remains`,
        );
    }
    assert.ok(
      state.portClosed && state.storageAbsent && Object.values(state.groups).every(Boolean),
      'independent owned-service cleanup audit',
    );
    const reports = readdirSync(root).filter((n) => n.startsWith(`${mode}-node`) && n.endsWith('.json'));
    state.applicationReports = reports.map((name) => {
      const report = JSON.parse(readFileSync(join(root, name), 'utf8'));
      // Even failure reports must close application sessions and drop their fixture database,
      // unless prerequisite validation failed before either was created.
      if (report.server) {
        assert.ok(
          identity.children?.some((record) => record.pid === report.provenance.runtime.pid),
          'runtime PID is absent from the service child history',
        );
        assert.equal(report.databaseRemoved, true);
        assert.equal(report.applicationSessionsClosed, true);
      }
      return {
        name,
        status: report.status,
        databaseRemoved: report.databaseRemoved,
        applicationSessionsClosed: report.applicationSessionsClosed,
      };
    });
    result.push(state);
  }
  assert.ok(result.length, 'no owned-service identities found');
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await audit(process.argv[2]), null, 2));
