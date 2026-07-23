import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TurbineClient } from './client.js';
import { ConnectionError } from './errors.js';
import type { SchemaMetadata } from './schema.js';

export type SeedFunction = (db: TurbineClient) => Promise<void> | void;
export type DefinedSeed = () => Promise<void>;

const emptySchema: SchemaMetadata = { tables: {}, enums: {} };

/**
 * Extract the filesystem path from a single V8 stack-trace line, regardless of
 * whether the frame is a `file://` URL (ESM), a bare absolute path (CJS / tsx),
 * or a wrapped `(… )` location. The trailing `:line:col` (and any surrounding
 * parens) are peeled from the END so a Windows drive colon or a URL scheme colon
 * inside the path never confuses the match. Non-file frames (`node:internal/…`,
 * `<anonymous>`) return null.
 *
 * Exported for unit testing the frame parser in isolation.
 */
export function parseStackFramePath(line: string): string | null {
  // Peel the trailing `:line:col` (with any closing paren) from the END so a
  // Windows drive colon or a `file://` scheme colon earlier in the path is never
  // mistaken for the location separator.
  const loc = line.match(/:(\d+):(\d+)\)?\s*$/);
  if (!loc || loc.index === undefined) return null;

  let head = line.slice(0, loc.index);
  const paren = head.lastIndexOf('(');
  if (paren !== -1) {
    // `at fn (PATH:line:col)`: the path is whatever the last "(" wraps.
    head = head.slice(paren + 1);
  } else {
    // `at PATH:line:col`: drop the leading "    at " prefix.
    head = head.replace(/^\s*at\s+/, '');
  }
  head = head.trim();

  if (head.startsWith('file://')) {
    try {
      return fileURLToPath(head);
    } catch {
      return null;
    }
  }
  // Accept only absolute filesystem paths (POSIX `/…` or Windows `C:\…` / `C:/…`).
  if (/^(\/|[A-Za-z]:[\\/])/.test(head)) return head;
  return null;
}

/** Best-effort canonicalization so two spellings of the same file compare equal. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The canonical path of THIS module's own file, captured once at load time from
 * a fresh stack. It is used to skip the library's own frames when locating the
 * caller. This is robust to the src (`seed.ts`) vs published dist (`seed.js`)
 * basename difference AND to the fact that the user's own file is ALSO named
 * `seed.ts`, which a basename skip-list would wrongly exclude. This fixes the
 * silent no-op: previously the plain-path skip-list only knew `src/seed.ts`, so
 * the library's own `dist/seed.js` frame (or a tsx plain-path frame) was
 * mistaken for the caller and the entry===caller self-run check never passed.
 */
const SELF_PATH: string | null = (() => {
  const stack = new Error().stack;
  if (!stack) return null;
  // Frame [1] (after the "Error" header) is this IIFE, i.e. the current module.
  for (const line of stack.split('\n').slice(1)) {
    const p = parseStackFramePath(line);
    if (p) return canonicalPath(p);
  }
  return null;
})();

function entryUrl(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  return pathToFileURL(canonicalPath(entry)).href;
}

/**
 * The first stack frame that is NOT part of this module, expressed as a
 * canonical `file://` URL. That frame is whoever invoked `defineSeed`: the
 * user's seed module when the file is run directly.
 */
function callerUrl(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;

  for (const line of stack.split('\n').slice(2)) {
    const p = parseStackFramePath(line);
    if (!p) continue;
    const canonical = canonicalPath(p);
    if (SELF_PATH && canonical === SELF_PATH) continue; // skip the library's own frames
    return pathToFileURL(canonical).href;
  }

  return null;
}

function isDirectSeedModule(): boolean {
  const entry = entryUrl();
  const caller = callerUrl();
  return process.env.NODE_TEST_CONTEXT === undefined && !!entry && !!caller && entry === caller;
}

/**
 * Signal, to a parent `turbine seed` process, that a defineSeed callback
 * actually executed to completion. The CLI sets `TURBINE_SEED_SENTINEL` to a
 * temp path before spawning the seed; if the file never appears the CLI knows
 * the seed module loaded but no callback ran, and reports that as a failure
 * instead of a false "Seed completed".
 */
function markSeedRan(): void {
  const sentinel = process.env.TURBINE_SEED_SENTINEL;
  if (!sentinel) return;
  try {
    writeFileSync(sentinel, 'ran');
  } catch {
    // Best-effort only: an unwritable sentinel must never fail a good seed run.
  }
}

async function runSeed(fn: SeedFunction): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConnectionError('[turbine] DATABASE_URL is required to run this seed.');
  }

  const db = new TurbineClient({ connectionString }, emptySchema);
  try {
    await fn(db);
    markSeedRan();
  } finally {
    await db.disconnect();
  }
}

export function defineSeed(fn: SeedFunction): DefinedSeed {
  const run = () => runSeed(fn);

  if (isDirectSeedModule()) {
    queueMicrotask(() => {
      run().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exitCode = 1;
      });
    });
  }

  return run;
}
