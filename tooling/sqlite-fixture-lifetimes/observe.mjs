/** Preload before fixtures; emergency cleanup never erases a lifetime violation. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

const directory = process.env.TURBINE_SQLITE_LIFETIME_REPORT;
if (!directory) throw new Error('Set TURBINE_SQLITE_LIFETIME_REPORT to an audit directory');
mkdirSync(directory, { recursive: true });
const report = {
  protocol: 1, pid: process.pid, ppid: process.ppid, argv: process.argv,
  execArgv: process.execArgv, execPath: process.execPath, cwd: process.cwd(),
  node: process.version, started: new Date().toISOString(), complete: false,
  supported: false, constructed: 0, opened: 0, observedClosed: 0, leaked: 0,
  cleanupClosed: 0, cleanupFailures: [], survivors: [], remaining: 0,
};
const path = join(resolve(directory), `${process.pid}.json`);
const save = () => writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
save();
let native;
try { native = createRequire(import.meta.url)('node:sqlite'); } catch (error) {
  if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
  report.unsupportedReason = error.message;
}
if (native) {
  report.supported = true;
  const Original = native.DatabaseSync;
  const close = Original.prototype.close;
  const prepare = Original.prototype.prepare;
  const handles = new Map();
  // Use captured native operations, independent of isOpen availability or fixture hooks.
  const isOpen = (db) => {
    try { Reflect.apply(prepare, db, ['SELECT 1']); return true; } catch (error) {
      if (error.code === 'ERR_INVALID_STATE' && /not open|closed/i.test(error.message)) return false;
      // A malformed file or busy catalog still owns an open native handle.
      if (error.code === 'ERR_SQLITE_ERROR') return true;
      throw error;
    }
  };
  Original.prototype.close = function (...args) {
    const result = Reflect.apply(close, this, args);
    const entry = handles.get(this);
    if (entry && !isOpen(this) && entry.open) {
      report.observedClosed++;
      entry.open = false;
    }
    return result;
  };
  if (Original.prototype.open) {
    const open = Original.prototype.open;
    Original.prototype.open = function (...args) {
      const result = Reflect.apply(open, this, args);
      const entry = handles.get(this);
      if (entry && !entry.open && isOpen(this)) { entry.open = true; report.opened++; }
      return result;
    };
  }
  native.DatabaseSync = new Proxy(Original, {
    construct(target, args, newTarget) {
      const db = Reflect.construct(target, args, newTarget);
      const open = isOpen(db);
      handles.set(db, { id: ++report.constructed, open, stack: new Error('SQLite fixture constructed').stack });
      if (open) report.opened++;
      return db;
    },
  });
  syncBuiltinESMExports();
  if ((await import('node:sqlite')).DatabaseSync !== native.DatabaseSync) {
    throw new Error('SQLite named exports were not instrumented');
  }
  process.on('exit', () => {
    report.primaryExitCode = process.exitCode ?? 0;
    for (const [db, entry] of handles) {
      try {
        if (!isOpen(db)) {
          if (entry.open) { report.observedClosed++; entry.open = false; }
          continue;
        }
        report.survivors.push({ id: entry.id, stack: entry.stack });
        report.leaked++;
        try {
          Reflect.apply(close, db, []);
          if (isOpen(db)) throw new Error('Native handle remained open after cleanup');
          report.cleanupClosed++;
        } catch (error) {
          report.cleanupFailures.push({ id: entry.id, code: error.code, message: error.message, stack: error.stack });
        }
        if (isOpen(db)) report.remaining++;
      } catch (error) {
        report.cleanupFailures.push({ id: entry.id, code: error.code, message: error.message, stack: error.stack });
      }
    }
    if (report.leaked || report.cleanupFailures.length) {
      console.error(`SQLite fixture lifetime violation: ${report.leaked} leaked, ${report.cleanupFailures.length} cleanup errors; ${path}`);
      if (!process.exitCode) process.exitCode = 1;
    }
  });
}
// Registered last so the final record includes the observer's cleanup results.
process.on('exit', () => { report.complete = true; report.finished = new Date().toISOString(); save(); });
