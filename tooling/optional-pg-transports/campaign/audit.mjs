#!/usr/bin/env node
// Independent, read-only ownership audit. Never signals a process.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { processIdentity, bounded } from '../lifecycle.mjs';
const [destination, ...inputs] = process.argv.slice(2);
assert.ok(destination && inputs.length, 'Usage: node audit.mjs OUTPUT_JSON REPORT_JSON...');
const evidence = { scope: 'independent audit of retained PID/starttime/group/path/port facts; no signals', reports: [] };
for (const input of inputs) {
  const report = JSON.parse(readFileSync(input));
  const audit = { report: resolve(input), success: report.success, signal: report.signal ?? null, rootAbsent: !existsSync(report.root), services: [], commands: [] };
  assert.equal(audit.rootAbsent, true);
  for (const record of [...report.commands, ...(report.lifecycle?.children ?? [])]) {
    const identities = [...(record.ownedProcesses ?? []), ...(record.supervisor ? [record.supervisor] : [])];
    const remaining = identities.filter((item) => processIdentity(item.pid)?.startTime === item.startTime);
    assert.deepEqual(remaining, []);
    audit.commands.push({ binary: record.binary, code: record.code, signal: record.signal, remainingIdentities: remaining, reaped: record.reaped });
    assert.equal(record.reaped, true);
    const groups = new Set(identities.map((item) => item.pgid ?? item.group).filter(Boolean));
    const remainingGroups = new Set();
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (groups.has(Number(fields[2]))) remainingGroups.add(Number(fields[2]));
      } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
    }
    assert.deepEqual([...remainingGroups], []); audit.commands.at(-1).remainingGroups = [];
  }
  for (const service of report.services) {
    assert.equal(service.auditComplete, true);
    const row = { engine: service.engine, port: service.port, retainedCleanup: true };
    if (service.engine === 'postgresql') {
      row.datadirAbsent = !existsSync(service.datadir); row.socketDirectoryAbsent = !existsSync(service.socket);
      assert.equal(row.datadirAbsent, true); assert.equal(row.socketDirectoryAbsent, true);
      row.remainingIdentities = service.ownedProcesses.filter((item) => processIdentity(item.pid)?.startTime === item.startTime);
      assert.deepEqual(row.remainingIdentities, []);
    }
    const probe = createServer();
    try {
      await bounded(new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(service.port, '127.0.0.1', resolve); }), 1500, 'Independent port bind');
      row.portReleased = true;
    } finally { if (probe.listening) await new Promise((resolve) => probe.close(resolve)); }
    audit.services.push(row);
  }
  evidence.reports.push(audit);
}
writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Independent cleanup audit passed: ${destination}`);
