/** Test-only native prerequisite and bounded owned runtime lifetime. Never imported by a Worker. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { D1DatabaseBinding } from '../../../d1/types.js';

export interface NativeRuntime {
  getD1Database(name: string): Promise<D1DatabaseBinding>;
  dispatchFetch(url: string): Promise<{ status: number; text(): Promise<string> }>;
  dispose(): Promise<void>;
}
export function nativeRuntime(script = 'export default {fetch(){return new Response("ready")}}'): NativeRuntime {
  const require = createRequire(import.meta.url);
  // Missing Miniflare is a hard failure. No node:sqlite substitution or mocks.
  const module = process.env.TURBINE_D1_MINIFLARE_MODULE ?? 'miniflare';
  const nativeRequire = createRequire(require.resolve(module));
  const executable = process.env.MINIFLARE_WORKERD_PATH ?? (nativeRequire('workerd') as { default: string }).default;
  assert.match(
    execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /^workerd \d{4}-\d{2}-\d{2}\b/,
  );
  const { Miniflare } = require(module);
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: `d1-introspection-${process.pid}-${randomUUID().slice(0, 8)}` },
    host: '127.0.0.1',
    port: 0,
    inspectorPort: 0,
  }) as NativeRuntime;
}
export async function withNative<T>(check: (db: D1DatabaseBinding) => Promise<T>): Promise<T> {
  const runtime = nativeRuntime();
  const stop = () => {
    const timer = setTimeout(() => process.exit(1), 5_000);
    timer.unref();
    void runtime.dispose().finally(() => process.exit(1));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await check(await runtime.getD1Database('DB'));
  } finally {
    try {
      await runtime.dispose();
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}
export async function executeDdl(binding: D1DatabaseBinding, sql: string): Promise<void> {
  // Fixture DDL contains no semicolons inside literals or comments.
  for (const statement of sql
    .replace(/^--.*$/gm, '')
    .split(';')
    .filter((part) => part.trim()))
    await binding.prepare(statement).all();
}
