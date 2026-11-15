// Executable control only: deliver a real signal while the owned server is
// shutting down. Never replaces a signal handler or changes the native helper.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.MYSQL_STREAM_LATE_SIGNAL_OUTPUT;
if (!root) throw new Error('late-signal control output required');
const kill = process.kill.bind(process);
let delivered = false;
process.kill = function (pid, signal) {
  const value = kill(pid, signal),
    path = join(root, 'default/identity.json');
  if (!delivered && signal === 'SIGTERM' && existsSync(path)) {
    const identity = JSON.parse(readFileSync(path));
    if (pid === -identity.pid) {
      delivered = true;
      writeFileSync(
        join(root, 'late-delivery.json'),
        JSON.stringify({
          delivered: true,
          controller: process.pid,
          server: identity.pid,
          phase: 'server-shutdown',
        }) + '\n',
      );
      kill(process.pid, 'SIGTERM');
    }
  }
  return value;
};
