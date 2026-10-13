/**
 * The OpenTelemetry recipe on the observability page, run for real.
 *
 * Turbine imports nothing from @opentelemetry/*. The recipe is two hooks, `$use`
 * (a span per operation) and `$on('query')` (a span per statement), and what
 * makes it work is one property of Turbine: a query event is delivered in the
 * async context of the code that awaited the statement, so the statement span
 * lands under whichever operation span, request span or transaction span was
 * active there. This file pins that property.
 *
 * It runs the recipe's exact text (the region between the `recipe:begin` and
 * `recipe:end` markers, which a test below compares with the page) against a
 * real client, with an in-memory tracer that has the same method shapes as
 * @opentelemetry/api's (`startActiveSpan`, `startSpan` with a parent context,
 * `setStatus`, `recordException`, `end`) built on AsyncLocalStorage, which is
 * what OpenTelemetry's Node context manager uses.
 *
 * The optional `sqlComment` part of the recipe (a W3C `traceparent` on each
 * statement, for sampled traces only) runs the same way: its exact text sits
 * between `traceparent:begin` and `traceparent:end`, and the spans carry the
 * span context (`traceId`, `spanId`, `traceFlags`) that @opentelemetry/api's do.
 *
 * Two lanes, one set of scenarios:
 *   - the in-process SQLite engine, which needs node:sqlite (Node >= 22.5) and no server;
 *   - a live PostgreSQL server (DATABASE_URL), against two scratch tables it creates and drops.
 */

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UniqueConstraintError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { QueryEvent, QueryEventListener } from '../query/deferred.js';
import type { SqlCommentOptions } from '../query/sql-comment.js';
import { RAW_QUERY_MODEL } from '../query-events.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// In-memory tracer: the method shapes of @opentelemetry/api, on AsyncLocalStorage
// ---------------------------------------------------------------------------

interface SpanOptions {
  kind?: number;
  startTime?: number;
  attributes?: Record<string, unknown>;
}
interface FakeContext {
  span?: FakeSpan;
}

const nowMs = (): number => performance.timeOrigin + performance.now();

/** `bytes` random bytes as lower-case hex, the way trace and span ids are written. */
const randomHex = (bytes: number): string =>
  Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');

/** What @opentelemetry/api's `Span.spanContext()` returns, minus the fields the recipe does not read. */
interface FakeSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

class FakeSpan {
  readonly kind?: number;
  readonly attributes: Record<string, unknown>;
  readonly startTime: number;
  readonly exceptions: Error[] = [];
  endTime?: number;
  status?: { code: number; message?: string };
  private readonly context: FakeSpanContext;
  constructor(
    readonly name: string,
    options: SpanOptions,
    readonly parent?: FakeSpan,
    rootFlags = 1,
  ) {
    this.kind = options.kind;
    this.attributes = { ...options.attributes };
    this.startTime = options.startTime ?? nowMs();
    // A child joins its parent's trace and inherits its sampling decision.
    const inherited = parent?.spanContext();
    this.context = {
      traceId: inherited?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      traceFlags: inherited?.traceFlags ?? rootFlags,
    };
  }
  spanContext(): FakeSpanContext {
    return this.context;
  }
  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }
  setStatus(status: { code: number; message?: string }): this {
    this.status = status;
    return this;
  }
  recordException(error: Error): void {
    this.exceptions.push(error);
  }
  end(time?: number): void {
    assert.equal(this.endTime, undefined, `span "${this.name}" was ended twice`);
    this.endTime = time ?? nowMs();
  }
}

/** `sampled: false` makes every root span (and so every trace) unsampled. */
function createFakeOtel({ sampled = true }: { sampled?: boolean } = {}) {
  const store = new AsyncLocalStorage<FakeSpan>();
  const spans: FakeSpan[] = [];
  const context = { active: (): FakeContext => ({ span: store.getStore() }) };
  const tracer = {
    startSpan(name: string, options: SpanOptions = {}, parent?: FakeContext): FakeSpan {
      const span = new FakeSpan(name, options, parent?.span, sampled ? 1 : 0);
      spans.push(span);
      return span;
    },
    startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: FakeSpan) => T): T {
      const span = tracer.startSpan(name, options, context.active());
      return store.run(span, () => fn(span));
    },
  };
  const trace = { getTracer: (_name: string) => tracer, getActiveSpan: () => store.getStore() };
  const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2 } as const;
  const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
  const TraceFlags = { NONE: 0, SAMPLED: 1 } as const;
  return { spans, store, tracer, context, trace, SpanKind, SpanStatusCode, TraceFlags };
}
type FakeOtel = ReturnType<typeof createFakeOtel>;

