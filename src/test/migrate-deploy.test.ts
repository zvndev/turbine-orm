/**
 * turbine-orm, migrate deploy unit tests
 *
 * Locks the production deploy contract without requiring a database.
 *
 * Run: npx tsx --test src/test/migrate-deploy.test.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildMigrateDeployOptions, parseArgs } from '../cli/index.js';
import type { MigrationFile } from '../cli/migrate.js';
import {
  type AppliedMigration,
  planMigrationDeploy,
  predictOutOfOrder,
  readAppliedMigrations,
} from '../cli/migrate.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

describe('turbine migrate deploy', () => {
  it('parses deploy as a migrate subcommand and preserves --dry-run', () => {
    const args = parseArgs(['migrate', 'deploy', '--dry-run']);
    assert.equal(args.command, 'migrate');
    assert.equal(args.subcommand, 'deploy');
    assert.equal(args.dryRun, true);
  });

  it('uses non-interactive apply options for deploy', () => {
    const args = parseArgs(['migrate', 'deploy']);
    const options = buildMigrateDeployOptions(args);
    assert.equal(options.allowDestructive, true);
    assert.equal(options.allowDrift, false);
    assert.equal(options.step, undefined);
  });

  it('plans pending migrations and checksum failures before deploy', () => {
    const dir = join(tmpdir(), `turbine-deploy-plan-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const appliedSql = '-- UP\nSELECT 1;\n-- DOWN\nSELECT 0;\n';
      writeFileSync(join(dir, '20260708000000_applied.sql'), appliedSql);
      writeFileSync(join(dir, '20260708000100_pending.sql'), '-- UP\nSELECT 2;\n-- DOWN\nSELECT 1;\n');

      const applied: AppliedMigration[] = [
        { id: 1, name: '20260708000000_applied', applied_at: new Date(), checksum: sha256(appliedSql) },
      ];

      const plan = planMigrationDeploy(dir, applied);
      assert.deepEqual(
        plan.pending.map((file) => file.filename),
        ['20260708000100_pending.sql'],
      );
      assert.deepEqual(plan.mismatches, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports missing applied migration files as deploy-blocking drift', () => {
    const dir = join(tmpdir(), `turbine-deploy-missing-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const applied: AppliedMigration[] = [
        { id: 1, name: '20260708000000_missing', applied_at: new Date(), checksum: sha256('gone') },
      ];

      const plan = planMigrationDeploy(dir, applied);
      assert.equal(plan.pending.length, 0);
      assert.deepEqual(plan.mismatches, [
        {
          name: '20260708000000_missing',
          expected: sha256('gone'),
          actual: '',
          type: 'missing',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --step is a count, so it is a positive integer or it is a mistake
// ---------------------------------------------------------------------------

/**
 * `parseArgs` with `process.exit` and both streams captured.
 *
 * A refused flag VALUE goes through `failArg` (banner, red line, hints) and
 * exits, the same path every other flag refusal takes, so it cannot be observed
 * with `assert.throws`. `--step` used to throw a bare `ValidationError` past
 * `main()` instead, which printed one unstyled sentence with no banner.
 */
const EXITED = Symbol('process.exit called');

function runParse(argv: string[]): { step?: number; exited: number | null; stderr: string } {
  const realError = console.error;
  const realLog = console.log;
  const realExit = process.exit;
  const err: string[] = [];
  let exited: number | null = null;
  let step: number | undefined;
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(' '));
  };
  console.log = () => {};
  process.exit = ((code?: number) => {
    exited = code ?? 0;
    throw EXITED;
  }) as unknown as typeof process.exit;
  try {
    step = parseArgs(argv).step;
  } catch (e) {
    if (e !== EXITED) throw e;
  } finally {
    console.error = realError;
    console.log = realLog;
    process.exit = realExit;
  }
  return { step, exited, stderr: err.join('\n') };
}

