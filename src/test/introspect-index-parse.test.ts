/**
 * turbine-orm: index `indexdef` parsing (parseIndexColumns / indexHasWhere)
 *
 * The old greedy `/\((.+)\)/` swallowed a PARTIAL index's trailing
 * `WHERE (...)` parentheses into the captured column list, so IndexMetadata
 * carried a raw predicate fragment that then leaked into generated
 * compound-unique selector names. These build-only tests pin the USING-anchored
 * parse: clean columns, no WHERE fragment, quoted identifiers de-quoted, and the
 * partial-index flag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indexHasWhere, parseIndexColumns } from '../introspect.js';

describe('parseIndexColumns', () => {
  it('parses a plain multi-column index', () => {
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (org_id, user_id)'), ['org_id', 'user_id']);
  });

  it('drops a PARTIAL index WHERE clause instead of splicing it into the columns', () => {
    const def = 'CREATE UNIQUE INDEX u ON pos USING btree (pos_id, pos_item_id) WHERE (pos_item_id IS NOT NULL)';
    const cols = parseIndexColumns(def);
    assert.deepEqual(cols, ['pos_id', 'pos_item_id']);
    // No WHERE / predicate garbage leaked into the column names.
    for (const c of cols) assert.doesNotMatch(c, /WHERE|IS NOT NULL|\)/i);
  });

  it('de-quotes quoted uppercase identifiers (Prisma implicit junction "A"/"B")', () => {
    assert.deepEqual(parseIndexColumns('CREATE UNIQUE INDEX u ON "_UserOrgs" USING btree ("A", "B")'), ['A', 'B']);
  });

  it('strips ASC/DESC ordering keywords', () => {
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (created_at DESC, id ASC)'), [
      'created_at',
      'id',
    ]);
  });

  it('drops expression columns conservatively', () => {
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (lower(email))'), []);
  });
});

describe('indexHasWhere', () => {
  it('is true for a partial index and false for a full index', () => {
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX u ON t USING btree (a, b) WHERE (b IS NOT NULL)'), true);
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX u ON t USING btree (a, b)'), false);
  });
});
