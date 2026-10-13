/**
 * Where the code that opens an implicit transaction finds `TransactionClient`.
 *
 * A nested write (or an upsert that looks its row up first) issued outside a
 * transaction opens one of its own and runs the nested-write engine against a
 * `TransactionClient` (query/builder.ts; powql.ts, the PowDB generator, does
 * the same and can read this slot too). Those modules sit BELOW client.ts in
 * the import graph: client.ts imports query/, so a static value import back
 * would be a cycle, and scripts/check-import-cycles.mjs refuses one.
 *
 * builder.ts used to reach the class with a dynamic import of client.ts.
 * That works, but a bundler that does not split code (esbuild, which is also
 * what the size budget in .size-limit.js measures, and Wrangler) inlines the
 * dynamic target and, to keep its evaluation lazy, wraps client.ts and every
 * module it reaches in lazy-init closures: about 1 kB brotli on every entry,
 * for a module that is always already loaded by the time a query runs.
 * client.ts instead registers the class here once, when it is evaluated, and
 * every public entry point evaluates client.ts.
 *
 * ## One slot per package copy, deliberately not `Symbol.for`
 *
 * The ESM and CJS builds can both be loaded in one process. Shared state that
 * must agree across them (the warn-once registry, the prepared-statement
 * budget) lives under a `Symbol.for` key; this slot must NOT. A builder has to
 * construct the `TransactionClient` of its OWN copy, exactly as the dynamic
 * import did: the other copy's class builds the other copy's accessors and
 * transaction state and throws the other copy's error classes, so `instanceof`
 * checks in the caller's copy would stop matching. Each copy's entry points
 * load that copy's client.ts, so each copy's slot is filled.
 *
 * ## An empty slot
 *
 * Reachable only when a `QueryInterface` is built directly and client.ts was
 * never loaded in that copy: a test or tool that deep-imports query/, or a
 * bundled application that uses the exported `QueryInterface` without ever
 * importing `TurbineClient` or an engine factory (with `sideEffects: false` a
 * bundler may then drop client.ts). Only the implicit-transaction path reads
 * the slot, so everything else keeps working; that path throws a
 * `ValidationError` (E003) naming the fix, before any connection is checked out.
 *
 * The import of client.ts below is type-only, so this file adds no edge to the
 * runtime graph. errors.ts is a leaf.
 */
import type { TransactionClient } from './client.js';
import { ValidationError } from './errors.js';

/** The `TransactionClient` constructor, as client.ts registers it. */
export type TransactionClientClass = typeof TransactionClient;

let registered: TransactionClientClass | undefined;

/** @internal Called once, by client.ts, when it is evaluated. */
export function registerTransactionClient(ctor: TransactionClientClass): void {
  registered = ctor;
}

/** @internal The registered class, or `undefined` when client.ts was never loaded in this copy. */
export function registeredTransactionClient(): TransactionClientClass | undefined {
  return registered;
}

/**
 * @internal The registered class for an implicit transaction. Throws a
 * `ValidationError` when client.ts was never loaded in this copy of the package.
 * `operation` starts the message, for example `A nested write on "users"`.
 */
export function transactionClientFor(operation: string): TransactionClientClass {
  if (registered !== undefined) return registered;
  throw new ValidationError(
    `${operation} outside a transaction opens one of its own through TurbineClient, ` +
      'and TurbineClient was never loaded in this program. Import TurbineClient (or an engine factory such as ' +
      "turbineHttp) from 'turbine-orm' before running it, or run the write inside db.$transaction().",
  );
}
