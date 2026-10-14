import { LATEST_TAGLINE, LATEST_VERSION } from './changelog.generated';

/**
 * Manual hero-tagline overrides, keyed by exact release version.
 *
 * `LATEST_TAGLINE` is derived from the first bold bullet of the newest
 * CHANGELOG entry, which is right most of the time and wrong for a
 * correctness release, where the first bullet is the title of a bug. Add an
 * entry here to present that release sensibly; leave it out and the derived
 * tagline is used, so this never has to be maintained release to release.
 */
const TAGLINE_OVERRIDES: Record<string, string> = {
  '0.49.0': 'Correctness release: nested-write scoping, PII contract, guard hardening',
  '0.90.0': 'Correctness release: wrong-result queries now throw, pluggable logger, five-engine fixes',
  '0.90.1': 'Patch: a PowDB filter that could delete every row, 1 kB smaller bundles, OIDC-ready publishing',
  '0.90.2': 'Patch: createMany 10x less JavaScript, transactions reuse their SQL, more prepared statements',
  '0.91.0': 'Count-only createMany, percentiles of expressions, SQLite bulk inserts 70 to 140x faster',
};

/** The tagline shown in the landing hero badge. */
export const HERO_TAGLINE: string = TAGLINE_OVERRIDES[LATEST_VERSION] ?? LATEST_TAGLINE;
