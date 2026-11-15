import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../../../../tooling/optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.RELAY_ROOT ?? mkdtempSync(join(tmpdir(), 'turbine-relay-')));
process.once('exit', () => {
  if (!process.env.RELAY_ROOT) rmSync(root, { recursive: true, force: true });
});
for (const name of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(process.env[name], `${root}/tmp`);
assert.equal(process.env.CLOUDFLARE_CF_FETCH_ENABLED, 'false');
const attempt = process.env.RELAY_ATTEMPT;
assert.match(attempt ?? '', /^[a-z0-9-]+$/);
const nodes = { 22: process.env.RELAY_NODE22, 24: process.env.RELAY_NODE24 };
const pgPrefix = process.env.PG_PREFIX;
const mysqlPrefix = process.env.MYSQL_BASEDIR;
const mysqlLib = process.env.MYSQL_LIBRARY_PATH ?? '';
for (const [name, value] of Object.entries({
  RELAY_NODE22: nodes[22],
  RELAY_NODE24: nodes[24],
  PG_PREFIX: pgPrefix,
  MYSQL_BASEDIR: mysqlPrefix,
}))
  assert.ok(value, `${name} must name the required local runtime installation.`);
const report = {
  commands: [],
  services: [],
  cells: [],
  generated: [],
  netns: readlinkSync('/proc/self/ns/net'),
  uid: process.getuid(),
  source: repo,
};
const supplemental = process.env.RELAY_SUPPLEMENTAL === '1';
assert.ok(report.uid > 0, 'Run the disposable services as an unprivileged user.');
assert.notEqual(report.netns, process.env.RELAY_HOST_NETNS);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function refuseAndBind(port) {
  await new Promise((yes, no) => {
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(1000, () => {
      s.destroy();
      no(new Error('port refusal deadline'));
    });
    s.once('connect', () => {
      s.destroy();
      no(new Error(`Occupied namespace port ${port}`));
    });
    s.once('error', (e) => (e.code === 'ECONNREFUSED' ? yes() : no(e)));
  });
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((yes, no) => server.close((e) => (e ? no(e) : yes())));
  return { port, netns: readlinkSync('/proc/self/ns/net'), refused: true, rebound: true };
}

await runWithShutdown(report, `${root}/${attempt}.json`, async (scope) => {
  const run = async (label, cwd, binary, args, env = process.env, expected = 0) => {
    const rec = {
      label,
      cwd,
      binary,
      args,
      expected,
      runtimeSha256: sha(binary),
      environment: Object.fromEntries(
        [
          'TMPDIR',
          'TMP',
          'TEMP',
          'CLOUDFLARE_CF_FETCH_ENABLED',
          'DATABASE_URL',
          'MYSQL_DATABASE',
          'MYSQL_PORT',
          'PG_SCHEMA',
          'SOURCE_HISTORY_ID',
        ]
          .filter((n) => n in env)
          .map((n) => [n, env[n]]),
      ),
    };
    report.commands.push(rec);
    const h = scope.spawn(binary, args, { cwd, env, deadlineMs: 180000 }, rec);
    let stdout = '',
      stderr = '';
    h.child.stdout.on('data', (b) => {
      stdout += b;
    });
    h.child.stderr.on('data', (b) => {
      stderr += b;
    });
    try {
      await h.closed;
      await h.stop();
    } finally {
      rec.stdout = stdout;
      rec.stderr = stderr;
      writeFileSync(`${root}/logs/${attempt}-${label}.stdout`, stdout);
      writeFileSync(`${root}/logs/${attempt}-${label}.stderr`, stderr);
    }
    assert.equal(h.spawnError, undefined);
    if (typeof expected === 'string') assert.equal(rec.signal, expected, stdout + stderr);
    else assert.equal(rec.code, expected, stdout + stderr);
    return rec;
  };

  for (const n of [22, 24]) {
    const cwd = `${root}/n${n}`,
      req = createRequire(`${cwd}/package.json`);
    assert.equal(req('pg/package.json').version, '8.23.1');
    assert.equal(req('mysql2/package.json').version, '3.24.6');
    report[`consumer${n}`] = { lockSha256: sha(`${cwd}/package-lock.json`), pg: '8.23.1', mysql2: '3.24.6' };
    await run(`version-${n}`, cwd, nodes[n], [
      '-e',
      `if(process.versions.node!=='${n === 22 ? '22.16.0' : '24.10.0'}')throw Error(process.version)`,
    ]);
    for (const format of ['esm', 'cjs']) {
      const src = `${cwd}/${format}-src`;
      mkdirSync(src, { recursive: true });
      writeFileSync(`${src}/package.json`, JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      for (const example of ['postgres-mysql-relay', 'postgres-durable-replay', 'mysql-durable-replay'])
        cpSync(`${repo}/examples/${example}`, `${src}/examples/${example}`, { recursive: true });
      const config = {
        compilerOptions: {
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          esModuleInterop: true,
          types: ['node'],
          declaration: true,
          rootDir: '.',
          outDir: `../${format}`,
        },
        include: ['examples/postgres-mysql-relay/*.ts'],
      };
      writeFileSync(`${src}/tsconfig.json`, JSON.stringify(config));
      await run(`strict-${n}-${format}`, src, nodes[n], [
        `${cwd}/node_modules/typescript/bin/tsc`,
        '-p',
        'tsconfig.json',
      ]);
      cpSync(`${src}/package.json`, `${cwd}/${format}/package.json`);
      const types = readFileSync(`${src}/examples/postgres-mysql-relay/consumer-types.ts`, 'utf8');
      writeFileSync(
        `${src}/examples/postgres-mysql-relay/negative.ts`,
        types.replaceAll(/\s*\/\/ @ts-expect-error[^\n]*/g, ''),
      );
      writeFileSync(
        `${src}/negative.json`,
        JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: { noEmit: true },
          include: ['examples/postgres-mysql-relay/negative.ts'],
        }),
      );
      const negative = await run(
        `negative-${n}-${format}`,
        src,
        nodes[n],
        [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'negative.json'],
        process.env,
        2,
      );
      assert.equal((negative.stdout.match(/error TS/g) ?? []).length, 4, negative.stdout);
      rmSync(`${src}/examples/postgres-mysql-relay/negative.ts`);
    }
    cpSync(`${fixture}/controls.mjs`, `${cwd}/controls.mjs`);
    cpSync(`${fixture}/generated.mjs`, `${cwd}/generated.mjs`);
    cpSync(`${fixture}/omissions.mjs`, `${cwd}/omissions.mjs`);
    cpSync(`${fixture}/supplemental.mjs`, `${cwd}/supplemental.mjs`);
    cpSync(`${fixture}/boundaries.mjs`, `${cwd}/boundaries.mjs`);
  }

  const req = createRequire(`${root}/n24/package.json`),
    pg = req('pg'),
    mysql = req('mysql2/promise');
  async function service(engine, port, mode = '') {
    const owned = `${root}/services/${attempt}-${engine}${mode ? `-${port}` : ''}`;
    assert.ok(!existsSync(owned));
    mkdirSync(owned, { recursive: true });
    const rec = {
      engine,
      root: owned,
      data: `${owned}/data`,
      socket: engine === 'pg' ? `${owned}/socket` : `${owned}/mysql.sock`,
      port,
      mode,
      binary: engine === 'pg' ? `${pgPrefix}/bin/postgres` : `${mysqlPrefix}/bin/mysqld`,
    };
    report.services.push(rec);
    console.log(JSON.stringify({ announcedOwnedService: rec, namespace: report.netns }));
    rec.preflight = await refuseAndBind(port);
    let h, client, stopped;
    const stop = () =>
      (stopped ??= (async () => {
        await client?.end();
        if (h) {
          await h.stop();
          h.capture();
        }
        rec.finalPort = await refuseAndBind(port);
        rec.connectionsClosed = true;
        rmSync(owned, { recursive: true, force: true });
        rec.rootRemoved = !existsSync(owned);
        rec.stopped = true;
      })());
    scope.registerStop(stop);
    const env = { ...process.env, LD_LIBRARY_PATH: engine === 'pg' ? `${pgPrefix}/lib` : mysqlLib };
    let args;
    if (engine === 'pg') {
      mkdirSync(rec.socket);
      await run(
        'pg-initdb',
        owned,
        `${pgPrefix}/bin/initdb`,
        [
          '-D',
          rec.data,
          '-U',
          'contract',
          '-A',
          'trust',
          '--no-locale',
          '--encoding=UTF8',
          '--no-instructions',
          '-L',
          `${pgPrefix}/share/postgresql`,
        ],
        env,
      );
      args = [
        '-D',
        rec.data,
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-k',
        rec.socket,
        '-c',
        'timezone=UTC',
        '-c',
        'shared_buffers=32MB',
        '-c',
        'max_connections=64',
        '-c',
        `dynamic_library_path=${pgPrefix}/lib/postgresql`,
        '-c',
        'fsync=on',
        '-c',
        'synchronous_commit=on',
        '-c',
        'full_page_writes=on',
        '-c',
        'log_statement=all',
      ];
    } else {
      await run(
        `mysql-init-${port}`,
        owned,
        `${mysqlPrefix}/bin/mysqld`,
        ['--no-defaults', '--initialize-insecure', `--basedir=${mysqlPrefix}`, `--datadir=${rec.data}`],
        env,
      );
      args = [
        '--no-defaults',
        `--basedir=${mysqlPrefix}`,
        `--datadir=${rec.data}`,
        `--socket=${rec.socket}`,
        `--port=${port}`,
        '--bind-address=127.0.0.1',
        '--mysqlx=0',
        `--pid-file=${owned}/mysql.pid`,
        `--sql-mode=${mode}`,
        '--innodb-buffer-pool-size=64M',
        '--innodb-lock-wait-timeout=1',
        '--lock-wait-timeout=2',
        '--max-execution-time=2000',
        '--innodb-flush-log-at-trx-commit=1',
        '--sync-binlog=1',
        `--log-bin=${owned}/binlog`,
        '--character-set-server=utf8mb4',
        '--collation-server=utf8mb4_0900_ai_ci',
        '--transaction-isolation=REPEATABLE-READ',
      ];
    }
    rec.args = args;
    rec.binarySha256 = sha(rec.binary);
    h = scope.spawn(rec.binary, args, { cwd: owned, env, deadlineMs: 1800000 }, rec);
    h.service = true;
    let log = '';
    h.child.stdout.on('data', (b) => {
      log += b;
      writeFileSync(`${root}/logs/${attempt}-${engine}-${port}.log`, log);
    });
    h.child.stderr.on('data', (b) => {
      log += b;
      writeFileSync(`${root}/logs/${attempt}-${engine}-${port}.log`, log);
    });
    for (let n = 0; n < 100; n++) {
      if (engine === 'pg') {
        const c = new pg.Client({
          host: '127.0.0.1',
          port,
          user: 'contract',
          database: 'postgres',
          connectionTimeoutMillis: 500,
          query_timeout: 2500,
        });
        try {
          await c.connect();
          client = c;
          break;
        } catch {
          await c.end();
        }
      } else {
        try {
          client = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', connectTimeout: 500 });
          break;
        } catch {}
      }
      await delay(100);
    }
    assert.ok(client, `required ${engine} startup`);
    const pid =
      engine === 'pg'
        ? Number(readFileSync(`${rec.data}/postmaster.pid`, 'utf8').split('\n')[0])
        : Number(readFileSync(`${owned}/mysql.pid`, 'utf8').trim());
    rec.generation = processIdentity(pid);
    rec.serviceNetns = readlinkSync(`/proc/${pid}/ns/net`);
    assert.equal(rec.serviceNetns, report.netns);
    if (engine === 'pg') {
      rec.facts = (
        await client.query(
          "SELECT version(),current_setting('server_version') AS version,current_setting('data_directory') AS datadir,current_setting('server_encoding') AS encoding,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('full_page_writes') AS full_page_writes",
        )
      ).rows[0];
      assert.equal(rec.facts.version, '18.6');
      assert.equal(rec.facts.datadir, rec.data);
      assert.equal(rec.facts.encoding, 'UTF8');
      for (const key of ['fsync', 'synchronous_commit', 'full_page_writes']) assert.equal(rec.facts[key], 'on');
    } else {
      rec.facts = (
        await client.query(
          'SELECT VERSION() AS version,@@datadir AS datadir,@@GLOBAL.sql_mode AS mode,@@session.sql_mode AS sessionMode,@@character_set_server AS charset,@@transaction_isolation AS isolationLevel,@@innodb_flush_log_at_trx_commit AS flushLog,@@sync_binlog AS syncBinlog,@@log_bin AS logBin',
        )
      )[0][0];
      assert.match(rec.facts.version, /^8\.4\.0/);
      assert.equal(rec.facts.datadir.replace(/\/$/, ''), rec.data);
      assert.equal(rec.facts.charset, 'utf8mb4');
      assert.deepEqual(rec.facts.mode.split(',').sort(), mode.split(',').sort());
    }
    writeFileSync(`${root}/${attempt}-live.json`, JSON.stringify(report.services, null, 2));
    return { client, stop };
  }

  const pgPort = Number(process.env.RELAY_PG_PORT ?? 60111);
  const pgService = await service('pg', pgPort);
  for (const [index, sqlMode] of [
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_BACKSLASH_ESCAPES',
  ].entries()) {
    const port = Number(process.env.RELAY_MYSQL_PORT ?? 60112) + index,
      destination = await service('mysql', port, sqlMode);
    for (const n of [22, 24])
      for (const format of ['esm', 'cjs']) {
        const label = `${index}-${n}-${format}`,
          database = `relay_${attempt}_${label}`.replaceAll('-', '_'),
          schema = database,
          history = randomUUID();
        await destination.client.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
        const env = {
          ...process.env,
          RELAY_REPO: repo,
          DATABASE_URL: `postgresql://contract@127.0.0.1:${pgPort}/postgres`,
          PG_SCHEMA: schema,
          MYSQL_PORT: String(port),
          MYSQL_DATABASE: database,
          SOURCE_HISTORY_ID: history,
        };
        const cwd = `${root}/n${n}`;
        await run(
          `suite-${label}`,
          cwd,
          nodes[n],
          [
            supplemental ? 'supplemental.mjs' : 'controls.mjs',
            format,
            ...(supplemental ? [] : ['suite']),
            `${root}/${attempt}-${label}.cell.json`,
          ],
          env,
        );
        const cell = JSON.parse(readFileSync(`${root}/${attempt}-${label}.cell.json`));
        assert.equal(cell.success, true);
        report.cells.push(cell);
        if (!supplemental) {
          await run(`crash-${label}`, cwd, nodes[n], ['controls.mjs', format, 'crash'], env, 'SIGKILL');
          await run(
            `reopen-${label}`,
            cwd,
            nodes[n],
            ['controls.mjs', format, 'reopen', `${root}/${attempt}-${label}.reopen.json`],
            env,
          );
          await run(
            `generated-${label}`,
            cwd,
            nodes[n],
            ['generated.mjs', format, `${root}/${attempt}-${label}.generated.json`],
            env,
          );
          report.generated.push(JSON.parse(readFileSync(`${root}/${attempt}-${label}.generated.json`)));
          const extraDb = `${database}_settlement`;
          await destination.client.query(`CREATE DATABASE ${extraDb} CHARACTER SET utf8mb4`);
          await run(
            `settlement-${label}`,
            cwd,
            nodes[n],
            ['supplemental.mjs', format, `${root}/${attempt}-${label}.settlement.json`],
            { ...env, MYSQL_DATABASE: extraDb, PG_SCHEMA: extraDb, SOURCE_HISTORY_ID: randomUUID() },
          );
          report.settlement ??= [];
          report.settlement.push(JSON.parse(readFileSync(`${root}/${attempt}-${label}.settlement.json`)));
          await destination.client.query(`DROP DATABASE ${extraDb}`);
          await pgService.client.query(`DROP SCHEMA "${extraDb}" CASCADE`);
          const boundaryDb = `${database}_boundaries`;
          await destination.client.query(`CREATE DATABASE ${boundaryDb} CHARACTER SET utf8mb4`);
          await run(
            `boundaries-${label}`,
            cwd,
            nodes[n],
            ['boundaries.mjs', format, `${root}/${attempt}-${label}.boundaries.json`],
            { ...env, MYSQL_DATABASE: boundaryDb, PG_SCHEMA: boundaryDb, SOURCE_HISTORY_ID: randomUUID() },
          );
          report.boundaries ??= [];
          report.boundaries.push(JSON.parse(readFileSync(`${root}/${attempt}-${label}.boundaries.json`)));
          await destination.client.query(`DROP DATABASE ${boundaryDb}`);
          await pgService.client.query(`DROP SCHEMA "${boundaryDb}" CASCADE`);
        }
        if (n === 24 && format === 'esm') {
          for (const kind of ['dedup', 'early-ack', 'effect']) {
            const mutantRoot = `${cwd}/omit-${kind}`;
            cpSync(`${cwd}/esm`, mutantRoot, { recursive: true });
            const file = `${mutantRoot}/examples/${kind === 'early-ack' ? 'postgres-mysql-relay' : 'mysql-durable-replay'}/application.js`;
            const original = readFileSync(file, 'utf8');
            let mutant;
            if (kind === 'early-ack') mutant = original.replace('await delivery;', 'void delivery.catch(() => {});');
            else if (kind === 'effect')
              mutant = original.replace('SET delivered=delivered+1', 'SET delivered=delivered+0');
            else {
              const split = original.indexOf('deliverToInbox(consumer');
              assert.ok(split > 0);
              mutant =
                original.slice(0, split) + original.slice(split).replace('if (prior) {', 'if (false && prior) {');
            }
            assert.notEqual(mutant, original);
            writeFileSync(file, mutant);
            const mutantDb = `${database}_${kind.replaceAll('-', '_')}`;
            await destination.client.query(`CREATE DATABASE ${mutantDb} CHARACTER SET utf8mb4`);
            await run(
              `omission-${label}-${kind}`,
              cwd,
              nodes[n],
              ['omissions.mjs', kind, `${root}/${attempt}-${label}-${kind}.omission.json`],
              { ...env, MYSQL_DATABASE: mutantDb, PG_SCHEMA: mutantDb, SOURCE_HISTORY_ID: randomUUID() },
              1,
            );
            const result = JSON.parse(readFileSync(`${root}/${attempt}-${label}-${kind}.omission.json`));
            assert.equal(result.detected, true);
            assert.match(
              [result.error, ...(result.causes ?? [])].join(' / '),
              kind === 'dedup'
                ? /Unique constraint violation on PRIMARY/
                : kind === 'early-ack'
                  ? /target rollback must not advance/
                  : /projection effect/,
            );
            report.omissions ??= [];
            report.omissions.push({ ...result, mutantFile: file, mutantSha256: sha(file) });
            await destination.client.query(`DROP DATABASE ${mutantDb}`);
            await pgService.client.query(`DROP SCHEMA "${mutantDb}" CASCADE`);
          }
        }
        if (!supplemental) {
          const demoDb = `${database}_demo`,
            demoSchema = demoDb;
          await destination.client.query(`CREATE DATABASE ${demoDb} CHARACTER SET utf8mb4`);
          await run(`demo-${label}`, cwd, nodes[n], [`${format}/examples/postgres-mysql-relay/demo.js`], {
            ...env,
            MYSQL_DATABASE: demoDb,
            PG_SCHEMA: demoSchema,
            SOURCE_HISTORY_ID: randomUUID(),
          });
          await destination.client.query(`DROP DATABASE ${demoDb}`);
          await pgService.client.query(`DROP SCHEMA "${demoSchema}" CASCADE`);
        }
        await destination.client.query(`DROP DATABASE ${database}`);
        await pgService.client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    await destination.stop();
  }
  await pgService.stop();
});
console.log(
  JSON.stringify({
    success: report.success,
    cells: report.cells.length,
    generated: report.generated.length,
    services: report.services.map((s) => ({
      engine: s.engine,
      port: s.port,
      stopped: s.stopped,
      finalPort: s.finalPort,
    })),
  }),
);
