/**
 * turbine-orm/prisma-compat, `$extends` (client extensions).
 *
 * Two layers over one small fixture (Prisma `User.email` -> column
 * `email_address`, plus a `Post` model):
 *   - DB-less tests over a recording client, covering the supported `client` /
 *     `model` / `$allModels` components, the named refusal of every component
 *     this adapter does NOT support, and the invariant that an extended client
 *     is still a WORKING client (delegates under both spellings, `$transaction`
 *     in both forms, the raw surface).
 *   - a live-Postgres section (gated on `DATABASE_URL`) that runs an extended
 *     client end to end against its own tables.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { introspect } from '../introspect.js';
import { CLIENT_RESERVED_KEYS, type CompatTurbineClient, createPrismaCompatClient, Prisma } from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

// ---------------------------------------------------------------------------
// Fixture + recording client
// ---------------------------------------------------------------------------

function fixture(): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email_address', field: 'emailAddress', pgType: 'text' },
  ]);
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  const schema: SchemaMetadata = { enums: {}, tables: { users, posts } };
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        fields: { id: 'id', email: 'emailAddress' },
        relations: {},
        compoundUniques: {},
      },
      Post: {
        table: 'posts',
        accessor: 'posts',
        fields: { id: 'id', title: 'title' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

interface SpyCall {
  table: string;
  method: string;
}

/** A recording client: notes which table/method each delegate call reached. */
function spyDb(
  schema: SchemaMetadata,
  results: Record<string, unknown> = {},
): { db: CompatTurbineClient; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const qi = (table: string): Any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return () => {
            calls.push({ table, method: prop });
            const key = `${table}.${prop}`;
            if (key in results) return Promise.resolve(results[key]);
            if (/Many$/.test(prop)) return Promise.resolve([]);
            return Promise.resolve(null);
          };
        },
      },
    );
  const db = {
    schema,
    table: qi,
    pool: {
      query: async (sql: string, params: unknown[]) => ({ rows: [{ sql, params }], rowCount: 1 }),
    },
    dialect: { paramPlaceholder: (n: number) => `$${n}` },
    $transaction: (arg: Any) => {
      if (Array.isArray(arg)) return Promise.resolve([]);
      return arg({
        table: qi,
        rawQuery: async (text: string, params: unknown[] = []) => ({ rows: [{ text, params }], rowCount: 1 }),
      });
    },
  };
  return { db: db as unknown as CompatTurbineClient, calls };
}

function mkCompat(db: CompatTurbineClient, map: PrismaCompatMap): Any {
  return createPrismaCompatClient(db as unknown as TurbineClient, map) as Any;
}

/** Assert `fn` throws a TurbineError with `code`, and that its message names `needle`. */
function throwsWith(fn: () => unknown, code: string, needle: string): TurbineError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TurbineError, `expected a TurbineError, got ${String(caught)}`);
  assert.equal((caught as TurbineError).code, code);
  assert.ok(
    (caught as TurbineError).message.includes(needle),
    `message did not name "${needle}": ${(caught as TurbineError).message}`,
  );
  return caught as TurbineError;
}

// ---------------------------------------------------------------------------
// Supported components
// ---------------------------------------------------------------------------

