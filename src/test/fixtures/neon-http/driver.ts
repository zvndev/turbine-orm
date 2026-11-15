import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { NeonHttpSql } from '../../../neon-http.js';

/** Real installed driver, optionally in an isolated prerequisite directory. */
export async function loadNeonDriver(): Promise<{
  neon: (url: string, options?: Record<string, unknown>) => NeonHttpSql;
  neonConfig: Record<string, unknown>;
}> {
  const path = process.env.NEON_HTTP_DRIVER_PATH;
  const require = createRequire(import.meta.url);
  const specifier = path ? pathToFileURL(path).href : pathToFileURL(require.resolve('@neondatabase/serverless')).href;
  return import(specifier);
}
