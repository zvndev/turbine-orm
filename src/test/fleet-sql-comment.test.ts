/**
 * turbine-orm: `sqlComment`, sqlcommenter key/values on each statement.
 *
 * Format and encoding (keys sorted, values URL-encoded with `'` escaped), the
 * hostile values that must not end, nest or extend the comment, construction
 * refusals, the prepared-statement naming rule (static/model/tag named under a
 * `c_` name from the budget, any dynamic value unnamed), the template cache
 * untouched, and every path a model statement leaves by: single calls,
 * timeouts, transactions, pipelines, `$transaction([...])` batches and
 * streams. Raw SQL and transaction control carry nothing.
 *
 * No database: a recording pool. The live parse of hostile values is in
 * fleet-sql-comment.integration.test.ts.
 *
 * Run: npx tsx --test src/test/fleet-sql-comment.test.ts
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import type { QueryEvent } from '../query/index.js';
import { QueryInterface } from '../query/index.js';
import {
  commentDeferred,
  MAX_SQL_COMMENT_VALUE_LENGTH,
  resolveSqlComment,
  type SqlCommentOptions,
  withoutTrailingComment,
} from '../query/sql-comment.js';
import { claimPreparedName, PREPARED_STATEMENT_BUDGET, resetPreparedNameBudget } from '../query/utils.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

interface Sent {
  text: string;
  name: string | undefined;
  params: unknown[];
}

/** A pool that records each statement (text and prepared name) and answers with `rows`. */
function recordingPool(rows: Record<string, unknown>[] = [{ id: 1, name: 'a' }]): {
  pool: PgCompatPool;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const query = async (
    textOrConfig: string | { name?: string; text: string; values?: unknown[] },
    values?: unknown[],
  ) => {
    const config = typeof textOrConfig === 'string' ? { text: textOrConfig, values } : textOrConfig;
    sent.push({ text: config.text, name: config.name, params: config.values ?? [] });
    if (/^(FETCH|CLOSE|BEGIN|COMMIT|ROLLBACK|DECLARE)/.test(config.text)) return { rows: [], rowCount: 0, fields: [] };
    return { rows, rowCount: rows.length, fields: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
  return { pool, sent };
}

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
      posts: mockTable('posts', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'title', field: 'title', pgType: 'text' },
      ]),
    },
  };
}

function client(sqlComment: SqlCommentOptions | undefined, extra: Record<string, unknown> = {}) {
  const { pool, sent } = recordingPool();
  const warned: { message: string; code: unknown }[] = [];
  const db = new TurbineClient(
    {
      pool,
      preparedStatements: true,
      warnOnUnlimited: false,
      logger: { warn: (message: string, entry: { code?: unknown }) => warned.push({ message, code: entry.code }) },
      ...(sqlComment === undefined ? {} : { sqlComment }),
      ...extra,
    },
    schema(),
  ) as Any;
  const events: QueryEvent[] = [];
  db.$on('query', (e: QueryEvent) => events.push(e));
  return { db, sent, events, warned };
}

/** The comment a statement carries, or undefined. */
function commentOf(text: string): string | undefined {
  const at = text.indexOf(' /*');
  return at < 0 ? undefined : text.slice(at + 1);
}

afterEach(() => {
  resetPreparedNameBudget();
  resetWarnOnce();
});

