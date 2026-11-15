import assert from 'node:assert/strict';
import { turbine } from './generated/turbine/index.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must select the MySQL database');
  const pending = turbine(url, { connectionLimit: 2 });
  const db = await pending;
  try {
    await db.users.create({ data: { id: 1, displayName: 'Created by the app' } });
    await db.users.update({ where: { id: 1 }, data: { displayName: 'Updated by the app' } });
    const user = await db.users.findUniqueOrThrow({ where: { id: 1 } });
    const name: string = user.displayName;
    assert.equal(name, 'Updated by the app');
    console.log(JSON.stringify({ id: user.id, displayName: name }));
  } finally {
    await db.disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
