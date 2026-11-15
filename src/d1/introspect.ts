/** Optional native Cloudflare D1 main catalog entry; caller owns the binding. */
import { nullRecord } from '../catalog-metadata.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { TurbineLogger } from '../logger.js';
import type { SchemaMetadata } from '../schema.js';
import { collectD1Catalog } from './catalog.js';
import { d1CatalogMetadata } from './catalog-metadata.js';
import type { D1DatabaseBinding } from './types.js';

export interface D1IntrospectOptions {
  /** Exact names; empty/undefined includes all eligible main base tables. */
  include?: string[];
  exclude?: string[];
  keepColumnNames?: boolean;
  relationNames?: Record<string, Record<string, string>>;
  legacyToManyUniques?: boolean;
  logger?: TurbineLogger;
  schema?: 'main';
  includeViews?: false;
}

const keys = new Set([
  'include',
  'exclude',
  'keepColumnNames',
  'relationNames',
  'legacyToManyUniques',
  'logger',
  'schema',
  'includeViews',
]);
function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function validatedOptions(input: D1IntrospectOptions): D1IntrospectOptions {
  if (!record(input)) throw new ValidationError('D1 introspection options must be a plain object.');
  for (const key of Reflect.ownKeys(input))
    if (typeof key !== 'string' || !keys.has(key))
      throw new UnsupportedFeatureError(String(key), 'd1', 'Only main base-table catalog options are implemented.');
  const options = { ...input };
  if (
    (options.schema !== undefined && options.schema !== 'main') ||
    (options.includeViews !== undefined && options.includeViews !== false)
  )
    throw new UnsupportedFeatureError('Non-main or view introspection', 'd1', 'Only main base tables are implemented.');
  for (const key of ['keepColumnNames', 'legacyToManyUniques'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw new ValidationError(`D1 introspection ${key} must be boolean.`);
  for (const key of ['include', 'exclude'] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (!Array.isArray(value) || value.some((name) => typeof name !== 'string'))
        throw new ValidationError(`D1 introspection ${key} must be an array of exact table names.`);
      options[key] = [...value];
    }
  }
  if (
    options.logger !== undefined &&
    (!record(options.logger) ||
      Object.entries(options.logger).some(
        ([key, value]) => !['debug', 'info', 'warn', 'error'].includes(key) || typeof value !== 'function',
      ))
  )
    throw new ValidationError('D1 introspection logger accepts only debug/info/warn/error methods.');
  if (options.relationNames !== undefined) {
    if (!record(options.relationNames))
      throw new ValidationError('D1 relationNames must be a record of rename records.');
    const renames = nullRecord<Record<string, string>>();
    for (const [table, mapping] of Object.entries(options.relationNames)) {
      if (!record(mapping) || Object.values(mapping).some((value) => typeof value !== 'string'))
        throw new ValidationError('D1 relationNames must map relation names to strings.');
      renames[table] = Object.assign(nullRecord<string>(), mapping);
    }
    options.relationNames = renames;
  }
  return options;
}

/**
 * Read a real caller-owned D1Database binding into the existing SchemaMetadata.
 * Discovery plus a manifest-validated native atomic catalog batch, never an
 * interactive transaction. Errors propagate; the binding is never closed.
 * Unknown/unsupported options refuse before the first prepare call.
 */
export async function introspectD1(
  binding: D1DatabaseBinding,
  options: D1IntrospectOptions = {},
): Promise<SchemaMetadata> {
  const captured = validatedOptions(options);
  if (!binding || typeof binding.prepare !== 'function' || typeof binding.batch !== 'function')
    throw new ValidationError('introspectD1 requires a supplied Worker D1Database binding with prepare() and batch().');
  return d1CatalogMetadata(await collectD1Catalog(binding), captured);
}
