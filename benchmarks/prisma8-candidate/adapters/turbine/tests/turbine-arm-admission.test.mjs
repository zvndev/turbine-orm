import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import wrongPg from 'pg-wrong';
import { packageEntries, sha256, sourceIdentity } from '../archive.mjs';
import { installDriver } from '../driver.mjs';

function archive(files) {
  const blocks = [];
  for (const { name, type = '0', value = '' } of files) {
    const header = Buffer.alloc(512);
    const data = Buffer.from(value);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    const sum = [...header].reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const valid = () => [
  { name: 'package/package.json', value: JSON.stringify({ name: 'turbine-orm', version: '1.2.3' }) },
  ...['index.js', 'index.d.ts', 'generate.js', 'introspect.js'].map((f) => ({
    name: `package/dist/${f}`,
    value: 'export {};',
  })),
];

test('turbine-arm archive guard accepts a nonempty public package and rejects wrong hash', () => {
  const bytes = archive(valid());
  assert.equal(packageEntries(bytes, sha256(bytes)).manifest.version, '1.2.3');
  assert.throws(() => packageEntries(bytes, '0'.repeat(64)), /Archive SHA256 mismatch/);
});

for (const [label, entry, message] of [
  ['traversal', { name: 'package/../../escape', value: 'bad' }, /Unsafe archive path/],
  ['absolute', { name: '/escape', value: 'bad' }, /Only package/],
  ['symlink', { name: 'package/link', type: '2' }, /links\/extensions\/devices/],
  ['hardlink', { name: 'package/link', type: '1' }, /links\/extensions\/devices/],
  ['pax', { name: 'package/pax', type: 'x' }, /links\/extensions\/devices/],
  ['duplicate', valid()[0], /Duplicate archive path/],
])
  test(`turbine-arm rejects ${label} before any extraction`, () => {
    const bytes = archive([...valid(), entry]);
    assert.throws(() => packageEntries(bytes, sha256(bytes)), message);
  });

test('turbine-arm refuses missing runtime package payload and a forged source identity', () => {
  const bytes = archive(valid().slice(0, 1));
  assert.throws(() => packageEntries(bytes, sha256(bytes)), /Missing archive public API/);
  const evidence = { head: 'a'.repeat(40), artifact: { sha256: 'b'.repeat(64) } };
  sourceIdentity(evidence, 'a'.repeat(40), 'b'.repeat(64));
  assert.throws(() => sourceIdentity(evidence, 'c'.repeat(40), 'b'.repeat(64)), /source mismatch/);
  assert.throws(() => sourceIdentity(evidence, 'a'.repeat(40), 'd'.repeat(64)), /archive mismatch/);
});

test('turbine-arm driver guard requires the actual native caller pool and runtime', async () => {
  const pool = new pg.Pool();
  try {
    installDriver(pool, process.version, 'pg@8.22.0');
    assert.throws(() => installDriver(pool, process.version, 'pg@8.23.1'), /requires pg/);
    const wrongPool = new wrongPg.Pool();
    try {
      assert.throws(
        () => installDriver(wrongPool, process.version, 'pg@8.22.0'),
        /Actual supplied pool driver version mismatch/,
      );
    } finally {
      await wrongPool.end();
    }
    assert.throws(() => installDriver(pool, 'v24.10.0', 'pg@8.22.0'), /actual process runtime/);
    assert.throws(
      () => installDriver({ query() {}, connect() {} }, process.version, 'pg@8.22.0'),
      /actual loaded native pg.Pool/,
    );
    class OtherPool extends pg.Pool {}
    const other = new OtherPool();
    try {
      assert.throws(() => installDriver(other, process.version, 'pg@8.22.0'), /actual loaded native pg.Pool/);
    } finally {
      await other.end();
    }
  } finally {
    await pool.end();
  }
  assert.throws(() => installDriver(pool, process.version, 'pg@8.22.0'), /closed/);
});
