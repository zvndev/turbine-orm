/**
 * Migration CLI and DDL behavior that needs no database:
 *
 *   - migration filenames are stamped in UTC
 *   - lossless type widenings are recognized, and nothing else is
 *   - enum values are inserted where the schema declares them
 *   - a dropped column gets an IRREVERSIBLE note as its DOWN
 *   - the destructive gate excuses a checked widening marker and nothing else
 *   - the migration lock can be waited for
 *   - the new flags parse, and misplaced ones are refused
 *   - the status summary and the pending-migration refusal
 *
 * Run: npx tsx --test src/test/migrations-pure.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { DatabaseAdapter } from '../adapters/index.js';
import { parseArgs } from '../cli/index.js';
import {
  acquireMigrationLockWaiting,
  buildDiffMigrationBody,
  collectUpDestructive,
  formatPendingAutoRefusal,
  formatTimestamp,
  hasExecutableStatement,
  type MigrationFile,
  type MigrationLockClient,
  type MigrationStatus,
  pendingMigrationFiles,
  rollbacksWithoutSql,
  scanMigrationDestructive,
  summarizeMigrationStatus,
  wideningMarker,
} from '../cli/migrate.js';
import { diffEnumValues, findDestructivePushStatements, isLosslessWidening, type TypeWidening } from '../schema-sql.js';

// ---------------------------------------------------------------------------
// UTC filenames
// ---------------------------------------------------------------------------

describe('migration filenames are stamped in UTC', () => {
  const instant = new Date('2026-03-27T23:59:58.000Z');

  it('prints the UTC digits whatever the process time zone is', () => {
    const original = process.env.TZ;
    try {
      const seen = new Set<string>();
      const localHours = new Set<number>();
      for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        seen.add(formatTimestamp(instant));
        localHours.add(instant.getHours());
      }
      assert.deepEqual([...seen], ['20260327235958']);
      // Control: the zones really did disagree about the local hour, so the
      // equality above would have failed for a local-time implementation.
      assert.ok(
        localHours.size > 1,
        `the zones did not differ (${[...localHours].join(',')}); the test proves nothing`,
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('two people creating a migration in different zones get ordered stamps', () => {
    const earlier = new Date('2026-03-27T07:00:00.000Z'); // 09:00 in Berlin
    const later = new Date('2026-03-27T13:00:00.000Z'); // 08:00 in New York
    assert.ok(formatTimestamp(earlier) < formatTimestamp(later));
  });
});

// ---------------------------------------------------------------------------
// Lossless widening
// ---------------------------------------------------------------------------

describe('isLosslessWidening', () => {
  const widening: Array<[string, string]> = [
    ['VARCHAR(50)', 'VARCHAR(100)'],
    ['VARCHAR(50)', 'VARCHAR(50)'],
    ['VARCHAR(50)', 'VARCHAR'],
    ['VARCHAR(50)', 'TEXT'],
    ['character varying(50)', 'text'],
    ['TEXT', 'TEXT'],
    ['SMALLINT', 'INTEGER'],
    ['SMALLINT', 'BIGINT'],
    ['INTEGER', 'BIGINT'],
    ['int4', 'int8'],
    ['INTEGER', 'NUMERIC'],
    ['BIGINT', 'NUMERIC(19)'],
    ['INTEGER', 'NUMERIC(12, 2)'],
    ['NUMERIC(10, 2)', 'NUMERIC(12, 2)'],
    ['NUMERIC(10, 2)', 'NUMERIC(14, 4)'],
    ['NUMERIC(10, 2)', 'NUMERIC'],
    ['VARCHAR(5)[]', 'VARCHAR(9)[]'],
    ['INTEGER[]', 'BIGINT[]'],
  ];
  const notWidening: Array<[string, string, string]> = [
    ['VARCHAR(100)', 'VARCHAR(50)', 'shorter'],
    ['TEXT', 'VARCHAR(100)', 'text to bounded'],
    ['TEXT', 'VARCHAR', 'text to varchar is a different type'],
    ['VARCHAR', 'VARCHAR(100)', 'unbounded to bounded'],
    ['BIGINT', 'INTEGER', 'narrower integer'],
    ['INTEGER', 'SMALLINT', 'narrower integer'],
    ['INTEGER', 'NUMERIC(5)', 'not enough digits for an integer'],
    ['BIGINT', 'NUMERIC(10, 2)', 'not enough integer digits'],
    ['NUMERIC(10, 2)', 'NUMERIC(10, 4)', 'fewer integer digits'],
    ['NUMERIC(10, 2)', 'NUMERIC(8, 2)', 'smaller'],
    ['NUMERIC(10, 2)', 'NUMERIC(10, 0)', 'drops decimals'],
    ['NUMERIC', 'NUMERIC(10, 2)', 'unbounded to bounded'],
    ['NUMERIC', 'INTEGER', 'rounds'],
    ['INTEGER', 'REAL', 'float is lossy'],
    ['INTEGER', 'DOUBLE PRECISION', 'outside the vocabulary'],
    ['REAL', 'DOUBLE PRECISION', 'outside the vocabulary'],
    ['TIMESTAMP', 'TIMESTAMPTZ', 'reinterprets the value'],
    ['JSON', 'JSONB', 'drops duplicate keys'],
    ['INTEGER', 'TEXT', 'cross family'],
    ['VARCHAR(5)', 'VARCHAR(9)[]', 'scalar to array'],
    ['VARCHAR(5)[]', 'VARCHAR(2)[]', 'narrower element'],
    ['totally unknown', 'whatever', 'unparseable'],
    ['"MyEnum"', '"MyEnum"', 'user types are never claimed lossless'],
  ];

  for (const [from, to] of widening) {
    it(`${from} -> ${to} is lossless`, () => {
      assert.equal(isLosslessWidening(from, to), true, `${from} -> ${to}`);
    });
  }
  for (const [from, to, why] of notWidening) {
    it(`${from} -> ${to} is not lossless (${why})`, () => {
      assert.equal(isLosslessWidening(from, to), false, `${from} -> ${to}`);
    });
  }
});

describe('the destructive gate and widenings', () => {
  const widen = `ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
  const narrow = `ALTER TABLE "users" ALTER COLUMN "age" TYPE SMALLINT;`;
  const widening: TypeWidening = { statement: widen, from: 'INTEGER', to: 'BIGINT' };

  it('push excuses exactly the statements the diff proved lossless', () => {
    assert.equal(findDestructivePushStatements([widen], [widening]).length, 0);
    assert.equal(findDestructivePushStatements([widen, narrow], [widening]).length, 1);
    assert.equal(findDestructivePushStatements([narrow], [widening]).length, 1);
  });

  it('without the diff proof, a widening is still flagged (the old behavior)', () => {
    assert.equal(findDestructivePushStatements([widen]).length, 1);
  });

  it('a look-alike statement is not excused by a proof for another', () => {
    const other = `ALTER TABLE "users" ALTER COLUMN "name" TYPE BIGINT;`;
    assert.equal(findDestructivePushStatements([other], [widening]).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Enum placement
// ---------------------------------------------------------------------------

describe('diffEnumValues keeps the declared order', () => {
  it('a trailing label is a bare ADD VALUE, as before', () => {
    const { statements, warnings } = diffEnumValues('s', ['a', 'b', 'c'], ['a', 'b']);
    assert.deepEqual(statements, [`ALTER TYPE "s" ADD VALUE 'c';`]);
    assert.deepEqual(warnings, []);
  });

  it('a middle label goes AFTER its predecessor', () => {
    const { statements, warnings } = diffEnumValues('s', ['a', 'x', 'b'], ['a', 'b']);
    assert.deepEqual(statements, [`ALTER TYPE "s" ADD VALUE 'x' AFTER 'a';`]);
    assert.deepEqual(warnings, []);
  });

  it('a leading label goes BEFORE its successor', () => {
    const { statements, warnings } = diffEnumValues('s', ['x', 'a', 'b'], ['a', 'b']);
    assert.deepEqual(statements, [`ALTER TYPE "s" ADD VALUE 'x' BEFORE 'a';`]);
    assert.deepEqual(warnings, []);
  });

  it('several new labels chain off each other in declared order', () => {
    const { statements, warnings } = diffEnumValues('s', ['a', 'x', 'y', 'b'], ['a', 'b']);
    assert.deepEqual(statements, [
      `ALTER TYPE "s" ADD VALUE 'x' AFTER 'a';`,
      `ALTER TYPE "s" ADD VALUE 'y' AFTER 'x';`,
    ]);
    assert.deepEqual(warnings, []);
  });

  it('a new label that only has new labels around it is still placed', () => {
    const { statements } = diffEnumValues('s', ['x', 'y', 'a'], ['a']);
    assert.deepEqual(statements, [
      `ALTER TYPE "s" ADD VALUE 'x' BEFORE 'a';`,
      `ALTER TYPE "s" ADD VALUE 'y' AFTER 'x';`,
    ]);
  });

  it('a label with the quote character is escaped in its position', () => {
    const { statements } = diffEnumValues('s', ["it's", 'b'], ['b']);
    assert.deepEqual(statements, [`ALTER TYPE "s" ADD VALUE 'it''s' BEFORE 'b';`]);
  });

  it('a reorder of existing labels warns and emits nothing', () => {
    const { statements, warnings } = diffEnumValues('s', ['b', 'a'], ['a', 'b']);
    assert.deepEqual(statements, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cannot reorder enum values in place/);
    assert.match(warnings[0]!, /\[b, a\].*\[a, b\]/);
  });

  it('an add that is also a reorder adds the label and still warns', () => {
    const { statements, warnings } = diffEnumValues('s', ['c', 'b', 'a'], ['a', 'b']);
    assert.equal(statements.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cannot reorder/);
  });

  it('a removed label still warns that Postgres cannot remove it', () => {
    const { statements, warnings } = diffEnumValues('s', ['a'], ['a', 'b']);
    assert.deepEqual(statements, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cannot remove enum values in place/);
  });

  it('an unchanged enum is silent', () => {
    assert.deepEqual(diffEnumValues('s', ['a', 'b'], ['a', 'b']), { statements: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// Diff-generated migration bodies
// ---------------------------------------------------------------------------

describe('buildDiffMigrationBody', () => {
  const dropUp = `ALTER TABLE "users" DROP COLUMN "bio";`;
  const placeholder = [
    '-- IRREVERSIBLE: this migration drops "users"."bio", and the data in it cannot be restored automatically.',
    '-- To roll back, restore the data from a backup and re-add the column by hand, for example:',
    '-- ALTER TABLE "users" ADD COLUMN "bio" TEXT;',
  ].join('\n');

  it('a dropped column carries its IRREVERSIBLE note into DOWN, untouched and un-semicoloned', () => {
    const body = buildDiffMigrationBody({ statements: [dropUp], reverseStatements: [placeholder] });
    assert.equal(body.down, placeholder);
    assert.ok(!body.down.includes('-- ALTER TABLE "users" ADD COLUMN "bio" TEXT;;'));
    assert.equal(body.destructiveDown.length, 0, 'a comment is not a destructive statement');
    assert.equal(body.destructiveUp.length, 1);
  });

  it('every DROP in UP has an IRREVERSIBLE line in DOWN, for several drops', () => {
    const drops = ['a', 'b', 'c'].map((c) => `ALTER TABLE "t" DROP COLUMN "${c}";`);
    const notes = ['a', 'b', 'c'].map(
      (c) => `-- IRREVERSIBLE: this migration drops "t"."${c}", and the data in it cannot be restored automatically.`,
    );
    const body = buildDiffMigrationBody({ statements: drops, reverseStatements: notes });
    const dropCount = (body.up.match(/DROP COLUMN/g) ?? []).length;
    const noteCount = (body.down.match(/IRREVERSIBLE/g) ?? []).length;
    assert.equal(dropCount, 3);
    assert.equal(noteCount, dropCount);
  });

  it('a proven widening gets its marker and is not reported destructive', () => {
    const stmt = `ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    const body = buildDiffMigrationBody({
      statements: [stmt],
      reverseStatements: [`ALTER TABLE "users" ALTER COLUMN "age" TYPE INTEGER;`],
      widenings: [{ statement: stmt, from: 'INTEGER', to: 'BIGINT' }],
    });
    assert.match(body.up, /-- turbine:widening INTEGER -> BIGINT\nALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;/);
    assert.equal(body.destructiveUp.length, 0);
    assert.doesNotMatch(body.up, /!! DESTRUCTIVE/, 'no inline flag on the widening itself');
    // Its reverse is a narrowing, and is still flagged on the way down.
    assert.equal(body.destructiveDown.length, 1);
  });

  it('the file banner says only DOWN is destructive when UP is clean, and the full banner when UP is not', () => {
    const stmt = `ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    const downOnly = buildDiffMigrationBody({
      statements: [stmt],
      reverseStatements: [`ALTER TABLE "users" ALTER COLUMN "age" TYPE INTEGER;`],
      widenings: [{ statement: stmt, from: 'INTEGER', to: 'BIGINT' }],
    });
    assert.match(downOnly.up, /Only the DOWN section is destructive/);
    assert.doesNotMatch(downOnly.up, /refuses/, 'UP runs without a prompt, so the banner must not say it is refused');

    const both = buildDiffMigrationBody({
      statements: [`ALTER TABLE "users" ALTER COLUMN "age" TYPE SMALLINT;`],
      reverseStatements: [`ALTER TABLE "users" ALTER COLUMN "age" TYPE INTEGER;`],
    });
    assert.doesNotMatch(both.up, /Only the DOWN section is destructive/);
    assert.match(both.up, /refuses/);
  });

  it('accepts statements with or without a trailing semicolon, and skips empty ones', () => {
    const body = buildDiffMigrationBody({
      statements: ['', 'ALTER TABLE "t" ADD COLUMN "a" text', 'ALTER TABLE "t" ADD COLUMN "b" text;'],
      reverseStatements: [],
    });
    assert.equal(body.up, 'ALTER TABLE "t" ADD COLUMN "a" text;\nALTER TABLE "t" ADD COLUMN "b" text;');
  });

  it('marks a widening whose statement came without a semicolon', () => {
    const body = buildDiffMigrationBody({
      statements: ['ALTER TABLE "t" ALTER COLUMN "n" TYPE BIGINT'],
      reverseStatements: [],
      widenings: [{ statement: 'ALTER TABLE "t" ALTER COLUMN "n" TYPE BIGINT;', from: 'INTEGER', to: 'BIGINT' }],
    });
    assert.equal(body.up, '-- turbine:widening INTEGER -> BIGINT\nALTER TABLE "t" ALTER COLUMN "n" TYPE BIGINT;');
    assert.equal(body.destructiveUp.length, 0);
  });

  it('says so when the diff has no statements at all', () => {
    const body = buildDiffMigrationBody({ statements: [], reverseStatements: [] });
    assert.match(body.up, /no statements: schema already matches the database/);
  });

  it('a type change with no proof is flagged as before', () => {
    const stmt = `ALTER TABLE "users" ALTER COLUMN "age" TYPE SMALLINT;`;
    const body = buildDiffMigrationBody({ statements: [stmt], reverseStatements: [] });
    assert.equal(body.destructiveUp.length, 1);
    assert.match(body.up, /!! DESTRUCTIVE \[alter-column-type\]/);
  });
});

describe('scanMigrationDestructive and the widening marker', () => {
  const widen = (from: string, to: string, tableCol = '"users" ALTER COLUMN "age"') =>
    `${wideningMarker({ from, to })}\nALTER TABLE ${tableCol} TYPE ${to};`;

  it('excuses a marked, checked widening', () => {
    assert.deepEqual(scanMigrationDestructive(widen('INTEGER', 'BIGINT')), []);
    assert.deepEqual(scanMigrationDestructive(widen('VARCHAR(50)', 'VARCHAR(100)')), []);
  });

  it('is case and spacing tolerant in the marker', () => {
    const sql = `--   TURBINE:WIDENING   integer   ->   bigint\nALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    assert.deepEqual(scanMigrationDestructive(sql), []);
  });

  it('finds the marker below other comment lines and blank lines', () => {
    const sql = `-- backfill first\n\n${widen('INTEGER', 'BIGINT')}`;
    assert.deepEqual(scanMigrationDestructive(sql), []);
  });

  it('a note above the statement is not a marker', () => {
    const sql = `-- just a note\nALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    assert.equal(scanMigrationDestructive(sql).length, 1);
  });

  it('ignores a trailing comment and keeps every other destructive kind', () => {
    const sql = `${widen('INTEGER', 'BIGINT')}\nDROP TABLE "old";\n-- done`;
    const hits = scanMigrationDestructive(sql);
    assert.deepEqual(
      hits.map((h) => h.kind),
      ['drop-table'],
    );
  });

  it('an unmarked narrowing beside a marked widening is still reported', () => {
    const sql = `${widen('INTEGER', 'BIGINT')}\nALTER TABLE "users" ALTER COLUMN "qty" TYPE SMALLINT;`;
    const hits = scanMigrationDestructive(sql);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.target, /qty/);
  });

  it('collectUpDestructive skips a file with no UP section and reports the marked-but-narrowing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mig-up-'));
    try {
      const file = (name: string, body: string): MigrationFile => {
        const path = join(dir, name);
        writeFileSync(path, body);
        return { name: name.replace(/\.sql$/, ''), filename: name, path, timestamp: name.slice(0, 14) };
      };
      const empty = file('20260101000001_empty.sql', '-- UP\n\n-- DOWN\nSELECT 1;\n');
      const narrowing = file(
        '20260101000002_narrow.sql',
        '-- UP\nALTER TABLE "users" ALTER COLUMN "age" TYPE SMALLINT;\n\n-- DOWN\n-- none\n',
      );
      const offenders = collectUpDestructive([empty, narrowing]);
      assert.deepEqual(
        offenders.map((o) => o.file),
        ['20260101000002_narrow.sql'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a marker whose claim is itself a narrowing', () => {
    const hits = scanMigrationDestructive(widen('BIGINT', 'SMALLINT'));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, 'alter-column-type');
  });

  it('refuses a marker that does not match the statement below it', () => {
    const sql = `${wideningMarker({ from: 'INTEGER', to: 'BIGINT' })}\nALTER TABLE "users" ALTER COLUMN "age" TYPE SMALLINT;`;
    assert.equal(scanMigrationDestructive(sql).length, 1);
  });

  it('a marker excuses one statement, not an identical unmarked one beside it', () => {
    const marked = widen('INTEGER', 'BIGINT');
    const bare = `ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    assert.equal(scanMigrationDestructive(`${marked}\n${bare}`).length, 1);
  });

  it('a marker does not excuse a different statement kind under it', () => {
    const sql = `${wideningMarker({ from: 'INTEGER', to: 'BIGINT' })}\nDROP TABLE users;`;
    const hits = scanMigrationDestructive(sql);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, 'drop-table');
  });

  it('a marker does not excuse a multi-action ALTER that also drops a column', () => {
    const sql = `${wideningMarker({ from: 'INTEGER', to: 'BIGINT' })}\nALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT, DROP COLUMN "bio";`;
    const kinds = scanMigrationDestructive(sql).map((h) => h.kind);
    assert.ok(kinds.length >= 1, `expected the statement to stay flagged, got ${JSON.stringify(kinds)}`);
  });

  it('without any marker the scanner is unchanged', () => {
    const sql = `ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    assert.equal(scanMigrationDestructive(sql).length, 1);
  });

  it('a marker inside a string or a dollar-quoted body excuses nothing', () => {
    const sql = `INSERT INTO notes VALUES ('-- turbine:widening INTEGER -> BIGINT');\nALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`;
    assert.equal(scanMigrationDestructive(sql).length, 1);
  });
});

describe('DOWN sections that run no SQL', () => {
  it('hasExecutableStatement ignores comments and blank lines', () => {
    assert.equal(hasExecutableStatement('-- only\n\n-- comments'), false);
    assert.equal(hasExecutableStatement(''), false);
    assert.equal(hasExecutableStatement('-- c\nSELECT 1;'), true);
  });

  it('rollbacksWithoutSql names the migrations whose DOWN is comments only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mig-down-'));
    try {
      const write = (name: string, down: string): MigrationFile => {
        const path = join(dir, `${name}.sql`);
        writeFileSync(path, `-- UP\nSELECT 1;\n\n-- DOWN\n${down}\n`);
        return { filename: `${name}.sql`, path, name, timestamp: name.slice(0, 14) };
      };
      const real = write('20260101000000_real', 'DROP TABLE IF EXISTS x;');
      const note = write('20260101000001_note', '-- IRREVERSIBLE: data cannot be restored automatically.');
      assert.deepEqual(
        rollbacksWithoutSql([real, note]).map((f) => f.name),
        ['20260101000001_note'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Waiting for the migration lock
// ---------------------------------------------------------------------------

describe('acquireMigrationLockWaiting', () => {
  /** An adapter that refuses `refusals` times and then grants the lock. */
  function adapter(refusals: number): { adapter: DatabaseAdapter; attempts: () => number; releases: () => number } {
    let attempts = 0;
    let releases = 0;
    const a = {
      name: 'fake',
      async acquireLock() {
        attempts++;
        return attempts > refusals;
      },
      async releaseLock() {
        releases++;
      },
    } as unknown as DatabaseAdapter;
    return { adapter: a, attempts: () => attempts, releases: () => releases };
  }
  const runner = { query: async () => ({}), end: async () => {} } as MigrationLockClient;
  const open = async () => runner;

  /** A clock the fake sleep advances, so no test waits in real time. */
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      slept,
    };
  }

  it('without a wait it is one attempt, as it always was', async () => {
    const f = adapter(1);
    const lock = await acquireMigrationLockWaiting(runner, 7, f.adapter, open);
    assert.equal(lock.acquired, false);
    assert.equal(f.attempts(), 1);
  });

  it('with a wait it retries until the holder lets go', async () => {
    const f = adapter(3);
    const c = clock();
    let announced = 0;
    const lock = await acquireMigrationLockWaiting(runner, 7, f.adapter, open, {
      timeoutMs: 60_000,
      intervalMs: 1000,
      onWait: () => announced++,
      now: c.now,
      sleep: c.sleep,
    });
    assert.equal(lock.acquired, true);
    assert.equal(f.attempts(), 4);
    assert.equal(announced, 1, 'the wait is announced once, not per retry');
    assert.deepEqual(c.slept, [1000, 1000, 1000]);
  });

  it('gives up at the deadline and reports the lock as not acquired', async () => {
    const f = adapter(Number.POSITIVE_INFINITY);
    const c = clock();
    const lock = await acquireMigrationLockWaiting(runner, 7, f.adapter, open, {
      timeoutMs: 2500,
      intervalMs: 1000,
      now: c.now,
      sleep: c.sleep,
    });
    assert.equal(lock.acquired, false);
    assert.equal(c.now(), 2500, 'it never sleeps past the deadline');
    assert.deepEqual(c.slept, [1000, 1000, 500]);
  });

  it('uses the real clock and a capped sleep when none is injected', async () => {
    const f = adapter(Number.POSITIVE_INFINITY);
    const started = Date.now();
    const lock = await acquireMigrationLockWaiting(runner, 7, f.adapter, open, { timeoutMs: 40 });
    assert.equal(lock.acquired, false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 30 && elapsed < 900, `waited ${elapsed}ms for a 40ms budget (the default interval is 1s)`);
    assert.ok(f.attempts() >= 2, 'it retried at least once');
  });

  it('does not wait when the first attempt succeeds', async () => {
    const f = adapter(0);
    const c = clock();
    let announced = 0;
    const lock = await acquireMigrationLockWaiting(runner, 7, f.adapter, open, {
      timeoutMs: 60_000,
      onWait: () => announced++,
      now: c.now,
      sleep: c.sleep,
    });
    assert.equal(lock.acquired, true);
    assert.equal(announced, 0);
    assert.deepEqual(c.slept, []);
  });
});

