import { turbine } from '../generated';

export const db = turbine({
  connectionString: process.env.DATABASE_URL!,
  poolSize: 5,
});
