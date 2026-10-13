/**
 * Two CLI reporting gaps:
 *
 *   - A refused `localhost` connection printed an empty reason ("x " and
 *     "Failed to start Studio: "), because Node rejects it with an
 *     AggregateError whose message is empty. `errorText` reads the aggregated
 *     errors, and the top-level handler classifies by it.
 *   - `migrate status --exit-code` passed with a migration named `.SQL`,
 *     which the runner never runs.
 *
 * Run: npx tsx --test src/test/fx-eng-cli.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { errorText } from '../cli/error-text.js';
import { listIgnoredSqlFiles, listMigrationFiles, statusGateProblems } from '../cli/migrate.js';

describe('errorText', () => {
  it('reads an AggregateError with an empty message from the errors it aggregates', () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });
    const err = Object.assign(new AggregateError([refused('::1:5432'), refused('127.0.0.1:5432')], ''), {
      code: 'ECONNREFUSED',
    });
    assert.equal(err.message, '', 'the premise: Node leaves the message empty');
    assert.equal(errorText(err), 'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('prefers the message, then the aggregated errors, the cause, the code and the name', () => {
    assert.equal(errorText(new Error('boom')), 'boom');
    assert.equal(errorText(new AggregateError([new Error('a'), new Error('a'), new Error('b')], '')), 'a; b');
    assert.equal(errorText(new Error('', { cause: new Error('underneath') })), 'underneath');
    assert.equal(errorText(Object.assign(new Error(''), { code: 'ETIMEDOUT' })), 'ETIMEDOUT');
    assert.equal(errorText(new TypeError('')), 'TypeError');
    assert.equal(errorText('plain string'), 'plain string');
    assert.equal(errorText(undefined), 'undefined');
  });

  it('the CLI reads every caught error through it, not through `.message` directly', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/cli/index.ts'), 'utf8');
    assert.doesNotMatch(source, /(\w+) instanceof Error \? \1\.message : String\(\1\)/);
    const handler = source.slice(source.lastIndexOf('} catch (err) {'));
    assert.match(handler, /const message = errorText\(err\);/);
    assert.doesNotMatch(handler.slice(0, handler.indexOf('function isCliEntry')), /err\.message/);
  });
});

const repoRoot = process.cwd();
// tsx is a devDependency, so it is always there for the test lane.
const tsxLoader = resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs');

/** Run the CLI from source; returns its exit code and combined output. */
function runCli(args: string[], cwd: string): { code: number; output: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--import', pathToFileURL(tsxLoader).href, resolve(repoRoot, 'src/cli/index.ts'), ...args],
      {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: '', FORCE_COLOR: '0', NO_COLOR: '1' },
        timeout: 60_000,
      },
    );
    return { code: 0, output: out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A localhost port nothing listens on: bind an ephemeral port, then release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe('a refused localhost connection names its reason (CLI, end to end)', () => {
  const dir = join(tmpdir(), `turbine-fx-eng-cli-${process.pid}-${Date.now()}`);
  before(() => mkdirSync(dir, { recursive: true }));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('`turbine status` reports a refused connection with the address that refused it', async () => {
    const port = await closedPort();
    const { code, output } = runCli(['status', '--url', `postgresql://localhost:${port}/x`], dir);
    assert.equal(code, 1, output);
    assert.match(output, /Could not connect to database/, output);
    assert.match(output, new RegExp(`ECONNREFUSED [^\\n]*:${port}`), output);
  });
});

describe('`migrate status --exit-code` reports a migration whose extension is upper case', () => {
  const dir = join(tmpdir(), `turbine-fx-eng-sql-case-${process.pid}-${Date.now()}`);
  before(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '20260101000001_ok.sql'), '-- UP\nSELECT 1;\n-- DOWN\n');
    writeFileSync(join(dir, '20260101000002_shouting.SQL'), '-- UP\nSELECT 1;\n-- DOWN\n');
    writeFileSync(join(dir, '20260101000003_mixed.Sql'), '-- UP\nSELECT 1;\n-- DOWN\n');
    writeFileSync(join(dir, 'notes.txt'), 'not sql');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('lists it as a file that will never run, and the status gate fails on it', () => {
    assert.deepEqual(
      listMigrationFiles(dir).map((f) => f.filename),
      ['20260101000001_ok.sql'],
    );
    const ignored = listIgnoredSqlFiles(dir);
    assert.deepEqual(ignored, ['20260101000002_shouting.SQL', '20260101000003_mixed.Sql']);
    const problems = statusGateProblems({ pending: 0, drifted: 0, missing: 0 } as never, ignored);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /20260101000002_shouting\.SQL/);
  });
});
