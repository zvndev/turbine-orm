/**
 * Cross-engine oracle battery: embedded PowDB against Postgres. Scenarios,
 * comparison and allowlist live in `oracle/engines/`. The engine runs
 * in-process in a temporary directory.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/oracle-engines-powdb.test.ts
 */

import { skipGate } from './helpers.js';
import { postgresHarness, powdbEmbeddedAvailable, powdbHarness } from './oracle/engines/harness.js';
import { registerEngineBattery } from './oracle/engines/run.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const embedded = await powdbEmbeddedAvailable();
const oracleGate = skipGate(!DATABASE_URL, 'requires DATABASE_URL (Postgres is the oracle)');
const engineGate = skipGate(!embedded, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

registerEngineBattery({
  engine: powdbHarness(),
  oracle: postgresHarness(DATABASE_URL || 'postgres://unset/unset', 'oe_powdb'),
  runners: DATABASE_URL ? engineGate : oracleGate,
  repro: 'DATABASE_URL=... npx tsx --test src/test/oracle-engines-powdb.test.ts',
});