// ---------------------------------------------------------------------------
// Status summary and the pending refusal
// ---------------------------------------------------------------------------

describe('migration status helpers', () => {
  const file = (name: string): MigrationFile => ({
    filename: `${name}.sql`,
    path: `/x/${name}.sql`,
    name,
    timestamp: name.slice(0, 14),
  });
  const status = (name: string, extra: Partial<MigrationStatus>): MigrationStatus => ({
    file: file(name),
    applied: false,
    ...extra,
  });

  it('a clean history is ok', () => {
    const s = [status('20260101000000_a', { applied: true, checksumValid: true })];
    assert.deepEqual(summarizeMigrationStatus(s), { pending: 0, drifted: 0, missing: 0, ok: true });
    assert.deepEqual(summarizeMigrationStatus([]), { pending: 0, drifted: 0, missing: 0, ok: true });
  });

  it('pending, drifted and missing each make it not ok, and are counted apart', () => {
    const s = [
      status('20260101000000_a', { applied: true, checksumValid: true }),
      status('20260101000001_b', { applied: false }),
      status('20260101000002_c', { applied: true, checksumValid: false }),
      status('20260101000003_d', { applied: true, checksumValid: false, missingFile: true }),
    ];
    assert.deepEqual(summarizeMigrationStatus(s), { pending: 1, drifted: 1, missing: 1, ok: false });
    for (const one of s.slice(1)) {
      assert.equal(summarizeMigrationStatus([one]).ok, false, one.file.name);
    }
  });

  it('pendingMigrationFiles returns the unapplied files in order', () => {
    const s = [
      status('20260101000000_a', { applied: true, checksumValid: true }),
      status('20260101000001_b', {}),
      status('20260101000002_c', {}),
    ];
    assert.deepEqual(
      pendingMigrationFiles(s).map((f) => f.filename),
      ['20260101000001_b.sql', '20260101000002_c.sql'],
    );
  });

  it('the pending refusal lists every file and names both ways out', () => {
    const msg = formatPendingAutoRefusal([file('20260101000001_b'), file('20260101000002_c')], '--auto');
    assert.match(msg, /2 migration\(s\)/);
    assert.match(msg, /20260101000001_b\.sql/);
    assert.match(msg, /20260101000002_c\.sql/);
    assert.match(msg, /npx turbine migrate up/);
    assert.match(msg, /--allow-pending/);
    assert.ok(!msg.includes('—'), 'no em-dash in user-facing text');
  });
});

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

