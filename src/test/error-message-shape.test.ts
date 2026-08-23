import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircularRelationError,
  NotFoundError,
  OptimisticLockError,
  ReadOnlyError,
  TimeoutError,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/**
 * One prefix per error message.
 *
 * `formatErrorMessage` prepends `[${code}] ` unless the message already starts
 * with that exact tag. A hand-written `[turbine] ` never matches
 * `[TURBINE_E003]`, so for most of the package's history the two stacked:
 *
 *   [TURBINE_E003] [turbine] Unknown column "titel" on table "posts". (…)
 *
 * These tests pin the RENDERED shape of errors a user can actually receive.
 * `scripts/check-error-prefix.mjs` is the other half: it stops the literal
 * coming back at a source level, including at the message-building helpers
 * these tests reach only indirectly.
 *
 * Every assertion here is paired with a non-vacuity check. `doesNotMatch` is
 * green on an empty string, so "no doubled prefix" alone would also pass on a
 * message that failed to build at all.
 */

/** Assert `message` is a real, singly-prefixed message carrying `identity`. */
function assertSinglePrefix(message: string, code: string, identity: string): void {
  assert.ok(message.length > 0, 'message must not be empty (an empty string passes doesNotMatch vacuously)');
  assert.ok(message.includes(identity), `message must carry its own text ("${identity}"), got: ${message}`);
  assert.ok(message.startsWith(`[${code}] `), `message must open with exactly the code tag, got: ${message}`);
  assert.doesNotMatch(message, /\[turbine\]/, `message must not carry a second hand-written prefix: ${message}`);
  const links = message.match(/turbineorm\.dev\/errors#/g) ?? [];
  assert.equal(links.length, 1, `exactly one docs link, got ${links.length}: ${message}`);
}

describe('error message shape', () => {
  it('a plain ValidationError carries exactly one prefix', () => {
    const err = new ValidationError('Unknown column "titel" on table "posts".');
    assertSinglePrefix(err.message, 'TURBINE_E003', 'Unknown column "titel"');
  });

  // Each of these classes COMPOSES its own message inside errors.ts, so a
  // codemod over call sites alone would leave every one of them doubled.
  it('TimeoutError composes its message without a second prefix', () => {
    const err = new TimeoutError(5000, 'Pipeline');
    assertSinglePrefix(err.message, 'TURBINE_E002', 'Pipeline timed out after 5000ms');
  });

  it('NotFoundError composes its message without a second prefix', () => {
    const err = new NotFoundError({ table: 'users', operation: 'findUniqueOrThrow', where: { id: 1 } });
    assertSinglePrefix(err.message, 'TURBINE_E001', 'findUniqueOrThrow on "users" found no record');
  });

  it('NotFoundError with no detail at all still carries one prefix', () => {
    const err = new NotFoundError({});
    assertSinglePrefix(err.message, 'TURBINE_E001', 'Record not found');
  });

  it('UniqueConstraintError composes its message without a second prefix', () => {
    const err = new UniqueConstraintError({ constraint: 'users_email_key', columns: ['email'] });
    assertSinglePrefix(err.message, 'TURBINE_E008', 'Unique constraint violation on users_email_key');
  });

  it('CircularRelationError composes its message without a second prefix', () => {
    const err = new CircularRelationError(['users', 'posts', 'users']);
    assertSinglePrefix(err.message, 'TURBINE_E007', 'Circular or too-deep relation nesting');
  });

  it('OptimisticLockError composes its message without a second prefix', () => {
    const err = new OptimisticLockError({ table: 'posts', versionField: 'version', expectedVersion: 3 });
    assertSinglePrefix(err.message, 'TURBINE_E015', 'Optimistic lock failed on "posts"');
  });

  it('UnsupportedFeatureError composes its message without a second prefix', () => {
    const err = new UnsupportedFeatureError('pgvector distance ordering', 'sqlite');
    assertSinglePrefix(err.message, 'TURBINE_E017', 'pgvector distance ordering is unsupported on "sqlite"');
  });

  it('ReadOnlyError composes its message without a second prefix', () => {
    const err = new ReadOnlyError('create on "users" refused: this PowDB connection is read-only.');
    assertSinglePrefix(err.message, 'TURBINE_E018', 'this PowDB connection is read-only');
    assert.equal(err.message.match(/Route writes to a writable primary/g)?.length, 1, 'exactly one routing hint');
  });
});

describe('error message shape, through a real query build', () => {
  function schema(): SchemaMetadata {
    const tables: Record<string, TableMetadata> = {};
    tables.posts = mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
    ]);
    return { tables, enums: {} };
  }

  /** Run `fn`, require it to throw a TurbineError, and return the message. */
  function messageFrom(fn: () => unknown): string {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, 'the call must actually throw (a silent pass proves nothing)');
    return thrown.message;
  }

  it('an unknown column in `where` reports one prefix', () => {
    const q = makeQuery('posts', schema());
    const message = messageFrom(() => q.buildFindMany({ where: { titel: 'x' } as never }));
    assertSinglePrefix(message, 'TURBINE_E003', 'titel');
  });

  it('an unknown relation in `with` reports one prefix', () => {
    const q = makeQuery('posts', schema());
    const message = messageFrom(() => q.buildFindMany({ with: { authr: true } as never }));
    assertSinglePrefix(message, 'TURBINE_E005', 'authr');
  });

  it('an unknown field in `orderBy` reports one prefix', () => {
    const q = makeQuery('posts', schema());
    const message = messageFrom(() => q.buildFindMany({ orderBy: { bogus: 'asc' } as never }));
    assertSinglePrefix(message, 'TURBINE_E003', 'bogus');
  });

  it('an invalid pagination bound reports one prefix', () => {
    const q = makeQuery('posts', schema());
    const message = messageFrom(() => q.buildFindMany({ limit: -1 } as never));
    assertSinglePrefix(message, 'TURBINE_E003', 'non-negative integer');
  });
});
