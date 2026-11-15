import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both the measured raw route and production's optional peer must resolve the
// root-lock installation, even with a nested benchmark driver installation.
export function rootDriver(manifest = new URL('../../package.json', import.meta.url)) {
  const path = manifest instanceof URL ? fileURLToPath(manifest) : manifest;
  const root = dirname(path),
    req = createRequire(path);
  const orm = createRequire(join(root, 'src/optional-peer-import.cts'));
  const rawPath = realpathSync(req.resolve('mysql2/promise'));
  const ormPath = realpathSync(orm.resolve('mysql2/promise'));
  assert.equal(rawPath, ormPath, 'raw and production ORM must resolve identical driver bytes');
  const packagePath = realpathSync(req.resolve('mysql2/package.json'));
  const driverRoot = dirname(packagePath);
  const version = JSON.parse(readFileSync(packagePath)).version;
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'))).packages['node_modules/mysql2'];
  assert.equal(version, '3.24.5', 'required pinned root native driver');
  assert.equal(lock.version, version, 'resolved driver matches root lock');
  const entrySha256 = createHash('sha256').update(readFileSync(rawPath)).digest('hex');
  return {
    req,
    driverRoot,
    mysql: req('mysql2/promise'),
    identity: {
      version,
      integrity: lock.integrity,
      raw: relative(root, rawPath),
      orm: relative(root, ormPath),
      entrySha256,
      indexSha256: createHash('sha256')
        .update(readFileSync(join(driverRoot, 'index.js')))
        .digest('hex'),
      packageSha256: createHash('sha256').update(readFileSync(packagePath)).digest('hex'),
    },
    assertRaw(raw) {
      assert.ok(
        raw instanceof req(join(driverRoot, 'lib/base/connection.js')),
        'actual raw/ORM connection is from the fingerprinted root driver',
      );
    },
    assertCommand(command, method) {
      assert.equal(
        command.constructor,
        req(join(driverRoot, `lib/commands/${method}.js`)),
        'actual native command comes from fingerprinted driver bytes',
      );
    },
  };
}
