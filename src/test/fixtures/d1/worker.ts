import { type D1DatabaseBinding, type D1PreparedStatement, turbineD1 } from '../../../d1.js';
import { SCHEMA as schema } from './metadata.js';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, message: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}
async function refused(action: () => unknown, pattern: RegExp) {
  try {
    await action();
  } catch (error) {
    check(pattern.test(String(error)), `wrong refusal: ${String(error)}`);
    return;
  }
  throw new Error(`Expected refusal was accepted: ${action.toString()}`);
}

/** Hold native results after dispatch while callers reuse their admitted inputs. */
function holdBatch(binding: D1DatabaseBinding) {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: D1DatabaseBinding = {
    prepare: (sql) => binding.prepare(sql),
    batch<Row>(statements: D1PreparedStatement[]) {
      const result = binding.batch<Row>(statements);
      return ready.then(() => result);
    },
  };
  return { binding: held, release };
}

export default {
  async fetch(_request: unknown, env: { DB: D1DatabaseBinding }): Promise<Response> {
    const trace: string[] = [];
    let prepares = 0;
    let batches = 0;
    const binding: D1DatabaseBinding = {
      prepare(sql) {
        prepares++;
        trace.push(sql);
        return env.DB.prepare(sql);
      },
      batch(statements) {
        batches++;
        return env.DB.batch(statements);
      },
    };
    // Schema provisioning uses the actual binding explicitly; the adapter has no migration lifecycle.
    for (const sql of [
      'CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL, profile TEXT, created_at TEXT NOT NULL, payload BLOB)',
      'CREATE TABLE posts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, visible INTEGER NOT NULL)',
    ])
      await env.DB.prepare(sql).all();
    const db = turbineD1(binding, schema, { warnOnUnlimited: false, relationLoadStrategy: 'join' });
    const users = db.table('users');
    const posts = db.table('posts');
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const first = await users.create({
      data: {
        name: 'Ada',
        active: true,
        profile: { tags: ['x', 'y'] },
        createdAt,
        payload: new Uint8Array([0, 128, 255]),
      },
    });
    same(
      first,
      {
        id: 1,
        name: 'Ada',
        active: true,
        profile: { tags: ['x', 'y'] },
        createdAt,
        payload: new Uint8Array([0, 128, 255]),
      },
      'write RETURNING conversions',
    );
    await users.create({ data: { name: 'Bea', active: false, profile: null, createdAt, payload: null } });
    await posts.createMany({
      data: [
        { userId: 1, title: 'Second', visible: false },
        { userId: 1, title: 'First', visible: true },
        { userId: 2, title: 'Other', visible: true },
      ],
    });
    const expected = [
      { name: 'Ada', posts: [{ title: 'First', visible: true }] },
      { name: 'Bea', posts: [{ title: 'Other', visible: true }] },
    ];
    for (const strategy of ['join', 'batched', 'auto'] as const) {
      const rows = await users.findMany({
        select: { name: true },
        where: { name: { in: ['Ada', 'Bea'] } },
        with: {
          posts: {
            where: { visible: true },
            select: { title: true, visible: true },
            orderBy: { title: 'asc' },
            limit: 1,
          },
        },
        orderBy: { name: 'asc' },
        relationLoadStrategy: strategy,
      });
      same(rows, expected, `nested relation ${strategy}`);
    }
    const author = Object.values(schema.tables.posts!.relations).find(
      (relation) => relation.type === 'belongsTo',
    )!.name;
    for (const strategy of ['join', 'batched'] as const) {
      const nested = await posts.findMany({
        where: { id: 1 },
        select: { title: true },
        with: { [author]: true },
        relationLoadStrategy: strategy,
      });
      same((nested[0] as Record<string, unknown>)[author], first, `nested scalars and BLOB ${strategy}`);
    }
    // Nested parameters precede outer predicates in SQL text, but bind by number.
    const orderedSql = trace.find((sql) => sql.includes('json_group_array') && sql.includes('?'));
    check(orderedSql && /\?2/.test(orderedSql), 'parameterized relation SQL was exercised');
    same(
      await users.update({ where: { id: 2 }, data: { active: true }, select: { name: true, active: true } }),
      { name: 'Bea', active: true },
      'update effect',
    );
    same(await users.count({ where: { active: true } }), 2, 'typed count');
    const batch = await db.$batch([
      posts.buildCreate({ data: { userId: 1, title: 'Batch', visible: true } }),
      posts.buildCount({ where: { userId: 1 } }),
      posts.buildFindMany({ where: { userId: 1 }, select: { title: true }, orderBy: { title: 'asc' } }),
    ]);
    check((batch[0] as { id: number }).id === 4, 'batch insert result');
    same(batch[1], 3, 'batch sees earlier write');
    same(batch[2], [{ title: 'Batch' }, { title: 'First' }, { title: 'Second' }], 'ordered batch rows');
    const rawBatch = await db.$batchRaw([
      { sql: 'UPDATE users SET active = ?1 WHERE id = ?2', params: [false, 2] },
      { sql: 'SELECT active FROM users WHERE id = $1', params: [2] },
    ]);
    same(
      rawBatch.map((result) => result.results),
      [[], [{ active: 0 }]],
      'raw ordered results',
    );
    check(rawBatch[0]?.meta.changes === 1 && typeof rawBatch[0].meta.duration === 'number', 'native metadata');
    await refused(
      () =>
        db.$batch([
          users.buildCreate({ data: { name: 'Rolled back', active: true, createdAt } }),
          users.buildCreate({ data: { name: 'Ada', active: true, createdAt } }),
        ]),
      /TURBINE_E008/,
    );
    same(await users.count({ where: { name: 'Rolled back' } }), 0, 'native batch rollback');
    await refused(() => posts.create({ data: { userId: 999, title: 'Orphan', visible: true } }), /TURBINE_E009/);
    await refused(
      () => db.rawUnsafe('INSERT INTO users (active, created_at) VALUES ($1, $2)', true, createdAt),
      /TURBINE_E010/,
    );
    const filtered = turbineD1(binding, schema, {
      warnOnUnlimited: false,
      globalFilters: { posts: { visible: true } },
    });
    same(await filtered.table('posts').count(), 3, 'global filters');
    await refused(() => db.$batch([filtered.table('posts').buildCount()]), /this facade/);
    let callbackCalls = 0;
    const before = prepares;
    for (const call of [
      () =>
        db.$transaction(async () => {
          callbackCalls++;
        }),
      () =>
        db.transaction(async () => {
          callbackCalls++;
        }),
      () => db.pipeline([posts.buildCount()]),
      () =>
        db.$withSession({}, async () => {
          callbackCalls++;
        }),
      () =>
        db.$listen('channel', () => {
          callbackCalls++;
        }),
      () => db.$notify('channel'),
      () => db.$connection(),
      () => db.rawUnsafe('BEGIN'),
      () => db.rawUnsafe('CREATE TABLE forbidden(id INTEGER)'),
      () =>
        db.$batchRaw([
          { sql: "INSERT INTO posts(user_id,title,visible) VALUES (1,'Must not land',1)" },
          { sql: 'PRAGMA foreign_keys=OFF' },
        ]),
      () => db.rawUnsafe('SELECT 1; DELETE FROM posts'),
      () =>
        users.create({
          data: { name: 'Nested', active: true, createdAt, posts: { create: { title: 'Nested post', visible: true } } },
        }),
      () =>
        posts.createMany({
          data: [{ userId: 1, title: 'Conflict', visible: true }],
          onConflict: { columns: ['id'], update: { title: true } },
        } as never),
      async () => {
        await users.findManyStream().next();
      },
      () => users.findMany({ lock: 'update' } as never),
      () =>
        posts.createMany({
          data: Array.from({ length: 101 }, (_, i) => ({ userId: 1, title: `Too many ${i}`, visible: true })),
        }),
    ])
      await refused(call, /TURBINE_E003|TURBINE_E017/);
    check(prepares === before && callbackCalls === 0, 'unsupported operations must fail before prepare or callback');
    const abort = new AbortController();
    const reason = new Error('pre-dispatch cancellation');
    abort.abort(reason);
    try {
      await db.$batch([posts.buildDeleteMany({ where: { userId: 1 } })], { signal: abort.signal });
      throw new Error('aborted batch accepted');
    } catch (error) {
      check(error === reason, 'exact cancellation reason');
    }
    check(prepares === before, 'aborted batch dispatched');
    // A later invalid value must prevent an earlier valid write from being prepared.
    await refused(
      () => db.$batchRaw([{ sql: 'DELETE FROM posts' }, { sql: 'SELECT ?1', params: [9007199254740993n] }]),
      /safe-integer/,
    );
    check(prepares === before, 'batch preflight side effects');
    same(await posts.count({ where: { title: 'Must not land' } }), 0, 'refused batch did not write');
    await posts.deleteMany({ where: { userId: 2 } });
    same(
      await users.delete({ where: { id: 2 }, select: { name: true } }).catch((error) => {
        throw error;
      }),
      { name: 'Bea' },
      'delete with RETURNING',
    );
    // Admission snapshots survive mutation while the actual native batch is in flight.
    {
      const held = holdBatch(binding);
      const client = turbineD1(held.binding, schema, { warnOnUnlimited: false });
      try {
        const items = [{ sql: "INSERT INTO posts(user_id,title,visible) VALUES (1,'snapshot-raw',1)" }];
        const pending = client.$batchRaw(items);
        items.length = 0;
        held.release();
        const result = await pending;
        check(result.length === 1 && result[0]?.meta.changes === 1, 'raw admission cardinality');
      } finally {
        held.release();
        await client.disconnect();
      }
    }
    {
      const held = holdBatch(binding);
      const client = turbineD1(held.binding, schema, { warnOnUnlimited: false });
      try {
        const table = client.table('posts');
        const items = [table.buildCount(), table.buildFindMany({ where: { id: 1 }, select: { title: true } })];
        const pending = client.$batch(items);
        items.reverse();
        held.release();
        same(await pending, [4, [{ title: 'Second' }]], 'typed admission order and transforms');
      } finally {
        held.release();
        await client.disconnect();
      }
    }
    {
      const held = holdBatch(binding);
      const client = turbineD1(held.binding, schema, { warnOnUnlimited: false });
      try {
        const query = client.table('posts').buildCount();
        const pending = client.$batch([query]);
        query.transform = () => -999;
        held.release();
        same(await pending, [4], 'admitted transform function');
      } finally {
        held.release();
        await client.disconnect();
      }
    }
    {
      const held = holdBatch(binding);
      const client = turbineD1(held.binding, schema, { warnOnUnlimited: false });
      try {
        const lazy = client.sql`INSERT INTO posts(user_id,title,visible) VALUES (${1},${'lazy-after-seal'},${true})`;
        const pending = client.$batchRaw([{ sql: 'SELECT 1' }]);
        const closing = client.disconnect();
        const before = prepares;
        await refused(() => Promise.resolve(lazy), /disconnected/);
        check(prepares === before, 'lazy SQL prepared after seal while native batch drains');
        held.release();
        await Promise.all([pending, closing]);
        const rows = await env.DB.prepare("SELECT count(*) AS n FROM posts WHERE title='lazy-after-seal'").all();
        same(rows.results, [{ n: 0 }], 'no lazy write after seal; caller binding remains usable');
      } finally {
        held.release();
        await client.disconnect();
      }
    }
    const hoisted = users;
    // A later JSON conversion or binding wrapper may reenter before dispatch.
    // Previously admitted ArrayBuffer bytes must no longer alias caller storage.
    await env.DB.prepare('CREATE TABLE binary_snapshots(id TEXT PRIMARY KEY, payload BLOB)').all();
    {
      const bytes = new Uint8Array([11, 22, 33]);
      await db.$batchRaw([
        { sql: 'INSERT INTO binary_snapshots VALUES (?1, ?2)', params: ['json', bytes.buffer] },
        {
          sql: 'SELECT ?1',
          params: [
            {
              toJSON: () => {
                bytes.fill(88);
                return { ok: true };
              },
            },
          ],
        },
      ]);
      const actual = await env.DB.prepare("SELECT hex(payload) AS bytes FROM binary_snapshots WHERE id='json'").all();
      same(actual.results, [{ bytes: '0B1621' }], 'ArrayBuffer snapshot before later JSON admission');
    }
    {
      const bytes = new Uint8Array([11, 22, 33]);
      const reentrant: D1DatabaseBinding = {
        prepare(sql) {
          bytes.fill(99);
          return binding.prepare(sql);
        },
        batch: (statements) => binding.batch(statements),
      };
      const client = turbineD1(reentrant, schema, { warnOnUnlimited: false });
      try {
        await client.$batchRaw([
          { sql: 'INSERT INTO binary_snapshots VALUES (?1, ?2)', params: ['prepare', bytes.buffer] },
        ]);
        const actual = await env.DB.prepare(
          "SELECT hex(payload) AS bytes FROM binary_snapshots WHERE id='prepare'",
        ).all();
        same(actual.results, [{ bytes: '0B1621' }], 'ArrayBuffer snapshot before native preparation');
      } finally {
        await client.disconnect();
      }
    }
    const lazy = db.sql`SELECT ${3} AS value`;
    await db.disconnect();
    await refused(() => hoisted.count(), /disconnected/);
    await refused(() => Promise.resolve(lazy), /disconnected/);
    const checkBinding = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').all<{ count: number }>();
    same(checkBinding.results, [{ count: 1 }], 'binding remains caller owned');
    check(batches >= 3 && prepares > 10, 'real native execution must be nonempty');
    return new Response(JSON.stringify({ ok: true, prepares, batches, groups: 24 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
