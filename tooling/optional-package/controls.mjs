/** Deliberate omissions in disposable packed copies; production source stays intact. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [identityPath, destination] = process.argv.slice(2);
assert.ok(identityPath && destination);
const source = JSON.parse(readFileSync(identityPath));
const root = resolve(destination);
assert.ok(!existsSync(root));
mkdirSync(root);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const results = [];
const cases = [
  ['mandatory-pg', /Unwanted pg install/, (staged) => {
    const file = join(staged, 'package.json');
    const pkg = JSON.parse(readFileSync(file));
    pkg.dependencies.pg = pkg.peerDependencies.pg;
    writeFileSync(file, JSON.stringify(pkg));
  }],
  ['identity-parser', /Missing expected exception/, (staged) => {
    for (const suffix of ['js', 'cjs']) {
      const file = join(staged, `dist/unavailable-pg.${suffix}`);
      const text = readFileSync(file, 'utf8');
      assert.ok(text.includes('getTypeParser: unavailable'));
      writeFileSync(file, text.replace('getTypeParser: unavailable', 'getTypeParser: () => (value) => value'));
    }
  }],
  ['unredirected-cjs', /Cannot find module 'pg'/, (staged) => {
    const file = join(staged, 'dist/cjs/client.js');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('require("../optional-pg.cjs")'));
    writeFileSync(file, text.replace('require("../optional-pg.cjs")', 'require("pg")'));
  }],
];
for (const [name, expected, mutate] of cases) {
  const dir = join(root, name);
  mkdirSync(dir);
  const staged = join(dir, 'package');
  cpSync(join(dirname(identityPath), 'package'), staged, { recursive: true });
  mutate(staged);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: staged, encoding: 'utf8', timeout: 30000 }))[0];
  const archive = join(dir, packed.filename);
  const identity = join(dir, 'identity.json');
  writeFileSync(identity, JSON.stringify({ ...source, archive, sha256: hash(archive) }));
  const outcome = spawnSync(process.execPath, [join(here, 'prove.mjs'), identity, join(dir, 'proof')], { env: { ...process.env, OPTIONAL_PACKAGE_NODES: process.execPath }, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(outcome.status, 0, `Omission escaped: ${name}`);
  assert.equal(outcome.signal, null);
  const output = outcome.stdout + outcome.stderr;
  assert.match(output, expected, `Unexpected failure: ${name}`);
  writeFileSync(join(dir, 'expected-failure.log'), output);
  results.push({ name, detected: true, archiveSha256: hash(archive), status: outcome.status });
}
// A present, broken driver must propagate its actual load error in both formats.
const peer = join(root, 'broken-driver');
mkdirSync(peer);
cpSync(join(here, 'optional-pg.js'), join(peer, 'optional-pg.mjs'));
cpSync(join(here, 'optional-pg.cjs'), join(peer, 'optional-pg.cjs'));
writeFileSync(join(peer, 'unavailable-pg.js'), 'export default {};');
writeFileSync(join(peer, 'package.json'), '{"type":"module"}');
mkdirSync(join(peer, 'node_modules/pg'), { recursive: true });
writeFileSync(join(peer, 'node_modules/pg/package.json'), '{"name":"pg","version":"8.15.0","main":"index.js"}');
writeFileSync(join(peer, 'node_modules/pg/index.js'), 'throw Error("present-driver-load-fault");');
for (const suffix of ['mjs', 'cjs']) {
  const outcome = spawnSync(process.execPath, [join(peer, `optional-pg.${suffix}`)], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /present-driver-load-fault/);
  results.push({ name: `present-driver-load-${suffix}`, detected: true });
}
writeFileSync(join(peer, 'node_modules/pg/package.json'), '{"name":"pg","version":"8.15.0","main":"missing-entry.cjs"}');
rmSync(join(peer, 'node_modules/pg/index.js'));
for (const suffix of ['mjs', 'cjs']) {
  const outcome = spawnSync(process.execPath, [join(peer, `optional-pg.${suffix}`)], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /missing-entry\.cjs/);
  results.push({ name: `present-driver-resolution-${suffix}`, detected: true });
}
writeFileSync(join(root, 'report.json'), JSON.stringify({ success: true, results }, null, 2));
console.log(JSON.stringify({ success: true, results }));
