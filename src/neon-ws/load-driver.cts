import type { NeonWsDriver } from './transport.js';

/**
 * A literal peer import lets edge bundlers discover the optional driver. The
 * supported Neon 1.x package supplies both import and require entry points;
 * unlike ESM-only peers, its CJS build needs no runtime Node loader fallback.
 * Keeping this in a .cts also preserves import() in the NodeNext build.
 */
async function loadNeonDriver(): Promise<NeonWsDriver> {
  return (await import('@neondatabase/serverless')) as unknown as NeonWsDriver;
}
export = loadNeonDriver;
