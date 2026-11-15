import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { check, contract } from './contract.mjs';
import { omissions } from './omissions.mjs';

const repo = process.env.D1_REPLAY_REPO,
  cwd = process.cwd(),
  attempt = process.env.D1_REPLAY_ATTEMPT;
assert(repo && attempt);
const port = Number(process.env.D1_REPLAY_PORT),
  major = process.versions.node.split('.')[0];
assert.equal(process.versions.node, major === '22' ? '22.16.0' : '24.10.0');
const require = createRequire(join(cwd, 'package.json'));
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const workerd = require('workerd').default;
assert.equal(require('miniflare/package.json').version, '4.20260730.0');
assert.equal(require('workerd/package.json').version, '1.20260730.1');
const mode = process.argv[2] ?? 'full';
const report = {
  node: process.version,
  mode,
  port,
  workerd: {
    path: workerd,
    version: execFileSync(workerd, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
    sha256: hash(workerd),
  },
  miniflare: hash(require.resolve('miniflare')),
  lock: hash(join(cwd, 'package-lock.json')),
  cells: [],
  disposed: false,
};
function generation(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    pid,
    parent: Number(f[1]),
    group: Number(f[2]),
    startTime: f[19],
    command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(),
  };
}
function runtimeReceipt() {
  const parent = generation(process.pid),
    processes = [parent];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const child = generation(Number(name));
      if (child.parent === process.pid && child.command.startsWith(workerd) && child.command.includes(' serve '))
        processes.push(child);
    } catch {}
  }
  assert(processes.length >= 2, 'Actual native runtime generation receipt');
  const inodes = new Set();
  for (const p of processes)
    for (const fd of readdirSync(`/proc/${p.pid}/fd`)) {
      try {
        const link = readlinkSync(`/proc/${p.pid}/fd/${fd}`);
        const match = /^socket:\[([0-9]+)\]$/.exec(link);
        if (match) inodes.add(match[1]);
      } catch {}
    }
  const listeners = [];
  for (const family of ['tcp', 'tcp6'])
    for (const line of readFileSync(`/proc/net/${family}`, 'utf8').trim().split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] !== '0A' || !inodes.has(f[9])) continue;
      listeners.push({ family, localHex: f[1], port: Number.parseInt(f[1].split(':')[1], 16), inode: f[9] });
    }
  assert(
    listeners.some((x) => x.port === port),
    'Actual public listener',
  );
  assert(
    listeners.some((x) => x.port !== port),
    'Actual internal ephemeral listener',
  );
  return { processes, listeners };
}
const state = join(cwd, `${attempt}-state`);
let runtime;
const start = async (script = 'export default {fetch(){return new Response("ready")}}') => {
  assert(!runtime);
  runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: `replay-${major}` },
    d1Persist: state,
    host: '127.0.0.1',
    port,
    inspectorPort: 0,
  });
  await runtime.ready;
  report.launches ??= [];
  report.launches.push(runtimeReceipt());
  return runtime.getD1Database('DB');
};
const stop = async () => {
  await runtime?.dispose();
  runtime = undefined;
  report.disposed = true;
};
const compiler = join(cwd, 'node_modules/typescript/bin/tsc');
const compile = (directory, negative = false, configName = negative ? 'negative.json' : 'tsconfig.json') => {
  const args = [compiler, '-p', join(directory, configName)];
  const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 60000 });
  const log = configName.startsWith('worker')
    ? configName.replace('.json', '.log')
    : negative
      ? 'negative.log'
      : 'compile.log';
  writeFileSync(join(directory, log), result.stdout + result.stderr);
  if (negative) {
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /TS2345|TS2339|TS2322|TS2353/);
  } else assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
};
try {
  if (mode === 'reopen') {
    const binding = await start();
    const app = await import('./compiled/application.js');
    const { command } = await import('./contract.mjs');
    const facade = new app.ReplayApp(binding);
    const event = await facade.reconcile('process_persist', command());
    check(event?.position === 1, 'Separate process persisted event');
    check((await facade.checkpoint('process_persist', 'durable')) === 1, 'Separate process persisted checkpoint');
    const rows = (await binding.prepare("SELECT * FROM replay_destination WHERE tenant='process_persist'").all())
      .results;
    check(rows.length === 1, 'Separate process persisted destination');
    report.persisted = { event, checkpoint: 1, destination: rows };
    await facade.close();
  } else if (mode === 'interrupt') {
    const binding = await start();
    const { ReplayApp } = await import('./compiled/application.js');
    const { command } = await import('./contract.mjs');
    const app = new ReplayApp(binding);
    await app.append('process_interrupt', command());
    writeFileSync(
      join(cwd, `${attempt}-interrupt-committed.json`),
      JSON.stringify({ node: process.version, pid: process.pid, state, runtime: runtimeReceipt() }),
    );
    process.kill(process.pid, 'SIGKILL');
  } else if (mode === 'reopen-interrupt') {
    const binding = await start();
    const { ReplayApp } = await import('./compiled/application.js');
    const { command } = await import('./contract.mjs');
    const app = new ReplayApp(binding);
    assert.equal((await app.reconcile('process_interrupt', command())).position, 1);
    await app.close();
    report.interruptedCommitReopened = true;
  } else {
    const binding = await start();
    const esm = await import('./compiled/application.js'),
      cjs = require('./compiled/application.cjs');
    report.resolution = {
      esm: import.meta.resolve('turbine-orm/d1'),
      cjs: require.resolve('turbine-orm/d1'),
      generate: import.meta.resolve('turbine-orm/d1/generate'),
      migrate: import.meta.resolve('turbine-orm/d1/migrate'),
    };
    assert(report.resolution.esm.endsWith('/dist/d1.js'));
    assert(report.resolution.cjs.endsWith('/dist/cjs/d1.js'));
    for (const [format, api] of [
      ['installed-esm', esm],
      ['installed-cjs', cjs],
    ])
      report.cells.push({ format, result: await contract(api, binding, `${attempt}_${format.replaceAll('-', '_')}`) });
    const source = await build({
      stdin: {
        contents: `export * from ${JSON.stringify(join(repo, 'examples/d1-durable-replay/application.ts'))}`,
        resolveDir: cwd,
      },
      write: false,
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [
        {
          name: 'source-migrate',
          setup(b) {
            b.onResolve({ filter: /^turbine-orm\/d1\/migrate$/ }, () => ({ path: join(repo, 'src/d1/migrate.ts') }));
          },
        },
      ],
      metafile: true,
    });
    writeFileSync(join(cwd, 'source.mjs'), source.outputFiles[0].text);
    writeFileSync(join(cwd, 'source-graph.json'), JSON.stringify(source.metafile));
    report.cells.push({
      format: 'native-source',
      result: await contract(await import('./source.mjs'), binding, `${attempt}_source`),
    });
    report.omissions = await omissions(esm, binding);
    const demo = await import('./compiled/demo.js');
    report.demo = await demo.demo(binding);
    assert.equal(report.demo.checkpoint, 1);
    const { generateD1Files } = await import('turbine-orm/d1/generate');
    const { metadata } = await import('./compiled/schema.js');
    report.generated = [];
    for (const format of ['esm', 'cjs']) {
      const dir = join(cwd, `${attempt}-generated-${format}`);
      mkdirSync(join(dir, 'generated'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      for (const [name, content] of Object.entries(generateD1Files(metadata, {})))
        writeFileSync(join(dir, 'generated', name), content);
      copyFileSync(join(cwd, 'application.ts'), join(dir, 'application.ts'));
      const types = readFileSync(join(repo, 'src/test/fixtures/d1-durable-replay/generated-types.txt'), 'utf8');
      writeFileSync(join(dir, 'consumer.ts'), types);
      const config = {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          types: ['node'],
          outDir: 'out',
        },
        include: ['consumer.ts', 'application.ts', 'generated/**/*.ts'],
      };
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
      compile(dir);
      writeFileSync(join(dir, 'negative.ts'), types.replace(/^\s*\/\/ @ts-expect-error.*$/gm, ''));
      writeFileSync(
        join(dir, 'negative.json'),
        JSON.stringify({
          ...config,
          compilerOptions: { ...config.compilerOptions, noEmit: true },
          include: ['negative.ts', 'application.ts', 'generated/**/*.ts'],
        }),
      );
      compile(dir, true);
      const api =
        format === 'esm'
          ? await import(pathToFileURL(join(dir, 'out/consumer.js')).href)
          : require(join(dir, 'out/consumer.js'));
      report.generated.push({
        format,
        strict: true,
        skipLibCheck: false,
        negativeRejected: true,
        native: await api.run(binding),
      });
      if (format === 'esm') {
        const workerConfig = {
          ...config,
          compilerOptions: {
            ...config.compilerOptions,
            lib: ['ES2023'],
            types: ['@cloudflare/workers-types'],
            outDir: 'worker-out',
          },
        };
        writeFileSync(join(dir, 'worker.json'), JSON.stringify(workerConfig));
        compile(dir, false, 'worker.json');
        writeFileSync(
          join(dir, 'worker-negative.json'),
          JSON.stringify({
            ...workerConfig,
            compilerOptions: { ...workerConfig.compilerOptions, noEmit: true },
            include: ['negative.ts', 'application.ts', 'generated/**/*.ts'],
          }),
        );
        compile(dir, true, 'worker-negative.json');
        report.generatedWorkerStrict = {
          strict: true,
          skipLibCheck: false,
          types: ['@cloudflare/workers-types'],
          lib: ['ES2023'],
          negativeRejected: true,
        };
        report.generatedWorkerEntry = join(dir, 'worker-out/consumer.js');
      }
    }
    // Durable process-reopen marker has both source effect and destination acknowledgement.
    const app = new esm.ReplayApp(binding),
      sink = new esm.ReplayApp(binding);
    const { command } = await import('./contract.mjs');
    await app.append('process_persist', command());
    await app.deliver('process_persist', 'durable', async (es) => {
      for (const e of es) await sink.applyDestination('durable', e);
    });
    await app.close();
    await sink.close();
    await stop();
    // Worker ESM uses installed exports. Source Worker is a separate bundle and database tenant.
    for (const kind of ['installed', 'source', 'generated']) {
      const content =
        kind === 'generated'
          ? `import {run} from ${JSON.stringify(report.generatedWorkerEntry)};export default {async fetch(r,env){try{return Response.json(await run(env.DB));}catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}}}`
          : `import * as api from ${JSON.stringify(join(cwd, 'compiled/application.js'))};import {contract} from './contract.mjs';export default {async fetch(r,env){try{return Response.json(await contract(api,env.DB,${JSON.stringify(`${attempt}_worker_${kind}`)}));}catch(e){return Response.json({error:String(e),stack:e.stack},{status:500});}}}`;
      const plugins =
        kind === 'source'
          ? [
              {
                name: 'source-migrate',
                setup(b) {
                  b.onResolve({ filter: /^turbine-orm\/d1\/migrate$/ }, () => ({
                    path: join(repo, 'src/d1/migrate.ts'),
                  }));
                },
              },
            ]
          : [];
      const output = await build({
        stdin: { contents: content, resolveDir: cwd },
        bundle: true,
        write: false,
        platform: 'neutral',
        external: ['node:async_hooks'],
        format: 'esm',
        conditions: ['workerd'],
        plugins,
        metafile: true,
      });
      const graph = Object.keys(output.metafile.inputs);
      assert(
        !graph.some((p) => /node_modules\/(pg|mysql2|miniflare|workerd)\//.test(p)),
        'Worker runtime graph cannot contain tooling/PG',
      );
      writeFileSync(join(cwd, `${attempt}-worker-${kind}.mjs`), output.outputFiles[0].text);
      writeFileSync(join(cwd, `${attempt}-worker-${kind}-graph.json`), JSON.stringify(output.metafile));
      await start(output.outputFiles[0].text);
      const response = await runtime.dispatchFetch(`http://127.0.0.1:${port}/`);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      report.cells.push({ format: `worker-${kind}`, result: JSON.parse(text) });
      await stop();
    }
    // Every installed file is compared with the frozen normal archive, including all declaration bytes.
    const reference = join(cwd, 'reference');
    mkdirSync(reference, { recursive: true });
    execFileSync('tar', ['-xzf', process.env.D1_REPLAY_ARCHIVE, '--strip-components=1', '-C', reference], {
      timeout: 10000,
    });
    const files = (root, prefix = '') =>
      readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(root, join(prefix, e.name)) : [join(prefix, e.name)],
      );
    const payload = {};
    for (const file of files(reference)) {
      payload[file] = hash(join(reference, file));
      assert.equal(hash(join(cwd, 'node_modules/turbine-orm', file)), payload[file]);
    }
    assert.deepEqual(files(reference).sort(), files(join(cwd, 'node_modules/turbine-orm')).sort());
    assert.equal(Object.keys(payload).length, 753);
    report.payload = payload;
  }
} finally {
  await stop();
  writeFileSync(join(cwd, `${attempt}-${mode === 'full' ? 'native' : mode}.json`), JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({ node: process.version, mode, cells: report.cells.map((x) => x.format), disposed: report.disposed }),
);
