/** Optional Node tooling for an explicitly scoped persistent local D1 binding. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { D1DatabaseBinding } from '../d1/types.js';
import { ValidationError } from '../errors.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import { assertD1Config, type D1ProjectConfig } from './d1-config.js';
import { isSymlinkRefusal, readNoFollow } from './no-follow.js';

export type { D1LocalConfig, D1ProjectConfig } from './d1-config.js';

export const D1_MARKER = '.turbine-d1.json';
const unresolved = new WeakSet<object>();
export function d1CleanupResolved(context: D1Context): boolean {
  return !unresolved.has(context);
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** A project path with no symbolic-link components, including a missing leaf. */
export function d1ProjectPath(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value))
    throw new ValidationError('D1 paths must be nonempty project paths.');
  const root = realpathSync(process.cwd());
  const path = resolve(root, value);
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ValidationError('D1 paths must be strictly within the project root.');
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (exists(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new ValidationError('D1 paths must not contain symbolic links.');
    if (cursor !== path && exists(cursor) && !lstatSync(cursor).isDirectory())
      throw new ValidationError('D1 path ancestors must be directories.');
  }
  return path;
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}
export function resolveD1Context(config: D1ProjectConfig) {
  assertD1Config(config);
  if (
    config.engine !== 'd1' ||
    config.url ||
    config.schema !== 'main' ||
    config.adapter !== undefined ||
    config.exactNativeIntegers ||
    config.schemaFileConfigured ||
    config.seedFile !== undefined
  )
    throw new ValidationError(
      'Local D1 requires engine d1, schema main, no URL, seed, adapter, schema file or exact-native-integer policy.',
    );
  const local = config.d1;
  if (
    !local ||
    typeof local !== 'object' ||
    Array.isArray(local) ||
    Reflect.ownKeys(local).some((key) => !['binding', 'databaseId', 'persist'].includes(String(key))) ||
    typeof local.binding !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(local.binding) ||
    typeof local.databaseId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(local.databaseId)
  )
    throw new ValidationError(
      'D1 requires d1: { binding, databaseId, persist } identifying one local persistent binding.',
    );
  const persist = d1ProjectPath(local.persist);
  const out = d1ProjectPath(config.out);
  const migrations = d1ProjectPath(config.migrationsDir);
  const configPath = join(realpathSync(process.cwd()), 'turbine.config.mjs');
  const paths = [persist, out, migrations, configPath];
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
      if (overlaps(paths[i]!, paths[j]!))
        throw new ValidationError('D1 persistence, output, migrations and config paths must be disjoint.');
  for (const path of [persist, migrations])
    if (exists(path) && !lstatSync(path).isDirectory())
      throw new ValidationError('D1 persistence and migration paths must be directories.');
  return { local: { ...local }, persist, out, migrations, planPath: join(migrations, 'plan.json'), configPath };
}
export type D1Context = ReturnType<typeof resolveD1Context>;
export function writeD1Marker(context: D1Context): void {
  const directory = join(context.persist, 'miniflare-D1DatabaseObject');
  const files = readdirSync(directory).filter((file) => /^[a-f0-9]{64}\.sqlite$/.test(file));
  if (files.length !== 1) throw new ValidationError('Expected exactly one new Miniflare D1 persistence file.');
  writeFileSync(
    join(context.persist, D1_MARKER),
    `${JSON.stringify({
      version: 1,
      runtime: 'miniflare@4.20260730.0',
      binding: context.local.binding,
      databaseId: context.local.databaseId,
      databaseFile: `miniflare-D1DatabaseObject/${files[0]}`,
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
export function requireD1State(context: D1Context): void {
  const marker = d1ProjectPath(join(context.persist, D1_MARKER));
  const uninitialized = () =>
    new ValidationError(
      'D1 persistent binding is uninitialized or its identity differs. Run init with a fresh persistence directory.',
    );
  // One descriptor for the checks and the read: a marker replaced after a
  // separate check, by a symlink or a hard link, is never the one read.
  let text: string;
  try {
    text = readNoFollow(marker, (state) => {
      if (!state.isFile() || state.nlink !== 1) throw uninitialized();
    }).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isSymlinkRefusal(error)) throw uninitialized();
    throw error;
  }
  const value = JSON.parse(text);
  if (
    value?.version !== 1 ||
    value.runtime !== 'miniflare@4.20260730.0' ||
    value.binding !== context.local.binding ||
    value.databaseId !== context.local.databaseId ||
    typeof value.databaseFile !== 'string' ||
    !/^miniflare-D1DatabaseObject\/[a-f0-9]{64}\.sqlite$/.test(value.databaseFile)
  )
    throw new ValidationError('D1 persistent binding marker identity or persistence version differs.');
  const database = d1ProjectPath(join(context.persist, value.databaseFile));
  if (!exists(database) || !lstatSync(database).isFile() || lstatSync(database).nlink !== 1)
    throw new ValidationError('D1 persistent database state is missing or aliased. Refusing to bootstrap it.');
  // Opening SQLite can write recovery/coordination files even for SELECT-only
  // status. Refuse aliases before workerd can open or truncate a caller file.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = d1ProjectPath(`${database}${suffix}`);
    if (exists(sidecar)) {
      const state = lstatSync(sidecar);
      if (!state.isFile() || state.nlink !== 1)
        throw new ValidationError('D1 persistent database sidecar is not a private regular file.');
    }
  }
}
interface LocalRuntime {
  ready: Promise<URL>;
  getD1Database(name: string): Promise<D1DatabaseBinding>;
  dispose(): Promise<void>;
}
type RuntimeConstructor = new (options: Record<string, unknown>) => LocalRuntime;
export async function loadD1Runtime(): Promise<RuntimeConstructor> {
  let module: unknown;
  const version = importOptionalPeer.peerPackageVersion('miniflare');
  if (version !== '4.20260730.0')
    throw new ValidationError(
      'Local D1 tooling requires optional miniflare@4.20260730.0. Install it in this project; no hosted fallback is used.',
    );
  try {
    module = await importOptionalPeer('miniflare');
  } catch (cause) {
    throw new ValidationError(
      'Local D1 tooling requires optional miniflare@4.20260730.0. Install it in this project; no hosted fallback is used.',
      { cause },
    );
  }
  const Runtime = (module as { Miniflare?: RuntimeConstructor }).Miniflare;
  if (typeof Runtime !== 'function') throw new ValidationError('Optional miniflare does not expose Miniflare.');
  // Miniflare's missing-binary spawn can emit an unhandled process error. Probe
  // the same real executable before init creates any scaffolding or state.
  try {
    const projectRequire = createRequire(join(process.cwd(), 'package.json'));
    const nativeRequire = createRequire(projectRequire.resolve('miniflare'));
    const executable = process.env.MINIFLARE_WORKERD_PATH ?? (nativeRequire('workerd') as { default: string }).default;
    const version = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!/^workerd \d{4}-\d{2}-\d{2}\b/.test(version)) throw new Error('Unexpected workerd executable.');
  } catch (cause) {
    throw new ValidationError(
      'Local D1 tooling requires a working Miniflare workerd executable; no state was opened.',
      { cause },
    );
  }
  return Runtime;
}
/** Own only this runtime and lock. Never close a caller-supplied database. */
export async function withLocalD1<T>(
  context: D1Context,
  run: (binding: D1DatabaseBinding) => Promise<T>,
  Constructor?: RuntimeConstructor,
): Promise<T> {
  if (!Constructor) requireD1State(context);
  const Runtime = Constructor ?? (await loadD1Runtime());
  // Optional runtime loading yields to other work. Revalidate before acquiring
  // the lock and starting workerd; there is no intervening asynchronous step.
  if (!Constructor) requireD1State(context);
  const lock = join(context.persist, '.turbine-d1.lock');
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch (cause) {
    throw new ValidationError(
      'Local D1 persistence is in use or has a stale lock. Verify its owner before removing the lock.',
      { cause },
    );
  }
  const identity = lstatSync(lock);
  let runtime: LocalRuntime | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= runtime
      ? Promise.resolve().then(() => runtime!.dispose())
      : Promise.reject(new Error('Local D1 startup returned no runtime handle; cleanup is unresolved.'));
    return disposal;
  };
  let failed = false;
  let primary: unknown;
  let result: T | undefined;
  const cleanupErrors: unknown[] = [];
  const stop = () => {
    const timer = setTimeout(() => process.exit(1), 5_000);
    timer.unref();
    void dispose().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.info(
      `Local D1 service: ${context.persist}; binding ${context.local.binding}=${context.local.databaseId}; 127.0.0.1:0 (allocated); inspector 127.0.0.1:0 (allocated).`,
    );
    unresolved.add(context);
    runtime = new Runtime({
      // Local D1 does not need Miniflare's automatic public Request.cf fetch.
      cf: false,
      modules: true,
      script: 'export default {fetch(){return new Response("local D1")}}',
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { [context.local.binding]: context.local.databaseId },
      d1Persist: context.persist,
      host: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
    });
    let binding: D1DatabaseBinding | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('Local D1 startup exceeded 30 seconds.')), 30_000);
      });
      const started = await Promise.race([
        runtime.ready.then(async (url) => ({ url, binding: await runtime!.getD1Database(context.local.binding) })),
        deadline,
      ]);
      binding = started.binding;
      console.info(`Local D1 ready: ${started.url.origin}`);
    } finally {
      clearTimeout(startupTimer);
    }
    result = await run(binding!);
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    let disposeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        disposeTimer = setTimeout(() => reject(new Error('Local D1 disposal exceeded 5 seconds.')), 5_000);
      });
      if (runtime) {
        await Promise.race([dispose(), deadline]);
        unresolved.delete(context);
      } else cleanupErrors.push(new Error('Local D1 startup returned no runtime handle; cleanup is unresolved.'));
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      clearTimeout(disposeTimer);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      try {
        if (d1CleanupResolved(context) && exists(lock)) {
          const actual = lstatSync(lock);
          if (actual.dev === identity.dev && actual.ino === identity.ino) unlinkSync(lock);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length && failed) {
      try {
        console.error(
          'Local D1 cleanup is unresolved; preserving the primary error, persistence and lock.',
          cleanupErrors,
        );
      } catch {}
    }
  }
  if (failed) throw primary;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'Local D1 cleanup failed. Completed dispatches are not rolled back.');
  return result as T;
}