describe('parseArgs: --step', () => {
  it('accepts a positive whole number', () => {
    assert.equal(runParse(['migrate', 'down', '--step', '3']).step, 3);
    assert.equal(runParse(['migrate', 'down', '-n', '1']).step, 1);
  });

  it('refuses a negative step, which used to mean "everything except the oldest"', () => {
    // `applied.reverse().slice(0, -1)` is every migration but one, and with
    // --allow-destructive in a script it began tearing the history down.
    const { exited, stderr, step } = runParse(['migrate', 'down', '--step', '-1']);
    assert.equal(exited, 1);
    assert.equal(step, undefined, 'a refused value must never reach the command');
    assert.match(stderr, /--step/);
    assert.match(stderr, /positive whole number/);
  });

  it('refuses 0 and a non-number, which used to be silent no-ops that look like success', () => {
    for (const value of [['0'], ['abc'], ['1.5'], []]) {
      const { exited, step } = runParse(['migrate', 'down', '--step', ...value]);
      assert.equal(exited, 1, `--step ${value[0] ?? '(nothing)'} must be refused`);
      assert.equal(step, undefined);
    }
  });

  it('names the offending value so the message is actionable', () => {
    assert.match(runParse(['migrate', 'down', '--step', 'abc']).stderr, /"abc"/);
    assert.match(runParse(['migrate', 'down', '--step']).stderr, /\(nothing\)/);
  });

  it('does not fire for an UNKNOWN command, whose misspelling is the real problem', () => {
    // `turbine genrate --step 0` used to report a `--step` problem and never
    // mention the command. Fixing `--step` would not have helped.
    const { exited, stderr } = runParse(['genrate', '--step', '0']);
    assert.equal(exited, null, 'flag-value validation must not run for an unrecognized command');
    assert.equal(stderr, '');
  });
});

// ---------------------------------------------------------------------------
// deploy --dry-run must warn about the same out-of-order applies the real run does
// ---------------------------------------------------------------------------

describe('predictOutOfOrder', () => {
  const file = (name: string): MigrationFile => ({
    filename: `${name}.sql`,
    path: '',
    name,
    timestamp: name.slice(0, 14),
  });
  const applied = (name: string): AppliedMigration => ({
    id: 1,
    name,
    applied_at: new Date(),
    checksum: 'x',
  });

  it('flags a pending migration older than one already applied', () => {
    const out = predictOutOfOrder([applied('20260901000500_branch_b')], [file('20260901000300_branch_a')]);
    assert.deepEqual(out, [{ applied: '20260901000300_branch_a.sql', newestPrior: '20260901000500_branch_b.sql' }]);
  });

  it('says nothing when every pending migration is newer, or when nothing is applied yet', () => {
    assert.deepEqual(predictOutOfOrder([applied('20260901000100_a')], [file('20260901000900_b')]), []);
    assert.deepEqual(predictOutOfOrder([], [file('20260901000100_a')]), []);
  });

  it('compares against the NEWEST applied timestamp, not the last applied row', () => {
    // Applied out of order already: b (newer ts) went in first, then a.
    const out = predictOutOfOrder(
      [applied('20260901000500_b'), applied('20260901000300_a')],
      [file('20260901000400_c')],
    );
    assert.deepEqual(out, [{ applied: '20260901000400_c.sql', newestPrior: '20260901000500_b.sql' }]);
  });
});

// ---------------------------------------------------------------------------
// A status read must not need CREATE on the schema
// ---------------------------------------------------------------------------

describe('readAppliedMigrations', () => {
  /** A client that fails any CREATE, the way a read-only role's connection does. */
  function readOnlyClient(tablePresent: boolean) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        async query(sql: string): Promise<unknown> {
          calls.push(sql);
          if (/^\s*CREATE/i.test(sql)) throw new Error('permission denied for schema public');
          if (sql.includes('to_regclass')) return { rows: [{ present: tablePresent }] };
          return { rows: [{ id: 1, name: '20260101000001_a', applied_at: new Date(), checksum: 'x' }] };
        },
      },
    };
  }

  it('reads the applied rows without issuing a CREATE', async () => {
    const fake = readOnlyClient(true);
    const { applied, trackingTableExists } = await readAppliedMigrations(
      fake.client as unknown as Parameters<typeof readAppliedMigrations>[0],
    );
    assert.equal(trackingTableExists, true);
    assert.deepEqual(
      applied.map((m) => m.name),
      ['20260101000001_a'],
    );
    assert.ok(
      !fake.calls.some((sql) => /^\s*CREATE/i.test(sql)),
      `a read must not create the tracking table, saw ${JSON.stringify(fake.calls)}`,
    );
  });

  it('reports an absent tracking table as "nothing applied" instead of creating it', async () => {
    const fake = readOnlyClient(false);
    const { applied, trackingTableExists } = await readAppliedMigrations(
      fake.client as unknown as Parameters<typeof readAppliedMigrations>[0],
    );
    assert.deepEqual(applied, []);
    assert.equal(trackingTableExists, false);
    assert.ok(!fake.calls.some((sql) => /^\s*CREATE/i.test(sql)));
    // Anti-vacuous: it really did look, rather than short-circuiting on nothing.
    assert.ok(fake.calls.some((sql) => sql.includes('to_regclass')));
  });
});
