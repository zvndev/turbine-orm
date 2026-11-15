/**
 * Compatibility entry for npm run bench / bench:quick.
 * ITERATIONS and WARMUP retain their meanings; the calls now share the exact
 * preflight and interleaved headline arms instead of maintaining a second copy.
 */
import { runHeadline } from './bench-interleaved.js';

process.env['ROUNDS'] ??= process.env['ITERATIONS'] ?? '200';
runHeadline().catch((error) => {
  console.error('Benchmark error:', error);
  process.exitCode = 1;
});
