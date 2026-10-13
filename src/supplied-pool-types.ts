/**
 * turbine-orm, Turbine's column readings on a pool the caller supplied.
 *
 * Turbine reads `bigint` (int8) as a number and, under `utcTimestamps`, the
 * zone-less `timestamp` and `date` types (and their arrays) as UTC. On a pool
 * Turbine opens, those parsers are registered on the pg module. A pool the
 * caller supplies keeps the caller's parser table, so Turbine attaches its
 * parsers to each of its OWN queries instead: node-postgres reads a
 * query-level `types` in place of the connection's. The caller's own queries
 * on the same pool keep the caller's parsers.
 *
 * Everything Turbine does not govern is read from the table the query would
 * otherwise have used (the connection's, else the pool's `types` option, else
 * the driver's), so a parser the caller installed for another type still
 * applies to Turbine's reads.
 */

import pg from '#pg';
import type { PgCompatPool, PgCompatPoolClient } from './pg-types.js';
import {
  createFastTimestamptzParser,
  createPgArrayParser,
  createUtcDateParser,
  createUtcTimestampParser,
  isDefaultTextParser,
  markTurbineParser,
} from './query/utils.js';

/** Where node-postgres reads a parser from: `pg.types`, a pool's `types` option, a client's table. */
export interface TypeParserTable {
  getTypeParser(oid: number, format?: string): unknown;
}

type TextParser = (text: string) => unknown;
type Method = (...args: unknown[]) => unknown;

/** Same key `markTurbineParser` sets (`Symbol.for`, so ESM and CJS copies agree). */
const TURBINE_PARSER = Symbol.for('turbine.typeParser');
/** Reads the driver connection back out of a typed client (see {@link rawClientOf}). */
const RAW_CLIENT = Symbol.for('turbine.rawClient');

function isTurbineParser(parser: unknown): boolean {
  return typeof parser === 'function' && (parser as unknown as Record<symbol, unknown>)[TURBINE_PARSER] === true;
}

/** int8 as a number while the number is exact, else the driver's string. */
export const parseInt8: (text: string) => number | string = markTurbineParser((text: string): number | string => {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text;
});

/** The OIDs `utcTimestamps` governs (1184/1185 only for decode speed, as in `registerUtcTemporalParsers`). */
const UTC_OIDS: ReadonlySet<number> = new Set([1082, 1114, 1115, 1182, 1184, 1185]);
/** Array OID to element OID, for the forms built over a scalar parser. */
const ARRAY_ELEMENT: Readonly<Record<number, number>> = { 1115: 1114, 1182: 1082, 1185: 1184 };

/**
 * A parser table with Turbine's readings over `base`. `base` is read at lookup
 * time, so a parser the caller registers later is still the fallback. Built
 * parsers are cached per OID and rebuilt when what they were built over
 * changes.
 */
export function turbineTypeTable(base: () => TypeParserTable, utcTimestamps: boolean): TypeParserTable {
  const built = new Map<number, { from: unknown; element: unknown; parser: unknown }>();

  const parserFor = (oid: number): unknown => {
    const fallback = base().getTypeParser(oid, 'text');
    if (oid !== 20 && !(utcTimestamps && UTC_OIDS.has(oid))) return fallback;
    const elementOid = ARRAY_ELEMENT[oid];
    const element = elementOid === undefined ? undefined : parserFor(elementOid);
    const cached = built.get(oid);
    if (cached && cached.from === fallback && cached.element === element) return cached.parser;
    const parser = isTurbineParser(fallback) ? fallback : build(oid, fallback as TextParser, element);
    built.set(oid, { from: fallback, element, parser });
    return parser;
  };

  const build = (oid: number, fallback: TextParser, element: unknown): unknown => {
    switch (oid) {
      case 20:
        return parseInt8;
      case 1082:
        return markTurbineParser(createUtcDateParser(fallback));
      case 1114:
        return markTurbineParser(createUtcTimestampParser(fallback));
      case 1115:
      case 1182:
        return markTurbineParser(createPgArrayParser(element as TextParser));
      case 1184:
        // Speed only: a caller's own timestamptz parser is kept, as on owned pools.
        return isDefaultTextParser(1184, fallback)
          ? markTurbineParser(createFastTimestamptzParser(fallback))
          : fallback;
      case 1185:
        return isTurbineParser(element) && isDefaultTextParser(1185, fallback)
          ? markTurbineParser(createPgArrayParser(element as TextParser))
          : fallback;
      default:
        return fallback;
    }
  };

  return {
    getTypeParser(oid: number, format = 'text'): unknown {
      return format === 'text' ? parserFor(oid) : base().getTypeParser(oid, format);
    },
  };
}

let driverTypes: boolean | undefined;

/**
 * Whether this build has the real driver's parsers to build from. Under the
 * `edge-light` and `browser` conditions `#pg` is a stand-in with none, so
 * Turbine leaves a supplied pool's parsing to that pool's driver there.
 */
function driverTypesAvailable(): boolean {
  if (driverTypes === undefined) {
    try {
      const arrays = (pg.types as unknown as { arrayParser: { create(s: string, t: Method): { parse(): unknown } } })
        .arrayParser;
      driverTypes = Array.isArray(arrays.create('{}', (v) => v).parse());
    } catch {
      driverTypes = false;
    }
  }
  return driverTypes;
}

function isTable(value: unknown): value is TypeParserTable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getTypeParser?: unknown }).getTypeParser === 'function'
  );
}