/** The two client hooks the recipe uses. */
type Hooks = { $use: TurbineClient['$use']; $on(event: 'query', listener: QueryEventListener): void };

function installRecipe(db: Hooks, otel: FakeOtel, DB_SYSTEM: string): void {
  const { context, trace, SpanKind, SpanStatusCode } = otel;
  // recipe:begin
  const tracer = trace.getTracer('turbine-orm');

  // One span per Turbine operation. The statements it runs become its children.
  db.$use((params, next) =>
    tracer.startActiveSpan(`${params.model}.${params.action}`, { kind: SpanKind.INTERNAL }, async (span) => {
      try {
        return await next(params);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }),
  );

  // One span per SQL statement, back-dated from the event's duration.
  db.$on('query', (e) => {
    const end = e.timestamp.getTime();
    const table = e.model === RAW_QUERY_MODEL ? undefined : e.model;
    const span = tracer.startSpan(
      table ? `${e.action} ${table}` : e.action,
      {
        kind: SpanKind.CLIENT,
        startTime: end - e.duration,
        attributes: {
          'db.system.name': DB_SYSTEM,
          'db.operation.name': e.action,
          'db.query.text': e.sql,
          ...(table ? { 'db.collection.name': table } : {}),
          ...(e.tag ? { 'turbine.tag': e.tag } : {}),
          ...(e.batch ? { 'turbine.batch': e.batch } : {}),
          ...(e.retried ? { 'turbine.retried': true } : {}),
        },
      },
      context.active(),
    );
    if (e.error) {
      span.setAttribute('error.type', e.error.name);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.error.message });
    }
    span.end(end);
  });
  // recipe:end
}

/** The `sqlComment` option of the recipe: a W3C traceparent on each statement of a sampled trace. */
function traceparentComment(otel: FakeOtel): SqlCommentOptions {
  const { trace, TraceFlags } = otel;
  // traceparent:begin
  const sqlComment: SqlCommentOptions = {
    dynamic: () => {
      const ctx = trace.getActiveSpan()?.spanContext();
      // Unsampled: add nothing, so the statement keeps its prepared statement.
      if (!ctx || (ctx.traceFlags & TraceFlags.SAMPLED) === 0) return undefined;
      return { traceparent: `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, '0')}` };
    },
  };
  // traceparent:end
  return sqlComment;
}

/** Install the recipe on `db`, optionally delivering events from outside the caller's async scope. */
function traced(db: TurbineClient, dbSystem: string, detach = false): FakeOtel & { events: QueryEvent[] } {
  const otel = createFakeOtel();
  const events: QueryEvent[] = [];
  db.$on('query', (e) => events.push(e));
  const hooks: Hooks = detach
    ? {
        $use: (mw) => db.$use(mw),
        $on: (event, listener) => db.$on(event, (e) => otel.store.exit(() => listener(e))),
      }
    : db;
  installRecipe(hooks, otel, dbSystem);
  return Object.assign(otel, { events });
}

