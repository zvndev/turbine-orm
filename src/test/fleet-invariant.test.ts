/**
 * turbine-orm: InvariantError (E020) and the SQL-cache checks that always run.
 *
 * Two of the cache checks are not diagnostics: they run in every mode,
 * production included, because each costs one array compare and the
 * alternative is sending parameters Turbine already knows are wrong.
 *
 *   - On a cache MISS the params the build closure pushed must equal the params
 *     the collect path produced. A shape run once per query interface used to be
 *     compared never, because the rebuild-and-compare ran only on a HIT.
 *   - On a cache HIT the collected param count must equal the count the entry
 *     was built with. Without it PostgreSQL rejects the statement with a bind
 *     error that reads like a broken connection.
 *
 * Both throw `InvariantError` (E020). The drift is simulated at the one seam
 * every cached site passes through: the params handed to the check are
 * corrupted the way a collect path that fell out of step would corrupt them.
 *
 * Run: npx tsx --test src/test/fleet-invariant.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INVARIANT_REPORT_HINT, InvariantError, TurbineError, TurbineErrorCode, ValidationError } from '../errors.js';
import { InvariantError as RootInvariantError } from '../index.js';
import type { QueryInterface, QueryInterfaceOptions } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'age', field: 'age', pgType: 'int4' },
        { name: 'score', field: 'score', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

type Q = QueryInterface<Record<string, unknown>>;
type CrossCheck = (op: string, ck: string, entry: unknown, build: unknown, params: unknown[]) => void;

/**
 * Corrupt the params every cached site hands to the lockstep check, the way a
 * collect path that fell out of step with its builder would. Shadows the
 * prototype method on this one instance; the builder context calls it through
 * `this`, so the write builders in writes.ts see it too.
 */
function corruptCollectedParams(q: Q, corrupt: (params: unknown[]) => void): void {
  const host = q as unknown as { crossCheckCache: CrossCheck };
  const original = host.crossCheckCache;
  host.crossCheckCache = function (this: unknown, op, ck, entry, build, params) {
    corrupt(params);
    return original.call(this, op, ck, entry, build, params);
  };
}

function isInvariant(id: string, pattern?: RegExp): (err: unknown) => boolean {
  return (err: unknown) =>
    err instanceof InvariantError &&
    err.code === 'TURBINE_E020' &&
    err.invariant === id &&
    !(err instanceof ValidationError) &&
    (pattern === undefined || pattern.test(err.message));
}

/** One instance per mode that matters: the check must not depend on any of them. */
const MODES: Array<[label: string, options: QueryInterfaceOptions]> = [
  ['development (every-hit)', { diagnostics: 'development' }],
  ['production', { diagnostics: 'production' }],
  ["cacheCheck: 'off'", { diagnostics: { cacheCheck: 'off' } }],
  ['sqlCache: false', { diagnostics: 'production', sqlCache: false }],
];

describe('InvariantError', () => {
  it('is E020, extends TurbineError directly, carries its id, and is not retryable', () => {
    const err = new InvariantError('probe-id', 'two internal paths disagreed.');
    assert.equal(TurbineErrorCode.INVARIANT_VIOLATION, 'TURBINE_E020');
    assert.equal(InvariantError.CODE, 'TURBINE_E020');
    assert.equal(err.code, 'TURBINE_E020');
    assert.equal(err.name, 'InvariantError');
    assert.equal(err.invariant, 'probe-id');
    assert.equal(Object.getPrototypeOf(InvariantError), TurbineError);
    assert.ok(err instanceof TurbineError);
    assert.equal('isRetryable' in err, false);
    assert.equal(err.docsUrl, 'https://turbineorm.dev/errors#e020');
  });

  it('ends with the report hint, then the docs link, each exactly once', () => {
    const err = new InvariantError('probe-id', 'two internal paths disagreed.');
    assert.equal(
      err.message,
      `[TURBINE_E020] two internal paths disagreed. ${INVARIANT_REPORT_HINT} (https://turbineorm.dev/errors#e020)`,
    );
    // A message that already placed the hint (before multi-line details) keeps it where it is.
    const placed = new InvariantError('probe-id', `head. ${INVARIANT_REPORT_HINT}\ndetail line`);
    assert.equal(placed.message.split(INVARIANT_REPORT_HINT).length, 2, 'the hint must appear once');
    assert.ok(placed.message.endsWith('detail line (https://turbineorm.dev/errors#e020)'));
  });

  it('keeps a cause, and has no cause property when none was given', () => {
    const first = new SyntaxError('Unexpected end of JSON input');
    assert.equal(new InvariantError('x', 'm', { cause: first }).cause, first);
    assert.equal('cause' in new InvariantError('x', 'm'), false);
  });

  it('is exported from the package root', () => {
    assert.equal(RootInvariantError, InvariantError);
  });
});

