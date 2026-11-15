import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../../../../tooling/optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const root = resolve(process.env.MYSQL_REPLAY_ROOT ?? mkdtempSync(join(tmpdir(), 'turbine-mysql-replay-')));
process.once('exit', () => {
  if (!process.env.MYSQL_REPLAY_ROOT) rmSync(root, { recursive: true, force: true });
});
const report = { commands: [], services: [], cells: [], source: repo };
const nodes = { 22: process.env.MYSQL_REPLAY_NODE22, 24: process.env.MYSQL_REPLAY_NODE24 };
const fixture = join(repo, 'src/test/fixtures/mysql-durable-replay');
const attempt = process.env.MYSQL_REPLAY_ATTEMPT ?? 'native1';
const env = { ...process.env, TMPDIR: `${root}/tmp` };
await runWithShutdown(report, join(root, `${attempt}.json`), async (scope) => {
  const command = async (label, cwd, exe, args, childEnv = env, expected = 0) => {
    const rec = { label, cwd, binary: exe, args, expected };
    report.commands.push(rec);
    const log = createWriteStream(join(root, `${attempt}-${label}.log`));
    const h = scope.spawn(exe, args, { cwd, env: childEnv, deadlineMs: 180000 }, rec);
    h.child.stdout.pipe(log, { end: false });
    h.child.stderr.pipe(log, { end: false });
    await h.closed;
    await new Promise((r) => log.end(r));
    await h.stop();
    assert.equal(rec.code, expected, join(root, `${attempt}-${label}.log`));
    return rec;
  };
  for (const major of [22, 24]) {
    const cwd = `${root}/n${major}`,
      node = nodes[major];
    assert.ok(node);
    await command(`version${major}`, cwd, node, [
      '-e',
      `if(process.versions.node!=='${major === 22 ? '22.16.0' : '24.10.0'}')throw Error(process.version)`,
    ]);
    const req = createRequire(`${cwd}/package.json`);
    assert.equal(req('mysql2/package.json').version, '3.24.6');
    for (const f of ['application.ts', 'consumer-types.ts', 'demo.ts'])
      copyFileSync(`${repo}/examples/mysql-durable-replay/${f}`, `${cwd}/${f}`);
    copyFileSync(`${fixture}/controls.mjs`, `${cwd}/controls.mjs`);
    copyFileSync(`${fixture}/encoding-regressions.mjs`, `${cwd}/encoding-regressions.mjs`);
    const source = readFileSync(`${cwd}/application.ts`, 'utf8');
    writeFileSync(`${cwd}/application.cts`, source);
    writeFileSync(
      `${cwd}/consumer-types.cts`,
      readFileSync(`${cwd}/consumer-types.ts`, 'utf8').replace('./application.js', './application.cjs'),
    );
    for (const format of ['esm', 'cjs']) {
      const config = {
        compilerOptions: {
          types: ['node'],
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          esModuleInterop: true,
          outDir: format,
          declaration: true,
        },
        include:
          format === 'esm'
            ? ['application.ts', 'consumer-types.ts', 'demo.ts']
            : ['application.cts', 'consumer-types.cts'],
      };
      writeFileSync(`${cwd}/tsconfig-${format}.json`, JSON.stringify(config));
      await command(`compile${major}${format}`, cwd, node, [
        `${cwd}/node_modules/typescript/bin/tsc`,
        '-p',
        `tsconfig-${format}.json`,
      ]);
      writeFileSync(
        `${cwd}/${format}/package.json`,
        JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }),
      );
    }
  }
  for (const [index, mode] of [
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
    'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_BACKSLASH_ESCAPES',
  ].entries()) {
    const serviceRoot = join(root, 'services', `${attempt}-${index}`),
      data = `${serviceRoot}/data`,
      socket = `${serviceRoot}/mysql.sock`,
      port = Number(process.env.MYSQL_REPLAY_PORT ?? 59861) + index;
    assert.ok(!existsSync(serviceRoot), 'Fresh owned service directory required');
    mkdirSync(data, { recursive: true });
    const probe = createServer();
    await new Promise((yes, no) => {
      probe.once('error', no);
      probe.listen(port, '127.0.0.1', yes);
    });
    await new Promise((r) => probe.close(r));
    console.log(JSON.stringify({ announcedOwnedService: serviceRoot, port, mode }));
    const bin = `${process.env.MYSQL_BASEDIR}/bin/mysqld`,
      serviceEnv = { ...env, LD_LIBRARY_PATH: process.env.MYSQL_LIBRARY_PATH };
    await command(
      `initialize${index}`,
      serviceRoot,
      bin,
      ['--no-defaults', '--initialize-insecure', `--basedir=${process.env.MYSQL_BASEDIR}`, `--datadir=${data}`],
      serviceEnv,
    );
    const rec = { root: serviceRoot, data, socket, port, mode };
    report.services.push(rec);
    const log = createWriteStream(`${serviceRoot}/server.log`);
    const server = scope.spawn(
      bin,
      [
        '--no-defaults',
        `--basedir=${process.env.MYSQL_BASEDIR}`,
        `--datadir=${data}`,
        `--socket=${socket}`,
        `--port=${port}`,
        '--bind-address=127.0.0.1',
        '--mysqlx=0',
        `--pid-file=${serviceRoot}/mysql.pid`,
        `--sql-mode=${mode}`,
        '--innodb-buffer-pool-size=64M',
        '--innodb-lock-wait-timeout=1',
        '--lock-wait-timeout=2',
        '--max-execution-time=2000',
        '--innodb-flush-log-at-trx-commit=1',
        '--sync-binlog=1',
        `--log-bin=${serviceRoot}/binlog`,
      ],
      { cwd: serviceRoot, env: serviceEnv, deadlineMs: 600000 },
      rec,
    );
    server.service = true;
    server.child.stdout.pipe(log, { end: false });
    server.child.stderr.pipe(log, { end: false });
    const mysql = createRequire(`${root}/n24/package.json`)('mysql2/promise');
    let admin;
    let stopping;
    const stop = () =>
      (stopping ??= (async () => {
        await admin?.end();
        await server.stop();
        await new Promise((r) => log.end(r));
        rec.serverLog = readFileSync(`${serviceRoot}/server.log`, 'utf8');
        rmSync(serviceRoot, { recursive: true, force: true });
        rec.rootRemoved = !existsSync(serviceRoot);
      })());
    scope.registerStop(stop);
    for (let n = 0; n < 100; n++) {
      try {
        admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', connectTimeout: 500 });
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(admin, 'Native startup required');
    rec.generation = processIdentity(Number(readFileSync(`${serviceRoot}/mysql.pid`, 'utf8')));
    const [[facts]] = await admin.query(
      'SELECT VERSION() AS version,@@port AS port,@@datadir AS datadir,@@GLOBAL.sql_mode AS mode',
    );
    assert.match(facts.version, /^8\.4\./);
    assert.equal(facts.port, port);
    assert.equal(facts.datadir.replace(/\/$/, ''), data);
    assert.deepEqual(facts.mode.split(',').sort(), mode.split(',').sort());
    rec.facts = facts;
    for (const major of [22, 24])
      for (const format of ['esm', 'cjs']) {
        const cwd = `${root}/n${major}`,
          node = nodes[major],
          db = `mysql_replay_${attempt}_${index}_${major}_${format}`.replaceAll('-', '_');
        await admin.query(`CREATE DATABASE ${db} CHARACTER SET utf8mb4`);
        const childEnv = {
          ...env,
          MYSQL_PORT: String(port),
          MYSQL_DATABASE: db,
          MYSQL_URL: `mysql://root@127.0.0.1:${port}/${db}`,
        };
        const label = `${index}-${major}-${format}`;
        await command(
          `suite-${label}`,
          cwd,
          node,
          ['controls.mjs', format, 'suite', `${root}/${attempt}-${label}.cell.json`],
          childEnv,
        );
        const cell = JSON.parse(readFileSync(`${root}/${attempt}-${label}.cell.json`));
        assert.equal(cell.passed, true);
        report.cells.push(cell);
        await command(
          `review-regressions-${label}`,
          cwd,
          node,
          ['encoding-regressions.mjs', format, `${root}/${attempt}-${label}.regressions.json`],
          childEnv,
        );
        const regressions = JSON.parse(readFileSync(`${root}/${attempt}-${label}.regressions.json`));
        assert.equal(regressions.success, true);
        cell.reviewRegressions = regressions;
        // Real installed CLI generation, then strict generated ESM and CJS consumers.
        writeFileSync(
          `${cwd}/turbine.config.json`,
          JSON.stringify({ engine: 'mysql', connectionString: childEnv.MYSQL_URL, outDir: './generated/turbine' }),
        );
        await command(
          `generate-${label}`,
          cwd,
          node,
          [
            `${cwd}/node_modules/turbine-orm/dist/cli/index.js`,
            'generate',
            '--engine',
            'mysql',
            '--url',
            childEnv.MYSQL_URL,
            '--out',
            './generated/turbine',
          ],
          childEnv,
        );
        const generated = readFileSync(`${fixture}/generated-types.txt`, 'utf8');
        writeFileSync(`${cwd}/generated-use.ts`, generated);
        writeFileSync(
          `${cwd}/tsconfig-generated.json`,
          JSON.stringify({
            compilerOptions: {
              types: ['node'],
              strict: true,
              target: 'ES2023',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              skipLibCheck: false,
              outDir: 'generated-out',
            },
            include: ['generated-use.ts', 'generated/**/*.ts'],
          }),
        );
        await command(
          `generated-types-${label}`,
          cwd,
          node,
          [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig-generated.json'],
          childEnv,
        );
        await command(`generated-native-${label}`, cwd, node, ['generated-out/generated-use.js'], childEnv);
        const cjsRoot = `${cwd}/generated-cjs`;
        mkdirSync(cjsRoot, { recursive: true });
        cpSync(`${cwd}/generated`, `${cjsRoot}/generated`, { recursive: true });
        writeFileSync(`${cjsRoot}/package.json`, JSON.stringify({ type: 'commonjs' }));
        writeFileSync(
          `${cjsRoot}/use.ts`,
          generated.replace(
            'await generated(process.env.MYSQL_URL!);',
            'generated(process.env.MYSQL_URL!).catch(e=>{console.error(e);process.exitCode=1;});',
          ),
        );
        writeFileSync(
          `${cjsRoot}/tsconfig.json`,
          JSON.stringify({
            compilerOptions: {
              types: ['node'],
              strict: true,
              target: 'ES2023',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              skipLibCheck: false,
              outDir: 'out',
            },
            include: ['**/*.ts'],
            exclude: ['out'],
          }),
        );
        await command(
          `generated-cjs-types-${label}`,
          cjsRoot,
          node,
          [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json'],
          childEnv,
        );
        await command(`generated-cjs-native-${label}`, cjsRoot, node, ['out/use.js'], childEnv);
        const demoDb = `${db}_demo`;
        await admin.query(`CREATE DATABASE ${demoDb}`);
        await command(`demo-${label}`, cwd, node, ['esm/demo.js'], { ...childEnv, MYSQL_DATABASE: demoDb });
        await admin.query(`DROP DATABASE ${demoDb}`);
        // Delete the annotated type guards: the negative consumer must actually fail.
        writeFileSync(
          `${cwd}/consumer-negative.ts`,
          readFileSync(`${cwd}/consumer-types.ts`, 'utf8').replaceAll(/\s*\/\/ @ts-expect-error[^\n]*/g, ''),
        );
        writeFileSync(
          `${cwd}/tsconfig-negative.json`,
          JSON.stringify({
            extends: './tsconfig-esm.json',
            compilerOptions: { noEmit: true },
            include: ['consumer-negative.ts'],
          }),
        );
        await command(
          `negative-types-${label}`,
          cwd,
          node,
          [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig-negative.json'],
          childEnv,
          2,
        );
        if (major === 24 && format === 'esm') {
          const base = readFileSync(`${cwd}/application.ts`, 'utf8');
          const mutations = {
            capture: base.replace('body: Buffer.from(c.body)', 'body: c.body'),
            id: base.replace(
              /if\s*\(\s*payload\(event\)\s*!==\s*payload\(c\)\s*\)\s*throw new Error\('eventId mismatch'\);/,
              '',
            ),
            acknowledgement: base
              .replace(/\{\s*\.\.\.event,\s*body:\s*Buffer.from\(event.body\)\s*\}/, 'event')
              .replace(/\[tenant,\s*consumer,\s*acknowledgement\]/, '[tenant,consumer,events.at(-1)?.position]'),
          };
          for (const [omission, source] of Object.entries(mutations)) {
            assert.notEqual(source, base, `Missing omission target ${omission}`);
            writeFileSync(`${cwd}/omit-${omission}.ts`, source);
            writeFileSync(
              `${cwd}/tsconfig-omit.json`,
              JSON.stringify({ extends: './tsconfig-esm.json', include: [`omit-${omission}.ts`] }),
            );
            await command(
              `omit-compile-${label}-${omission}`,
              cwd,
              node,
              [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig-omit.json'],
              childEnv,
            );
            const omissionDb = `${db}_${omission}`;
            await admin.query(`CREATE DATABASE ${omissionDb}`);
            await command(
              `omit-native-${label}-${omission}`,
              cwd,
              node,
              ['controls.mjs', 'esm', 'suite'],
              { ...childEnv, MYSQL_DATABASE: omissionDb, MYSQL_REPLAY_APPLICATION: `${cwd}/esm/omit-${omission}.js` },
              1,
            );
            const rejection = readFileSync(`${root}/${attempt}-omit-native-${label}-${omission}.log`, 'utf8');
            assert.match(rejection, /AssertionError|must reject/, 'Omitted guard must fail a functional assertion');
            await admin.query(`DROP DATABASE ${omissionDb}`);
          }
        }
        const pdb = `${db}_process`;
        await admin.query(`CREATE DATABASE ${pdb}`);
        const penv = { ...childEnv, MYSQL_DATABASE: pdb };
        const prec = { label: `process-${label}` };
        report.commands.push(prec);
        const plog = createWriteStream(`${root}/${attempt}-process-${label}.log`);
        const child = scope.spawn(
          node,
          ['controls.mjs', format, 'process-wait'],
          { cwd, env: penv, deadlineMs: 15000 },
          prec,
        );
        let ready = '';
        const reached = new Promise((yes, no) => {
          child.child.stdout.on('data', (b) => {
            ready += b;
            if (ready.includes('PROCESS_EFFECT_READY')) yes();
          });
          child.closed.then(() => {
            if (!ready.includes('PROCESS_EFFECT_READY')) no(new Error('Process exited before effect'));
          });
        });
        child.child.stdout.pipe(plog, { end: false });
        child.child.stderr.pipe(plog, { end: false });
        await reached;
        await child.stop();
        await new Promise((r) => plog.end(r));
        await command(
          `process-reopen-${label}`,
          cwd,
          node,
          ['controls.mjs', format, 'process-reopen', `${root}/${attempt}-process-${label}.json`],
          penv,
        );
        await admin.query(`DROP DATABASE ${pdb}`);
        await admin.query(`DROP DATABASE ${db}`);
      }
    await stop();
  }
});
