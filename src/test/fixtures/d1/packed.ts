import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Unpack exactly the archive supplied by the required package runner. */
export function unpackD1(root: string): string {
  const archive = process.env.TURBINE_CORE_D1_TARBALL;
  assert.ok(archive && existsSync(archive), 'A real packed archive is required. Use npm run test:d1.');
  const destination = join(root, 'node_modules/turbine-orm');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  for (const entry of ['core', 'd1']) {
    assert.deepEqual(
      manifest.exports[`./${entry}`],
      {
        import: { types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.js` },
        require: { types: `./dist/cjs/${entry}.d.ts`, default: `./dist/cjs/${entry}.js` },
      },
      `Packed ${entry} export must already exist, with both conditions.`,
    );
  }
  assert.deepEqual(manifest.dependencies, { pg: '^8.15.0' });
  return destination;
}
