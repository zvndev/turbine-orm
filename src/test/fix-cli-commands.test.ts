/**
 * The CLI commands, through the real entry point (a subprocess).
 *
 *   - `push --dry-run --exit-code` exits 2 on a difference it reports as a warning
 *     (a unique index that is not unique, a removed enum label) and stays at 0 for
 *     what it only says it did not compare
 *   - `migrate status --exit-code` exits 2 for a misnamed `.sql` file, and names it
 *   - `migrate up|deploy|down` refuse a transaction-pooler URL before connecting
 *   - `generate` refuses a `columnTypes` table that is a typo when `include` is set
 *
 * The pooler tests need no database: the refusal happens before any connection.
 * The rest run in their own Postgres schema (`schema` in the project's config).
 *
 * Run: DATABASE_URL=... npx tsx --test --test-concurrency=1 src/test/fix-cli-commands.test.ts
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { stripAnsi } from '../cli/ui.js';
import { makeProject, type Project, SRC } from './codegen-cli-fixture.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');
const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;

interface Fixture {
  pgSchema: string;
  pool: pg.Pool;
  project: Project;
  /** Write turbine/schema.ts: `body` is the inside of the `defineSchema` object. */
  schema(body: string, options?: string): void;
  cleanup(): Promise<void>;
}

async function fixture(tag: string, config = ''): Promise<Fixture> {
  const pgSchema = `fcc_${tag}_${SUFFIX}`;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await pool.query(`CREATE SCHEMA "${pgSchema}"`);
  const project = makeProject(`fcc-${tag}`, { databaseUrl: DATABASE_URL });
  project.write('turbine.config.js', `export default { schema: ${JSON.stringify(pgSchema)}${config} };\n`);
  return {
    pgSchema,
    pool,
    project,
    schema(body, options = '') {
      project.write(
        'turbine/schema.ts',
        `import { defineSchema } from ${JSON.stringify(SRC.schemaBuilder)};\n` +
          `export default defineSchema({\n${body}\n}${options});\n`,
      );
    },
    async cleanup() {
      await pool.query(`DROP SCHEMA IF EXISTS "${pgSchema}" CASCADE`);
      await pool.end();
      project.cleanup();
    },
  };
}

const ID = `    id: { type: 'serial', primaryKey: true },`;
const users = (extra = '') => `  users: {\n${ID}\n    email: { type: 'text', notNull: true },\n${extra}\n  },`;

// ---------------------------------------------------------------------------
// push --dry-run --exit-code
// ---------------------------------------------------------------------------

