/**
 * Run configuration shared by every oracle test.
 *
 *   TURBINE_ORACLE_SEED  base seed (any integer; default fixed so CI is repeatable)
 *   TURBINE_ORACLE_FULL  "1" selects the larger nightly sizes
 *
 * The fast sizes keep the whole lane under about a minute on a laptop. The full
 * sizes widen the random search, they never change what a test asserts.
 */

import { hashSeed, Rng } from './rng.js';

export const DATABASE_URL = process.env.DATABASE_URL;
export const SKIP = !DATABASE_URL;

export const FULL = process.env.TURBINE_ORACLE_FULL === '1';

const DEFAULT_SEED = 20261012;

function parseSeed(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SEED;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`TURBINE_ORACLE_SEED must be an integer, got ${JSON.stringify(raw)}`);
  }
  return n >>> 0;
}

export const BASE_SEED = parseSeed(process.env.TURBINE_ORACLE_SEED);

/** `fast` on every PR, `full` when TURBINE_ORACLE_FULL=1. */
export function scaled<T>(fast: T, full: T): T {
  return FULL ? full : fast;
}

/** An independent stream for one test, derived from the base seed. */
export function rngFor(label: string): Rng {
  return new Rng(hashSeed(BASE_SEED, label));
}

/** The line that makes a failure replayable. Goes into every failure message. */
export function reproLine(file: string): string {
  return `reproduce: TURBINE_ORACLE_SEED=${BASE_SEED}${FULL ? ' TURBINE_ORACLE_FULL=1' : ''} DATABASE_URL=... npx tsx --test src/test/${file}`;
}
