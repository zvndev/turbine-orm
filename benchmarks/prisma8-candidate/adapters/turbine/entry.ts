import type { PgCompatPool } from 'turbine-orm';
import { installDriver } from './driver.mjs';

export { policy, supported } from './definition.js';

// Bind the caller's real driver before evaluating the archive runtime, whose
// native pipeline module captures pg.Result and pg.utils at module evaluation.
// esbuild keeps this as a lazy initializer inside the ONE emitted ESM bundle.
export async function createArm(input: { pool: PgCompatPool; runtime: string; driver: string }) {
  installDriver(input.pool, input.runtime, input.driver);
  const runtime = await import('./arm.js');
  return runtime.createArm(input);
}