describe('SQL cache: a miss compares built and collected params in every mode', () => {
  for (const [label, options] of MODES) {
    it(`${label}: the FIRST call of a fresh interface throws when the params are permuted`, () => {
      const q = makeQuery('users', schema(), options) as Q;
      corruptCollectedParams(q, (p) => p.reverse());
      assert.throws(
        () => q.buildFindMany({ where: { age: 1, score: 2 } } as never),
        isInvariant(
          'sql-cache-lockstep',
          /built params and collected params diverge on a cache miss \(collected 2, built 2\)/,
        ),
      );
    });

    it(`${label}: the FIRST call throws when the collect path drops a param`, () => {
      const q = makeQuery('users', schema(), options) as Q;
      corruptCollectedParams(q, (p) => {
        p.pop();
      });
      assert.throws(
        () => q.buildCount({ where: { age: 1, score: 2 } } as never),
        isInvariant('sql-cache-lockstep', /collected 1, built 2/),
      );
    });
  }

  it('covers every cached site, the write builders in writes.ts included', () => {
    const sites: Array<[op: string, run: (q: Q) => unknown]> = [
      ['findUnique', (q) => q.buildFindUnique({ where: { id: 1, age: 2 } } as never)],
      ['findUnique', (q) => q.buildFindUnique({ where: { id: 1, age: { gt: 2 } } } as never)],
      ['findMany', (q) => q.buildFindMany({ where: { age: 1, score: 2 } } as never)],
      ['findMany', (q) => q.buildFindFirst({ where: { age: 5, score: 6 } } as never)],
      ['count', (q) => q.buildCount({ where: { age: 1, score: 2 } } as never)],
      ['update', (q) => q.buildUpdate({ where: { id: 1 }, data: { name: 'n' } } as never)],
      ['delete', (q) => q.buildDelete({ where: { id: 1, age: 2 } } as never)],
      ['updateMany', (q) => q.buildUpdateMany({ where: { age: 1 }, data: { name: 'n' } } as never)],
      ['deleteMany', (q) => q.buildDeleteMany({ where: { age: 1, score: 2 } } as never)],
    ];
    for (const [op, run] of sites) {
      const q = makeQuery('users', schema(), { diagnostics: 'production' }) as Q;
      corruptCollectedParams(q, (p) => p.reverse());
      assert.throws(
        () => run(q),
        isInvariant('sql-cache-lockstep', new RegExp(`lockstep violation on ${op} `)),
        `${op} must compare on its first (missed) call`,
      );
    }
  });

  it('a miss in lockstep passes, and the built params are not retained afterwards', () => {
    const q = makeQuery('users', schema(), { diagnostics: 'production' }) as Q;
    const built = q.buildFindMany({ where: { age: 1, score: 2 } } as never);
    assert.deepEqual(built.params.slice(0, 2), [1, 2]);
    assert.equal((q as unknown as { lastMissParams?: unknown }).lastMissParams, undefined);
  });

  it('the message names the shape and never a parameter value', () => {
    const q = makeQuery('users', schema(), { diagnostics: 'production' }) as Q;
    corruptCollectedParams(q, (p) => p.reverse());
    assert.throws(
      () => q.buildFindMany({ where: { name: 'secret-value-7f3a', age: 4242 } } as never),
      (err: unknown) =>
        err instanceof InvariantError &&
        !err.message.includes('secret-value-7f3a') &&
        !err.message.includes('4242') &&
        err.message.includes(INVARIANT_REPORT_HINT),
    );
  });
});

describe('SQL cache: a hit checks the param count in every mode', () => {
  for (const [label, options] of MODES.filter(([, o]) => o.sqlCache !== false)) {
    it(`${label}: a hit that collects one param too few throws before anything is sent`, () => {
      const q = makeQuery('users', schema(), options) as Q;
      q.buildFindMany({ where: { age: 1, score: 2 } } as never); // warm: a clean miss
      corruptCollectedParams(q, (p) => {
        p.pop();
      });
      assert.throws(
        () => q.buildFindMany({ where: { age: 10, score: 20 } } as never),
        isInvariant('sql-cache-param-count', /has 2 placeholders but the cache hit collected 1 params/),
      );
    });
  }

  it('a hit with the right count and the check off returns the cached statement', () => {
    const q = makeQuery('users', schema(), { diagnostics: { cacheCheck: 'off' } }) as Q;
    const first = q.buildFindMany({ where: { age: 1, score: 2 } } as never);
    const second = q.buildFindMany({ where: { age: 10, score: 20 } } as never);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params.slice(0, 2), [10, 20]);
  });
});
