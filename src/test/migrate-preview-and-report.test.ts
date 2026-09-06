/**
 * turbine-orm, the migration CLI's two honesty rules.
 *
 * Both defects these cover are of the same shape and neither is visible from
 * inside the library: the COMMAND did one thing and the TERMINAL said another.
 * So this suite drives the real CLI as a subprocess (the harness in
 * prisma-migrate-command.integration.test.ts) and compares what it printed with
 * what the database holds afterwards. A unit test on `migrateUp` could not have
 * caught either one, because in both cases the library's return value was
 * already correct and the CLI dropped it.
 *
 *   RULE 1, a write is announced. `--allow-drift` REWRITES stored checksums.
 *     Whenever it does, the run that did it names the migration and both
 *     hashes. The report used to sit below an early return taken when nothing
 *     was pending, which is `--allow-drift`'s most common case by far, so the
 *     history table changed under "All migrations are up to date".
 *
 *   RULE 2, a refusal touches nothing, and a preview refuses what the run
 *     refuses. `--dry-run` used to green-light batches the real command rejects
 *     outright (an empty-UP migration; a rollback across a deleted file),
 *     because the pre-flight assertions live inside the runner a dry run never
 *     calls. Asserted as an EQUALITY between the two exit codes rather than
 *     against a fixed code, so it keeps holding if a refusal's code or wording
 *     changes.
 *
 * Every case uses its own schema, named per test and dropped in `after`.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/migrate-preview-and-report.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { skipGate } from './helpers.js';

const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const cliEntry = resolve(repoRoot, 'src/cli/index.ts');
const haveTsx = existsSync(resolve(repoRoot, 'node_modules/tsx'));
const url = process.env.DATABASE_URL;

const gate = skipGate(
  !url || !haveTsx,
  !url ? 'DATABASE_URL not set' : 'tsx is not installed in node_modules (run npm ci)',
);

/** Every schema this file creates, dropped once at the end. */
const createdSchemas: string[] = [];

interface CliRun {
  code: number;
  output: string;
}

/** Block the current thread; `execFileSync` gives us nowhere to await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runCliOnce(cwd: string, args: string[]): CliRun {
  try {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', DATABASE_URL: url ?? '' },
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` };
  }
}

/**
 * Run the real CLI in `cwd`, capturing both streams and the exit code.
 *
 * Retried ONLY on the migration lock refusal, and this is a property of the
 * harness rather than a softened assertion: the advisory lock is derived per
 * DATABASE, so every live migration suite in this repo contends for one lock
 * while `node:test` runs their files in parallel. That refusal is a different
 * outcome from anything under test here, and letting it stand would make this
 * file report a failure whose cause is another file.
 */
function runCli(cwd: string, args: string[]): CliRun {
  let run = runCliOnce(cwd, args);
  for (
    let attempt = 0;
    attempt < 40 && run.code !== 0 && /Could not acquire migration lock/.test(run.output);
    attempt++
  ) {
    sleepSync(150);
    run = runCliOnce(cwd, args);
  }
  return run;
}

/** A throwaway project directory with a `turbine/migrations` folder. */
function project(tag: string): string {
  const dir = join(tmpdir(), `turbine-preview-${tag}-${process.pid}-${Date.now()}`);
  mkdirSync(join(dir, 'turbine', 'migrations'), { recursive: true });
  return dir;
}

function migration(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, 'turbine', 'migrations', `${name}.sql`), body);
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function freshSchema(name: string): Promise<void> {
  createdSchemas.push(name);
  await withClient(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await c.query(`CREATE SCHEMA "${name}"`);
  });
}

