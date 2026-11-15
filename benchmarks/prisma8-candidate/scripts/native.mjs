import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { bounded } from '../../../tooling/optional-pg-transports/lifecycle.mjs';
import {
  assertExact,
  assertIncrementEffect,
  canonical,
  countValue,
  dashboardValue,
  expectedHeadline,
  headlineNames,
} from '../dist/canonical/equivalence.js';
import {
  aggregateRows,
  assertExtendedExact,
  expectedExtended,
  flattenTags,
  isWrite,
  prepareWrite,
  readExtendedFixture,
  scratchQuery,
  verifyWrite,
} from '../dist/canonical/extended-equivalence.js';
import { batchSize, candidate, contract, dashboard, extended, headline } from '../dist/src/candidate.js';
import { rawDashboard, rawExtended, rawHeadline } from '../dist/src/raw.js';
import { assertRoute } from './catalog.mjs';
import { execute } from './execution.mjs';

export function observe(pool) {
  const trace = [];
  const restorers = [];
  const connected = (client) => {
    const connection = client.connection;
    for (const method of ['bind', 'execute', 'parse', 'query', 'close']) {
      const original = connection[method];
      restorers.push(() => {
        connection[method] = original;
      });
      connection[method] = function (arg, ...rest) {
        trace.push({ kind: method, ...(typeof arg === 'string' ? { text: arg } : arg) });
        return original.call(this, arg, ...rest);
      };
    }
  };
  pool.on('connect', connected);
  trace.detach = () => {
    pool.off('connect', connected);
    for (const restore of restorers) restore();
  };
  return trace;
}
export async function* rawCursor(pool) {
  const client = await pool.connect();
  const cursor = client.query(new Cursor('SELECT * FROM comments ORDER BY id'));
  let failure;
  try {
    for (;;) {
      const rows = await cursor.read(batchSize);
      if (!rows.length) break;
      yield* rows;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await closeRawCursor(cursor, client, failure);
  }
}
async function closeRawCursor(cursor, client, primary) {
  try {
    await cursor.close();
  } catch (error) {
    client.release(primary ?? error);
    if (!primary) throw error;
    return;
  }
  client.release(primary);
}
export function receipt() {
  const hash = createHash('sha256');
  let count = 0;
  return {
    row(value) {
      const text = JSON.stringify(canonical(value));
      hash.update(`${Buffer.byteLength(text)}:`).update(text);
      count++;
    },
    done() {
      return { count, sha256: hash.digest('hex') };
    },
  };
}
export async function drain(iterable, expected, label, scope) {
  const sink = receipt();
  let first;
  let index = 0;
  for await (const row of iterable) {
    scope?.assertOpen();
    if (index === 0) first = row;
    if (expected) {
      assert.ok(index < expected.length, `${label}: extra row ${index}`);
      assertExact(`${label}: ordered row ${index}`, row, expected[index]);
    }
    sink.row(row);
    index++;
  }
  if (expected) {
    assert.ok(expected.length > 0, `${label}: nonempty oracle required`);
    assertExact(`${label}: first row`, first, expected[0]);
    assert.equal(index, expected.length, `${label}: full drain omitted rows`);
  }
  return sink.done();
}
export async function createArms(url, scope) {
  const raw = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
  const bufferPool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
  const cursorPool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
  const rawCursorPool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
  const bufferTrace = observe(bufferPool),
    cursorTrace = observe(cursorPool),
    rawCursorTrace = observe(rawCursorPool);
  const buffered = candidate(bufferPool),
    cursor = candidate(cursorPool, true);
  for (const pool of [raw, bufferPool, cursorPool, rawCursorPool])
    scope.registerStop(() => bounded(pool.end(), 3000, 'Owned pool drain'));
  // Stop registrations run in reverse, so client runtimes close before caller-owned pools.
  scope.registerStop(() => cursor.close());
  scope.registerStop(() => buffered.close());
  return [
    {
      name: 'Raw pg 8.22.0',
      pool: raw,
      runHeadline: (n, i) => rawHeadline(raw, n, i),
      runExtended: (id, i) => rawExtended(raw, id, i),
      dashboard: (route) => rawDashboard(raw, route),
      stream: () => raw.query('SELECT * FROM comments ORDER BY id').then((r) => r.rows),
      route: 'buffered',
    },
    {
      name: 'Prisma 8 buffered',
      pool: bufferPool,
      db: buffered,
      trace: bufferTrace,
      runHeadline: (n, i) => headline(buffered, n, i),
      runExtended: (id, i) => extended(buffered, id, i),
      dashboard: (route) => dashboard(buffered, route),
      stream: () => buffered.orm.public.Comment.orderBy((c) => c.id.asc()).all(),
      route: 'buffered',
    },
    {
      name: 'Prisma 8 cursor batch1000',
      pool: cursorPool,
      db: cursor,
      trace: cursorTrace,
      stream: () => cursor.orm.public.Comment.orderBy((c) => c.id.asc()).all(),
      route: 'cursor',
    },
    {
      name: 'Raw pg 8.22.0 cursor batch1000',
      pool: rawCursorPool,
      trace: rawCursorTrace,
      stream: () => rawCursor(rawCursorPool),
      route: 'cursor',
    },
  ];
}
export async function assertFixturePreserved(oracle, original, scope, label) {
  const actual = await execute(scope, () => readExtendedFixture(oracle), label);
  assertExtendedExact(label, actual, original);
}
export async function preflight(report, catalog, arms, oracle, scope, fault, original) {
  const full = original ?? (await execute(scope, () => readExtendedFixture(oracle), 'Initial read fixture'));
  const fixture = { users: full.users, posts: full.posts, comments: full.comments };
  const stream = receipt();
  for (const row of fixture.comments) stream.row(row);
  report.fixture = {
    stream: stream.done(),
    counts: Object.fromEntries(Object.entries(full).map(([key, rows]) => [key, rows.length])),
    sha256: createHash('sha256')
      .update(JSON.stringify(canonical(full)))
      .digest('hex'),
  };
  report.cases = [];
  for (const item of catalog) {
    for (const arm of arms) {
      const cell = item.arms[arm.name];
      if (cell?.status !== 'implemented') continue;
      const indices = item.index === 10 ? Array.from({ length: 50 }, (_, i) => i) : [0];
      for (const i of indices) {
        scope.assertOpen();
        const label = `${item.id} / ${arm.name} [${i}]`;
        if (item.index === 6) {
          if (arm.trace) arm.trace.length = 0;
          const rows = awaitStream(arm);
          const result = await execute(scope, () => drain(rows, fixture.comments, label, scope), label);
          if (arm.trace) assertRoute(arm.trace, arm.route === 'cursor');
          report.cases.push({
            id: item.id,
            arm: arm.name,
            i,
            status: 'passed',
            receipt: result,
            route: arm.route,
            routeProof: arm.trace ? summarizeTrace(arm.trace) : null,
          });
          continue;
        }
        if (item.index === 7) {
          const before = (await oracle.query('SELECT * FROM posts ORDER BY id')).rows;
          try {
            const returned = await execute(scope, () => arm.runHeadline(7, i), label);
            assertIncrementEffect(label, before, (await oracle.query('SELECT * FROM posts ORDER BY id')).rows);
            assertExact(`${label} returning`, returned, (await oracle.query('SELECT * FROM posts WHERE id=1')).rows[0]);
          } finally {
            await oracle.query('UPDATE posts SET view_count=$1 WHERE id=$2', [before[0].view_count, 1]);
          }
        } else if (item.group === 'headline') {
          if (arm.trace && item.index === 9) arm.trace.length = 0;
          let value = await execute(scope, () => arm.runHeadline(item.index, i), label);
          if (fault === 'omit' && item.index === 0 && arm.name === 'Prisma 8 buffered') value = value.slice(1);
          if (fault === 'corrupt' && item.index === 0 && arm.name === 'Prisma 8 buffered') value[0].email = 'corrupted';
          if (fault === 'route' && item.index === 0 && arm.name === 'Prisma 8 buffered') assertRoute(arm.trace, true);
          if (item.index === 5) value = countValue(value);
          if (item.index === 9) value = dashboardValue(value);
          assertExact(label, value, expectedHeadline(item.scenario, fixture, i));
          if (arm.trace && item.index === 9) {
            const texts = arm.trace.map((t) => t.text ?? '').join('\n');
            assert.match(texts, /BEGIN/i, `${label}: missing BEGIN`);
            assert.match(texts, /COMMIT/i, `${label}: missing COMMIT`);
          }
        } else if (item.group === 'appendix') {
          assertExact(
            label,
            dashboardValue(await execute(scope, () => arm.dashboard(item.id.slice('dashboard-'.length)), label)),
            expectedHeadline(headlineNames[9], fixture, 0),
          );
        } else if (isWrite(item.id)) {
          await prepareWrite(oracle, item.id);
          const before = (await oracle.query(scratchQuery)).rows;
          const value = await execute(scope, () => arm.runExtended(item.id, i), label);
          if (fault === 'effect' && item.id === 'update' && arm.name === 'Prisma 8 buffered')
            await oracle.query('UPDATE bench_writes SET amount=-777 WHERE id=1');
          await verifyWrite(oracle, item.id, label, before, i, value);
        } else {
          let value = await execute(scope, () => arm.runExtended(item.id, i), label);
          if (item.id === 'group-by') value = aggregateRows(value, false);
          if (item.id === 'many-to-many' && arm.name.startsWith('Prisma 8')) value = flattenTags(value);
          assertExtendedExact(label, value, expectedExtended(item.id, full));
        }
        report.cases.push({ id: item.id, arm: arm.name, i, status: 'passed' });
      }
    }
  }
  await assertFixturePreserved(oracle, full, scope, 'Preflight preserves every read fixture value');
  report.fixtureChecks ??= {};
  report.fixtureChecks.preflight = 'passed';
  assert.ok(report.cases.length > 100, 'Preflight unexpectedly lost coverage');
  await oracle.query('TRUNCATE bench_writes RESTART IDENTITY');
  return fixture;
}
async function* awaitStream(arm) {
  if (arm.route === 'buffered' && arm.name.startsWith('Raw')) yield* await arm.stream();
  else yield* arm.stream();
}
export const streamFor = awaitStream;
export function summarizeTrace(trace) {
  return {
    binds: trace.filter((t) => t.kind === 'bind').length,
    namedPortals: trace.filter((t) => t.kind === 'bind' && t.portal).map((t) => t.portal),
    executeRows: trace.filter((t) => t.kind === 'execute').map((t) => t.rows ?? 0),
    closes: trace.filter((t) => t.kind === 'close').length,
  };
}

export async function cursorControls(url, oracle, fixture, report, scope, fault) {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
  const trace = observe(pool),
    db = candidate(pool, true);
  scope.registerStop(() => pool.end());
  scope.registerStop(() => db.close());
  report.controls = [];
  const reuse = async (label) => {
    assertExact(
      label,
      await bounded(db.orm.public.User.whereUnique({ id: 1n }).first(), 3000, label),
      fixture.users[0],
    );
    assert.equal(pool.waitingCount, 0, `${label}: leaked pool waiter`);
    assert.equal(pool.idleCount, 1, `${label}: cursor did not release the single connection`);
  };
  const rows = db.orm.public.Comment.orderBy((c) => c.id.asc()).all();
  const iterator = rows[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assertExact('Cursor first row before early return', first.value, fixture.comments[0]);
  await iterator.return();
  assertRoute(trace, true);
  await reuse('Connection reusable after explicit early return');
  report.controls.push({
    id: 'cursor-first-row-early-return',
    status: 'passed',
    rowsConsumed: 1,
    routeProof: summarizeTrace(trace),
  });
  for await (const row of db.orm.public.Comment.orderBy((c) => c.id.asc()).all()) {
    assertExact('break first row', row, fixture.comments[0]);
    break;
  }
  await reuse('Connection reusable after break');
  report.controls.push({ id: 'cursor-break', status: 'passed' });

  const reason = new Error('candidate controlled cancellation');
  const controller = new AbortController();
  const plan = db.sql.public.comments.select('id').build();
  let seen = 0;
  await assert.rejects(
    async () => {
      for await (const _row of db.runtime().query(plan, { signal: controller.signal })) {
        seen++;
        if (seen === 1) controller.abort(reason);
      }
    },
    (error) => error.code === 'RUNTIME.ABORTED',
    'In-flight cursor cancellation must reject RUNTIME.ABORTED',
  );
  assert.ok(seen > 0 && seen < fixture.comments.length, 'Cancellation must interrupt the drain');
  await reuse('Connection reusable after cursor cancellation');
  report.controls.push({ id: 'cursor-cancel-after-first-row', status: 'passed', rowsConsumed: seen });
  const pre = new AbortController();
  pre.abort(reason);
  await assert.rejects(
    async () => {
      await db.runtime().query(plan, { signal: pre.signal });
    },
    (error) => error.code === 'RUNTIME.ABORTED' && error.cause === reason,
  );
  await reuse('Connection reusable after pre-abort');
  report.controls.push({ id: 'cursor-pre-abort', status: 'passed' });
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => {
        await tx.orm.public.BenchWrite.create({
          orgId: 1n,
          slug: 'rollback-probe',
          label: 'rollback',
          amount: 44,
          active: true,
          createdAt: new Date('2023-11-14T22:13:20Z'),
        });
        assert.equal(
          (await oracle.query('SELECT count(*)::int AS n FROM bench_writes')).rows[0].n,
          0,
          'Independent connection saw uncommitted write',
        );
        if (fault !== 'rollback') throw new Error('deliberate rollback');
      });
    },
    /deliberate rollback/,
    'Transaction must throw and roll back',
  );
  assert.deepEqual((await oracle.query(scratchQuery)).rows, [], 'Rolled-back write persisted');
  report.controls.push({ id: 'transaction-rollback-independent-connection', status: 'passed' });
  await db.transaction(async (tx) => {
    const made = await tx.orm.public.BenchWrite.create({
      orgId: 1n,
      slug: 'commit-probe',
      label: 'committed',
      amount: 45,
      active: true,
      createdAt: new Date('2023-11-14T22:13:20Z'),
    });
    assert.equal(made.amount, 45);
  });
  assert.equal(
    (await oracle.query('SELECT * FROM bench_writes')).rows[0].amount,
    45,
    'Independent connection missed committed effect',
  );
  await oracle.query('TRUNCATE bench_writes RESTART IDENTITY');
  report.controls.push({ id: 'transaction-commit-independent-connection', status: 'passed' });
  assert.throws(
    () => candidateWithInvalidCursor(pool),
    (error) => error.code === 'RUNTIME.ARGUMENT_INVALID',
  );
  report.controls.push({ id: 'invalid-batch-size', status: 'passed' });
  await db.close();
  assert.equal((await pool.query('SELECT 19 AS n')).rows[0].n, 19, 'Client closed caller-owned pool');
  await assert.rejects(
    async () => {
      await db.orm.public.User.limit(1).all();
    },
    (error) => error.code === 'DRIVER.NOT_CONNECTED',
  );
  report.controls.push({ id: 'caller-pool-ownership-and-closed-client-refusal', status: 'passed' });
}

// Use the same public constructor as the adapter, with the actual invalid option.
import postgres from '@prisma/orm-postgres/runtime';

function candidateWithInvalidCursor(pool) {
  return postgres({ contract, pg: pool, verifyMarker: false, cursor: { batchSize: 0 } });
}
