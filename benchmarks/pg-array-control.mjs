/** Native negative control for the rejected array-row alternative. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [consumer, output] = process.argv.slice(2);
assert.ok(consumer && output && process.env.DATABASE_URL, 'Explicit installed consumer and owned native service required');
const require = createRequire(join(consumer, 'package.json'));
const pg = require('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const text = `SELECT ${Array.from({ length: 39 }, (_, i) => `${i}::int AS f${i}`).join(',')}`;
const observations = [];
try {
  for (const rowMode of [undefined, 'array']) {
    let calls = 0, setterCalls = 0, assigned;
    const types = { getTypeParser(oid, format) {
      const parse = pg.types.getTypeParser(oid, format);
      return function (value) {
        if (++calls === 1) Object.defineProperty(Array.prototype, '38', {
          configurable: true, get() { return 'inherited'; }, set(next) { setterCalls++; assigned = next; },
        });
        return parse.call(this, value);
      };
    } };
    let result;
    try { result = await pool.query({ text, rowMode, types }); }
    finally { Reflect.deleteProperty(Array.prototype, '38'); }
    assert.equal(calls, 39);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    observations.push({ mode: rowMode ?? 'object', setterCalls, assigned, hasLast: Object.hasOwn(row, rowMode ? 38 : 'f38') });
    if (rowMode) { assert.equal(setterCalls, 1); assert.equal(assigned, 38); assert.equal(Object.hasOwn(row, 38), false); }
    else { assert.equal(setterCalls, 0); assert.equal(row.f38, 38); }
  }
  writeFileSync(output, `${JSON.stringify({ node: process.version, driver: JSON.parse(readFileSync(join(consumer, 'node_modules/pg/package.json'))).version, bareArrayRejected: true, observations }, null, 2)}\n`);
} finally { Reflect.deleteProperty(Array.prototype, '38'); await pool.end(); }
