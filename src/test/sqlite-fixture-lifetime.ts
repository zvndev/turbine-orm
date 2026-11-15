/** Test-owned native handles outlive borrowed clients, but never their owning test/suite. */
import type { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';

type Cleanup = () => void | Promise<void>;
type Register = (cleanup: Cleanup) => void;

/** Call in a test body/helper; in beforeEach pass t.after.bind(t), in before use a suite scope. */
export function closeSqliteAfter<T extends DatabaseSync>(db: T, register: Register = after): T {
  const prepare = db.prepare.bind(db);
  const close = db.close.bind(db);
  register(() => {
    // Some ownership tests deliberately close the handle themselves. Node 22.5 has no isOpen getter.
    try {
      prepare('SELECT 1');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE' && /not open|closed/i.test(String(error)))
        return;
      // An open malformed/busy database still needs closing.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SQLITE_ERROR') throw error;
    }
    close();
  });
  return db;
}

/** Register at describe/module scope; pass client teardown here so a failure cannot skip native cleanup. */
export function sqliteFixtureScope(teardown?: Cleanup): Register {
  const cleanups: Cleanup[] = [];
  after(async () => {
    const errors: unknown[] = [];
    try {
      await teardown?.();
    } catch (error) {
      errors.push(error);
    }
    const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
    errors.push(...results.filter((result) => result.status === 'rejected').map((result) => result.reason));
    if (errors.length === 1) throw errors[0];
    if (errors.length) {
      throw new AggregateError(
        errors,
        `SQLite fixture cleanup failed: ${errors.map((error) => String(error)).join('; ')}`,
        { cause: errors[0] },
      );
    }
  });
  return (cleanup) => {
    cleanups.push(cleanup);
  };
}

/** Demo contexts expose a pool that owns its native handle. Keep that ownership seam. */
export function closeSqliteContextAfter<T extends { pool: { end(): Promise<void> } }>(context: T): T {
  after(() => context.pool.end());
  return context;
}
