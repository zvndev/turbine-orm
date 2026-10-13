/**
 * turbine-orm: internal contract breaks are InvariantError (E020), not E003
 *
 * A where scope built from an already-quoted reference is a bug in Turbine's
 * own call sites, never something a caller's arguments can cause, so it is
 * reported as E020 with a stable `invariant` id rather than as a validation
 * error the caller would try to fix. The relation-payload site is covered in
 * relation-parse-failure.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvariantError } from '../errors.js';
import type { BuilderCtx } from '../query/where.js';
import { aliasWhereScope } from '../query/where.js';
import { mockTable } from './helpers.js';

describe('internal contract breaks are InvariantError', () => {
  it('aliasWhereScope refuses a rendered reference as where-scope-reference', () => {
    const meta = mockTable('posts', [{ name: 'id', field: 'id' }]);
    // The refusal runs before the context is read, so no builder is needed.
    const qi = {} as BuilderCtx;
    assert.throws(
      () => aliasWhereScope(qi, 'posts', meta, '"t0"'),
      (err: unknown) => {
        assert.ok(err instanceof InvariantError, `expected InvariantError, got ${String(err)}`);
        assert.equal(err.code, 'TURBINE_E020');
        assert.equal(err.invariant, 'where-scope-reference');
        assert.match(err.message, /renderedRefWhereScope/);
        return true;
      },
    );
  });
});
