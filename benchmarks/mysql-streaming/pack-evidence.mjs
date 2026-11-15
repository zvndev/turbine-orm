// Portable, compressed copies retain machine-readable observations and hashes.
// Original commands, absolute executable paths, logs and process identities stay
// in the local campaign directory for independent replay/audit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { validateCampaign } from './validate.mjs';
const [campaignPath, controlsPath, auditPath, guardsPath] = process.argv.slice(2);
assert.ok(guardsPath, 'usage: pack-evidence.mjs campaign.json controls.json combined-audit.json guards.json');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = fileURLToPath(new URL('./results', import.meta.url));
mkdirSync(directory, { recursive: true });
const native = JSON.parse(readFileSync(campaignPath));
validateCampaign(native);
const controls = JSON.parse(readFileSync(controlsPath));
assert.equal(controls.status, 'passed');
assert.equal(controls.controls.length, 12);
const replacements = [
  [root, '<checkout>/'],
  ...[process.env.MYSQL_STREAM_NODE22, process.env.MYSQL_STREAM_NODE24]
    .filter(Boolean)
    .map((p) => [p, p.includes('22.16') ? '<exact-node22>' : '<exact-node24>']),
];
const scrub = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v !== 'string') return v;
      for (const [from, to] of replacements) v = v.split(from).join(to);
      return v;
    }),
  );
const cleanup = JSON.parse(readFileSync(auditPath));
assert.equal(cleanup.late.status, 'passed');
assert.equal(cleanup.late.controls.length, 2);
for (const c of cleanup.late.controls) {
  assert.equal(c.exit.signal, 'SIGTERM');
  assert.equal(c.groupAbsent, true);
}
const files = {};
for (const [name, input] of [
  ['native', native],
  ['controls', controls],
  ['cleanup', cleanup],
  ['guards', JSON.parse(readFileSync(guardsPath))],
]) {
  const bytes = gzipSync(Buffer.from(JSON.stringify(scrub(input)) + '\n'), { level: 9 });
  const file = name + '.json.gz';
  writeFileSync(join(directory, file), bytes);
  files[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const manifest = {
  format: 'mysql-streaming-portable-evidence-v1',
  sourceHead: native.samples[0].provenance.sourceHead,
  sourceSha256: native.samples[0].provenance.sourceSha256,
  harnessSha256: native.samples[0].provenance.harnessSha256,
  inheritedArtifact: native.samples[0].provenance.inheritedArtifact,
  samples: native.samples.length,
  nativeControls: controls.controls.length,
  lateSignalControls: cleanup.late.controls.length,
  files,
  claims:
    'Branch source observations only. No integrated-head, all-memory bound, speed winner or certification claim.',
  pathRedaction:
    'Checkout and exact Node executable paths replaced only in the portable copy. Original local reports retain exact commands.',
};
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
