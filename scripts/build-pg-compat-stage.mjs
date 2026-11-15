#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedPayload, exactPayload, extract, fileHashes, freshDirectory, hashFile, inputs, jsonBytes, normalPin, npmPack, pgPin, rebuildNormal, source, writePayload } from '../tooling/pg-compat-stage/contract.mjs';

const [flag, destination, normalFlag, archive, ...extra] = process.argv.slice(2);
assert.ok(flag === '--out' && destination && normalFlag === '--normal' && archive && !extra.length,
  'Usage: node scripts/build-pg-compat-stage.mjs --out ABSOLUTE_NEW_DIRECTORY --normal PINNED_NORMAL_TGZ');
const output = freshDirectory(destination);
const { normal, receipt: build } = rebuildNormal(output, archive);
const payload = expectedPayload(normal);
const staged = join(output, 'package');
writePayload(staged, payload);
const packed = npmPack(staged, output);
const stageArchive = join(output, packed.filename);
const extracted = extract(stageArchive, join(output, 'stage-extracted'));
exactPayload(extracted, payload);
assert.deepEqual(inputs(), build.inputs, 'Inputs changed during stage packing');
const identity = { schemaVersion: 1, stagedOnly: true, source, normalSha256: normalPin, pgPin,
  archive: stageArchive, sha256: hashFile(stageArchive), build, stagedHashes: fileHashes(extracted), packed };
writeFileSync(join(output, 'identity.json'), jsonBytes(identity));
console.log(JSON.stringify({ archive: stageArchive, sha256: identity.sha256, identity: join(output, 'identity.json') }));