describe('prisma-compat, $extends supported components', () => {
  it('exists on the client and is a reserved (non-delegate) key', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    assert.equal(typeof compat.$extends, 'function');
    assert.ok(CLIENT_RESERVED_KEYS.has('$extends'));
  });

  it('`model` members land on BOTH spellings of the delegate and can call it through `this`', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, { 'users.findMany': [{ id: 1, emailAddress: 'a@acme.com' }] });
    const compat = mkCompat(db, map);
    const ext = compat.$extends({
      model: {
        User: {
          async byDomain(domain: string) {
            // `this` is the extended delegate, so the real delegate call runs.
            return (this as Any).findMany({ where: { email: { endsWith: domain } } });
          },
        },
      },
    });

    assert.equal(typeof ext.User.byDomain, 'function');
    // Prisma's client-property spelling resolves to the SAME extended delegate.
    assert.equal(ext.user.byDomain, ext.User.byDomain);
    const rows = await ext.User.byDomain('@acme.com');
    assert.deepEqual(rows, [{ id: 1, email: 'a@acme.com' }]);
    assert.deepEqual(calls, [{ table: 'users', method: 'findMany' }]);
    // Untouched models keep the base delegate.
    assert.equal((ext.Post as Any).byDomain, undefined);
  });

  it('`$allModels` members land on every delegate, and `$name` reports the model', async () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const ext = compat.$extends({
      model: {
        $allModels: {
          whoAmI() {
            return Prisma.getExtensionContext(this as Any).$name;
          },
        },
      },
    });
    assert.equal(ext.User.whoAmI(), 'User');
    assert.equal(ext.Post.whoAmI(), 'Post');
    assert.equal(ext.post.whoAmI(), 'Post');
  });

  it('a per-model member wins over `$allModels`, and a later extension wins over an earlier one', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const ext = compat
      .$extends({ model: { $allModels: { tag: () => 'all' }, User: { tag: () => 'user' } } })
      .$extends({ model: { Post: { tag: () => 'post-later' } } });
    assert.equal(ext.User.tag(), 'user');
    assert.equal(ext.Post.tag(), 'post-later');
  });

  it('`client` members land on the client and can reach the delegates through `this`', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, { 'users.count': 4 });
    const ext = mkCompat(db, map).$extends({
      name: 'stats',
      client: {
        async $userCount() {
          return (this as Any).User.count();
        },
      },
    });
    assert.equal(await ext.$userCount(), 4);
    assert.deepEqual(calls, [{ table: 'users', method: 'count' }]);
  });

  it('returns a NEW client and leaves the one it was called on untouched', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const ext = compat.$extends({ client: { $ping: () => 'pong' }, model: { User: { hello: () => 'hi' } } });
    assert.notEqual(ext, compat);
    assert.equal(compat.$ping, undefined);
    assert.equal((compat.User as Any).hello, undefined);
    assert.equal(ext.$ping(), 'pong');
  });

  it('the callback form is `fn(client)`, exactly as in Prisma', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const seen: unknown[] = [];
    const out = compat.$extends(
      Prisma.defineExtension((c: Any) => {
        seen.push(c);
        return c.$extends({ client: { $viaCallback: () => 42 } });
      }),
    );
    assert.equal(seen[0], compat);
    assert.equal(out.$viaCallback(), 42);
  });

  it('an extension applies to a schema whose only accessor keys are lowercase', () => {
    // A model whose Prisma name is already lowercase has no separate alias; the
    // single spelling must still resolve as a `model` key.
    const { schema } = fixture();
    const map: PrismaCompatMap = {
      enums: {},
      models: {
        users: { table: 'users', accessor: 'users', fields: { id: 'id' }, relations: {}, compoundUniques: {} },
      },
    };
    const ext = mkCompat(spyDb(schema).db, map).$extends({ model: { users: { tag: () => 'ok' } } });
    assert.equal(ext.users.tag(), 'ok');
  });
});

// ---------------------------------------------------------------------------
// Refusals: every capability that is NOT supported is named at $extends time
// ---------------------------------------------------------------------------

