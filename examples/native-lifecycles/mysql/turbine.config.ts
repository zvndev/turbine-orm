import type { TurbineCliConfig } from 'turbine-orm/cli';

export default {
  engine: 'mysql',
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
  seedFile: './seed.ts',
  migrationsDir: './turbine/migrations',
} satisfies TurbineCliConfig;
