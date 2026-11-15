/** Best-effort observations, never an attribution of shared-host load to this child. */
import { readFile } from 'node:fs/promises';
import { freemem, loadavg, totalmem } from 'node:os';

async function procFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function hostSnapshot() {
  const [memory, cpuPressure, memoryPressure] = await Promise.all([
    procFile('/proc/meminfo'),
    procFile('/proc/pressure/cpu'),
    procFile('/proc/pressure/memory'),
  ]);
  const available = memory?.match(/^MemAvailable:\s+(\d+) kB$/m);
  return {
    at: new Date().toISOString(),
    loadAverage: loadavg(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    availableMemoryBytes: available ? Number(available[1]) * 1024 : null,
    cpuPressure,
    memoryPressure,
    scope: 'Shared host observations; other workloads, caches and scheduling are uncontrolled',
  };
}

export async function childMemory(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  const status = await procFile(`/proc/${pid}/status`);
  const rss = status?.match(/^VmRSS:\s+(\d+) kB$/m);
  const highWater = status?.match(/^VmHWM:\s+(\d+) kB$/m);
  return rss && highWater ? { rssBytes: Number(rss[1]) * 1024, highWaterBytes: Number(highWater[1]) * 1024 } : null;
}
