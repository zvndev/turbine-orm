/**
 * Column references are branded: only `col()` builds one, and request data
 * (anything `JSON.parse` produced) can never name a column.
 *
 * The shape this closes: `delete({ where: { id: body.id } })` with a body of
 * `{"id":{"equals":{"col":"id"}}}` used to compile to `WHERE "id" = "id"` and
 * match every row. Each position a reference is read from is asked the same
 * two questions: the branded form compiles to a column comparison, and the
 * plain parsed form is refused naming `col()`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertNoPiiPredicates } from '../cli/pii-predicate-guard.js';
import { ValidationError } from '../errors.js';
import { COLUMN_REF, col, isColumnRef } from '../query/column-ref.js';
import { accounts, whereCoreSchema } from './where-core-fixture.js';

const PLAIN_REFUSAL = /is not a column reference\. Build one with col\("(id|score|age)"\)/;

describe('col(): the brand', () => {
  it('builds a frozen reference that prints as { col } and carries a registered symbol', () => {
    const ref = col('score');
    assert.ok(Object.isFrozen(ref));
    assert.equal(JSON.stringify(ref), '{"col":"score"}');
    assert.deepEqual(Object.keys(ref), ['col']);
    assert.equal(COLUMN_REF, Symbol.for('turbine-orm.columnRef'));
    assert.ok(isColumnRef(ref));
  });

  it('nothing parsed or cloned from data carries the brand', () => {
    const text = JSON.stringify({ equals: col('id') });
    assert.equal(isColumnRef(JSON.parse(text).equals), false);
    assert.equal(isColumnRef(structuredClone(col('id'))), false);
    assert.equal(isColumnRef({ ...col('id') }), false);
    assert.equal(isColumnRef({ col: 'id' }), false);
  });

  it('a reference built by another copy of the package (same registered symbol) is recognized', () => {
    const foreign = { col: 'id' };
    Object.defineProperty(foreign, Symbol.for('turbine-orm.columnRef'), { value: true });
    assert.ok(isColumnRef(foreign));
  });

  it('refuses a missing or non-string name', () => {
    assert.throws(() => col(''), ValidationError);
    assert.throws(() => col(5 as never), /col\(\) takes the name of a field/);
  });
});

describe('a parsed { col } is refused at every operand position', () => {
  const body = (json: string): Record<string, unknown> => JSON.parse(json);

  const cases: [string, () => unknown][] = [
    ['deleteMany equals', () => accounts().buildDeleteMany({ where: body('{"id":{"equals":{"col":"id"}}}') } as never)],
    ['delete equals', () => accounts().buildDelete({ where: body('{"id":{"equals":{"col":"id"}}}') } as never)],
    [
      'updateMany gte',
      () => accounts().buildUpdateMany({ where: body('{"score":{"gte":{"col":"score"}}}'), data: { age: 1 } } as never),
    ],
    ['findMany lt', () => accounts().buildFindMany({ where: body('{"age":{"lt":{"col":"score"}}}') } as never)],
    ['findMany not', () => accounts().buildFindMany({ where: body('{"age":{"not":{"col":"age"}}}') } as never)],
    [
      'findMany inside a not operator object',
      () => accounts().buildFindMany({ where: body('{"age":{"not":{"equals":{"col":"age"}}}}') } as never),
    ],
    ['findMany bare value', () => accounts().buildFindMany({ where: body('{"id":{"col":"id"}}') } as never)],
    [
      'relation filter body',
      () => accounts().buildFindMany({ where: body('{"posts":{"some":{"id":{"equals":{"col":"id"}}}}}') } as never),
    ],
    [
      'relation with where',
      () =>
        accounts().buildFindMany({
          with: { posts: { where: body('{"id":{"equals":{"col":"id"}}}') } },
        } as never),
    ],
    ['count', () => accounts().buildCount({ where: body('{"OR":[{"id":{"gt":{"col":"id"}}}]}') } as never)],
    [
      'groupBy having on a by key',
      () => accounts().buildGroupBy({ by: ['age'], having: body('{"age":{"equals":{"col":"age"}}}') } as never),
    ],
  ];

  for (const [label, run] of cases) {
    it(label, () => {
      assert.throws(run, (err: unknown) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
        assert.match(err.message, /col\(/);
        return true;
      });
    });
  }

  it('names the operator, the column and the import in the message', () => {
    assert.throws(
      () => accounts().buildDeleteMany({ where: body('{"id":{"equals":{"col":"id"}}}') } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, PLAIN_REFUSAL);
        assert.match(err.message, /'equals' on "id" for table "accounts"/);
        assert.match(err.message, /import \{ col \} from 'turbine-orm'/);
        return true;
      },
    );
  });

  it('a JSON column still takes { col: "x" } as a JSON value', () => {
    const { sql, params } = accounts().buildFindMany({ where: { meta: { equals: { col: 'id' } } } } as never);
    assert.match(sql, /"meta"::jsonb = \$1::jsonb/);
    assert.deepEqual(params.slice(0, 1), ['{"col":"id"}']);
  });
});

describe('the branded form compiles to a column comparison', () => {
  it('equals / not / gt bind nothing and quote the referenced column', () => {
    const { sql, params } = accounts().buildFindMany({
      where: { age: { gt: col('score'), not: col('tenantId') }, score: { equals: col('age') } },
    } as never);
    assert.match(sql, /"age" > "score"/);
    assert.match(sql, /"age" != "tenant_id"/);
    assert.match(sql, /"score" = "age"/);
    assert.deepEqual(params, []);
  });

  it('inside a not operator object', () => {
    const { sql } = accounts().buildFindMany({ where: { age: { not: { gte: col('score') } } } } as never);
    assert.match(sql, /NOT \("age" >= "score"\)/);
  });

  it('a bare reference needs an operator', () => {
    assert.throws(
      () => accounts().buildFindMany({ where: { age: col('score') } } as never),
      /needs an operator: write \{ equals: col\("score"\) \}/,
    );
  });

  it('a JSON column refuses a reference', () => {
    assert.throws(
      () => accounts().buildFindMany({ where: { meta: { equals: col('id') } } } as never),
      /cannot be the 'equals' operand of a JSON filter/,
    );
  });

  it('distinct references never share a cache key', () => {
    const q = accounts();
    const a = q.fingerprintWhere({ age: { gt: col('score') } });
    const b = q.fingerprintWhere({ age: { gt: col('tenantId') } });
    const v = q.fingerprintWhere({ age: { gt: 5 } });
    assert.notEqual(a, b);
    assert.notEqual(a, v);
  });
});

describe('PII predicate guard', () => {
  const schema = whereCoreSchema();
  const table = schema.tables.accounts!;
  const email = table.columns.find((c) => c.name === 'email')!;
  (email as { pii?: true }).pii = true;

  function verdict(args: Record<string, unknown>): string {
    try {
      assertNoPiiPredicates(args, table, {
        metadata: schema,
        hiddenReason: (owner, column) =>
          owner.columns.some((c) => c.name === column && c.pii === true) ? 'is PII-tagged' : null,
        refuseColumn: (_owner, column) => {
          throw new Error(`column:${column}`);
        },
        refuseDepth: () => {
          throw new Error('depth');
        },
        refuseShape: (_owner, key) => {
          throw new Error(`shape:${key}`);
        },
      });
      return 'ok';
    } catch (err) {
      return (err as Error).message;
    }
  }

  it('refuses a branded reference to a hidden column, including under not', () => {
    assert.equal(verdict({ where: { name: { equals: col('email') } } }), 'column:email');
    assert.equal(verdict({ where: { name: { not: { lt: col('email') } } } }), 'column:email');
  });

  it('refuses the plain { col } spelling as a shape, whatever it names', () => {
    assert.equal(verdict({ where: { name: { gt: { col: 'name' } } } }), 'shape:gt: { col }');
    assert.equal(verdict({ where: { name: { not: { equals: { col: 'email' } } } } }), 'shape:equals: { col }');
  });

  it('accepts a reference to a visible column', () => {
    assert.equal(verdict({ where: { name: { equals: col('name') } } }), 'ok');
  });
});
