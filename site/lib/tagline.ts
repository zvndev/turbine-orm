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
};

/** The tagline shown in the landing hero badge. */
export const HERO_TAGLINE: string = TAGLINE_OVERRIDES[LATEST_VERSION] ?? LATEST_TAGLINE;
