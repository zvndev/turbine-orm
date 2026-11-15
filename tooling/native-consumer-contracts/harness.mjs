import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifact, requiredFile } from '../lifecycle-examples/harness.mjs';
export const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;

export { assertRows, command, sha256 } from '../lifecycle-examples/harness.mjs';
export { files, installedPayload } from '../lifecycle-upgrades/harness.mjs';
export const archivePin = 'ab9edec43d3801c10e76b5054db3a9bcd15cee00bbd2ccccd25faedea9dd5116';
export function pinnedArchive(path, pin) {
  assert.match(pin ?? '', /^[a-f0-9]{64}$/, 'Explicit archive SHA256 pin required');
  const result = artifact(path);
  assert.equal(result.sha256, pin, 'Archive SHA256 does not match pin');
  return result;
}
export function prerequisites(engine, env, version = process.versions.node) {
  assert.ok(['sqlite', 'postgresql', 'mysql', 'all'].includes(engine), 'Unknown required native engine');
  assert.ok(Number(version.split('.')[0]) >= 22, 'Native contracts require Node >=22');
  if (engine === 'mysql' || engine === 'all') {
    assert.ok(env.MYSQL_BASEDIR, 'MYSQL_BASEDIR required; no external service is borrowed');
    requiredFile(join(env.MYSQL_BASEDIR, 'bin/mysqld'), 'Native MySQL binary');
  }
  if (engine === 'postgresql' || engine === 'all') {
    assert.ok(env.PG_PREFIX, 'PG_PREFIX required; no external service is borrowed');
    for (const name of ['initdb', 'postgres'])
      requiredFile(join(env.PG_PREFIX, 'bin', name), 'Native PostgreSQL binary');
    requiredFile(join(env.PG_PREFIX, 'share/postgresql/postgres.bki'), 'PostgreSQL catalog');
  }
}
export function compilerDiagnostics(output, source, statements) {
  assert.ok(statements.length, 'Type-negative controls must be nonempty');
  for (const [index, statement] of statements.entries()) {
    assert.ok(source.includes(statement), 'Missing type-negative statement');
    const line = source.slice(0, source.indexOf(statement)).split('\n').length;
    // The last three controls specifically require a missing property, not
    // an incidental implicit-any diagnostic on the same source line.
    const code = index >= 4 ? '2339' : '(?:2322|2345|2353)';
    assert.ok(
      new RegExp(`invalid\\.ts\\(${line},\\d+\\): error TS${code}\\b`).test(output),
      `Missing compiler refusal at line ${line}: ${statement}\n${output}`,
    );
  }
}
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