describe('new migration flags parse', () => {
  it('--exit-code is accepted by push and migrate', () => {
    assert.equal(parseArgs(['push', '--dry-run', '--exit-code']).exitCode, true);
    assert.equal(parseArgs(['migrate', 'status', '--exit-code']).exitCode, true);
    assert.equal(parseArgs(['migrate', 'status']).exitCode, undefined);
  });

  it('--allow-pending is accepted by migrate', () => {
    assert.equal(parseArgs(['migrate', 'create', 'x', '--auto', '--allow-pending']).allowPending, true);
    assert.equal(parseArgs(['migrate', 'create', 'x', '--auto']).allowPending, undefined);
  });

  it('--wait forms: bare, =N, and a separate N', () => {
    assert.equal(parseArgs(['migrate', 'deploy']).wait, undefined);
    assert.equal(parseArgs(['migrate', 'deploy', '--wait']).wait, 300);
    assert.equal(parseArgs(['migrate', 'deploy', '--wait=45']).wait, 45);
    assert.equal(parseArgs(['migrate', 'deploy', '--wait', '45']).wait, 45);
    // A following flag is not swallowed as the value.
    const args = parseArgs(['migrate', 'deploy', '--wait', '--dry-run']);
    assert.equal(args.wait, 300);
    assert.equal(args.dryRun, true);
  });

  it('--wait is not accepted by commands that have no lock to wait for', () => {
    // An unknown flag exits the process; assert through the flag table instead.
    const originalExit = process.exit;
    const originalErr = console.error;
    let exited: number | undefined;
    process.exit = ((code?: number) => {
      exited = code;
      throw new Error('exit');
    }) as typeof process.exit;
    console.error = () => {};
    try {
      assert.throws(() => parseArgs(['generate', '--wait=5']), /exit/);
      assert.equal(exited, 1);
    } finally {
      process.exit = originalExit;
      console.error = originalErr;
    }
  });

  for (const bad of ['--wait=0', '--wait=abc', '--wait=', '--wait=-5', '--wait=1.5']) {
    it(`${bad} is refused with a usage error`, () => {
      const originalExit = process.exit;
      const originalErr = console.error;
      const originalLog = console.log;
      let exited: number | undefined;
      process.exit = ((code?: number) => {
        exited = code;
        throw new Error('exit');
      }) as typeof process.exit;
      console.error = () => {};
      console.log = () => {};
      try {
        assert.throws(() => parseArgs(['migrate', 'deploy', bad]), /exit/);
        assert.equal(exited, 1);
      } finally {
        process.exit = originalExit;
        console.error = originalErr;
        console.log = originalLog;
      }
    });
  }
});
