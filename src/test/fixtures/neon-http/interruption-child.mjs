// Deliberately stubborn copied-fixture control; never loaded by production or ordinary native suites.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { checkpoint, identity } from './native-lifecycle.mjs';

if (process.env.NEON_HTTP_TEST_PARENT_GRACEFUL !== '1') process.on('SIGTERM', () => {});
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
  process.on('SIGTERM', () => {});
  process.send('ready');
  setInterval(() => {}, 1000);
`,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
);
const exited = once(child, 'close');
await once(child, 'message');
// This parent stays alive to reap the leaf, even when the leaf requires SIGKILL.
void exited.then(() => {});
await checkpoint('stubborn-child', { child: identity(child.pid) });
setInterval(() => {}, 1000);
