import type { TurbineCliConfig } from 'turbine-orm/cli';

const config: TurbineCliConfig = {
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
  schema: 'public',
  schemaFile: './turbine/schema.ts',
  seedFile: './turbine/seed.ts',
  migrationsDir: './turbine/migrations',
};

export default config;
