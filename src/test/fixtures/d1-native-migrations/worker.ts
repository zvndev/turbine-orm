import { migrateD1 } from '../../../d1/migrate.js';
import type { D1DatabaseBinding } from '../../../d1/types.js';
import { runD1MigrationContract } from './contract.js';

export default {
  async fetch(_request: unknown, env: { DB: D1DatabaseBinding }): Promise<Response> {
    try {
      return Response.json(await runD1MigrationContract(env.DB, migrateD1));
    } catch (error) {
      const causes: string[] = [];
      for (let item = error; item instanceof Error; item = item.cause) causes.push(`${item.stack}`);
      return Response.json(
        { causes, schema: (await env.DB.prepare('SELECT * FROM sqlite_schema').all()).results },
        { status: 500 },
      );
    }
  },
};
