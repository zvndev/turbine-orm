// Owned command trees for the HTTP supervisor regressions, never adapter code.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { identity, OwnedChildren, persist } from './native-lifecycle.mjs';

const [role, root, mode] = process.argv.slice(2);
if (role === 'leaf') {
  process.on('SIGTERM', () => {});
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    persist(join(root, 'leaf.json'), { ...identity(process.pid), port: server.address().port });
    process.send('ready');
    process.disconnect();
  });
} else if (role === 'caller') {
  const report = { commands: [], caller: identity(process.pid) };
  const owner = new OwnedChildren({
    cwd: root,
    env: process.env,
    report,
    onChange() {
      persist(join(root, 'caller-stalled.json'), identity(process.pid));
      const until = Date.now() + 20_000;
      while (!existsSync(join(root, 'caller.release')) && Date.now() < until)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    },
  });
  const task = owner.run('cancelled-invocation', process.execPath, [import.meta.filename, 'parent', root, 'timeout'], {
    log: join(root, 'command.log'),
    timeout: 30_000,
  });
  // Deliberately no JS signal handler: the supervisor must survive invocation exit.
  await task;
  await owner.close();
} else {
  process.on('SIGTERM', () => {});
  const child = spawn(
    process.execPath,
    [import.meta.filename, role === 'parent' && mode === 'nested' ? 'middle' : 'leaf', root, mode],
    {
      detached: mode === 'nested',
      stdio: ['ignore', mode === 'pipes' ? 'inherit' : 'ignore', mode === 'pipes' ? 'inherit' : 'ignore', 'ipc'],
    },
  );
  await new Promise((resolve) => child.once('message', resolve));
  if (role === 'middle') {
    process.send('ready');
    process.disconnect();
  }
  if (mode !== 'timeout') {
    while (!existsSync(join(root, 'exit.release'))) await delay(5);
    writeFileSync(join(root, `${role}-exiting.json`), JSON.stringify(identity(process.pid)));
    process.exit(mode === 'failure' ? 7 : 0);
  }
}
