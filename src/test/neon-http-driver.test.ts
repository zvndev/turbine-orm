import assert from 'node:assert/strict';
import { test } from 'node:test';
import { turbineNeonHttp } from '../neon-http.js';
import { loadNeonDriver } from './fixtures/neon-http/driver.js';
import { neonHttpSchema } from './fixtures/neon-http/schema.js';

const required = process.env.TURBINE_REQUIRE_NEON_HTTP_DRIVER === '1';
// Explicit opt-in avoids treating an uninstalled optional peer as native evidence.
test('actual Neon driver over an intercepted fetch protocol fixture', {
  skip: !required && !process.env.NEON_HTTP_DRIVER_PATH,
}, async (t) => {
  const { neon, neonConfig } = await loadNeonDriver();
  const originalConfig = {
    fetchEndpoint: neonConfig.fetchEndpoint,
    fetchFunction: neonConfig.fetchFunction,
    poolQueryViaFetch: neonConfig.poolQueryViaFetch,
  };
  const requests: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  const replies: { status: number; value: unknown }[] = [];
  let onRequest: ((signal: AbortSignal) => Promise<Response>) | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), init });
    if (onRequest) return onRequest(init.signal!);
    const next = replies.shift();
    assert.ok(next, 'unexpected HTTP request');
    return new Response(JSON.stringify(next.value), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const wire = (names: [string, number][], rows: unknown[][], command = 'SELECT', rowCount = rows.length) => ({
    fields: names.map(([name, dataTypeID]) => ({ name, dataTypeID })),
    rows,
    command,
    rowCount,
    rowAsArray: true,
  });
  const sql = neon('postgresql://fixture_user:fixture_password@database.invalid/fixture_database');
  const db = turbineNeonHttp(sql, neonHttpSchema(), {
    jsonEncoding: 'object',
    globalFilters: { accounts: { tenantId: 4 }, posts: { tenantId: 4 } },
  });

  await t.test('real lazy query, parameter serialization and native scalar decoding', async () => {
    replies.push({
      status: 200,
      value: wire(
        [
          ['big', 20],
          ['decimal', 1700],
          ['json', 3802],
          ['array', 1007],
          ['bytes', 17],
          ['flag', 16],
        ],
        [['9007199254740993', '123.4500', '{"safe":true}', '{3,1}', '\\x00ff', 't']],
      ),
    });
    const value = { nested: "apostrophe's value" };
    const rows = await db.rawUnsafe('SELECT $1::jsonb AS json', [value]);
    assert.deepEqual(rows, [
      {
        big: '9007199254740993',
        decimal: '123.4500',
        json: { safe: true },
        array: [3, 1],
        bytes: Buffer.from([0, 255]),
        flag: true,
      },
    ]);
    assert.deepEqual(requests[0]!.body, { query: 'SELECT $1::jsonb AS json', params: [JSON.stringify(value)] });
    assert.match(requests[0]!.url, /^https:\/\/[^/]+\/sql$/);
    assert.equal(replies.length, 0);
  });

  await t.test('aliases, child order and both tenancy filters reach the native HTTP request', async () => {
    replies.push({
      status: 200,
      value: wire(
        [
          ['id', 23],
          ['tenant_id', 23],
          ['display_name', 25],
          ['posts', 114],
        ],
        [
          [
            '7',
            '4',
            'Ada',
            '[{"id":2,"account_id":7,"tenant_id":4,"title":"B"},{"id":1,"account_id":7,"tenant_id":4,"title":"A"}]',
          ],
        ],
      ),
    });
    const rows = await db
      .table('accounts')
      .findMany({ where: { displayName: 'Ada' }, with: { posts: { orderBy: { id: 'desc' } } }, limit: 2 });
    assert.deepEqual(rows, [
      {
        id: 7,
        tenantId: 4,
        displayName: 'Ada',
        posts: [
          { id: 2, accountId: 7, tenantId: 4, title: 'B' },
          { id: 1, accountId: 7, tenantId: 4, title: 'A' },
        ],
      },
    ]);
    const request = requests.at(-1)!;
    assert.match(String(request.body.query), /ORDER BY .*"id" DESC/);
    assert.ok((request.body.params as string[]).filter((value) => value === '4').length >= 2);
    assert.ok((request.body.params as string[]).includes('Ada'));
    assert.doesNotMatch(String(request.body.query), /Ada/);
  });

  await t.test('default positional relation encoding preserves exact child rows and order', async () => {
    replies.push({
      status: 200,
      value: wire(
        [
          ['id', 23],
          ['tenant_id', 23],
          ['display_name', 25],
          ['posts', 114],
        ],
        [['7', '4', 'Ada', '[[2,7,4,"B"],[1,7,4,"A"]]']],
      ),
    });
    const positional = turbineNeonHttp(sql, neonHttpSchema());
    const rows = await positional
      .table('accounts')
      .findMany({ with: { posts: { orderBy: { id: 'desc' } } }, limit: 1 });
    assert.deepEqual(rows, [
      {
        id: 7,
        tenantId: 4,
        displayName: 'Ada',
        posts: [
          { id: 2, accountId: 7, tenantId: 4, title: 'B' },
          { id: 1, accountId: 7, tenantId: 4, title: 'A' },
        ],
      },
    ]);
    assert.match(String(requests.at(-1)!.body.query), /json_build_array/);
    await positional.disconnect();
  });

  await t.test('native transaction receives lazy handles once with ordered response transforms', async () => {
    const before = requests.length;
    replies.push({ status: 200, value: { results: [wire([], [], 'UPDATE', 2), wire([['id', 23]], [['8'], ['7']])] } });
    const result = await db.batch(
      [
        db.table('accounts').buildUpdateMany({ where: { tenantId: 4 }, data: { displayName: 'new' } }),
        db.table('accounts').buildFindMany({ select: { id: true }, orderBy: { id: 'desc' }, limit: 2 }),
      ],
      { isolationLevel: 'Serializable', readOnly: false },
    );
    assert.deepEqual(result, [{ count: 2 }, [{ id: 8 }, { id: 7 }]]);
    assert.equal(requests.length, before + 1);
    const request = requests.at(-1)!;
    assert.equal((request.body.queries as unknown[]).length, 2);
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers['Neon-Batch-Isolation-Level'], 'Serializable');
    assert.equal(headers['Neon-Batch-Read-Only'], 'false');
  });

  await t.test('native failure propagates code and makes no independent requests or retries', async () => {
    const before = requests.length;
    replies.push({
      status: 400,
      value: { message: 'fixture unique constraint', code: '23505', detail: 'fixture detail' },
    });
    await assert.rejects(
      db.batch([db.table('accounts').buildCreate({ data: { id: 7, tenantId: 4, displayName: 'duplicate' } })]),
      (e: unknown) => (e as { code?: string }).code === '23505',
    );
    assert.equal(requests.length, before + 1);
    assert.equal(replies.length, 0);
  });

  await t.test('cancellation reaches actual driver fetch and preserves exact caller reason', async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    onRequest = (signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const controller = new AbortController();
    const reason = { cancelled: true };
    const pending = db.rawUnsafe('SELECT 1', [], { signal: controller.signal });
    const checked = assert.rejects(pending, (e) => e === reason);
    await ready;
    controller.abort(reason);
    await checked;
    assert.equal(requests.at(-1)!.init.signal!.aborted, true);
    onRequest = undefined;
  });

  await t.test('facade closes while caller neon function remains usable and config unchanged', async () => {
    await db.disconnect();
    replies.push({ status: 200, value: wire([['one', 23]], [['1']]) });
    const ownRows = await sql.query('SELECT 1 AS one');
    assert.deepEqual(ownRows, [{ one: 1 }]);
    assert.deepEqual(
      {
        fetchEndpoint: neonConfig.fetchEndpoint,
        fetchFunction: neonConfig.fetchFunction,
        poolQueryViaFetch: neonConfig.poolQueryViaFetch,
      },
      originalConfig,
    );
    assert.equal(replies.length, 0);
  });
});
