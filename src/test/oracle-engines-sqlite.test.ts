/**
 * Cross-engine oracle battery: SQLite (in-process, `node:sqlite`) against
 * Postgres. Scenarios, comparison and allowlist live in `oracle/engines/`.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/oracle-engines-sqlite.test.ts
 */

import { skipGate } from './helpers.js';
import { DatabaseSync, postgresHarness, sqliteHarness } from './oracle/engines/harness.js';
import { registerEngineBattery } from './oracle/engines/run.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const oracleGate = skipGate(!DATABASE_URL, 'requires DATABASE_URL (Postgres is the oracle)');
const engineGate = skipGate(!DatabaseSync, 'requires node:sqlite (Node >= 22.5)');

registerEngineBattery({
  engine: sqliteHarness(),
  oracle: postgresHarness(DATABASE_URL || 'postgres://unset/unset', 'oe_sqlite'),
  runners: DATABASE_URL ? engineGate : oracleGate,
  repro: 'DATABASE_URL=... npx tsx --test src/test/oracle-engines-sqlite.test.ts',
});