/**
 * The table a query on `pool` would use without Turbine: a connected client's
 * (which already folds in the pool's `types` option and the driver copy the
 * pool was built from), else the pool's `types` option, else this module's
 * driver. pg-pool keeps every client it opened in `_clients`; a pool without
 * that field falls through to the option and the driver.
 */
function poolTypeBase(pool: PgCompatPool): () => TypeParserTable {
  let fromClient: TypeParserTable | undefined;
  return () => {
    if (fromClient) return fromClient;
    const clients = (pool as unknown as { _clients?: unknown })._clients;
    if (Array.isArray(clients)) {
      for (const client of clients) {
        const types = (client as { _types?: unknown } | null)?._types;
        if (isTable(types)) {
          fromClient = types;
          return types;
        }
      }
    }
    const configured = (pool as unknown as { options?: { types?: unknown } }).options?.types;
    return isTable(configured) ? configured : (pg.types as unknown as TypeParserTable);
  };
}

/**
 * `(text, values)` or a query config, with `types` attached. A submittable
 * (a cursor) carries its own result: it gets the table the same way
 * node-postgres gives it the connection's, only when it has none.
 */
function withTypes(textOrConfig: unknown, values: unknown, types: TypeParserTable): unknown {
  if (typeof textOrConfig === 'string') {
    return values === undefined ? { text: textOrConfig, types } : { text: textOrConfig, values, types };
  }
  if (typeof textOrConfig !== 'object' || textOrConfig === null) return textOrConfig;
  const config = textOrConfig as { submit?: unknown; types?: unknown; _result?: { _types?: unknown } | null };
  if (typeof config.submit === 'function') {
    if (config._result && !config._result._types) config._result._types = types;
    return config;
  }
  if (config.types !== undefined) return config;
  return values === undefined ? { ...config, types } : { ...config, values, types };
}

/** Forward every other member to the target, bound to it, so the driver's internals see the real object. */
function forwardingProxy<T extends object>(target: T, own: (prop: PropertyKey) => unknown): T {
  const bound = new Map<PropertyKey, { fn: unknown; bound: unknown }>();
  return new Proxy(target, {
    get(t, prop) {
      const mine = own(prop);
      if (mine !== undefined) return mine;
      const value = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      const hit = bound.get(prop);
      if (hit && hit.fn === value) return hit.bound;
      const fn = (value as Method).bind(t);
      bound.set(prop, { fn: value, bound: fn });
      return fn;
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value, t);
    },
  });
}

/**
 * The pool Turbine sends its own queries through, for a caller-supplied
 * PostgreSQL pool: `query` and every client from `connect` carry Turbine's
 * parsers. Everything else (`end`, counts, events, `instanceof`) is the pool's
 * own.
 *
 * Returns `undefined`, meaning "use the pool as it is", for a pool that is not
 * built on node-postgres (it may not read a query config at all) and for a
 * build without the driver's parsers. A driver that accepts a config but
 * ignores its `types` keeps its own readings.
 */
export function typedQueryPool(pool: PgCompatPool, utcTimestamps: boolean): PgCompatPool | undefined {
  if (typeof (pool as unknown as { Client?: unknown }).Client !== 'function' || !driverTypesAvailable()) {
    return undefined;
  }
  const target = pool as unknown as Record<PropertyKey, unknown>;
  const table = turbineTypeTable(poolTypeBase(pool), utcTimestamps);
  const clients = new WeakMap<object, PgCompatPoolClient>();

  const typedClient = (client: PgCompatPoolClient): PgCompatPoolClient => {
    const known = clients.get(client);
    if (known) return known;
    const own = (client as unknown as { _types?: unknown })._types;
    const clientTable = isTable(own) ? turbineTypeTable(() => own, utcTimestamps) : table;
    const send = (client as unknown as { query: Method }).query;
    const query = (textOrConfig: unknown, values?: unknown, ...more: unknown[]): unknown =>
      more.length > 0 || typeof values === 'function'
        ? send.call(client, textOrConfig, values, ...more)
        : send.call(client, withTypes(textOrConfig, values, clientTable));
    const typed = forwardingProxy(client as unknown as Record<PropertyKey, unknown>, (prop) => {
      if (prop === 'query') return query;
      if (prop === '_types') return clientTable;
      if (prop === RAW_CLIENT) return client;
      return undefined;
    }) as unknown as PgCompatPoolClient;
    clients.set(client, typed);
    return typed;
  };

  const query = (textOrConfig: unknown, values?: unknown, ...more: unknown[]): unknown => {
    const send = target.query as Method;
    return more.length > 0 || typeof values === 'function'
      ? send.call(pool, textOrConfig, values, ...more)
      : send.call(pool, withTypes(textOrConfig, values, table));
  };
  const connect = (...args: unknown[]): unknown => {
    const open = target.connect as Method;
    if (args.length > 0) return open.apply(pool, args);
    return (open.call(pool) as Promise<PgCompatPoolClient>).then(typedClient);
  };
  return forwardingProxy(target, (prop) => {
    if (prop === 'query') return query;
    if (prop === 'connect') return connect;
    return undefined;
  }) as unknown as PgCompatPool;
}

/**
 * The driver connection behind a client {@link typedQueryPool} handed out, or
 * `client` itself. Used where the caller is given the connection to run their
 * own statements on, which keep the driver's readings.
 */
export function rawClientOf(client: PgCompatPoolClient): PgCompatPoolClient {
  return ((client as unknown as Record<symbol, unknown>)[RAW_CLIENT] as PgCompatPoolClient | undefined) ?? client;
}