describe('sqlComment: format', () => {
  it('sorts keys, quotes values, and appends after one space', async () => {
    const { db, sent } = client({ static: { application: 'billing', zone: 'eu' }, model: true });
    await db.users.findMany({ where: { id: 1 }, limit: 5 });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /^SELECT .* LIMIT \$2 \/\*[^/]*\*\/$/);
    assert.equal(commentOf(sent[0]!.text), "/*action='findMany',application='billing',model='users',zone='eu'*/");
  });

  it('encodes values as the sqlcommenter spec does', async () => {
    const { db, sent } = client({
      static: { route: '/param*d', name: 'DROP TABLE FOO', quote: "it's", plain: 'a-b_c.d~e' },
    });
    await db.users.findMany({ limit: 1 });
    assert.equal(
      commentOf(sent[0]!.text),
      "/*name='DROP%20TABLE%20FOO',plain='a-b_c.d~e',quote='it\\'s',route='%2Fparam*d'*/",
    );
  });

  it('a hostile value cannot end, nest or extend the comment, or reach a placeholder rewrite', async () => {
    const hostile = "x */ DROP TABLE users; /* y '; -- \n\u0000 $1 ? :p1 @p1 # \\   é";
    const { db, sent } = client({ static: { evil: hostile }, dynamic: () => ({ evil2: hostile }) });
    await db.users.findMany({ where: { id: 7 }, limit: 1 });
    const comment = commentOf(sent[0]!.text)!;
    const body = comment.slice(2, -2);
    assert.ok(comment.startsWith('/*evil=') && comment.endsWith("'*/"), comment);
    assert.ok(!body.includes('*/') && !body.includes('/*') && !body.includes('/'), body);
    for (const ch of ['$', '?', ':', '@', ';', '#', '\n', '\u0000', ' ', '-- ', ' ']) {
      assert.ok(!body.includes(ch), `the comment body holds ${JSON.stringify(ch)}: ${body}`);
    }
    // Every quote in the body is a value delimiter or an escaped one.
    assert.equal(body.replace(/\\'/g, '').match(/'/g)!.length, 4);
    assert.equal(decodeURIComponent('x%20*%2F%20DROP%20TABLE%20users%3B'), 'x */ DROP TABLE users;');
    assert.ok(body.includes('%2F'), 'the slash is encoded');
  });

  it('withoutTrailingComment removes exactly the appended comment', () => {
    assert.equal(withoutTrailingComment("UPDATE t SET a = $1 /*app='returning'*/"), 'UPDATE t SET a = $1');
    assert.equal(withoutTrailingComment('SELECT 1'), 'SELECT 1');
    assert.equal(withoutTrailingComment("SELECT '/*' AS x /*k='v'*/"), "SELECT '/*' AS x");
  });

  it('no comment at all when nothing would be added', async () => {
    for (const option of [{}, { static: {} }, { model: false, tag: false }]) {
      const { db, sent } = client(option as SqlCommentOptions);
      await db.users.findMany({ limit: 1 });
      assert.equal(commentOf(sent[0]!.text), undefined, JSON.stringify(option));
      assert.match(sent[0]!.name ?? '', /^t_[0-9a-f]{16}$/);
    }
  });
});

