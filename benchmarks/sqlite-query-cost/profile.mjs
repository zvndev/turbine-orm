import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [artifact, out] = process.argv.slice(2);
assert.ok(artifact && out, 'profile.mjs bundle.mjs out.json');
const { __queryCost: h } = await import(pathToFileURL(resolve(artifact)));
const sql = 'SELECT id, enabled, payload FROM items WHERE id=$1';
const db = new DatabaseSync(':memory:');
const samples = [];
let sink;
try {
  db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, enabled BOOLEAN, payload TEXT);
    INSERT INTO items VALUES(1,1,'{"n":1}')`);
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const raw = stmt.all({ 1: 1n })[0];
  const memo = { decoders: null };
  const decoders = h.resultColumnDecoders(stmt, null, memo);
  const cases = {
    binding: () => h.toNamedBinding([1]),
    'rewrite-dollar': () => h.rewritePositionalPlaceholders(sql, 'sqlite', 1, (i) => `:p${i}`, (m) => { throw Error(m); }),
    'rewrite-named': () => h.rewritePositionalPlaceholders(sql.replace('$1', ':p1'), 'sqlite', 1, (i) => `:p${i}`, (m) => { throw Error(m); }),
    classification: () => h.statementReturnsRows(sql),
    'native-prepare': () => db.prepare(sql),
    'native-all': () => stmt.all({ 1: 1n }),
    'native-columns': () => stmt.columns(),
    'describe-and-match': () => h.resultColumnDecoders(stmt, null, memo),
    'normalize-row': () => h.normalizeRow(raw, decoders),
  };
  for (let round = 0; round < 7; round++) {
    for (const [name, run] of Object.entries(cases)) {
      for (let i = 0; i < 2000; i++) sink = run();
      const iterations = 30000;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) sink = run();
      samples.push({ name, round, iterations, us: (performance.now() - start) * 1000 / iterations });
    }
  }
  assert.ok(sink);
} finally { db.close(); }
writeFileSync(out, JSON.stringify({
  node: process.version, executable: process.execPath,
  binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  artifact: JSON.parse(readFileSync(`${artifact}.json`)), samples,
  note: 'Isolated real helper/native costs, not additive end-to-end latency; shared-host measurements.',
}, null, 2));
