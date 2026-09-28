#!/usr/bin/env node
/**
 * Guard: the packed tarball imports cleanly against the OLDEST pg its own
 * dependency range allows.
 *
 * ## Why this exists
 *
 * `dependencies.pg` is a promise to every consumer: any pg inside this range
 * works. For several releases the range said `^8.13.1` while
 * src/pipeline-submittable.ts read `pg.utils` and `pg.Result` off the module
 * object at load time, and pg exports neither before 8.15.0. So a consumer on
 * pg 8.13 or 8.14, both inside the declared range, could not even import
 * `turbine-orm` ("Cannot destructure property 'prepareValue' of 'pg.utils'").
 * Every gate here was green, because CI and every dev machine install the
 * NEWEST pg the range allows and the floor is never exercised.
 *
 * The floor is a claim about code, so it is checked against code: this script
 * installs the packed tarball next to EXACTLY the floor version and imports
 * every published entry point, ESM and CJS. Raising a pg requirement in src/
 * without raising the range now fails here instead of in a stranger's install.
 *
 * ## Usage
 *
 *   node scripts/check-pg-floor.mjs [path/to/turbine-orm-x.y.z.tgz]
 *
 * With no argument it runs `npm pack` itself (dist/ must already be built).
 * Called from the pack-smoke job of both ci.yml and release.yml, so a tag push
 * asks the same question a pull request does.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(message) {
  console.error(`check-pg-floor: ${message}`);
  process.exit(1);
}

let tarball = process.argv[2];
let packedHere = false;
if (!tarball) {
  if (!existsSync(join(repoRoot, 'dist'))) fail('dist/ is missing, run `npm run build` first');
  const out = run('npm', ['pack', '--silent'], repoRoot).trim().split('\n');
  tarball = join(repoRoot, out[out.length - 1]);
  packedHere = true;
}
tarball = resolve(tarball);
if (!existsSync(tarball)) fail(`tarball not found: ${tarball}`);
if (packedHere) process.on('exit', () => rmSync(tarball, { force: true }));

// Read the range from the PACKED manifest, not the working tree: the tarball is
// what a consumer installs, and prepack/postpack rewrite package.json.
const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
const range = manifest.dependencies?.pg;
if (typeof range !== 'string') fail('the packed manifest declares no pg dependency');
const floorMatch = /^(?:\^|>=|~)?\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
if (!floorMatch) {
  fail(`cannot derive a floor from pg range "${range}"; teach this script the new shape rather than skipping it`);
}
const floor = floorMatch[1];

// Every JS entry point the package publishes, straight from the exports map, so
// a new subpath is covered the day it is added. `./cli` is the bin's module and
// runs the CLI on import, so it is exercised by the bin check in pack-smoke.
const subpaths = Object.keys(manifest.exports ?? {})
  .filter((key) => key !== './package.json' && key !== './cli')
  .map((key) => (key === '.' ? 'turbine-orm' : `turbine-orm/${key.slice(2)}`));
if (subpaths.length < 2) fail(`expected several published entry points, found [${subpaths.join(', ')}]`);

const dir = mkdtempSync(join(tmpdir(), 'turbine-pg-floor-'));
try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pg-floor-probe', version: '1.0.0', private: true }));
  run('npm', ['install', tarball, `pg@${floor}`, '--no-audit', '--no-fund', '--ignore-scripts'], dir);

  // The probe is only meaningful if turbine-orm really resolves the floor pg. A
  // nested copy under turbine-orm/node_modules would mean the range excludes the
  // floor we just installed and the imports below would test a different pg.
  const installed = JSON.parse(readFileSync(join(dir, 'node_modules/pg/package.json'), 'utf8')).version;
  if (installed !== floor) fail(`asked npm for pg@${floor} and got ${installed}`);
  if (existsSync(join(dir, 'node_modules/turbine-orm/node_modules/pg'))) {
    fail(`turbine-orm installed its own nested pg instead of using pg@${floor}, so "${range}" excludes its own floor`);
  }

  const failures = [];
  for (const spec of subpaths) {
    for (const [label, code] of [
      ['import', `await import(${JSON.stringify(spec)});`],
      ['require', `require(${JSON.stringify(spec)});`],
    ]) {
      const args = label === 'import' ? ['--input-type=module', '-e', code] : ['-e', code];
      try {
        run(process.execPath, args, dir);
      } catch (err) {
        const detail = String(err.stderr || err.message)
          .split('\n')
          .find((line) => /Error|Cannot/.test(line));
        failures.push(`${label} ${spec}: ${detail ?? 'failed'}`);
      }
    }
  }
  if (failures.length > 0) {
    fail(
      `the packed tarball does not load against pg@${floor}, the floor of its own range "${range}":\n  ` +
        failures.join('\n  ') +
        '\nEither stop depending on the newer pg API or raise dependencies.pg to the version that ships it.',
    );
  }
  console.log(`check-pg-floor: ${subpaths.length} entry points load under import and require against pg@${floor} OK`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
