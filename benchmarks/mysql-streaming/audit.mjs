// A separate invocation probes actual OS/network state, never trusts cleanup booleans.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupAlive, portOpen } from '../mysql-preparation/native.mjs';
export async function audit(root) {
  const results = [];
  for (const mode of ['default', 'ansi-no-backslash']) {
    const path = join(root, mode, 'identity.json');
    if (!existsSync(path)) continue;
    const i = JSON.parse(readFileSync(path));
    const pids = [i.initializationPid, i.pid, ...i.children.map((c) => c.pid)].filter(Boolean);
    const processes = pids.map((pid) => {
      let absent = false;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
        absent = true;
      }
      return { pid, absent, groupAbsent: !groupAlive(pid) };
    });
    const storageAbsent = [i.data, i.socket, i.socket + '.lock', join(i.root, 'mysqld.pid')].every(
      (p) => !existsSync(p),
    );
    const portClosed = !i.port || !(await portOpen(i.port));
    assert.ok(
      processes.every((p) => p.absent && p.groupAbsent) && storageAbsent && portClosed,
      'independent process/port/datadir/socket cleanup',
    );
    const reports = readdirSync(root)
      .filter((n) => n.startsWith(mode + '-node') && n.endsWith('.json'))
      .map((n) => {
        const r = JSON.parse(readFileSync(join(root, n)));
        if (r.database) {
          assert.equal(r.databaseRemoved, true);
        }
        return {
          file: n,
          status: r.status,
          databaseRemoved: r.databaseRemoved,
          applicationSessionsClosed: r.applicationSessionsClosed,
        };
      });
    results.push({ mode, processes, storageAbsent, portClosed, reports });
  }
  assert.ok(results.length, 'missing owned-service identities');
  return results;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await audit(process.argv[2]), null, 2));
