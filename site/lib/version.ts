/**
 * Single source of truth for the version shown on the site (hero badge,
 * docs sidebar). Bump this together with the root package.json on every
 * release — it's part of the AGENTS.md release-flow drift check.
 *
 * (The site deploys standalone from `site/`, so it cannot import the root
 * package.json at build time on Vercel.)
 */
export const TURBINE_VERSION = '0.19.1';

/** Marketing minor line, e.g. "v0.19" for the hero badge. */
export const TURBINE_MINOR = `v${TURBINE_VERSION.split('.').slice(0, 2).join('.')}`;
