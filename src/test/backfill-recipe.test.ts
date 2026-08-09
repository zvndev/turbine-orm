/**
 * turbine-orm - migrate `--recipe backfill` scaffold tests
 *
 * Verifies that `createMigration(..., { recipe: 'backfill' })` writes a file
 * whose UP contains the sanctioned two-phase pattern (add nullable column,
 * batched UPDATE backfill, SET NOT NULL, atomic rename swap) in order, and a
 * DOWN that reverses the renames. Unknown recipes throw.
 *
 * Run: npx tsx --test src/test/backfill-recipe.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createMigration,
  findTransactionControlStatements,
  MIGRATION_RECIPES,
  parseMigrationContent,
} from '../cli/migrate.js';

describe('migrate --recipe backfill', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'turbine-backfill-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers the backfill recipe', () => {
    assert.ok(MIGRATION_RECIPES.backfill, 'backfill recipe should be registered');
    assert.match(MIGRATION_RECIPES.backfill!.description, /backfill/i);
  });

  it('scaffolds the two-phase pattern in order', () => {
    const file = createMigration(dir, 'backfill_full_name', undefined, { recipe: 'backfill' });
    const content = readFileSync(file.path, 'utf-8');
    const { up, down } = parseMigrationContent(content);

    // The four phases appear, in order, in the UP body.
    const phaseMarkers = [
      /Phase 1:.*NULLABLE/s,
      /ADD COLUMN "new_col"/,
      /Phase 2:.*batches/s,
      /UPDATE "my_table"/,
      /LIMIT 5000/,
      /Phase 3:.*NOT NULL/s,
      /ALTER COLUMN "new_col" SET NOT NULL/,
      /Phase 4.*atomic swap/s,
      /RENAME COLUMN "old_col" TO "old_col_retired"/,
      /RENAME COLUMN "new_col" TO "old_col"/,
    ];
    let cursor = 0;
    for (const marker of phaseMarkers) {
      const idx = up.slice(cursor).search(marker);
      assert.ok(idx >= 0, `marker ${marker} not found after cursor ${cursor} in UP:\n${up}`);
      cursor += idx;
    }

    // Every UP line is commented out - the scaffold must never run as-is.
    for (const line of up.split('\n')) {
      if (line.trim().length === 0) continue;
      assert.ok(line.trimStart().startsWith('--'), `UP line is not commented: ${line}`);
    }

    // DOWN reverses the rename swap.
    assert.match(down, /RENAME COLUMN "old_col" TO "new_col"/);
    assert.match(down, /RENAME COLUMN "old_col_retired" TO "old_col"/);
  });

  /**
   * The scaffold used to hand the user `BEGIN; ... COMMIT;` around Phase 4.
   * Those were both unnecessary (the runner already wraps each file in ONE
   * transaction) and harmful: uncommenting them commits the WRAPPER, so the
   * first half of the migration becomes durable, the rest runs unprotected, and
   * the migration is recorded nowhere, after which every rerun fails on
   * "already exists". The runner now refuses such a file, which would have made
   * its own shipped scaffold unrunnable.
   */
  it('never scaffolds its own transaction control', () => {
    const file = createMigration(dir, 'backfill_no_txn', undefined, { recipe: 'backfill' });
    const content = readFileSync(file.path, 'utf-8');
    const { up, down } = parseMigrationContent(content);

    for (const [section, body] of [
      ['UP', up],
      ['DOWN', down],
    ] as const) {
      assert.doesNotMatch(body, /^\s*--\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, `${section} still scaffolds a transaction`);
    }

    // Uncommenting the whole scaffold must produce a file the runner accepts.
    const uncomment = (body: string): string => body.replace(/^-- ?/gm, '');
    assert.deepEqual(findTransactionControlStatements(uncomment(up)), []);
    assert.deepEqual(findTransactionControlStatements(uncomment(down)), []);

    // And the reason is stated where the author will read it.
    assert.match(up, /ONE transaction/);
  });

  it('never emits an em-dash character in the scaffold', () => {
    const file = createMigration(dir, 'backfill_no_emdash', undefined, { recipe: 'backfill' });
    const content = readFileSync(file.path, 'utf-8');
    assert.ok(!content.includes('\u2014'), 'scaffold must not contain an em-dash');
  });

  it('throws MigrationError on an unknown recipe', () => {
    assert.throws(
      () => createMigration(dir, 'nope', undefined, { recipe: 'does_not_exist' }),
      /Unknown migration recipe/,
    );
  });
});