describe('sqlComment: refused at construction', () => {
  const refused: Array<[label: string, option: unknown, pattern: RegExp]> = [
    ['not an object', 'billing', /expected an object/],
    ['an array', [], /expected an object/],
    ['an unknown key', { models: true }, /unknown key "models"/],
    ['an upper-case static key', { static: { App: 'x' } }, /key "App".*lower-case/],
    ['a static key starting with a digit', { static: { '1a': 'x' } }, /lower-case/],
    ['a static key with a dash', { static: { 'trace-id': 'x' } }, /lower-case/],
    ['a static key opening a MySQL hint', { static: { '+x': 'x' } }, /`\/\*!` or `\/\*\+`/],
    ['a non-string static value', { static: { app: 3 } }, /expected a string value, got number/],
    ['a static value too long', { static: { app: 'x'.repeat(MAX_SQL_COMMENT_VALUE_LENGTH + 1) } }, /257 characters/],
    ['a lone surrogate', { static: { app: '\uD800' } }, /lone surrogate/],
    ['static `model` with model: true', { static: { model: 'x' }, model: true }, /filled in by sqlComment\.model/],
    ['static `action` with model: true', { static: { action: 'x' }, model: true }, /filled in by sqlComment\.model/],
    ['static `tag` with tag: true', { static: { tag: 'x' }, tag: true }, /filled in by sqlComment\.tag/],
    ['a non-boolean model', { model: 'yes' }, /sqlComment\.model: expected true or false/],
    ['a non-function dynamic', { dynamic: { traceparent: 'x' } }, /sqlComment\.dynamic: expected a function/],
  ];
  for (const [label, option, pattern] of refused) {
    it(`${label}: E003, before any statement`, () => {
      const { pool, sent } = recordingPool();
      assert.throws(
        () => new TurbineClient({ pool, sqlComment: option as SqlCommentOptions }, schema()),
        (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003' && pattern.test(err.message),
      );
      assert.equal(sent.length, 0);
    });
  }

  it('a 256-character value and a static key named like a built-in that is off are accepted', () => {
    const { pool } = recordingPool();
    new TurbineClient({ pool, sqlComment: { static: { app: 'x'.repeat(256), model: 'billing' } } }, schema());
  });

  it('a backend that runs no SQL (PowDB) refuses it with E017', () => {
    const { pool } = recordingPool();
    assert.throws(
      () =>
        new TurbineClient(
          {
            pool,
            sqlComment: { static: { app: 'x' } },
            queryInterfaceFactory: () => ({}),
            dialect: { ...mysqlDialect, name: 'powdb' },
          } as Any,
          schema(),
        ),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError &&
        err.code === 'TURBINE_E017' &&
        /sqlComment is unsupported on "powdb"/.test(err.message),
    );
  });

  it('dynamic on MySQL is E017 naming max_prepared_stmt_count; static, model and tag are accepted', () => {
    const { pool } = recordingPool();
    assert.throws(
      () => new TurbineClient({ pool, dialect: mysqlDialect, sqlComment: { dynamic: () => undefined } }, schema()),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError &&
        /sqlComment\.dynamic is unsupported on "mysql"/.test(err.message) &&
        /max_prepared_stmt_count/.test(err.message) &&
        /1461/.test(err.message),
    );
    new TurbineClient(
      { pool, dialect: mysqlDialect, sqlComment: { static: { app: 'x' }, model: true, tag: true } },
      schema(),
    );
  });

  it('a QueryInterface built directly resolves and checks the option itself', () => {
    assert.throws(
      () => new QueryInterface(null as never, 'users', schema(), [], { sqlComment: { static: { A: 'x' } } }),
      ValidationError,
    );
    assert.equal(
      resolveSqlComment(undefined, {}, { dialect: 'postgresql', preparesEveryStatement: false, buildsSql: true }),
      undefined,
    );
  });
});

describe('sqlComment: prepared-statement names', () => {
  it('static and model: a stable c_ name per template and comment', async () => {
    const { db, sent } = client({ static: { app: 'billing' }, model: true });
    await db.users.findMany({ where: { id: 1 }, limit: 1 });
    await db.users.findMany({ where: { id: 2 }, limit: 1 });
    await db.users.count({ where: { id: 2 } });
    assert.match(sent[0]!.name!, /^c_[0-9a-f]{16}$/);
    assert.equal(sent[1]!.name, sent[0]!.name, 'same shape and comment, same name');
    assert.match(sent[2]!.name!, /^c_[0-9a-f]{16}$/);
    assert.notEqual(sent[2]!.name, sent[0]!.name, 'another template, another name');
  });

  it('tag: a different label is a different name, the same label the same name', async () => {
    const { db, sent } = client({ tag: true });
    const find = () => db.users.findMany({ where: { id: 1 }, limit: 1 });
    await db.$tag('checkout', find);
    await db.$tag('checkout', find);
    await db.$tag('refund', find);
    await find();
    assert.equal(commentOf(sent[0]!.text), "/*tag='checkout'*/");
    assert.equal(sent[1]!.name, sent[0]!.name);
    assert.equal(commentOf(sent[2]!.text), "/*tag='refund'*/");
    assert.notEqual(sent[2]!.name, sent[0]!.name);
    // Outside any scope there is no comment, and the template's own name is used.
    assert.equal(commentOf(sent[3]!.text), undefined);
    assert.match(sent[3]!.name!, /^t_[0-9a-f]{16}$/);
  });

  it('any dynamic value sends the statement unnamed; no dynamic value keeps the name', async () => {
    let trace: string | undefined = '00-aaaa-bbbb-01';
    const { db, sent } = client({ static: { app: 'x' }, dynamic: () => ({ traceparent: trace }) });
    await db.users.findMany({ where: { id: 1 }, limit: 1 });
    trace = '00-cccc-dddd-01';
    await db.users.findMany({ where: { id: 1 }, limit: 1 });
    trace = undefined;
    await db.users.findMany({ where: { id: 1 }, limit: 1 });
    assert.equal(commentOf(sent[0]!.text), "/*app='x',traceparent='00-aaaa-bbbb-01'*/");
    assert.equal(sent[0]!.name, undefined, 'sent without a name');
    assert.equal(commentOf(sent[1]!.text), "/*app='x',traceparent='00-cccc-dddd-01'*/");
    assert.equal(sent[1]!.name, undefined);
    assert.equal(commentOf(sent[2]!.text), "/*app='x'*/");
    assert.match(sent[2]!.name!, /^c_[0-9a-f]{16}$/, 'an unsampled statement keeps its prepared name');
  });

  it('forceCustomPlan and a variable-arity OR stay unnamed with a comment', async () => {
    const { db, sent } = client({ static: { app: 'x' } });
    await db.users.findMany({ where: { id: 1 }, limit: 1, forceCustomPlan: true });
    await db.users.findMany({ where: { OR: [{ id: 1 }, { id: 2 }] }, limit: 1 });
    for (const s of sent) {
      assert.equal(commentOf(s.text), "/*app='x'*/");
      assert.equal(s.name, undefined);
    }
  });

  it('with a comment on every statement, a template name is not claimed: one budget slot per shape', async () => {
    const { db, sent } = client({ static: { app: 'x' } });
    const ops = ['equals', 'not', 'gt', 'gte', 'lt', 'lte'];
    for (const op of ops) await db.users.findMany({ where: { id: { [op]: 1 } }, limit: 1 });
    assert.equal(new Set(sent.map((s) => s.name)).size, ops.length);
    assert.ok(
      sent.every((s) => /^c_/.test(s.name ?? '')),
      'only c_ names reach the wire',
    );
    // Exactly `ops.length` slots are used: the rest of the budget is still free.
    for (let i = 0; i < PREPARED_STATEMENT_BUDGET - ops.length; i++) {
      assert.equal(claimPreparedName(`probe_${i}`), `probe_${i}`, `slot ${i} should be free`);
    }
    assert.equal(claimPreparedName('probe_over'), '', 'and then the budget is spent');
  });

  it('the budget bounds commented names: past it, statements go out unnamed', async () => {
    const { db, sent } = client({ tag: true });
    const find = () => db.users.findMany({ where: { id: 1 }, limit: 1 });
    for (let i = 0; i < PREPARED_STATEMENT_BUDGET + 20; i++) await db.$tag(`label-${i}`, find);
    const named = new Set(sent.filter((s) => s.name).map((s) => s.name));
    assert.ok(named.size <= PREPARED_STATEMENT_BUDGET, `${named.size} names`);
    assert.ok(
      sent.slice(-20).every((s) => !s.name),
      'labels past the budget are sent unnamed',
    );
  });
});

describe('sqlComment: dynamic values never fail a query', () => {
  const cases: Array<[label: string, dynamic: () => Any, warning: RegExp]> = [
    ['an invalid key', () => ({ 'Trace-Id': 'x' }), /key "Trace-Id" was left out.*lower-case/],
    ['a key static already sets', () => ({ app: 'other' }), /key "app" was left out.*take precedence/],
    ['a key model fills in', () => ({ model: 'other' }), /key "model" was left out.*take precedence/],
    ['a non-string value', () => ({ trace: 42 }), /key "trace" was left out.*number, not a string/],
    ['a value too long', () => ({ trace: 'x'.repeat(257) }), /key "trace" was left out.*257 characters/],
    ['a lone surrogate', () => ({ trace: '\uDC00' }), /key "trace" was left out.*lone surrogate/],
    [
      'a throw',
      () => {
        throw new Error('tracer down');
      },
      /threw \(tracer down\)/,
    ],
    ['a non-object', () => 'traceparent', /other than an object/],
  ];
  for (const [label, dynamic, warning] of cases) {
    it(`${label}: the statement runs, the value is left out, one warning`, async () => {
      const { db, sent, warned } = client({ static: { app: 'x' }, model: true, dynamic });
      await db.users.findMany({ where: { id: 1 }, limit: 1 });
      await db.users.findMany({ where: { id: 1 }, limit: 1 });
      assert.equal(sent.length, 2);
      for (const s of sent) {
        assert.equal(commentOf(s.text), "/*action='findMany',app='x',model='users'*/");
        assert.match(s.name!, /^c_/, 'nothing dynamic survived, so the name is kept');
      }
      assert.equal(warned.length, 1, JSON.stringify(warned));
      assert.equal(warned[0]!.code, 'sql-comment-dropped');
      assert.match(warned[0]!.message, warning);
    });
  }

  it('a usable key beside a dropped one is kept', async () => {
    const { db, sent } = client({ dynamic: () => ({ BAD: 'x', traceparent: 't', skipped: undefined }) });
    await db.users.findMany({ limit: 1 });
    assert.equal(commentOf(sent[0]!.text), "/*traceparent='t'*/");
    assert.equal(sent[0]!.name, undefined);
  });
});

describe('sqlComment: the template cache and events', () => {
  it('adds no cache miss: one template whatever the comment', async () => {
    const { db } = client({ tag: true, dynamic: () => ({ traceparent: String(Math.random()) }) });
    for (const label of ['a', 'b', 'c', 'd']) {
      await db.$tag(label, () => db.users.findMany({ where: { id: 1 }, limit: 1 }));
    }
    assert.deepEqual((({ hits, misses }) => ({ hits, misses }))(db.users.cacheStats()), { hits: 3, misses: 1 });
  });

  it('events keep the commentless sql and carry the comment', async () => {
    const { db, sent, events } = client({ static: { app: 'x' }, model: true });
    await db.users.findMany({ where: { id: 1 }, limit: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.comment, "/*action='findMany',app='x',model='users'*/");
    assert.equal(`${events[0]!.sql} ${events[0]!.comment}`, sent[0]!.text);
    assert.ok(!events[0]!.sql.includes('/*'));
  });

  it('an event without sqlComment has no comment key', async () => {
    const { db, events } = client(undefined);
    await db.users.findMany({ limit: 1 });
    assert.equal('comment' in events[0]!, false);
  });
});

describe('sqlComment: every path a model statement takes', () => {
  it('writes, and a timeout on a non-cancellable pool', async () => {
    const { db, sent } = client({ model: true });
    await db.users.update({ where: { id: 1 }, data: { name: 'b' }, timeout: 5000 });
    await db.users.create({ data: { id: 3, name: 'c' } });
    assert.equal(commentOf(sent[0]!.text), "/*action='update',model='users'*/");
    assert.equal(commentOf(sent[1]!.text), "/*action='create',model='users'*/");
  });

  it('inside $transaction: the statements carry it, BEGIN and COMMIT do not', async () => {
    const { db, sent } = client({ model: true });
    await db.$transaction(async (tx: Any) => {
      await tx.users.findMany({ limit: 1 });
    });
    const begin = sent.find((s) => s.text.startsWith('BEGIN'))!;
    const commit = sent.find((s) => s.text.startsWith('COMMIT'))!;
    const select = sent.find((s) => s.text.startsWith('SELECT'))!;
    assert.equal(commentOf(begin.text), undefined);
    assert.equal(commentOf(commit.text), undefined);
    assert.equal(commentOf(select.text), "/*action='findMany',model='users'*/");
  });

  it('pipeline: each statement carries its own model and action; events carry the comment', async () => {
    const { db, sent, events } = client({ model: true, tag: true });
    await db.$tag('report', () =>
      db.pipeline(db.users.buildFindMany({ limit: 1 }), db.posts.buildCount({ where: { id: 1 } })),
    );
    const statements = sent.filter((s) => s.text.startsWith('SELECT'));
    assert.equal(commentOf(statements[0]!.text), "/*action='findMany',model='users',tag='report'*/");
    assert.equal(commentOf(statements[1]!.text), "/*action='count',model='posts',tag='report'*/");
    assert.ok(sent.filter((s) => /^(BEGIN|COMMIT)/.test(s.text)).every((s) => commentOf(s.text) === undefined));
    assert.deepEqual(
      events.map((e) => [e.batch, e.comment, e.sql.includes('/*')]),
      [
        ['pipeline', "/*action='findMany',model='users',tag='report'*/", false],
        ['pipeline', "/*action='count',model='posts',tag='report'*/", false],
      ],
    );
  });

  it('$transaction([...]): each statement carries it, and so do its events', async () => {
    const { db, sent, events } = client({ static: { app: 'x' } });
    await db.$transaction([db.users.buildFindMany({ limit: 1 }), db.posts.buildFindMany({ limit: 1 })]);
    const statements = sent.filter((s) => s.text.startsWith('SELECT'));
    assert.equal(statements.length, 2);
    for (const s of statements) assert.equal(commentOf(s.text), "/*app='x'*/");
    assert.deepEqual(
      events.map((e) => [e.batch, e.comment]),
      [
        ['transaction', "/*app='x'*/"],
        ['transaction', "/*app='x'*/"],
      ],
    );
  });

  it('commentDeferred: a reselect plan (MySQL) carries the comment on every statement it runs', async () => {
    const run: string[] = [];
    const dq = {
      sql: 'UPDATE t SET a = 1',
      params: [],
      tag: 't.update',
      transform: (r: unknown) => r,
      reselect: async (exec: Any) => {
        await exec('UPDATE t SET a = 1', []);
        return exec('SELECT * FROM t', []);
      },
    };
    const commented = commentDeferred(dq as Any, "/*app='x'*/");
    await commented.reselect!(async (sql: string) => {
      run.push(sql);
      return { rows: [], rowCount: 0 } as Any;
    });
    assert.deepEqual(run, ["UPDATE t SET a = 1 /*app='x'*/", "SELECT * FROM t /*app='x'*/"]);
    assert.equal(commented.sql, "UPDATE t SET a = 1 /*app='x'*/");
    assert.equal(commentDeferred(dq as Any, undefined), dq);
  });

  it('a stream: the speculative fetch and the cursor statement carry it; cursor control does not', async () => {
    const { pool, sent } = recordingPool([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const db = new TurbineClient(
      { pool, warnOnUnlimited: false, sqlComment: { model: true }, logger: {} },
      schema(),
    ) as Any;
    const rows: unknown[] = [];
    for await (const row of db.users.findManyStream({ batchSize: 2, idleTimeoutMs: 0 })) rows.push(row);
    const speculative = sent.find((s) => s.text.startsWith('SELECT'))!;
    const declare = sent.find((s) => s.text.startsWith('DECLARE'))!;
    assert.equal(commentOf(speculative.text), "/*action='findManyStream',model='users'*/");
    assert.ok(declare.text.endsWith(" /*action='findManyStream',model='users'*/"), declare.text);
    for (const s of sent.filter((x) => /^(BEGIN|FETCH|CLOSE|COMMIT)/.test(x.text))) {
      assert.equal(commentOf(s.text), undefined, s.text);
    }
  });

  it('raw SQL carries no comment', async () => {
    const { db, sent, events } = client({ static: { app: 'x' }, model: true });
    await db.raw`SELECT 1`;
    await db.sql`SELECT 2`;
    assert.ok(sent.every((s) => commentOf(s.text) === undefined));
    assert.ok(events.every((e) => e.comment === undefined));
  });
});