/** The stored checksum of every applied migration, by name. */
async function storedChecksums(schema: string): Promise<Map<string, string>> {
  return withClient(async (c) => {
    const res = await c.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM "${schema}"."_turbine_migrations" ORDER BY name`,
    );
    return new Map(res.rows.map((r) => [r.name, r.checksum]));
  });
}

after(async () => {
  if (!url || createdSchemas.length === 0) return;
  await withClient(async (c) => {
    for (const schema of createdSchemas) await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
});

const CREATE_THING = (extra: string) =>
  `-- UP\nCREATE TABLE preview_thing (id serial primary key${extra});\n\n-- DOWN\nALTER TABLE preview_thing ADD COLUMN placeholder int;\n`;

// ---------------------------------------------------------------------------
// RULE 1: a re-baseline is announced, on every path
// ---------------------------------------------------------------------------

describe('--allow-drift announces the history rewrite it performs', () => {
  /**
   * Drive one command into the state that used to be silent: an applied
   * migration edited on disk, and NOTHING pending. Returns the run plus the
   * checksums either side of it.
   */
  async function driftThen(tag: string, command: string[]): Promise<{ run: CliRun; before: string; after: string }> {
    const schema = `qa78_${tag}`;
    await freshSchema(schema);
    const dir = project(tag);
    try {
      migration(dir, '20260101000000_thing', CREATE_THING(''));
      const applied = runCli(dir, ['migrate', 'up', '--schema', schema]);
      assert.equal(applied.code, 0, `setup failed:\n${applied.output}`);
      const before = (await storedChecksums(schema)).get('20260101000000_thing') ?? '';
      assert.notEqual(before, '', 'setup must have recorded a checksum');

      // Edit the applied file. Nothing is pending after this.
      migration(dir, '20260101000000_thing', CREATE_THING(', note text'));
      const run = runCli(dir, [...command, '--schema', schema]);
      const after = (await storedChecksums(schema)).get('20260101000000_thing') ?? '';
      return { run, before, after };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const [tag, command] of [
    ['up', ['migrate', 'up', '--allow-drift']],
    ['deploy', ['migrate', 'deploy', '--allow-drift']],
  ] as const) {
    gate.it(`migrate ${tag} names the migration and both hashes when it rewrites one`, async () => {
      const { run, before, after } = await driftThen(tag, [...command]);
      assert.equal(run.code, 0, `expected success; output:\n${run.output}`);

      // The premise: the stored checksum really did change. Without this the
      // assertions below could pass over a run that wrote nothing, which is
      // exactly how the defect stayed invisible.
      assert.notEqual(after, before, 'the stored checksum must have been rewritten');

      // The rule: the run that rewrote it said so, naming the file and enough
      // of each hash to audit the change from the terminal alone.
      assert.match(run.output, /20260101000000_thing/, `output must name the re-baselined migration:\n${run.output}`);
      assert.ok(
        run.output.includes(before.slice(0, 12)),
        `output must name the OLD checksum ${before.slice(0, 12)}:\n${run.output}`,
      );
      assert.ok(
        run.output.includes(after.slice(0, 12)),
        `output must name the NEW checksum ${after.slice(0, 12)}:\n${run.output}`,
      );
    });
  }

  gate.it('migrate down names them too, on the path where the rollback succeeds', async () => {
    const schema = 'qa78_downreport';
    await freshSchema(schema);
    const dir = project('downreport');
    try {
      migration(dir, '20260101000000_thing', CREATE_THING(''));
      assert.equal(runCli(dir, ['migrate', 'up', '--schema', schema]).code, 0);
      const before = (await storedChecksums(schema)).get('20260101000000_thing') ?? '';

      migration(dir, '20260101000000_thing', CREATE_THING(', note text'));
      const run = runCli(dir, ['migrate', 'down', '--allow-drift', '--schema', schema]);
      assert.equal(run.code, 0, `expected success; output:\n${run.output}`);
      // The row is gone, so the rewrite is only visible in what was printed.
      assert.match(run.output, /20260101000000_thing/);
      assert.ok(run.output.includes(before.slice(0, 12)), `output must name the OLD checksum:\n${run.output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  gate.it('a refused rollback rewrites NOTHING, which is what its message claims', async () => {
    // The destructive gate refuses a DROP TABLE in the DOWN section, and a
    // non-interactive shell cannot confirm. The checksum rewrite used to happen
    // BEFORE that gate, so the run aborted having already changed history and
    // then said "nothing was rolled back and no data was touched".
    const schema = 'qa78_refusal';
    await freshSchema(schema);
    const dir = project('refusal');
    try {
      migration(
        dir,
        '20260101000000_thing',
        '-- UP\nCREATE TABLE preview_thing (id int);\n\n-- DOWN\nDROP TABLE preview_thing;\n',
      );
      assert.equal(runCli(dir, ['migrate', 'up', '--schema', schema]).code, 0);
      const before = await storedChecksums(schema);

      migration(
        dir,
        '20260101000000_thing',
        '-- UP\nCREATE TABLE preview_thing (id int, note text);\n\n-- DOWN\nDROP TABLE preview_thing;\n',
      );
      const run = runCli(dir, ['migrate', 'down', '--allow-drift', '--schema', schema]);

      assert.notEqual(run.code, 0, `the destructive gate must refuse; output:\n${run.output}`);
      assert.deepEqual(
        [...(await storedChecksums(schema))],
        [...before],
        'a refused rollback must leave every stored checksum exactly as it found it',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// RULE 2: --dry-run accepts exactly what the real command accepts
// ---------------------------------------------------------------------------

describe('--dry-run accepts and refuses the same batches the real command does', () => {
  /**
   * Run `command` twice against IDENTICAL state, once with `--dry-run` and once
   * for real, and report both exit codes. Each run gets its own schema so the
   * real one cannot change what the preview would have seen.
   */
  async function previewAndReal(
    tag: string,
    command: string[],
    seed: (dir: string, schema: string) => Promise<void>,
  ): Promise<{ preview: CliRun; real: CliRun }> {
    const results: CliRun[] = [];
    for (const [index, extra] of [['dry', ['--dry-run']] as const, ['real', [] as string[]] as const].entries()) {
      const [half, flags] = extra;
      const schema = `qa78_${tag}_${half}`;
      await freshSchema(schema);
      const dir = project(`${tag}-${half}`);
      try {
        await seed(dir, schema);
        results[index] = runCli(dir, [...command, ...flags, '--schema', schema]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return { preview: results[0]!, real: results[1]! };
  }

  /** The untouched `migrate create` scaffold: a marker over no statement. */
  const EMPTY_UP = '-- UP\n-- Write your migration SQL here\n\n-- DOWN\n-- Write the reverse here\n';

  gate.it('migrate up: an empty-UP migration is refused by the preview too', async () => {
    const { preview, real } = await previewAndReal('emptyup', ['migrate', 'up'], async (dir) => {
      migration(dir, '20260102000000_empty', EMPTY_UP);
    });
    assert.notEqual(real.code, 0, `the real run must refuse; output:\n${real.output}`);
    assert.equal(preview.code, real.code, `preview and run must agree; preview said:\n${preview.output}`);
  });

  gate.it('migrate deploy: the CI shape, --dry-run in a check job then deploy on merge', async () => {
    const { preview, real } = await previewAndReal('emptydeploy', ['migrate', 'deploy'], async (dir) => {
      migration(dir, '20260102000000_empty', EMPTY_UP);
    });
    assert.notEqual(real.code, 0, `the real deploy must refuse; output:\n${real.output}`);
    assert.equal(preview.code, real.code, `preview and deploy must agree; preview said:\n${preview.output}`);
  });

  gate.it('migrate down: a rollback across a DELETED file is refused by the preview too', async () => {
    const { preview, real } = await previewAndReal(
      'deleted',
      ['migrate', 'down', '--step', '2'],
      async (dir, schema) => {
        migration(
          dir,
          '20260101000000_a',
          '-- UP\nCREATE TABLE preview_a (id int);\n\n-- DOWN\nALTER TABLE preview_a ADD COLUMN p int;\n',
        );
        migration(
          dir,
          '20260102000000_b',
          '-- UP\nCREATE TABLE preview_b (id int);\n\n-- DOWN\nALTER TABLE preview_b ADD COLUMN p int;\n',
        );
        assert.equal(runCli(dir, ['migrate', 'up', '--schema', schema]).code, 0);
        rmSync(join(dir, 'turbine', 'migrations', '20260101000000_a.sql'));
      },
    );
    assert.notEqual(real.code, 0, `the real rollback must refuse; output:\n${real.output}`);
    assert.equal(preview.code, real.code, `preview and run must agree; preview said:\n${preview.output}`);
  });

  gate.it('and both still accept a batch that is fine (anti-vacuous)', async () => {
    // Without this the three cases above would pass just as well against a
    // preview that refused EVERYTHING.
    const { preview, real } = await previewAndReal('good', ['migrate', 'up'], async (dir) => {
      migration(
        dir,
        '20260103000000_ok',
        '-- UP\nCREATE TABLE preview_ok (id int);\n\n-- DOWN\nDROP TABLE preview_ok;\n',
      );
    });
    assert.equal(preview.code, 0, `preview must accept a valid batch:\n${preview.output}`);
    assert.equal(real.code, 0, `the real run must accept it too:\n${real.output}`);
  });
});

// ---------------------------------------------------------------------------
// The schema guard, and how a bad --schema is CLASSIFIED
// ---------------------------------------------------------------------------

describe('a configured schema is checked before anything runs', () => {
  gate.it('turbine seed refuses a schema that does not exist, naming it', async () => {
    const dir = project('seedguard');
    try {
      writeFileSync(join(dir, 'seed.sql'), 'INSERT INTO qa78_absent_table (id) VALUES (1);\n');
      const run = runCli(dir, ['seed', '--schema', 'qa78_no_such_schema']);
      assert.notEqual(run.code, 0);
      // The rule: name the schema and say it does not exist. Before this the
      // seed reported the first unqualified statement's failure instead, which
      // names a TABLE and never mentions the schema that could not resolve.
      assert.match(run.output, /qa78_no_such_schema/, `must name the schema:\n${run.output}`);
      assert.match(run.output, /does not exist/i, `must say the schema is missing:\n${run.output}`);
      assert.doesNotMatch(run.output, /qa78_absent_table/, 'must not surface as a missing-table error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  gate.it('a --schema VALUE the CLI cannot pin is not reported as a connection failure', async () => {
    const dir = project('badschema');
    try {
      // A migration file has to exist, or `status` reports "no migrations" and
      // exits 0 before it ever opens a connection.
      migration(dir, '20260101000000_any', '-- UP\nSELECT 1;\n\n-- DOWN\nSELECT 1;\n');
      const run = runCli(dir, ['migrate', 'status', '--schema', 'bad name']);
      assert.notEqual(run.code, 0);
      // It is a ValidationError, and the handler must classify on the TYPE. It
      // used to fall into the connection branch because the message contains
      // the word "connection", so a typo was answered with three firewall hints.
      assert.match(run.output, /TURBINE_E003/, `must be a validation error:\n${run.output}`);
      assert.doesNotMatch(run.output, /Could not connect to database/);
      assert.doesNotMatch(run.output, /firewall/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  gate.it('a genuine connection failure still gets the connection banner (anti-vacuous)', () => {
    const dir = project('realconn');
    try {
      migration(dir, '20260101000000_any', '-- UP\nSELECT 1;\n\n-- DOWN\nSELECT 1;\n');
      const run = runCli(dir, ['migrate', 'status', '--url', 'postgresql://nobody@127.0.0.1:1/none']);
      assert.notEqual(run.code, 0);
      assert.match(run.output, /Could not connect to database/, `output:\n${run.output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The tracking table belongs to the schema that WRITES it
// ---------------------------------------------------------------------------

describe('the migration history read is the migration history written', () => {
  /** `url` with its own `search_path` startup parameter, as a role default would supply. */
  function urlInheriting(schema: string): string {
    const base = url ?? '';
    const q = base.indexOf('?');
    const params = new URLSearchParams(q === -1 ? '' : base.slice(q + 1));
    params.set('options', `-c search_path=${schema}`);
    return `${q === -1 ? base : base.slice(0, q)}?${params.toString()}`;
  }

  gate.it('a fresh schema does not adopt a tracking table it can merely SEE', async () => {
    // A pin EXTENDS the connection's search_path rather than replacing it, so
    // that a migration naming an extension type unqualified still resolves.
    // The cost, if the existence probe is not scoped, is that
    // `to_regclass('_turbine_migrations')` matches the FIRST such table
    // ANYWHERE on the path. A project moving to a new schema with an old
    // tracking table still sitting further down its path would then read the
    // OLD rows and report its own pending migrations as already applied, which
    // makes `migrate up` a silent no-op against the new schema.
    //
    // The connection here inherits `search_path=<donor>`, which is what a role
    // default looks like to the runner, so the donor's table sits one step
    // below the pinned target: visible, and not the one being written.
    //
    // The probe therefore asks about the schema the table would be CREATED in,
    // which is where `CREATE TABLE IF NOT EXISTS` puts it regardless of what is
    // visible further down (measured).
    const donor = 'qa78_history_donor';
    const fresh = 'qa78_history_fresh';
    await freshSchema(donor);
    await freshSchema(fresh);
    const dir = project('history');
    try {
      migration(dir, '20260101000000_thing', CREATE_THING(''));
      assert.equal(runCli(dir, ['migrate', 'up', '--schema', donor]).code, 0);
      assert.equal((await storedChecksums(donor)).size, 1, 'the donor schema must really hold a row');

      // The premise: from this connection, the donor's table is reachable.
      const visible = await withClient(async (c) => {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${donor}"."_turbine_migrations"`);
        return r.rows[0]?.n;
      });
      assert.equal(visible, '1', 'setup must leave a row for the fresh schema to wrongly adopt');

      const inheriting = urlInheriting(donor);
      const status = runCli(dir, ['migrate', 'status', '--url', inheriting, '--schema', fresh]);
      assert.equal(status.code, 0, status.output);
      // The summary line, not the table header, which carries the word
      // "Applied" as a COLUMN NAME whatever the rows say.
      assert.match(status.output, /0 applied, 1 pending/, `it must not adopt the donor's row:\n${status.output}`);

      const up = runCli(dir, ['migrate', 'up', '--url', inheriting, '--schema', fresh]);
      assert.equal(up.code, 0, up.output);
      assert.equal((await storedChecksums(fresh)).size, 1, 'the migration must actually run in the fresh schema');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A misspelled COMMAND outranks a bad flag value
// ---------------------------------------------------------------------------

describe('argument errors are reported in the order the reader can act on', () => {
  const dir = project('argorder');
  after(() => rmSync(dir, { recursive: true, force: true }));

  gate.it('an unknown command is reported even when a flag value is also bad', () => {
    // `--step 0` is invalid, but so is `genrate`, and fixing `--step` would not
    // help. The flag validator used to fire first and never mention the command.
    const run = runCli(dir, ['genrate', '--step', '0']);
    assert.notEqual(run.code, 0);
    assert.match(run.output, /Unknown command/, `output:\n${run.output}`);
    assert.match(run.output, /generate/, 'must offer the command they meant');
    assert.doesNotMatch(run.output, /--step/, 'must not lead with the flag');
  });

  gate.it('on a REAL command the bad flag value is still refused, with a banner (anti-vacuous)', () => {
    const run = runCli(dir, ['migrate', 'down', '--step', '0']);
    assert.notEqual(run.code, 0);
    assert.match(run.output, /--step/, `output:\n${run.output}`);
    // `failArg`, not a bare throw: the banner is what tells the reader this is
    // their command line rather than an internal crash.
    assert.match(run.output, /turbine-orm/, 'must print the banner every other CLI failure prints');
  });
});
