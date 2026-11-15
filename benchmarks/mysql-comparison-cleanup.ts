import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';

/** /proc identity used only to audit and signal this invocation's detached groups. */
export function mysqlProcessSnapshot(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return {
      pid,
      ppid: Number(fields[1]),
      group: Number(fields[2]),
      starttime: fields[19]!,
      uid: statSync(`/proc/${pid}`).uid,
      command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
    };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
export function auditMysqlProcesses(owned: NonNullable<ReturnType<typeof mysqlProcessSnapshot>>[], data: string) {
  const all = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      const record = mysqlProcessSnapshot(Number(name));
      return record ? [record] : [];
    });
  const remaining = all.filter(
    (record) =>
      owned.some((p) => (record.pid === p.pid && record.starttime === p.starttime) || record.group === p.group) ||
      record.command.includes(`--datadir=${data}`),
  );
  return {
    method: 'independent /proc scan by PID/starttime, detached process group and exact datadir argument',
    checkedAt: new Date().toISOString(),
    owned,
    data,
    remaining,
  };
}

/** Pool end can precede the server consuming COM_QUIT. Require observed native closure. */
export async function settleMysqlArmBackends<T>(
  read: () => Promise<T[]>,
  observe: (remaining: T[]) => void,
  timeoutMs = 2000,
): Promise<void> {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 2000);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = await read();
    observe(remaining);
    if (remaining.length === 0) return;
    assert.ok(performance.now() < deadline, 'owned arm backend remained after pool close');
    await setTimeout(Math.min(10, Math.max(0, deadline - performance.now())));
  }
}
