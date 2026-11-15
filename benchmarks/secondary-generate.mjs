/** Generate only the existing PostgreSQL client, against a caller-owned endpoint. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { generate } from '../dist/generate.js';
import { introspect } from '../dist/introspect.js';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required');
const schema = await introspect({ connectionString: process.env.DATABASE_URL });
const generated = generate({ schema, outDir: resolve('generated/turbine'), noTimestamp: true, importExtension: 'js' });
console.log(JSON.stringify(generated));
