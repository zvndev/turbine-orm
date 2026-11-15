import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { command } from '../../../tooling/optional-pg-transports/harness.mjs';
import { bounded } from '../../../tooling/optional-pg-transports/lifecycle.mjs';
import { ownedPostgres } from '../fixture/postgres-service.mjs';
import { sha256 } from './verify-pins.mjs';

export async function servicePlan(out, prefix) {
  assert.ok(prefix && existsSync(join(prefix, 'bin/postgres')), 'PG_PREFIX with PostgreSQL 18.6 required');
  out = resolve(out);
  assert.ok(
    Buffer.byteLength(join(out, 'service/socket/.s.PGSQL.65535')) < 108,
    'Evidence path too long for PostgreSQL Unix socket; choose a short private --out path',
  );
  assert.ok(!existsSync(out), 'Evidence directory must be new; retain earlier attempts');
  mkdirSync(out, { recursive: true });
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const plan = {
    format: 1,
    out,
    root: join(out, 'service'),
    port,
    prefix: resolve(prefix),
    created: new Date().toISOString(),
    postgresSha256: sha256(readFileSync(join(prefix, 'bin/postgres'))),
    initdbSha256: sha256(readFileSync(join(prefix, 'bin/initdb'))),
    catalogSha256: sha256(readFileSync(join(prefix, 'share/postgresql/postgres.bki'))),
  };
  mkdirSync(plan.root);
  writeFileSync(join(out, 'service-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  return plan;
}
export async function startService(plan, report, scope) {
  assert.ok(!existsSync(join(plan.root, 'data')), 'Refuse an existing datadir');
  for (const [name, path] of [
    ['postgres', 'bin/postgres'],
    ['initdb', 'bin/initdb'],
    ['catalog', 'share/postgresql/postgres.bki'],
  ]) {
    assert.equal(
      sha256(readFileSync(join(plan.prefix, path))),
      plan[`${name}Sha256`],
      `Service binary/catalog changed: ${name}`,
    );
  }
  const env = {
    ...process.env,
    PG_PREFIX: plan.prefix,
    PRISMA8_OWNED_PORT: String(plan.port),
    TZ: 'UTC',
    DATABASE_URL: '',
    NODE_PATH: '',
    NODE_OPTIONS: '',
  };
  let handle;
  const processLifecycle = {
    assertOpen: scope.assertOpen,
    async closeClient(client) {
      if (client)
        try {
          await bounded(client.end(), 1500, 'PG client close');
        } finally {
          client.connection?.stream?.destroy();
        }
    },
    wait: (promise, label) => bounded(promise, 1500, label),
    spawn(binary, args, options) {
      handle = scope.spawn(binary, args, options, { binary, args, cwd: plan.root });
      handle.service = true;
      return handle.child;
    },
    stop: () => handle?.stop(true),
  };
  const pg = (await import('pg')).default;
  return ownedPostgres({
    root: plan.root,
    env,
    driver: pg,
    report,
    processLifecycle,
    run: (cwd, binary, args) => command(report, cwd, binary, args, env, { scope, timeoutMs: 60000 }),
    registerStop(stop) {
      const identity = report.services.at(-1);
      scope.registerStop(async () => {
        await stop();
        handle?.capture();
        Object.assign(
          identity,
          handle
            ? {
                supervisor: handle.record.supervisor,
                pid: handle.record.pid,
                ownershipProof: handle.record.ownershipProof,
                ownedProcesses: handle.record.ownedProcesses,
                remainingPids: handle.record.remainingPids,
                remainingGroups: handle.record.remainingGroups,
              }
            : { serviceNeverLaunched: true, remainingPids: [], remainingGroups: [] },
        );
        assert.deepEqual(identity.remainingPids, [], 'Owned processes remain');
        assert.deepEqual(identity.remainingGroups, [], 'Owned groups remain');
        const probe = createServer();
        await new Promise((resolve, reject) => {
          probe.once('error', reject);
          probe.listen(plan.port, '127.0.0.1', resolve);
        });
        await new Promise((resolve) => probe.close(resolve));
        identity.portReleased = true;
        rmSync(join(plan.root, 'data'), { recursive: true, force: true });
        rmSync(join(plan.root, 'socket'), { recursive: true, force: true });
        identity.datadirRemoved = !existsSync(join(plan.root, 'data'));
        identity.socketRemoved = !existsSync(join(plan.root, 'socket'));
        identity.auditComplete = true;
      });
    },
  });
}
