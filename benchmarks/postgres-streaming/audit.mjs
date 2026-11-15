import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit, save } from './process.mjs';
import { sha } from './driver.mjs';
import { validateCampaign } from './validate.mjs';

const [directory] = process.argv.slice(2);
assert.ok(directory, 'Campaign directory required');
const report = JSON.parse(readFileSync(join(directory, 'campaign.json')));
assert.equal(sha(join(directory, 'server.log')), report.serverLogSha256, 'Frozen native server log hash');
assert.equal(sha(join(directory, 'source.mjs')), report.provenance.bundleSha256, 'Executed bundle hash');
const result = { status: report.status, audit: await audit(report) };
if (report.status === 'passed') validateCampaign(report);
save(join(directory, 'independent-audit.json'), result);
console.log(JSON.stringify(result));
