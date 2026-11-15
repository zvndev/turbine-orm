import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runWithShutdown } from '../../../tooling/optional-pg-transports/run.mjs';
import { ownedPostgres } from '../fixture/postgres-service.mjs';
import { execute } from '../scripts/execution.mjs';
import { timing } from '../scripts/timing.mjs';

const base = tmpdir();
test('SIGTERM initiates owned cleanup without settling the arm callback', async () => {
  const root = mkdtempSync(join(base, 'p8-signal-'));
  const previous = process.exitCode;
  const report = {};
  let cleanup = false;
  try {
    await assert.rejects(
      () =>
        runWithShutdown(report, join(root, 'report.json'), async (scope) => {
          scope.registerStop(() => {
            cleanup = true;
          });
          await execute(
            scope,
            () => {
              process.emit('SIGTERM');
              return new Promise(() => {});
            },
            'held callback',
          );
        }),
      /Interrupted by SIGTERM/,
    );
    assert.equal(cleanup, true);
    assert.equal(report.success, false);
  } finally {
    process.exitCode = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
test('callback deadline rejects and cleanup owns a late rejection', async () => {
  const root = mkdtempSync(join(base, 'p8-deadline-'));
  let rejectLate,
    cleaned = false;
  try {
    await assert.rejects(
      () =>
        runWithShutdown({}, join(root, 'report.json'), async (scope) => {
          scope.registerStop(() => {
            cleaned = true;
          });
          await execute(
            scope,
            () =>
              new Promise((_, reject) => {
                rejectLate = reject;
              }),
            'held arm',
            5,
          );
        }),
      /held arm/,
    );
    assert.equal(cleaned, true);
    rejectLate(new Error('late callback rejection'));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('partial initdb startup is registered and cleaned before any service launches', async () => {
  const root = mkdtempSync(join(base, 'p8-initdb-'));
  const stops = [],
    report = { services: [] };
  try {
    await assert.rejects(
      () =>
        ownedPostgres({
          root,
          env: { PRISMA8_OWNED_PORT: '32001', PG_PREFIX: '/synthetic' },
          report,
          registerStop(stop) {
            stops.push(stop);
          },
          async run() {
            assert.equal(stops.length, 1);
            mkdirSync(join(root, 'data'));
            throw new Error('partial initdb');
          },
        }),
      /partial initdb/,
    );
    await stops[0]();
    assert.equal(existsSync(join(root, 'data')), false);
    assert.equal(existsSync(join(root, 'socket')), false);
    assert.equal(report.services.length, 1);
    assert.equal(report.services[0].startup, 'failed');
    assert.equal(report.services[0].stopped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('deferred getter materialization is included inside the measured boundary', async () => {
  let calls = 0;
  const expected = { id: 1n, email: 'eager@test' },
    lazy = { id: 1n };
  Object.defineProperty(lazy, 'email', {
    enumerable: true,
    get() {
      calls++;
      const until = performance.now() + 12;
      while (performance.now() < until) {}
      return expected.email;
    },
  });
  const report = {},
    row = {
      id: 'headline-3',
      index: 3,
      group: 'headline',
      scenario: 'findUnique, single user by PK',
      arms: { Turbine: { status: 'implemented' } },
    };
  const fixture = { users: [expected], posts: [], comments: [] };
  await timing(
    report,
    [row],
    [{ name: 'Turbine', runHeadline: async () => lazy }],
    {},
    { assertOpen() {} },
    2,
    1,
    fixture,
    fixture,
  );
  assert.equal(calls, 3);
  assert.ok(report.results[0].arms.Turbine.samples.every((n) => n >= 10));
});
