/** Effect-free local D1 configuration admission; no optional loader or runtime. */
import type { ResolvedConfig } from './config.js';

export type { D1SeedPlan, D1SeedValue } from './d1-seed.js';

export interface D1LocalConfig {
  binding: string;
  databaseId: string;
  persist: string;
}
/** Structural until the separately supplied CLI configuration patch is integrated. */
export type D1ProjectConfig = Omit<ResolvedConfig, 'engine'> & { engine?: string; d1?: D1LocalConfig };
const keys = new Set(
  'engine url out schema include exclude relationNames columnTypes importExtension keepColumnNames exactNativeIntegers legacyToManyUniques migrationsDir seedFile seed schemaFile schemaFileConfigured adapter d1'.split(
    ' ',
  ),
);
export function assertD1Config(config: object): void {
  for (const key of Reflect.ownKeys(config))
    if (typeof key !== 'string' || !keys.has(key)) throw new TypeError(`Unsupported local D1 option: ${String(key)}.`);
}
