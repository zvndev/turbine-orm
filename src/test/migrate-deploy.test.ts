/**
 * turbine-orm — migrate deploy unit tests
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
import { type AppliedMigration, planMigrationDeploy } from '../cli/migrate.js';

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
