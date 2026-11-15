// Faults are fixtures only: resist SIGTERM and inherit the command output pipes.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.argv[2] === 'descendant') {
  process.on('SIGTERM', () => {});
  writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, parent: process.ppid }));
} else {
  process.on('SIGTERM', () => {});
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', process.argv[2]], { stdio: 'inherit' });
}
setInterval(() => {}, 1000);
