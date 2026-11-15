import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

/** Own native handles from construction onward; preserve primary and cleanup failures separately. */
export function campaignReport(path, initial) {
  const report = {
    ...initial,
    runId: randomUUID(),
    pid: process.pid,
    status: 'running',
    cleanupErrors: [],
    handles: [],
  };
  const owned = [];
  const fail = (error) => {
    report.failure ??= String(error?.stack ?? error);
    report.status = 'failed';
  };
  const save = () => {
    report.cleanup = {
      allHandlesClosed: owned.every((x) => x.record.closed),
      servicesStarted: 0,
      filesCreatedByFixtures: 0,
    };
    const samples = report.samples ?? [];
    report.counts = {
      samples: samples.length,
      checkedResults: samples.reduce((n, s) => n + s.checkedResults, 0),
      checkedRows: samples.reduce((n, s) => n + s.checkedRows, 0),
      fail: report.status === 'failed' ? 1 : 0,
      skip: 0,
    };
    const temporary = `${path}.${process.pid}.${report.runId}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(temporary, path);
  };
  const closeNative = (resource) => {
    if (resource.record.closed) return;
    try {
      if (resource.db.isOpen !== false) resource.db.close();
      if (resource.db.isOpen !== false) throw new Error('Native handle closure was not observed');
      resource.record.closed = true;
      resource.db = null;
      resource.pool = null;
    } catch (error) {
      report.cleanupErrors.push(`${resource.record.label}: ${error?.stack ?? error}`);
    }
  };
  const close = async (resource) => {
    if (resource.record.closed) return;
    let timeout;
    try {
      await Promise.race([
        resource.pool?.end(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Pool cleanup deadline exceeded')), 5000);
        }),
      ]);
    } catch (error) {
      report.cleanupErrors.push(`${resource.record.label}: ${error?.stack ?? error}`);
    } finally {
      clearTimeout(timeout);
    }
    closeNative(resource);
  };
  const signal = (name) => {
    report.interrupted = name;
    fail(new Error(`Campaign interrupted: ${name}`));
    // A pending pool promise must not prevent a failed report or native close.
    for (const resource of owned) closeNative(resource);
    report.finishedAt = new Date().toISOString();
    save();
    dispose();
    process.kill(process.pid, name);
  };
  const term = () => signal('SIGTERM'),
    int = () => signal('SIGINT');
  const dispose = () => {
    process.off('SIGTERM', term);
    process.off('SIGINT', int);
  };
  save(); // A rerun can never leave its predecessor's successful record in place.
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  return {
    report,
    save,
    fail,
    close,
    async closeLast() {
      if (owned.length) await close(owned[owned.length - 1]);
    },
    own(db, label) {
      const resource = { db, record: { label, closed: false } };
      owned.push(resource);
      report.handles.push(resource.record);
      return resource;
    },
    async finish() {
      for (const resource of owned) await close(resource);
      report.status =
        report.failure || report.interrupted || report.cleanupErrors.length ? 'failed' : 'passed';
      report.finishedAt = new Date().toISOString();
      try {
        save();
      } finally {
        dispose();
      }
      return report.status === 'passed';
    },
  };
}