/** Run `fn` inside a span standing for the caller's own work (an HTTP request, a job). */
async function inRequest<T>(otel: FakeOtel, fn: () => Promise<T>, name = 'request'): Promise<T> {
  return otel.tracer.startActiveSpan(name, { kind: otel.SpanKind.SERVER }, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

/** The span tree as indented names, in start order. A span with no parent prints at depth 0. */
function outline(spans: FakeSpan[]): string[] {
  const lines: string[] = [];
  const walk = (parent: FakeSpan | undefined, depth: number): void => {
    for (const span of spans) {
      if (span.parent !== parent) continue;
      lines.push(`${'  '.repeat(depth)}${span.name}`);
      walk(span, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines;
}

function expectOutline(otel: FakeOtel, expected: string[]): void {
  const actual = outline(otel.spans);
  assert.deepEqual(
    actual,
    expected,
    `the span tree is wrong. A statement span printed at the wrong depth means the query event ran outside the ` +
      `async context of the code that awaited the statement.\n expected: ${JSON.stringify(expected)}\n actual:   ${JSON.stringify(actual)}`,
  );
  assertAllEnded(otel);
}

function assertAllEnded(otel: FakeOtel): void {
  for (const span of otel.spans) assert.notEqual(span.endTime, undefined, `span "${span.name}" was never ended`);
}

const statements = (otel: FakeOtel): FakeSpan[] => otel.spans.filter((s) => s.kind === otel.SpanKind.CLIENT);
const childrenOf = (otel: FakeOtel, parent: FakeSpan): FakeSpan[] => otel.spans.filter((s) => s.parent === parent);
const spanNamed = (otel: FakeOtel, name: string): FakeSpan => {
  const found = otel.spans.find((s) => s.name === name);
  assert.ok(found, `no span named "${name}" in ${JSON.stringify(outline(otel.spans))}`);
  return found;
};

// ---------------------------------------------------------------------------
// Fixture: an owner table and a child table, indexed so the default relation strategy stays on the join
// ---------------------------------------------------------------------------

interface Opened {
  db: TurbineClient;
  /** The hasMany relation from the owner table to the item table, as introspection spelled it. */
  itemsRel: string;
  close(): Promise<void>;
}

function relationTo(schema: SchemaMetadata, from: string, to: string): string {
  const found = Object.values(schema.tables[from]?.relations ?? {}).find((r) => r.to === to);
  assert.ok(found, `fixture should expose a ${from} -> ${to} relation`);
  return found.name;
}

/** node:sqlite is a builtin only on Node >= 22.5; probe without a static import. */
const nodeSqlite: { DatabaseSync: new (path: string) => import('node:sqlite').DatabaseSync } | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite');
  } catch {
    return undefined;
  }
})();

const sqliteGate = skipGate(!nodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

/** Client options a scenario adds (the traceparent scenarios pass `sqlComment`). */
type ClientExtra = { sqlComment?: SqlCommentOptions };

async function openSqlite(extra: ClientExtra = {}): Promise<Opened> {
  const sqlite = new (nodeSqlite as NonNullable<typeof nodeSqlite>).DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE otel_owner (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE otel_item (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES otel_owner(id), label TEXT);
    CREATE INDEX idx_otel_item_owner_id ON otel_item (owner_id);
    INSERT INTO otel_owner (name) VALUES ('owner-a'), ('owner-b');
    INSERT INTO otel_item (owner_id, label) VALUES (1, 'x'), (1, 'y'), (2, 'z');
  `);
  const schema = introspectSqliteDatabase(sqlite);
  const db = turbineSqlite(sqlite, schema, { warnOnUnlimited: false, ...extra });
  return { db, itemsRel: relationTo(schema, 'otel_owner', 'otel_item'), close: () => db.disconnect() };
}

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const PG_TABLES = 'otel_item, otel_owner';
let pgSchema: SchemaMetadata | undefined;

async function runDdl(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const statement of statements) await pool.query(statement);
  } finally {
    await pool.end();
  }
}

async function preparePostgres(): Promise<void> {
  await runDdl([
    `DROP TABLE IF EXISTS ${PG_TABLES} CASCADE`,
    'CREATE TABLE otel_owner (id serial PRIMARY KEY, name text NOT NULL UNIQUE)',
    'CREATE TABLE otel_item (id serial PRIMARY KEY, owner_id int NOT NULL REFERENCES otel_owner(id), label text)',
    'CREATE INDEX idx_otel_item_owner_id ON otel_item (owner_id)',
    "INSERT INTO otel_owner (name) VALUES ('owner-a'), ('owner-b')",
    "INSERT INTO otel_item (owner_id, label) SELECT id, 'l' || g FROM otel_owner, generate_series(1, 2) g",
  ]);
  pgSchema = await introspect({ connectionString: DATABASE_URL! });
}

async function openPostgres(extra: ClientExtra = {}): Promise<Opened> {
  const schema = pgSchema as SchemaMetadata;
  const db = new TurbineClient(
    { connectionString: DATABASE_URL!, poolSize: 4, warnOnUnlimited: false, ...extra },
    schema,
  );
  await db.connect();
  return { db, itemsRel: relationTo(schema, 'otel_owner', 'otel_item'), close: () => db.disconnect() };
}

// ---------------------------------------------------------------------------
// Scenarios, run on both lanes
// ---------------------------------------------------------------------------

type Gate = ReturnType<typeof skipGate>;

async function withClient<T>(
  open: () => Promise<Opened>,
  dbSystem: string,
  fn: (c: Opened & FakeOtel & { events: QueryEvent[] }) => Promise<T>,
  detach = false,
): Promise<T> {
  const opened = await open();
  try {
    return await fn(Object.assign(opened, traced(opened.db, dbSystem, detach)));
  } finally {
    await opened.close();
  }
}

/**
 * {@link withClient} for the traceparent part of the recipe: the tracer exists
 * before the client, because the client's `sqlComment` reads it.
 */
async function withTraceparent<T>(
  open: (extra: ClientExtra) => Promise<Opened>,
  dbSystem: string,
  sampled: boolean,
  fn: (c: Opened & FakeOtel & { events: QueryEvent[] }) => Promise<T>,
): Promise<T> {
  const otel = createFakeOtel({ sampled });
  const opened = await open({ sqlComment: traceparentComment(otel) });
  const events: QueryEvent[] = [];
  opened.db.$on('query', (e) => events.push(e));
  installRecipe(opened.db, otel, dbSystem);
  try {
    return await fn(Object.assign(opened, otel, { events }));
  } finally {
    await opened.close();
  }
}

/** The comment the recipe's `sqlComment` gives a statement run while `span` is active. */
function traceparentOf(span: FakeSpan): string {
  const { traceId, spanId } = span.spanContext();
  return `/*traceparent='00-${traceId}-${spanId}-01'*/`;
}

function defineScenarios(gate: Gate, open: (extra?: ClientExtra) => Promise<Opened>, dbSystem: string): void {
  const run = <T>(fn: (c: Opened & FakeOtel & { events: QueryEvent[] }) => Promise<T>, detach = false) =>
    withClient(open, dbSystem, fn, detach);

  gate.it('traceparent: each statement of a sampled trace names the span that ran it', async () => {
    await withTraceparent(open, dbSystem, true, async (c) => {
      await inRequest(c, () => c.db.table('otel_owner').findMany({ where: { name: 'owner-a' } }));
      const op = spanNamed(c, 'otel_owner.findMany');
      assert.equal(c.events.length, 1);
      const event = c.events[0] as QueryEvent;
      // The operation span was active where the statement was sent, so the database sees it as the parent.
      assert.equal(event.comment, traceparentOf(op));
      assert.match(String(event.comment), /^\/\*traceparent='00-[0-9a-f]{32}-[0-9a-f]{16}-01'\*\/$/);
      assert.equal(op.spanContext().traceId, spanNamed(c, 'request').spanContext().traceId, 'one trace');
      assert.ok(!event.sql.includes('/*'), 'the event and db.query.text keep the commentless text');
      assert.equal(spanNamed(c, 'findMany otel_owner').attributes['db.query.text'], event.sql);

      // A pipeline bypasses middleware, so its statements name the caller's span.
      await inRequest(
        c,
        () => c.db.pipeline(c.db.table('otel_owner').buildFindMany({}), c.db.table('otel_item').buildCount({})),
        'batch',
      );
      const batch = spanNamed(c, 'batch');
      assert.deepEqual(
        c.events.slice(1).map((e) => e.comment),
        [traceparentOf(batch), traceparentOf(batch)],
      );
    });
  });

  gate.it('traceparent: an unsampled trace, or no trace, adds nothing to the statement', async () => {
    await withTraceparent(open, dbSystem, false, async (c) => {
      await inRequest(c, () => c.db.table('otel_owner').findMany({}));
      await c.db.table('otel_item').count();
      assert.equal(c.events.length, 2);
      for (const event of c.events) assert.equal(event.comment, undefined);
    });
    await withTraceparent(open, dbSystem, true, async (c) => {
      await c.db.raw`SELECT 1 AS one`;
      assert.equal(c.events[0]?.comment, undefined, 'raw SQL never carries a comment');
    });
  });

  gate.it('a findMany with a nested with: one operation span, one statement span under it', async () => {
    await run(async (c) => {
      await c.db
        .table('otel_owner')
        .findMany({ where: { name: 'owner-a' }, with: { [c.itemsRel]: true }, relationLoadStrategy: 'join' });
      expectOutline(c, ['otel_owner.findMany', '  findMany otel_owner']);

      const op = spanNamed(c, 'otel_owner.findMany');
      const stmt = spanNamed(c, 'findMany otel_owner');
      assert.equal(op.kind, c.SpanKind.INTERNAL, 'the operation is in-process work, not a second client span');
      assert.equal(stmt.kind, c.SpanKind.CLIENT);
      assert.equal(stmt.attributes['db.system.name'], dbSystem);
      assert.equal(stmt.attributes['db.operation.name'], 'findMany');
      assert.equal(stmt.attributes['db.collection.name'], 'otel_owner');
      assert.equal(stmt.status, undefined);

      // Placeholders only: the bound value never reaches the span.
      const text = String(stmt.attributes['db.query.text']);
      assert.match(text, /otel_item/, 'the nested relation is part of the one statement');
      assert.ok(!text.includes('owner-a'), `db.query.text must carry placeholders, not values: ${text}`);
      assert.equal(text, c.events[0]?.sql);

      // Back-dated from the event: the span is exactly as long as the event says, and ends at its timestamp.
      const event = c.events[0] as QueryEvent;
      assert.equal(stmt.endTime, event.timestamp.getTime());
      assert.ok(
        Math.abs((stmt.endTime as number) - stmt.startTime - event.duration) < 0.01,
        'span length is the duration',
      );
      assert.ok(
        stmt.startTime >= op.startTime - 2 && (stmt.endTime as number) <= (op.endTime as number) + 2,
        'inside its parent',
      );
    });
  });

  gate.it("relationLoadStrategy: 'batched': every follow-up statement is a child of the one operation", async () => {
    await run(async (c) => {
      await c.db.table('otel_owner').findMany({ with: { [c.itemsRel]: true }, relationLoadStrategy: 'batched' });
      const ops = c.spans.filter((s) => s.kind === c.SpanKind.INTERNAL);
      assert.deepEqual(
        ops.map((s) => s.name),
        ['otel_owner.findMany'],
        'one operation span, however many statements it ran',
      );
      const kids = childrenOf(c, ops[0] as FakeSpan);
      assert.equal(kids.length, 2, `the base statement and one follow-up: ${JSON.stringify(outline(c.spans))}`);
      assert.deepEqual(statements(c), kids, 'every statement span is a direct child of the operation');
      assert.match(
        String(kids[1]?.attributes['db.query.text']),
        /"otel_item"/,
        'the follow-up reads the relation table',
      );
      assert.equal(outline(c.spans).filter((line) => !line.startsWith(' ')).length, 1, 'nothing is orphaned');
      assertAllEnded(c);
    });
  });

  gate.it('a transaction-scoped call: statements nest under their operation under the caller', async () => {
    await run(async (c) => {
      await inRequest(c, () =>
        c.db.$transaction(async (tx) => {
          await tx.table('otel_owner').findMany({ where: { name: 'owner-b' } });
          await tx.table('otel_item').count();
        }),
      );
      // BEGIN and COMMIT are not reported, so the transaction adds no span of its own.
      expectOutline(c, [
        'request',
        '  otel_owner.findMany',
        '    findMany otel_owner',
        '  otel_item.count',
        '    count otel_item',
      ]);
    });
  });

  gate.it('a pipeline: one statement span per query under the caller, with the batch time split evenly', async () => {
    await run(async (c) => {
      await inRequest(c, () =>
        c.db.pipeline(c.db.table('otel_owner').buildFindMany({}), c.db.table('otel_item').buildCount({})),
      );
      // A pipeline bypasses middleware, so there are no operation spans, only statements.
      expectOutline(c, ['request', '  findMany otel_owner', '  count otel_item']);
      const [first, second] = statements(c) as [FakeSpan, FakeSpan];
      assert.equal(first.attributes['turbine.batch'], 'pipeline');
      assert.equal(second.attributes['turbine.batch'], 'pipeline');
      const length = (s: FakeSpan) => (s.endTime as number) - s.startTime;
      assert.ok(Math.abs(length(first) - length(second)) < 0.01, 'both statements report the same share of the batch');
    });
  });

  gate.it('a $transaction([...]) batch: statement spans under the caller, timed one by one', async () => {
    await run(async (c) => {
      await inRequest(c, () =>
        c.db.$transaction([c.db.table('otel_owner').buildFindMany({}), c.db.table('otel_item').buildCount({})]),
      );
      expectOutline(c, ['request', '  findMany otel_owner', '  count otel_item']);
      assert.deepEqual(
        statements(c).map((s) => s.attributes['turbine.batch']),
        ['transaction', 'transaction'],
      );
    });
  });

  gate.it('a lazy db.sql builder executes where it is awaited, not where it was built', async () => {
    await run(async (c) => {
      let query: PromiseLike<unknown> | undefined;
      await inRequest(
        c,
        async () => {
          query = c.db.sql`SELECT CAST(${1} AS INTEGER) AS one`;
        },
        'builder',
      );
      await inRequest(
        c,
        async () => {
          await query;
        },
        'runner',
      );
      expectOutline(c, ['builder', 'runner', '  sql']);
      const stmt = spanNamed(c, 'sql');
      assert.equal(stmt.attributes['db.collection.name'], undefined, 'raw SQL belongs to no table');
      assert.equal(stmt.attributes['db.operation.name'], 'sql');
    });
  });

  gate.it('a stream: its statement lands under the span active where the stream is consumed', async () => {
    await run(async (c) => {
      let rows = 0;
      await inRequest(c, async () => {
        for await (const _row of c.db.table('otel_owner').findManyStream({})) rows++;
      });
      assert.equal(rows, 2);
      // Streams bypass middleware, so there is no operation span.
      expectOutline(c, ['request', '  findManyStream otel_owner']);
    });
  });

  gate.it('db.raw carries the $tag scope as an attribute and has no collection', async () => {
    await run(async (c) => {
      await inRequest(c, () => c.db.$tag('report', () => c.db.raw`SELECT 1 AS one`));
      expectOutline(c, ['request', '  raw']);
      const stmt = spanNamed(c, 'raw');
      assert.equal(stmt.attributes['turbine.tag'], 'report');
      assert.equal(stmt.attributes['db.collection.name'], undefined);
    });
  });

  gate.it('concurrent requests keep their own spans', async () => {
    await run(async (c) => {
      const request = (name: string, owner: string) =>
        inRequest(
          c,
          () => c.db.table('otel_owner').findMany({ where: { name: owner }, with: { [c.itemsRel]: true } }),
          name,
        );
      await Promise.all([request('one', 'owner-a'), request('two', 'owner-b'), request('three', 'owner-a')]);
      for (const name of ['one', 'two', 'three']) {
        const root = spanNamed(c, name);
        const ops = childrenOf(c, root);
        assert.deepEqual(
          ops.map((s) => s.name),
          ['otel_owner.findMany'],
          `request ${name} owns exactly its own operation`,
        );
        const stmts = ops.flatMap((op) => childrenOf(c, op));
        assert.ok(stmts.length >= 1, `request ${name} owns its statements`);
        for (const stmt of stmts) assert.equal(stmt.kind, c.SpanKind.CLIENT);
      }
      assert.equal(
        outline(c.spans).filter((line) => !line.startsWith(' ')).length,
        3,
        'only the three requests are roots',
      );
    });
  });

  gate.it('a failed operation: exception recorded on the operation, status on both spans', async () => {
    await run(async (c) => {
      await inRequest(c, async () => {
        await assert.rejects(
          c.db.table('otel_owner').create({ data: { name: 'owner-a' } }),
          (err: unknown) => err instanceof UniqueConstraintError,
        );
      });
      expectOutline(c, ['request', '  otel_owner.create', '    create otel_owner']);
      const op = spanNamed(c, 'otel_owner.create');
      const stmt = spanNamed(c, 'create otel_owner');
      assert.equal(op.exceptions.length, 1);
      assert.equal(op.exceptions[0]?.name, 'UniqueConstraintError');
      assert.equal(op.status?.code, c.SpanStatusCode.ERROR);
      assert.equal(stmt.status?.code, c.SpanStatusCode.ERROR);
      assert.equal(stmt.attributes['error.type'], 'UniqueConstraintError');
      assert.ok(!String(stmt.status?.message).includes('owner-a'), 'the error message carries no bound value');
      assert.equal(spanNamed(c, 'request').status, undefined, 'the request itself did not fail');
    });
  });

  gate.it(
    "negative control: events delivered outside the caller's async context make the structure check fail",
    async () => {
      await run(async (c) => {
        await inRequest(c, () => c.db.table('otel_owner').findMany({}));
        assert.throws(
          () => expectOutline(c, ['request', '  otel_owner.findMany', '    findMany otel_owner']),
          /the query event ran outside the async context/,
          'the structure check must reject orphaned statement spans',
        );
        // The statement span exists, but at the top level.
        assert.deepEqual(outline(c.spans), ['request', '  otel_owner.findMany', 'findMany otel_owner']);
      }, true);
    },
  );
}

describe('OpenTelemetry recipe, in-process SQLite engine', () => {
  defineScenarios(sqliteGate, openSqlite, 'sqlite');
});

describe('OpenTelemetry recipe, live PostgreSQL', () => {
  pgGate.before(preparePostgres);
  pgGate.after(async () => {
    if (DATABASE_URL) await runDdl([`DROP TABLE IF EXISTS ${PG_TABLES} CASCADE`]);
  });
  defineScenarios(pgGate, openPostgres, 'postgresql');
});

// ---------------------------------------------------------------------------
// The page shows the code this file ran
// ---------------------------------------------------------------------------

/** Comments and layout do not matter; every token does. */
const squash = (code: string): string =>
  code
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, '')
    .replace(/,([)}\]])/g, '$1');

/** The `## OpenTelemetry` section of the page, up to the next top-level heading. */
function otelSection(page: string): string {
  const start = page.indexOf('\n## OpenTelemetry');
  assert.notEqual(start, -1, 'the observability page needs an "## OpenTelemetry" section');
  const next = page.indexOf('\n## ', start + 1);
  return page.slice(start, next === -1 ? undefined : next);
}

describe('OpenTelemetry recipe, documentation', () => {
  const page = readFileSync(new URL('../../site/app/(docs)/observability/page.mdx', import.meta.url), 'utf8');
  const own = readFileSync(new URL(import.meta.url), 'utf8');
  const tested = own.slice(own.indexOf('// recipe:begin') + '// recipe:begin'.length, own.indexOf('// recipe:end'));

  it('the recipe on the observability page is the code this file runs', () => {
    const block = (otelSection(page).match(/```ts\n[\s\S]*?```/g) ?? []).find((b) => b.includes('const tracer = '));
    assert.ok(block, 'no code block in the OpenTelemetry section defines the tracer');
    // The imports and the engine constant are the only lines the test supplies differently.
    const documented = block
      .replace(/^```ts\n|```$/g, '')
      .split('\n')
      .filter((line) => !line.startsWith('import ') && !line.startsWith('const DB_SYSTEM'))
      .join('\n');

    assert.ok(squash(tested).length > 500, 'the extracted recipe is implausibly short');
    assert.equal(
      squash(documented),
      squash(tested),
      'the recipe on site/app/(docs)/observability/page.mdx differs from the code src/test/otel-recipe.test.ts runs',
    );
  });

  it('the traceparent option on the observability page is the code this file runs', () => {
    const region = own.slice(
      own.indexOf('// traceparent:begin') + '// traceparent:begin'.length,
      own.indexOf('// traceparent:end'),
    );
    const block = (otelSection(page).match(/```ts\n[\s\S]*?```/g) ?? []).find((b) => b.includes('traceparent'));
    assert.ok(block, 'no code block in the OpenTelemetry section sets the traceparent comment');
    // The imports and the client construction are the only lines the test supplies differently.
    const documented = block
      .replace(/^```ts\n|```$/g, '')
      .split('\n')
      .filter((line) => !line.startsWith('import ') && !line.startsWith('const db = '))
      .join('\n');
    assert.ok(squash(region).length > 150, 'the extracted traceparent option is implausibly short');
    assert.equal(
      squash(documented),
      squash(region),
      'the traceparent option on site/app/(docs)/observability/page.mdx differs from the code src/test/otel-recipe.test.ts runs',
    );
  });

  it('every attribute the recipe sets is named in the prose', () => {
    const section = otelSection(page);
    const set = [...tested.matchAll(/'((?:db|turbine|error)\.[a-z_.]+)'/g)].map((m) => m[1] as string);
    assert.ok(set.length >= 8, `expected the recipe to set its attributes, found ${set.join(', ')}`);
    for (const name of new Set(set)) {
      assert.ok(section.includes(`\`${name}\``), `the OpenTelemetry section never mentions \`${name}\``);
    }
  });
});
