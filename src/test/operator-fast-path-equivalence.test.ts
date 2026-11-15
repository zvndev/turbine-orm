/** The straight-line scalar compiler must match the original loop-based operand order. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { mysqlDialect } from '../mysql.js';
import { JSON_STRING_OPERATORS } from '../query/filters.js';
import type { WhereOperator } from '../query/types.js';
import { type BuilderCtx, buildOperatorClauses, collectOperatorParams } from '../query/where.js';
import { escapeLike } from '../query-utils.js';
import { sqliteDialect } from '../sqlite.js';
import { accounts, ctxOf } from './where-core-fixture.js';

/** Frozen loop reference for the value-only scalar path, before straight-line dispatch. */
function reference(qi: BuilderCtx, op: WhereOperator, params: unknown[]): string[] {
  const column = '"name"';
  const clauses: string[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return qi.p(params.length);
  };
  const insensitive = op.mode === 'insensitive';
  if (op.equals !== undefined) {
    clauses.push(
      op.equals === null
        ? `${column} IS NULL`
        : insensitive
          ? `LOWER(${column}) = LOWER(${bind(op.equals)})`
          : `${column} = ${bind(op.equals)}`,
    );
  }
  for (const [key, sign] of [
    ['gt', '>'],
    ['gte', '>='],
    ['lt', '<'],
    ['lte', '<='],
  ] as const) {
    if (op[key] !== undefined) clauses.push(`${column} ${sign} ${bind(op[key])}`);
  }
  if (op.not !== undefined) {
    if (op.not === null) clauses.push(`${column} IS NOT NULL`);
    else if (typeof op.not === 'object' && !(op.not instanceof Date)) {
      const inner = op.not as WhereOperator;
      const inherited = inner.mode === undefined && op.mode !== undefined ? { ...inner, mode: op.mode } : inner;
      const nested = reference(qi, inherited, params);
      if (nested.length) clauses.push(`NOT (${nested.join(' AND ')})`);
    } else {
      const ref = bind(op.not);
      clauses.push(insensitive ? `LOWER(${column}) != LOWER(${ref})` : `${column} != ${ref}`);
    }
  }
  for (const key of ['in', 'notIn'] as const) {
    const value = op[key];
    if (value === undefined) continue;
    const ref = bind(qi.inParam(value));
    const negative = key === 'notIn';
    clauses.push(
      insensitive
        ? `LOWER(${column}) ${negative ? 'NOT IN' : 'IN'} (SELECT LOWER(v) FROM unnest(${ref}::text[]) AS v(v))`
        : qi.inClause(column, ref, negative),
    );
  }
  for (const [key, pattern] of [
    ['contains', JSON_STRING_OPERATORS.stringContains],
    ['startsWith', JSON_STRING_OPERATORS.stringStartsWith],
    ['endsWith', JSON_STRING_OPERATORS.stringEndsWith],
  ] as const) {
    if (op[key] === undefined) continue;
    const escaped = qi.dialect.escapeLikePattern?.(op[key]) ?? escapeLike(op[key]);
    const ref = bind(pattern(escaped));
    const base = insensitive ? qi.dialect.buildInsensitiveLike(column, ref) : `${column} LIKE ${ref}`;
    clauses.push(`${base} ESCAPE '${qi.dialect.likeEscapeCharacter ?? '\\'}'`);
  }
  return clauses;
}

it('differentially preserves scalar SQL, binding order and dialect hooks over generated operators', () => {
  let comparisons = 0;
  for (const dialect of [postgresDialect, mysqlDialect, sqliteDialect]) {
    const ctx = ctxOf(accounts({ dialect }));
    const values = ['', '%_\\[]', "O'Reilly", '日本語', 'İß', '__proto__'];
    for (let mask = 1; mask < 128; mask++) {
      const value = values[mask % values.length]!;
      for (const insensitive of [false, true]) {
        const op: WhereOperator = {
          ...(mask & 1 ? { equals: value, not: { equals: `not-${value}`, gt: 'a', lte: 'z' } } : { not: null }),
          ...(mask & 2 ? { gt: value, gte: 'a', lt: 'z', lte: 'zz' } : {}),
          ...(mask & 4 ? { in: [value, '', 'two'] } : {}),
          ...(mask & 8 ? { notIn: ['excluded', value] } : {}),
          ...(mask & 16 ? { contains: value } : {}),
          ...(mask & 32 ? { startsWith: value } : {}),
          ...(mask & 64 ? { endsWith: value } : {}),
          ...(insensitive ? { mode: 'insensitive' } : {}),
        };
        if (insensitive && !dialect.capabilities.insensitiveInList && (op.in || op.notIn)) continue;
        const calls: unknown[] = [];
        const qi: BuilderCtx = {
          ...ctx,
          inParam(v) {
            calls.push(['in', v]);
            return ctx.inParam(v);
          },
        };
        const expectedParams: unknown[] = ['prefix'];
        const expectedSql = reference(qi, op, expectedParams);
        const expectedCalls = calls.splice(0);
        const actualParams: unknown[] = ['prefix'];
        assert.deepEqual(buildOperatorClauses(qi, '"name"', op, actualParams), expectedSql);
        assert.deepEqual(actualParams, expectedParams);
        assert.deepEqual(calls.splice(0), expectedCalls);
        const collected: unknown[] = ['prefix'];
        collectOperatorParams(qi, '"name"', op, collected);
        assert.deepEqual(collected, expectedParams);
        assert.deepEqual(calls.splice(0), expectedCalls);
        assert.deepEqual(Reflect.ownKeys(collected), Reflect.ownKeys(expectedParams));
        assert.equal(Object.getPrototypeOf(collected), Object.getPrototypeOf(expectedParams));
        comparisons++;
      }
    }
  }
  assert.equal(comparisons, 570);
});

it('snapshots each scalar range and list operand once after validation', () => {
  const qi = ctxOf(accounts());
  for (const key of ['gt', 'gte', 'lt', 'lte', 'in', 'notIn'] as const) {
    for (const run of [buildOperatorClauses, collectOperatorParams]) {
      let reads = 0;
      const op = Object.defineProperty({}, key, {
        enumerable: true,
        get() {
          reads++;
          return key === 'in' || key === 'notIn' ? ['a', 'b'] : 'a';
        },
      }) as WhereOperator;
      run(qi, '"name"', op, []);
      assert.equal(reads, 2, `${key}: one validation read and one compilation read`);
    }
  }
});