describe('prisma-compat, $extends refusals', () => {
  it('`query` throws a named UnsupportedFeatureError pointing at $use', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const err = throwsWith(
      () => compat.$extends({ query: { user: { findMany: () => null } } }),
      TurbineErrorCode.UNSUPPORTED_FEATURE,
      '`query`',
    );
    assert.match(err.message, /\$use/);
  });

  it('`result` throws a named UnsupportedFeatureError with the workaround', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const err = throwsWith(
      () => compat.$extends({ result: { user: { fullName: { needs: { id: true }, compute: () => '' } } } }),
      TurbineErrorCode.UNSUPPORTED_FEATURE,
      '`result`',
    );
    assert.match(err.message, /generated column/);
  });

  it('an unrecognized component (Accelerate-style) is refused by name', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    throwsWith(
      () => compat.$extends({ accelerate: { enabled: true } }),
      TurbineErrorCode.UNSUPPORTED_FEATURE,
      'accelerate',
    );
  });

  it('a supported component alongside an unsupported one still refuses (nothing is half-applied)', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    throwsWith(
      () => compat.$extends({ model: { User: { tag: () => 'x' } }, result: {} }),
      TurbineErrorCode.UNSUPPORTED_FEATURE,
      '`result`',
    );
    assert.equal((compat.User as Any).tag, undefined);
  });

  it('a `client` member that would shadow a delegate or a client method is refused', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    throwsWith(() => compat.$extends({ client: { User: {} } }), TurbineErrorCode.VALIDATION, 'User');
    throwsWith(() => compat.$extends({ client: { user: {} } }), TurbineErrorCode.VALIDATION, 'user');
    throwsWith(
      () => compat.$extends({ client: { $transaction: () => null } }),
      TurbineErrorCode.VALIDATION,
      '$transaction',
    );
    throwsWith(() => compat.$extends({ client: { $extends: () => null } }), TurbineErrorCode.VALIDATION, '$extends');
  });

  it('a `model` key that names no model is refused, listing the known models', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const err = throwsWith(
      () => compat.$extends({ model: { Comment: { tag: () => 'x' } } }),
      TurbineErrorCode.VALIDATION,
      'Comment',
    );
    assert.match(err.message, /Post, User/);
  });

  it('a non-object, non-function argument is refused', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    throwsWith(() => compat.$extends(null), TurbineErrorCode.VALIDATION, 'null');
    throwsWith(() => compat.$extends('nope'), TurbineErrorCode.VALIDATION, 'string');
  });
});

// ---------------------------------------------------------------------------
// An extended client is still a working client
// ---------------------------------------------------------------------------

describe('prisma-compat, $extends keeps the client whole', () => {
  it('delegates, $connect/$disconnect and the raw surface all survive', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, { 'posts.findMany': [{ id: 9, title: 'T' }] });
    const ext = mkCompat(db, map).$extends({ client: { $ping: () => 'pong' } });

    assert.deepEqual(await ext.Post.findMany(), [{ id: 9, title: 'T' }]);
    assert.deepEqual(await ext.post.findMany(), [{ id: 9, title: 'T' }]);
    assert.deepEqual(calls, [
      { table: 'posts', method: 'findMany' },
      { table: 'posts', method: 'findMany' },
    ]);
    await ext.$connect();
    await ext.$disconnect();
    const rows = (await ext.$queryRaw`SELECT ${1}`) as Any[];
    assert.equal(rows[0].sql, 'SELECT $1');
    assert.deepEqual(rows[0].params, [1]);
    assert.equal(await ext.$executeRawUnsafe('DELETE FROM posts'), 1);
  });

  it('`model` members are on the TRANSACTION-scoped delegates too', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, { 'users.findMany': [{ id: 1, emailAddress: 'a@acme.com' }] });
    const ext = mkCompat(db, map).$extends({
      model: {
        $allModels: {
          async all() {
            return (this as Any).findMany();
          },
        },
      },
    });
    const out = await ext.$transaction(async (tx: Any) => {
      assert.equal(typeof tx.User.all, 'function');
      assert.equal(tx.User.$name, 'User');
      // Raw SQL on the transaction client still works alongside the extension.
      await tx.$executeRawUnsafe('SELECT 1');
      return tx.user.all();
    });
    assert.deepEqual(out, [{ id: 1, email: 'a@acme.com' }]);
    assert.deepEqual(calls, [{ table: 'users', method: 'findMany' }]);
  });

  it('an unextended client and a client-only extension share the very same delegates', () => {
    // The delegate copy is skipped when an extension contributes nothing to it,
    // so `client`-only extensions cost nothing on the query path.
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const ext = compat.$extends({ client: { $ping: () => 'pong' } });
    assert.equal(ext.User, compat.User);
    assert.equal(ext.Post, compat.Post);
  });

  it('the extended client exposes exactly the base keys plus the extension members', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    const ext = compat.$extends({ client: { $ping: () => 'pong' } });
    assert.deepEqual(Object.keys(ext).sort(), [...Object.keys(compat), '$ping'].sort());
  });
});

