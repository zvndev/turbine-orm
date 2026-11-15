import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function requiredFile(filename, label) {
  assert.ok(
    filename && existsSync(filename) && statSync(filename).isFile(),
    `${label} is required: ${filename || '(unset)'}`,
  );
  return resolve(filename);
}

export function prerequisite(engine, env = process.env, version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 24 || (major === 24 && minor >= 10), 'Native lifecycle verification requires Node >=24.10');
  if (engine === 'mysql') {
    assert.ok(env.MYSQL_BASEDIR, 'MYSQL_BASEDIR is required; no external service is borrowed');
    requiredFile(join(env.MYSQL_BASEDIR, 'bin/mysqld'), 'Native MySQL binary');
  }
}

export function assertRows(actual, expected, label = 'row effect') {
  assert.ok(expected.length, `${label}: expected rows must be nonempty`);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, `${label}: exact stored rows differ`);
}

export function scrub(value, root = '') {
  let result = String(value).replace(/\b(?:mysql|mssql|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, '[database URL withheld]');
  if (root) result = result.split(root).join('$FIXTURE');
  return result;
}

export function command(report, root, cwd, executable, args, env, expected = 0) {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const step = {
    cwd: scrub(cwd, root),
    command: scrub([executable, ...args].join(' '), root),
    expectedExit: expected,
    exit: result.status,
    signal: result.signal,
    stdout: scrub(result.stdout ?? '', root),
    stderr: scrub(result.stderr ?? '', root),
    error: result.error ? scrub(result.error.message, root) : null,
    elapsedMs: Date.now() - started,
  };
  report.steps.push(step);
  assert.equal(result.status, expected, `${step.command}\n${step.stdout}\n${step.stderr}\n${step.error ?? ''}`);
  assert.equal(result.signal, null, `${step.command}: unexpected signal`);
  return { ...result, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

export function configFile(project) {
  return requiredFile(join(project, 'turbine.config.ts'), 'Consumer config');
}

export function artifact(filename) {
  const path = requiredFile(filename, 'Built package tarball');
  return { path, sha256: sha256(readFileSync(path)), bytes: statSync(path).size };
}
