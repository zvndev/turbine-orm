/**
 * turbine-orm — `migrate create --from-diff` body builder + `init` step planner.
 *
 * Pure, DB-free unit tests for the two CLI improvements:
 *   1. buildDiffMigrationBody() — turns a schemaDiff() result into an annotated
 *      UP/DOWN migration body, flagging destructive statements.
 *   2. planInitSteps() — decides which init steps run / prompt / skip for a
 *      given project state + flags, across all three modes.
 *
 * Run: npx tsx --test src/test/cli-diff-migration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type InitPlanFlags, type InitPlanState, type InitStepId, parseArgs, planInitSteps } from '../cli/index.js';
import { buildDiffMigrationBody } from '../cli/migrate.js';

// ---------------------------------------------------------------------------
// buildDiffMigrationBody
// ---------------------------------------------------------------------------

describe('buildDiffMigrationBody', () => {
  it('puts forward statements in UP and reverse statements in DOWN', () => {
    const body = buildDiffMigrationBody({
      statements: ['ALTER TABLE "users" ADD COLUMN "email" text;'],
      reverseStatements: ['ALTER TABLE "users" DROP COLUMN "email";'],
    });
    assert.ok(body.up.includes('ALTER TABLE "users" ADD COLUMN "email" text;'));
    assert.ok(body.down.includes('ALTER TABLE "users" DROP COLUMN "email";'));
  });

  it('leaves a non-destructive UP unflagged (no banner)', () => {
    const body = buildDiffMigrationBody({
      statements: ['CREATE TABLE "orgs" ("id" serial PRIMARY KEY);'],
      reverseStatements: [], // no reverse -> irreversible DOWN, but UP itself is clean
    });
    assert.equal(body.destructiveUp.length, 0);
    assert.ok(!body.up.includes('DESTRUCTIVE'));
  });

  it('flags a destructive UP statement (lossy ALTER COLUMN TYPE) with a loud banner', () => {
    const stmt = 'ALTER TABLE "users" ALTER COLUMN "age" TYPE integer USING "age"::integer;';
    const body = buildDiffMigrationBody({ statements: [stmt], reverseStatements: [] });

    assert.equal(body.destructiveUp.length, 1);
    assert.equal(body.destructiveUp[0]!.kind, 'alter-column-type');
    assert.ok(body.up.includes('WARNING: this migration contains DESTRUCTIVE'), 'has file banner');
    assert.ok(body.up.includes('-- !! DESTRUCTIVE [alter-column-type] users.age'), 'has inline flag');
    assert.ok(body.up.includes('--allow-destructive'), 'mentions the escape hatch');
    // The statement itself is retained so `migrate up`'s gate still refuses it.
    assert.ok(body.up.includes(stmt));
  });

  it('flags a destructive DOWN (reverse of a CREATE TABLE is a DROP)', () => {
    const body = buildDiffMigrationBody({
      statements: ['CREATE TABLE "orgs" ("id" serial PRIMARY KEY);'],
      reverseStatements: ['DROP TABLE IF EXISTS "orgs" CASCADE;'],
    });
    assert.equal(body.destructiveDown.length, 1);
    assert.equal(body.destructiveDown[0]!.kind, 'drop-table');
    // A destructive statement in EITHER direction triggers the file banner.
    assert.ok(body.up.includes('WARNING: this migration contains DESTRUCTIVE'));
    assert.ok(body.down.includes('-- !! DESTRUCTIVE [drop-table] orgs'));
  });

  it('writes the irreversible placeholder when no reverse is derivable', () => {
    const body = buildDiffMigrationBody({
      statements: ['ALTER TABLE "users" ADD COLUMN "x" text;'],
      reverseStatements: [],
    });
    assert.ok(body.down.includes('irreversible, write manually'));
    assert.equal(body.destructiveDown.length, 0);
  });

  it('surfaces diff warnings as -- NOTE comments in UP', () => {
    const body = buildDiffMigrationBody({
      statements: ['CREATE TABLE "t" ("id" serial PRIMARY KEY);'],
      reverseStatements: ['DROP TABLE IF EXISTS "t" CASCADE;'],
      warnings: ['enum "role" has a removed value — not applied automatically'],
    });
    assert.ok(body.up.includes('-- NOTE: enum "role" has a removed value'));
  });

  it('does not double up semicolons on already-terminated statements', () => {
    const body = buildDiffMigrationBody({
      statements: ['CREATE INDEX idx_a ON t (a);'],
      reverseStatements: ['DROP INDEX IF EXISTS idx_a;'],
    });
    assert.ok(!body.up.includes(';;'));
    assert.ok(!body.down.includes(';;'));
  });
});

// ---------------------------------------------------------------------------
// parseArgs — new flags
// ---------------------------------------------------------------------------

describe('parseArgs — migrate create --from-diff', () => {
  it('parses --from-diff', () => {
    const args = parseArgs(['migrate', 'create', 'sync', '--from-diff']);
    assert.equal(args.command, 'migrate');
    assert.equal(args.subcommand, 'create');
    assert.equal(args.positional[0], 'sync');
    assert.equal(args.fromDiff, true);
  });

  it('leaves fromDiff undefined when absent', () => {
    const args = parseArgs(['migrate', 'create', 'sync']);
    assert.equal(args.fromDiff, undefined);
  });
});

describe('parseArgs — init flags', () => {
  it('parses --yes/-y and every --skip-* flag', () => {
    const a = parseArgs(['init', '--yes', '--skip-schema', '--skip-seed', '--skip-push', '--skip-generate']);
    assert.equal(a.yes, true);
    assert.equal(a.skipSchema, true);
    assert.equal(a.skipSeed, true);
    assert.equal(a.skipPush, true);
    assert.equal(a.skipGenerate, true);

    const b = parseArgs(['init', '-y']);
    assert.equal(b.yes, true);
  });

  it('leaves init flags undefined when absent', () => {
    const a = parseArgs(['init']);
    assert.equal(a.yes, undefined);
    assert.equal(a.skipSchema, undefined);
  });
});

// ---------------------------------------------------------------------------
// planInitSteps
// ---------------------------------------------------------------------------

const freshState: InitPlanState = {
  configExists: false,
  schemaExists: false,
  seedFileExists: false,
  hasUrl: false,
  dbReachable: false,
};

const baseFlags: InitPlanFlags = {
  yes: false,
  force: false,
  interactive: false,
  skipSchema: false,
  skipSeed: false,
  skipPush: false,
  skipGenerate: false,
};

function step(plan: ReturnType<typeof planInitSteps>, id: InitStepId) {
  const s = plan.find((p) => p.id === id);
  assert.ok(s, `plan must contain step ${id}`);
  return s;
}

describe('planInitSteps', () => {
  it('returns all six steps in a stable order', () => {
    const plan = planInitSteps(freshState, baseFlags);
    assert.deepEqual(
      plan.map((s) => s.id),
      ['config', 'schema', 'seed-file', 'push', 'generate', 'seed-run'],
    );
  });

  it('config runs when missing, skips (exists) when present without --force', () => {
    assert.equal(step(planInitSteps(freshState, baseFlags), 'config').action, 'run');
    const plan = planInitSteps({ ...freshState, configExists: true }, baseFlags);
    assert.equal(step(plan, 'config').action, 'skip');
    assert.equal(step(plan, 'config').skipReason, 'exists');
  });

  it('config re-runs with --force even when it exists', () => {
    const plan = planInitSteps({ ...freshState, configExists: true }, { ...baseFlags, force: true });
    assert.equal(step(plan, 'config').action, 'run');
  });

  it('interactive fresh project prompts for scaffold + reachable DB steps', () => {
    const plan = planInitSteps({ ...freshState, hasUrl: true, dbReachable: true }, { ...baseFlags, interactive: true });
    assert.equal(step(plan, 'schema').action, 'prompt');
    assert.equal(step(plan, 'seed-file').action, 'prompt');
    assert.equal(step(plan, 'push').action, 'prompt');
    assert.equal(step(plan, 'generate').action, 'prompt');
    assert.equal(step(plan, 'seed-run').action, 'prompt');
    // seed-run defaults to no; the others default to yes.
    assert.equal(step(plan, 'seed-run').defaultYes, false);
    assert.equal(step(plan, 'push').defaultYes, true);
  });

  it('--yes auto-runs the yes-defaults (push+generate) and skips seed-run (default no)', () => {
    const plan = planInitSteps(
      { ...freshState, hasUrl: true, dbReachable: true },
      { ...baseFlags, yes: true, interactive: true },
    );
    assert.equal(step(plan, 'schema').action, 'run');
    assert.equal(step(plan, 'seed-file').action, 'run');
    assert.equal(step(plan, 'push').action, 'run');
    assert.equal(step(plan, 'generate').action, 'run');
    const seedRun = step(plan, 'seed-run');
    assert.equal(seedRun.action, 'skip');
    assert.equal(seedRun.skipReason, 'default-no');
  });

  it('non-interactive without --yes reproduces legacy behavior (scaffold + generate, no push/seed)', () => {
    const plan = planInitSteps({ ...freshState, hasUrl: true, dbReachable: true }, baseFlags);
    assert.equal(step(plan, 'schema').action, 'run');
    assert.equal(step(plan, 'seed-file').action, 'run');
    assert.equal(step(plan, 'generate').action, 'run');
    const push = step(plan, 'push');
    assert.equal(push.action, 'skip');
    assert.equal(push.skipReason, 'non-interactive');
    const seedRun = step(plan, 'seed-run');
    assert.equal(seedRun.action, 'skip');
    assert.equal(seedRun.skipReason, 'non-interactive');
  });

  it('DB steps skip with no-url when there is no URL', () => {
    const plan = planInitSteps(freshState, { ...baseFlags, yes: true });
    for (const id of ['push', 'generate', 'seed-run'] as const) {
      assert.equal(step(plan, id).action, 'skip');
      assert.equal(step(plan, id).skipReason, 'no-url');
    }
  });

  it('DB steps skip with unreachable when URL present but DB down', () => {
    const plan = planInitSteps({ ...freshState, hasUrl: true, dbReachable: false }, { ...baseFlags, yes: true });
    assert.equal(step(plan, 'push').skipReason, 'unreachable');
    assert.equal(step(plan, 'generate').skipReason, 'unreachable');
  });

  it('existing files skip with reason exists (idempotent re-run)', () => {
    const plan = planInitSteps(
      { configExists: true, schemaExists: true, seedFileExists: true, hasUrl: false, dbReachable: false },
      { ...baseFlags, interactive: true },
    );
    assert.equal(step(plan, 'config').skipReason, 'exists');
    assert.equal(step(plan, 'schema').skipReason, 'exists');
    assert.equal(step(plan, 'seed-file').skipReason, 'exists');
  });

  it('--skip-* flags skip the matching steps (seed flag covers both seed steps)', () => {
    const plan = planInitSteps(
      { ...freshState, hasUrl: true, dbReachable: true },
      { ...baseFlags, yes: true, skipSchema: true, skipSeed: true, skipPush: true, skipGenerate: true },
    );
    assert.equal(step(plan, 'schema').skipReason, 'flag');
    assert.equal(step(plan, 'seed-file').skipReason, 'flag');
    assert.equal(step(plan, 'push').skipReason, 'flag');
    assert.equal(step(plan, 'generate').skipReason, 'flag');
    assert.equal(step(plan, 'seed-run').skipReason, 'flag');
  });

  it('offers seed-run when a seed file already exists (default-no under --yes)', () => {
    const plan = planInitSteps(
      { ...freshState, seedFileExists: true, hasUrl: true, dbReachable: true },
      { ...baseFlags, yes: true },
    );
    assert.equal(step(plan, 'seed-run').skipReason, 'default-no');
  });

  it('offers seed-run interactively when the seed file will be created this run', () => {
    // Fresh project, interactive: seed-file step is a prompt (creation), so
    // seedWillExist is true and seed-run is offered rather than no-seed-file.
    const plan = planInitSteps({ ...freshState, hasUrl: true, dbReachable: true }, { ...baseFlags, interactive: true });
    assert.equal(step(plan, 'seed-run').action, 'prompt');
  });
});
