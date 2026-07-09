import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TurbineClient } from './client.js';
import { ConnectionError } from './errors.js';
import type { SchemaMetadata } from './schema.js';

export type SeedFunction = (db: TurbineClient) => Promise<void> | void;
export type DefinedSeed = () => Promise<void>;

const emptySchema: SchemaMetadata = { tables: {}, enums: {} };

function entryUrl(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  try {
    return pathToFileURL(realpathSync(entry)).href;
  } catch {
    return pathToFileURL(resolve(entry)).href;
  }
}

function callerUrl(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;

  for (const line of stack.split('\n').slice(2)) {
    const fileUrl = line.match(/(file:\/\/\/[^):]+):\d+:\d+/)?.[1];
    if (fileUrl && !fileUrl.endsWith('/seed.ts') && !fileUrl.endsWith('/seed.js')) return fileUrl;

    const filePath = line.match(/\(?((?:\/|[A-Za-z]:\\)[^):]+):\d+:\d+\)?/)?.[1];
    if (filePath && !filePath.endsWith('/src/seed.ts') && !filePath.endsWith('\\src\\seed.ts')) {
      return pathToFileURL(resolve(filePath)).href;
    }
  }

  return null;
}

function isDirectSeedModule(): boolean {
  const entry = entryUrl();
  const caller = callerUrl();
  return process.env.NODE_TEST_CONTEXT === undefined && !!entry && !!caller && entry === caller;
}

async function runSeed(fn: SeedFunction): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConnectionError('[turbine] DATABASE_URL is required to run this seed.');
  }

  const db = new TurbineClient({ connectionString }, emptySchema);
  try {
    await fn(db);
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
