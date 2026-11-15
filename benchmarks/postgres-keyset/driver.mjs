import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';

export function rootDriver(root) {
  const require = createRequire(join(root, 'package.json'));
  const entry = require.resolve('pg');
  assert.ok(realpathSync(entry).startsWith(realpathSync(join(root, 'node_modules/pg')) + sep));
  const version = JSON.parse(readFileSync(require.resolve('pg/package.json'))).version;
  const lockedVersion = JSON.parse(readFileSync(join(root, 'package-lock.json'))).packages['node_modules/pg'].version;
  assert.equal(version, lockedVersion, 'Executed pg driver must match root lock');
  return { driver: require('pg'), entry, version, lockedVersion };
}
