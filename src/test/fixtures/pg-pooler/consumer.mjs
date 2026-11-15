// Run this COPY from a real npm-installed consumer, without tsx or staged exports.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { poolerContract } from './contract.mjs';

const format = process.argv[2];
assert.ok(['esm', 'cjs'].includes(format));
const require = createRequire(import.meta.url);
const load = format === 'esm' ? (name) => import(name) : (name) => require(name);
const hub = await load('turbine-orm/notification-hub');
const ws = await load('turbine-orm/neon-ws');
await test(`actual installed ${format} exports ${process.version}`, { timeout: 60_000 }, async (context) => {
  await poolerContract({ ...hub, ...ws }, context, `installed-${format}`);
});
