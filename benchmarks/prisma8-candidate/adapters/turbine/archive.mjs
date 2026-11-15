import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const saveJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

// Parse before writing anything. No tar executable, lifecycle script, links,
// devices, PAX path overrides, duplicate entries, or traversal is accepted.
export function packageEntries(archive, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/, 'Archive SHA256 required');
  assert.equal(sha256(archive), expected, 'Archive SHA256 mismatch');
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  const entries = new Map();
  const field = (block, start, length) =>
    block
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
  const octal = (value) => {
    assert.match(value.trim(), /^[0-7]+$/, 'Non-octal tar header');
    return Number.parseInt(value.trim(), 8);
  };
  let end = false;
  for (let offset = 0; offset < tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    assert.equal(block.length, 512, 'Truncated tar header');
    if (block.every((v) => v === 0)) {
      assert.ok(
        tar.subarray(offset).every((v) => v === 0),
        'Nonzero tar trailer',
      );
      end = true;
      break;
    }
    const checksum = [...block].reduce((sum, byte, n) => sum + (n >= 148 && n < 156 ? 32 : byte), 0);
    assert.equal(checksum, octal(field(block, 148, 8)), 'Tar checksum mismatch');
    const prefix = field(block, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${field(block, 0, 100)}`;
    assert.ok(name.startsWith('package/'), 'Only package/ archive paths allowed');
    assert.ok(
      !name.includes('\\') && [...name].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
      'Unsafe archive path',
    );
    assert.ok(
      name.split('/').every((v, i, all) => v !== '.' && v !== '..' && (v || i === all.length - 1)),
      'Unsafe archive path',
    );
    assert.ok(!entries.has(name), `Duplicate archive path: ${name}`);
    const type = field(block, 156, 1);
    assert.ok(type === '' || type === '0' || type === '5', `Archive links/extensions/devices refused: ${name}`);
    const size = octal(field(block, 124, 12));
    assert.ok(Number.isSafeInteger(size) && size <= 16 * 1024 * 1024, 'Oversized archive entry');
    assert.ok(type !== '5' || size === 0, 'Nonempty archive directory');
    const start = offset + 512;
    assert.ok(start + size <= tar.length, 'Truncated archive payload');
    entries.set(name, Buffer.from(tar.subarray(start, start + size)));
    assert.ok(entries.size <= 10000, 'Too many archive entries');
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(end, 'Missing tar trailer');
  const manifest = JSON.parse(entries.get('package/package.json')?.toString() ?? 'null');
  assert.equal(manifest?.name, 'turbine-orm', 'Actual turbine-orm package required');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'Exact package version required');
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/generate.js', 'dist/introspect.js'])
    assert.ok(entries.get(`package/${file}`)?.length, `Missing archive public API: ${file}`);
  return { entries, manifest };
}

export function stagePackage(entries, destination) {
  const files = {};
  for (const [name, bytes] of entries) {
    const relative = name.slice('package/'.length);
    if (!(relative === 'package.json' || (/^dist\//.test(relative) && /\.(?:js|cjs|json|ts|cts)$/.test(relative))))
      continue;
    const path = join(destination, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    files[relative] = sha256(bytes);
  }
  return files;
}

export function sourceIdentity(evidence, sourceCommit, archiveSha256) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, 'Exact source commit required');
  assert.equal(evidence.sourceCommit ?? evidence.head, sourceCommit, 'Retained identity source mismatch');
  assert.equal(evidence.artifact?.sha256, archiveSha256, 'Retained identity archive mismatch');
}
