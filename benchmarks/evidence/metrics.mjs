import { readFileSync } from 'node:fs';

export function distribution(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid metric samples');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  const middle = sorted.length / 2;
  return {
    n: sorted.length, min: sorted[0], max: sorted.at(-1),
    median: Number.isInteger(middle) ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)],
    p90: percentile(0.9), p95: percentile(0.95), p99: percentile(0.99),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

// Only a same-user local server process may be sampled. No privileges needed.
export function serverResource(pid) {
  if (!Number.isInteger(pid) || pid < 1 || process.platform !== 'linux') return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== process.getuid()) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return {
      pid, userTicks: Number(stat[11]), systemTicks: Number(stat[12]),
      rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
    };
  } catch { return null; }
}

export async function measure(run, round, serverPid) {
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const resource = process.resourceUsage();
  const serverBefore = serverResource(serverPid);
  let peak = before.rss;
  const sampleMemory = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  const start = performance.now();
  const value = await run(round, sampleMemory);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  const endResource = process.resourceUsage();
  const serverAfter = serverResource(serverPid);
  return {
    value,
    sample: {
      round, wallMs, userCpuUs: used.user, systemCpuUs: used.system,
      rssBeforeBytes: before.rss, rssAfterBytes: after.rss, observedPeakRssBytes: Math.max(peak, after.rss),
      heapBeforeBytes: before.heapUsed, heapAfterBytes: after.heapUsed,
      processLifetimeMaxRssKiB: endResource.maxRSS,
      voluntaryContextSwitches: endResource.voluntaryContextSwitches - resource.voluntaryContextSwitches,
      involuntaryContextSwitches: endResource.involuntaryContextSwitches - resource.involuntaryContextSwitches,
      serverBefore, serverAfter,
    },
  };
}
