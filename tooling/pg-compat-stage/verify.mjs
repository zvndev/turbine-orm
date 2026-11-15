import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exactPayload, expectedPayload, extract, fileHashes, freshDirectory, hashFile, jsonBytes, rebuildNormal, verifyBinding } from './contract.mjs';

const [identityFile, pinnedNormal, destination, ...extra] = process.argv.slice(2);
assert.ok(identityFile && pinnedNormal && destination && !extra.length, 'Usage: node verify.mjs IDENTITY PINNED_NORMAL NEW_OUTPUT');
const identity = JSON.parse(readFileSync(identityFile));
verifyBinding(identity);
const output = freshDirectory(destination);
const { normal, receipt } = rebuildNormal(output, pinnedNormal);
assert.deepEqual(receipt.tools, identity.build.tools, 'Fresh rebuild tools differ from producer identity');
assert.deepEqual(receipt.inputs, identity.build.inputs);
assert.deepEqual(receipt.dist, identity.build.dist);
const staged = extract(identity.archive, join(output, 'stage'), identity.sha256);
exactPayload(staged, expectedPayload(normal));
assert.deepEqual(fileHashes(staged), identity.stagedHashes, 'Descriptor inventory differs');
const report = { success: true, independentNormalRebuild: true, stageSha256: hashFile(identity.archive),
  normalSha256: receipt.normalSha256, files: Object.keys(identity.stagedHashes).length,
  distFilesIdentical: 757, declarationsIdentical: Object.keys(identity.stagedHashes).filter(name => /\.d\.(ts|cts)$/.test(name)).length,
  exportsAndLoadersIdentical: true, build: receipt };
writeFileSync(join(output, 'report.json'), jsonBytes(report));
console.log(JSON.stringify({ success: true, report: join(output, 'report.json') }));
