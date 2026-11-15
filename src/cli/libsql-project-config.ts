/** Effect-free option validation shared by project configuration and seed helpers. */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ValidationError } from '../errors.js';
import { localUrl } from '../libsql/pool.js';

const configKeys = new Set([
  'engine',
  'url',
  'out',
  'schema',
  'include',
  'exclude',
  'relationNames',
  'columnTypes',
  'importExtension',
  'keepColumnNames',
  'exactNativeIntegers',
  'legacyToManyUniques',
  'migrationsDir',
  'seedFile',
  'seed',
  'schemaFile',
  'schemaFileConfigured',
  'adapter',
]);
/**
 * Unknown settings must not disappear while resolving a local-only project. A
 * key whose value is undefined is not a setting: a resolved config carries
 * every optional key, set or not.
 */
export function assertLibsqlProjectConfigOptions(config: object): void {
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && !configKeys.has(key)) {
      throw new ValidationError(`Unsupported local libSQL option: ${key}.`);
    }
  }
}

/** Validate without opening a driver. Project commands must survive process exit. */
export function libsqlProjectUrl(url: string, cwd = process.cwd()): { url: string; databasePath: string } {
  localUrl(url);
  if (url === ':memory:') throw new ValidationError('libSQL project commands require a persistent local file: URL.');
  let databasePath: string;
  try {
    databasePath = url.startsWith('file://') ? fileURLToPath(url) : decodeURIComponent(url.slice(5));
  } catch {
    throw new ValidationError('Invalid local libSQL file: URL.');
  }
  // file::memory: is also ephemeral in the native driver. Do not reinterpret it.
  if (!databasePath.trim() || /[\0?#]/.test(databasePath) || /(?:^|[/\\]):memory:(?:$|[/\\])/i.test(databasePath))
    throw new ValidationError('libSQL project commands require a persistent local file: URL without options.');
  databasePath = resolve(cwd, databasePath);
  return { databasePath, url: pathToFileURL(databasePath).href };
}
