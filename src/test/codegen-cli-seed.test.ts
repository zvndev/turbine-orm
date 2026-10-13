/**
 * `turbine seed` exit codes, through the real CLI entry point.
 *
 * The process exit code is the contract scripts and CI read: 0 when the seed
 * finished, non-zero when it did not. A TypeScript seed that does its work at
 * the top level with a typed client (no `defineSeed`) used to exit 1 after
 * succeeding, because the runner treated "no completion sentinel" as failure.
 * A seed that names `defineSeed` and never runs its callback is still a failure.
 *
 * Needs DATABASE_URL: the runner checks the configured schema exists before any
 * seed kind runs.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/codegen-cli-seed.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { type CliRun, makeProject, type Project, SRC } from './codegen-cli-fixture.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

describe('turbine seed: exit codes', () => {
  let project: Project;

  before(() => {
    project = makeProject('seed-exit', { databaseUrl: DATABASE_URL });
  });

  after(() => {
    project?.cleanup();
  });

  /** Write a seed file, point the config at it, and run `turbine seed`. */
  function runSeed(file: string, body: string): CliRun {
    project.write(file, body);
    project.write('turbine.config.js', `export default { seedFile: ${JSON.stringify(`./${file}`)} };\n`);
    return project.cli(['seed']);
  }

  const defineSeedImport = `import { defineSeed } from ${JSON.stringify(SRC.seed)};\n`;

  live.it('defineSeed that finishes exits 0 and reports completion', () => {
    const run = runSeed(
      'seed-ok.ts',
      `${defineSeedImport}export default defineSeed(async (db) => { await db.raw\`select 1\`; });\n`,
    );
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /Seed completed/);
    assert.doesNotMatch(run.output, /does not call defineSeed/);
  });

  live.it('defineSeed that throws exits non-zero', () => {
    const run = runSeed(
      'seed-throws.ts',
      `${defineSeedImport}export default defineSeed(async () => { throw new Error('boom'); });\n`,
    );
    assert.notEqual(run.status, 0, `a failing seed exited ${run.status}\n${run.output}`);
    assert.match(run.output, /Seed failed/);
  });

  live.it('a typed-client seed with no defineSeed exits 0 and says it cannot confirm the work', () => {
    const run = runSeed(
      'seed-typed.ts',
      [
        `import { TurbineClient } from ${JSON.stringify(SRC.client)};`,
        `const db = new TurbineClient({ connectionString: process.env.DATABASE_URL }, { tables: {}, enums: {} });`,
        'await db.raw`select 1`;',
        'await db.disconnect();',
        '',
      ].join('\n'),
    );
    assert.equal(run.status, 0, `a seed that finished exited ${run.status}\n${run.output}`);
    assert.match(run.output, /Seed completed/);
    assert.match(run.output, /does not call defineSeed/);
  });

  live.it('a typed-client seed that throws exits non-zero', () => {
    const run = runSeed(
      'seed-typed-throws.ts',
      [
        `import { TurbineClient } from ${JSON.stringify(SRC.client)};`,
        `const db = new TurbineClient({ connectionString: process.env.DATABASE_URL }, { tables: {}, enums: {} });`,
        'try {',
        '  await db.raw`select * from this_table_does_not_exist_cgcli`;',
        '} finally {',
        '  await db.disconnect();',
        '}',
        '',
      ].join('\n'),
    );
    assert.notEqual(run.status, 0, `a failing typed seed exited ${run.status}\n${run.output}`);
    assert.match(run.output, /Seed failed/);
  });

  live.it('a file that names defineSeed but never runs a callback is still a failure', () => {
    const run = runSeed('seed-never-runs.ts', `// TODO: wrap this in defineSeed\nconsole.log('loaded');\n`);
    assert.notEqual(run.status, 0, `a no-op seed exited ${run.status}\n${run.output}`);
    assert.match(run.output, /Seed failed/);
  });

  live.it('a SQL seed that runs exits 0, and one that errors exits non-zero', () => {
    const ok = runSeed('seed-ok.sql', 'select 1;\n');
    assert.equal(ok.status, 0, ok.output);
    const bad = runSeed('seed-bad.sql', 'select * from this_table_does_not_exist_cgcli;\n');
    assert.notEqual(bad.status, 0, `a failing SQL seed exited ${bad.status}\n${bad.output}`);
  });

  live.it('a JavaScript seed that runs exits 0, and one that throws exits non-zero', () => {
    const ok = runSeed(
      'seed-ok.js',
      `${defineSeedImport}export default defineSeed(async (db) => { await db.raw\`select 1\`; });\n`,
    );
    assert.equal(ok.status, 0, ok.output);
    const bad = runSeed('seed-bad.js', `export default async function seed() { throw new Error('boom'); }\n`);
    assert.notEqual(bad.status, 0, `a failing JS seed exited ${bad.status}\n${bad.output}`);
  });
});