describe('push --dry-run --exit-code exits 2 on a difference reported as a warning', () => {
  let f: Fixture;
  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('push');
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('a declared UNIQUE index over an existing non-unique one of that name', async () => {
    const lookup = (unique: boolean) =>
      users(`    indexes: [{ columns: ['email'], name: 'users_email_lookup', unique: ${unique} }],`);
    f.schema(lookup(false));
    assert.equal(f.project.cli(['push']).status, 0);
    f.schema(lookup(true));

    const plain = f.project.cli(['push', '--dry-run']);
    assert.equal(plain.status, 0, plain.output);
    assert.match(plain.output, /declared UNIQUE, existing index is not unique/);

    const gate = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(gate.status, 2, gate.output);
    assert.match(gate.output, /declared UNIQUE, existing index is not unique/);
    assert.match(gate.output, /not fully in sync/);
    assert.match(gate.output, /exiting 2/);
  });

  live.it('an enum label the database still has but the schema file dropped', async () => {
    // Its own database schema: a table left over from another test would make the diff
    // report an extra table, which already exits 2 and would hide what this proves.
    const enums = await fixture('enum');
    try {
      const tasks = `  tasks: {\n${ID}\n    level: { type: 'enum', enumName: 'fcc_level' },\n  },`;
      const build = (labels: string[]) =>
        enums.schema(tasks, `, { enums: { fcc_level: [${labels.map((l) => `'${l}'`).join(', ')}] } }`);
      build(['low', 'mid', 'high']);
      assert.equal(enums.project.cli(['push']).status, 0);
      build(['low', 'mid']);

      const plain = enums.project.cli(['push', '--dry-run']);
      assert.equal(plain.status, 0, plain.output);
      assert.match(plain.output, /labels \[high\] exist in the database but not the schema/);
      assert.match(plain.output, /not fully in sync/, 'the only thing it found is the warning');

      const gate = enums.project.cli(['push', '--dry-run', '--exit-code']);
      assert.equal(gate.status, 2, gate.output);
      assert.match(gate.output, /labels \[high\] exist in the database but not the schema/);
      assert.match(gate.output, /exiting 2/);
    } finally {
      await enums.cleanup();
    }
  });

  live.it('what is only disclosed as "not compared" stays at exit 0', async () => {
    const clean = await fixture('notcompared');
    try {
      clean.schema(users());
      assert.equal(clean.project.cli(['push']).status, 0);
      await clean.pool.query(`CREATE INDEX hand_made ON "${clean.pgSchema}".users (lower(email))`);
      const run = clean.project.cli(['push', '--dry-run', '--exit-code']);
      assert.equal(run.status, 0, run.output);
      assert.match(run.output, /Not compared/);
      assert.match(run.output, /hand_made/);
    } finally {
      await clean.cleanup();
    }
  });

  live.it('a CHECK expression Postgres rewrites is shown as a warning but does not fail the gate', async () => {
    const checked = await fixture('check');
    try {
      checked.schema(
        `  users: {\n${ID}\n    role: { type: 'text' },\n` +
          `    checks: [{ name: 'role_known', expression: "role IN ('a', 'b')" }],\n  },`,
      );
      assert.equal(checked.project.cli(['push']).status, 0);
      const run = checked.project.cli(['push', '--dry-run', '--exit-code']);
      assert.match(run.output, /check constraint "role_known"/, 'the cosmetic difference must still be shown');
      assert.equal(run.status, 0, run.output);
    } finally {
      await checked.cleanup();
    }
  });

  live.it('an undeclared index on a table that manages its indexes is a difference', async () => {
    const managed = await fixture('undeclared');
    try {
      managed.schema(users(`    indexes: [{ columns: ['email'] }],`));
      assert.equal(managed.project.cli(['push']).status, 0);
      await managed.pool.query(`CREATE INDEX stray ON "${managed.pgSchema}".users (id)`);
      const run = managed.project.cli(['push', '--dry-run', '--exit-code']);
      assert.equal(run.status, 2, run.output);
      assert.match(run.output, /index "stray" on "users" exists in the database but is not declared/);
    } finally {
      await managed.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// migrate status --exit-code: a misnamed file
// ---------------------------------------------------------------------------

describe('migrate status --exit-code counts a misnamed .sql file', () => {
  let f: Fixture;
  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('misnamed');
    f.project.write(
      'turbine/migrations/20260101000001_one.sql',
      '-- UP\nCREATE TABLE one (id int);\n\n-- DOWN\nDROP TABLE one;\n',
    );
    assert.equal(f.project.cli(['migrate', 'up']).status, 0);
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('a clean directory exits 0', () => {
    const run = f.project.cli(['migrate', 'status', '--exit-code']);
    assert.equal(run.status, 0, run.output);
  });

  live.it('a file that does not match YYYYMMDDHHMMSS_name.sql exits 2 and is named', () => {
    f.project.write('turbine/migrations/add_thing.sql', '-- UP\nSELECT 1;\n\n-- DOWN\nSELECT 1;\n');
    const gate = f.project.cli(['migrate', 'status', '--exit-code']);
    assert.equal(gate.status, 2, gate.output);
    assert.match(gate.output, /1 misnamed \.sql file\(s\) that will never run \(add_thing\.sql;/);
    assert.match(gate.output, /exiting 2/);
  });

  live.it('without the flag it is still a warning and exit 0', () => {
    const plain = f.project.cli(['migrate', 'status']);
    assert.equal(plain.status, 0, plain.output);
    assert.match(plain.output, /add_thing\.sql/);
  });

  live.it('says so alongside a pending migration, in one message', () => {
    f.project.write(
      'turbine/migrations/20260101000002_two.sql',
      '-- UP\nCREATE TABLE two (id int);\n\n-- DOWN\nDROP TABLE two;\n',
    );
    const gate = f.project.cli(['migrate', 'status', '--exit-code']);
    assert.equal(gate.status, 2, gate.output);
    assert.match(gate.output, /1 pending, 1 misnamed/);
  });
});

// ---------------------------------------------------------------------------
// migrate up|deploy|down refuse a pooler
// ---------------------------------------------------------------------------

describe('migrate up, deploy and down refuse a transaction pooler', () => {
  let project: Project;
  const POOLED = 'postgresql://app@db-pooler.fcc-pool.invalid:5432/app';
  const PORT_POOLED = 'postgresql://app@db.fcc-pool.invalid:6543/app';
  const DIRECT = 'postgresql://app@db.fcc-pool.invalid:5432/app';

  before(() => {
    project = makeProject('fcc-pooler');
    project.write('turbine.config.js', 'export default {};\n');
    project.write(
      'turbine/migrations/20260101000001_one.sql',
      '-- UP\nCREATE TABLE one (id int);\n\n-- DOWN\nDROP TABLE one;\n',
    );
  });
  after(() => project.cleanup());

  for (const sub of ['up', 'deploy', 'down']) {
    it(`migrate ${sub}: refuses a pooler hostname before connecting, and says why`, () => {
      const run = project.cli(['migrate', sub], { DATABASE_URL: POOLED });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, new RegExp(`turbine migrate ${sub} refuses to run through a connection pooler`));
      assert.match(run.output, /the hostname contains "pooler"/);
      assert.match(run.output, /session-level advisory lock/);
      assert.match(run.output, /--allow-pooler/);
      assert.doesNotMatch(run.output, /ENOTFOUND|ECONNREFUSED|getaddrinfo/, 'it must refuse before it connects');
      assert.doesNotMatch(
        run.output,
        /pg_prepared_statements|statement_timeout/,
        'the doctor paragraph is not for migrate',
      );
    });
  }

  it('refuses a pooling port too', () => {
    const run = project.cli(['migrate', 'up'], { DATABASE_URL: PORT_POOLED });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /port 6543 is a transaction-pooling port/);
  });

  it('--allow-pooler gets past the refusal (and then fails to reach the made-up host)', () => {
    const run = project.cli(['migrate', 'up', '--allow-pooler'], { DATABASE_URL: POOLED });
    assert.doesNotMatch(run.output, /refuses to run through a connection pooler/);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /ENOTFOUND|getaddrinfo|EAI_AGAIN|ECONNREFUSED|connect/i);
  });

  it('a direct endpoint is not refused', () => {
    const run = project.cli(['migrate', 'up'], { DATABASE_URL: DIRECT });
    assert.doesNotMatch(run.output, /refuses to run through a connection pooler/);
  });

  it('a dry run takes no lock, so it is not refused', () => {
    const run = project.cli(['migrate', 'up', '--dry-run'], { DATABASE_URL: POOLED });
    assert.doesNotMatch(run.output, /refuses to run through a connection pooler/);
  });

  it('status reads only, so it is not refused', () => {
    const run = project.cli(['migrate', 'status'], { DATABASE_URL: POOLED });
    assert.doesNotMatch(run.output, /refuses to run through a connection pooler/);
  });

  it('the migrate help names the flag and the reason', () => {
    const run = project.cli(['migrate', 'help']);
    assert.equal(run.status, 0, run.output);
    assert.match(
      stripAnsi(run.output),
      /--allow-pooler\s+Run up \/ deploy \/ down against a transaction pooler anyway/,
    );
    assert.match(stripAnsi(run.output), /migration lock is session-level/);
  });

  it('--allow-pooler is a known flag on migrate, and still unknown elsewhere', () => {
    const elsewhere = project.cli(['seed', '--allow-pooler']);
    assert.notEqual(elsewhere.status, 0, elsewhere.output);
    assert.match(elsewhere.output, /allow-pooler/);
  });
});

// ---------------------------------------------------------------------------
// generate: a columnTypes table that is a typo
// ---------------------------------------------------------------------------

describe('generate refuses a columnTypes key naming no table, even with include set', () => {
  let f: Fixture;

  async function configure(columnTypes: Record<string, string>, include = "['users']"): Promise<void> {
    writeFileSync(
      join(f.project.dir, 'turbine.config.js'),
      `export default { schema: ${JSON.stringify(f.pgSchema)}, include: ${include}, ` +
        `columnTypes: ${JSON.stringify(columnTypes)} };\n`,
    );
  }

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('gen');
    f.schema(`${users()}\n  orders: {\n${ID}\n    meta: { type: 'jsonb' },\n  },`);
    assert.equal(f.project.cli(['push']).status, 0);
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('names the misspelt table and its closest match', async () => {
    await configure({ 'usrs.settings': '{ theme: string }' });
    const run = f.project.cli(['generate']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /columnTypes key "usrs\.settings" names no table\. Did you mean "users"\?/);
  });

  live.it('a table that exists but include leaves out is still skipped', async () => {
    await configure({ 'orders.meta': '{ total: number }', 'users.email': "'a@b.c' | string" });
    const run = f.project.cli(['generate']);
    assert.equal(run.status, 0, run.output);
  });

  live.it('without include, a typo is refused as it always was', async () => {
    await configure({ 'usrs.settings': '{ theme: string }' }, '[]');
    const run = f.project.cli(['generate']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /names no table/);
  });

  live.it('a value that is not one type is refused with the text', async () => {
    await configure({ 'users.email': 'string; }' });
    const run = f.project.cli(['generate']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /must be one TypeScript type on one line/);
    assert.match(run.output, /string; \}/);
    assert.match(run.output, /";" outside any brackets/);
  });
});

// ---------------------------------------------------------------------------
// push: a tsType in the schema file that is not one type
// ---------------------------------------------------------------------------

describe('a schema file with a tsType that is not one type', () => {
  let f: Fixture;
  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('tstype');
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('push refuses to load it and shows the text', () => {
    f.schema(`  users: {\n${ID}\n    settings: { type: 'jsonb', tsType: 'unknown // later' },\n  },`);
    const run = f.project.cli(['push', '--dry-run']);
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /Invalid column "tsType" "unknown \/\/ later"/);
    assert.match(run.output, /no comments/);
  });
});