// ---------------------------------------------------------------------------
// Live Postgres
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const { it: itDb, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat, $extends integration (real Postgres)', () => {
  let db: TurbineClient;
  let compat: Any;

  const ddl = [
    'DROP TABLE IF EXISTS ext_post, ext_user CASCADE',
    `CREATE TABLE ext_user (
       id            serial PRIMARY KEY,
       email_address text NOT NULL UNIQUE
     )`,
    `CREATE TABLE ext_post (
       id        serial PRIMARY KEY,
       title     text NOT NULL,
       author_id int NOT NULL REFERENCES ext_user(id)
     )`,
  ];

  before(async () => {
    if (!url) return;
    const admin = new TurbineClient({ connectionString: url }, { enums: {}, tables: {} });
    for (const stmt of ddl) await admin.raw([stmt] as unknown as TemplateStringsArray);
    await admin.raw([
      "INSERT INTO ext_user (email_address) VALUES ('a@acme.com'),('b@other.com')",
    ] as unknown as TemplateStringsArray);
    await admin.raw([
      "INSERT INTO ext_post (title, author_id) VALUES ('First', 1),('Second', 2)",
    ] as unknown as TemplateStringsArray);
    await admin.disconnect();

    const schema = await introspect({ connectionString: url });
    db = new TurbineClient({ connectionString: url }, schema);
    const map: PrismaCompatMap = {
      enums: {},
      models: {
        User: {
          table: 'ext_user',
          accessor: 'extUsers',
          fields: { id: 'id', email: 'emailAddress' },
          relations: {},
          compoundUniques: {},
        },
        Post: {
          table: 'ext_post',
          accessor: 'extPosts',
          fields: { id: 'id', title: 'title', authorId: 'authorId' },
          relations: {},
          compoundUniques: {},
        },
      },
    };
    compat = createPrismaCompatClient(db as unknown as TurbineClient, map) as Any;
  });

  after(async () => {
    if (!url) return;
    await db.raw(['DROP TABLE IF EXISTS ext_post, ext_user CASCADE'] as unknown as TemplateStringsArray);
    await db.disconnect();
  });

  itDb('runs `model` and `client` extension methods end to end', async () => {
    const ext = compat.$extends({
      model: {
        User: {
          async byDomain(domain: string) {
            return (this as Any).findMany({ where: { email: { endsWith: domain } }, orderBy: { id: 'asc' } });
          },
        },
        $allModels: {
          async total() {
            return (this as Any).count();
          },
        },
      },
      client: {
        async $summary() {
          return { users: await (this as Any).User.total(), posts: await (this as Any).Post.total() };
        },
      },
    });

    assert.deepEqual(await ext.User.byDomain('@acme.com'), [{ id: 1, email: 'a@acme.com' }]);
    assert.deepEqual(await ext.$summary(), { users: 2, posts: 2 });
    // The unextended client is untouched and still queries fine.
    assert.equal((await compat.User.findMany()).length, 2);
  });

  itDb('an extended client keeps $transaction (both forms) and raw SQL', async () => {
    const ext = compat.$extends({
      model: {
        $allModels: {
          async total() {
            return (this as Any).count();
          },
        },
      },
    });

    const created = await ext.$transaction(async (tx: Any) => {
      const user = await tx.User.create({ data: { email: 'c@acme.com' } });
      await tx.Post.create({ data: { title: 'Third', authorId: user.id } });
      // The extension member is live on the tx delegate, on the tx connection.
      assert.equal(await tx.Post.total(), 3);
      const raw = (await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM ext_user')) as Any[];
      assert.equal(raw[0].n, 3);
      return user;
    });
    assert.equal(created.email, 'c@acme.com');

    const [u, p] = (await ext.$transaction([ext.User.findMany({ orderBy: { id: 'asc' } }), ext.Post.count()])) as Any;
    assert.equal(u.length, 3);
    assert.equal(p, 3);

    const rows = (await ext.$queryRaw`SELECT email_address FROM ext_user WHERE id = ${1}`) as Any[];
    assert.equal(rows[0].email_address, 'a@acme.com');

    // Rollback: the extended client's transaction is still a real transaction.
    await assert.rejects(
      ext.$transaction(async (tx: Any) => {
        await tx.User.create({ data: { email: 'd@acme.com' } });
        throw new Error('boom');
      }),
    );
    assert.equal(await ext.User.total(), 3);
  });
});
