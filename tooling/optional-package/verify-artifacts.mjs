import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyPayload } from './artifact-contract.mjs';

const [identityPath, originalArchive, pin, destination] = process.argv.slice(2);
assert.ok(identityPath && originalArchive && pin && destination, 'Usage: node verify-artifacts.mjs IDENTITY ORIGINAL SHA256 NEW_OUTPUT');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(hash(originalArchive), pin);
const identity = JSON.parse(readFileSync(identityPath));
assert.equal(hash(identity.archive), identity.sha256);
const root = resolve(destination);
assert.ok(!existsSync(root));
mkdirSync(root);
for (const [name, archive] of [['original', originalArchive], ['optional', identity.archive]]) {
  mkdirSync(join(root, name));
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(members.length > (name === 'original' || !identity.profile ? 700 : 0));
  assert.ok(members.every((path) => path.startsWith('package/') && !path.split('/').includes('..')));
  assert.equal(new Set(members).size, members.length, 'Duplicate archive entries');
  const kinds = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(kinds.every(line => line.startsWith('-') || line.startsWith('d')), 'Archive contains a link or special file');
  execFileSync('tar', ['-xzf', archive, '-C', join(root, name)]);
}
const original = join(root, 'original/package');
const optional = join(root, 'optional/package');
const verified = verifyPayload(original, optional, identity.source, identity);
assert.ok(verified.declarationsIdentical > (identity.profile ? 0 : 300));
const report = { success: true, originalSha256: pin, optionalSha256: identity.sha256, ...verified };
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
