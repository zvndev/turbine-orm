/** Small shared helpers: stable serialization, error classification, client setup. */

import { TurbineClient, type TurbineConfig } from '../../client.js';
import { TurbineError } from '../../errors.js';
import { introspect } from '../../introspect.js';
import type { SchemaMetadata } from '../../schema.js';

/**
 * Serialize a value so two JS values compare equal iff they are the same value
 * for the purposes of a database read: Dates by instant (Invalid Date is its own
 * token), bigints and non-finite numbers tagged, Buffers by hex, `-0` distinct.
 */
export function stable(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    // JSON.stringify applies toJSON before the replacer, so read the original value.
    const original = this[key];
    if (typeof original === 'bigint') return `bigint:${original}`;
    if (original instanceof Date)
      return `date:${Number.isNaN(original.getTime()) ? 'INVALID' : original.toISOString()}`;
    if (Buffer.isBuffer(original)) return `buf:${original.toString('hex')}`;
    if (typeof original === 'number') {
      if (Number.isNaN(original)) return 'num:NaN';
      if (original === Infinity) return 'num:Infinity';
      if (original === -Infinity) return 'num:-Infinity';
      if (Object.is(original, -0)) return 'num:-0';
    }
    return v;
  });
}

/** JSON for failure messages: `undefined` object values stay visible instead of vanishing. */
export function show(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    const original = this[key];
    if (original === undefined) return '<undefined>';
    if (typeof original === 'bigint') return `${original}n`;
    if (original instanceof Date)
      return `Date(${Number.isNaN(original.getTime()) ? 'INVALID' : original.toISOString()})`;
    if (Buffer.isBuffer(original)) return `Buffer(${original.toString('hex')})`;
    if (typeof original === 'function') return '<function>';
    if (typeof original === 'symbol') return original.toString();
    if (typeof original === 'number' && !Number.isFinite(original)) return `<${original}>`;
    return v;
  });
}

export function isTurbineError(err: unknown): err is TurbineError {
  return err instanceof TurbineError;
}

/** "ValidationError TURBINE_E003: message" for typed errors, "TypeError: message" otherwise. */
export function describeError(err: unknown): string {
  if (err instanceof TurbineError) return `${err.constructor.name} ${err.code}: ${firstLine(err.message)}`;
  if (err instanceof Error) return `${err.constructor.name}: ${firstLine(err.message)}`;
  return `non-error thrown: ${String(err)}`;
}

function firstLine(message: string): string {
  const line = message.split('\n')[0] ?? '';
  return line.length > 220 ? `${line.slice(0, 220)}...` : line;
}

/** Run `fn`, returning its value or the thrown error. Never throws. */
export async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Introspect only the named tables, so a shared database's other tables are not pulled in. */
export function introspectTables(
  url: string,
  tables: string[],
  relationNames?: Record<string, Record<string, string>>,
): Promise<SchemaMetadata> {
  return introspect({ connectionString: url, include: tables, ...(relationNames ? { relationNames } : {}) });
}

// biome-ignore lint/suspicious/noExplicitAny: the oracle lane drives tables by name, with no generated types
export type AnyTable = any;

export interface OracleClient extends TurbineClient {
  /** The table accessor for `name` (the real table name, not the camelCase property). */
  t(name: string): AnyTable;
}

export function makeClient(url: string, schema: SchemaMetadata, config: Partial<TurbineConfig> = {}): OracleClient {
  const client = new TurbineClient(
    {
      connectionString: url,
      poolSize: 4,
      warnOnUnlimited: false,
      temporalInfinity: 'preserve',
      ...config,
    },
    schema,
  ) as OracleClient;
  client.t = (name: string) => client.table(name) as AnyTable;
  return client;
}
