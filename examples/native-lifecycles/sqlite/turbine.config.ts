import type { TurbineCliConfig } from 'turbine-orm/cli';

export default {
  engine: 'sqlite',
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
  migrationsDir: './turbine/migrations',
  seedFile: './seed.ts',
} satisfies TurbineCliConfig;
