/**
 * Local optional SQLite preparation and serial campaign entry.
 * No default archive, runtime substitution, source timing, or hosted endpoint.
 * See --help. Dependency installation is confined to optional-sqlite-deps.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bounded,
  descendants,
  identity,
  OwnedChildren,
  sameProcess,
} from '../src/test/fixtures/neon-http/native-lifecycle.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deps = join(root, 'benchmarks/optional-sqlite-deps');
const requireDeps = createRequire(join(deps, 'package.json'));
export const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function publicEntry(artifact, specifier) {
  const exports = JSON.parse(readFileSync(join(artifact, 'package.json'))).exports;
  const key = specifier === 'turbine-orm' ? '.' : `.${specifier.slice('turbine-orm'.length)}`;
  const target = exports[key]?.import?.default;
  assert.ok(
    typeof target === 'string' && target.startsWith('./dist/'),
    `Installed public ESM export required: ${specifier}`,
  );
  return join(artifact, target);
}
export function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    assert.ok(key.startsWith('--'), `Unexpected argument ${key}`);
    assert.ok(!Object.hasOwn(args, key.slice(2)), `Duplicate argument ${key}`);
    if (['--allow-missing-d1-factory', '--help', '--runtime-control'].includes(key)) args[key.slice(2)] = true;
    else {
      assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `Value required: ${key}`);
      args[key.slice(2)] = argv[++i];
    }
  }
  const allowed = [
    'artifact',
    'artifact-head',
    'sha256',
    'output',
    'mode',
    'scratch',
    'rounds',
    'warmup',
    'allow-missing-d1-factory',
    'runtime-control',
    'help',
    'control',
  ];
  for (const key of Object.keys(args)) assert.ok(allowed.includes(key), `Unknown argument --${key}`);
  return args;
}
export function admit(args) {
  assert.ok(['preflight', 'campaign'].includes(args.mode), '--mode preflight|campaign required');
  assert.ok(args.artifact && /^[a-f0-9]{64}$/.test(args.sha256 ?? ''), 'Explicit archive and sha256 required');
  assert.match(args['artifact-head'] ?? '', /^[a-f0-9]{40}$/, 'Explicit runtime artifact source head required');
  assert.equal(sha(resolve(args.artifact)), args.sha256, 'Archive hash mismatch');
  assert.ok(args.output && !existsSync(resolve(args.output)), '--output must be a new directory');
  assert.ok(
    !args['allow-missing-d1-factory'] || args.mode === 'preflight',
    'Missing factory exception is preflight only',
  );
  assert.ok(
    !args['runtime-control'] || args.mode === 'preflight',
    'Runtime controls are never baseline campaign timing',
  );
  if (!args['runtime-control']) assert.equal(process.version, 'v24.10.0', 'Exact Node24.10.0 baseline required');
  const rounds = Number(args.rounds ?? 200),
    warmup = Number(args.warmup ?? 20);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 100000, 'Invalid rounds');
  assert.ok(Number.isSafeInteger(warmup) && warmup >= 0 && warmup <= 10000, 'Invalid warmup');
  assert.ok(
    !args.control || ['fail-after-catalog', 'signal-after-catalog', 'deadline-after-catalog'].includes(args.control),
    'Unknown cleanup control',
  );
  assert.ok(!args.control || args.mode === 'preflight', 'Cleanup controls only in preflight');
  return { mode: args.mode, rounds, warmup };
}

export function bundlePlugin({ artifact, generated, prisma, worker = false }) {
  return {
    name: 'locked-optional-sqlite-resolution',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]sqlite-seed\.ts$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        // Only the existing pure fixture exports are needed. Its original seed
        // function writes shared generated output and imports this repo's dist.
        // Keep the original ddl/volumes/fields/row formulas verbatim.
        return {
          contents: source.slice(0, source.indexOf('export const seedHandleAudit:')).replace(/^import .*;\n/gm, ''),
          loader: 'ts',
        };
      });
      builder.onResolve({ filter: /^optional-prisma$/ }, () => ({
        path: join(prisma, worker ? 'edge.js' : 'index.js'),
      }));
      builder.onResolve({ filter: /^optional-generated-factory$/ }, () => ({ path: generated }));
      if (worker)
        builder.onResolve({ filter: /query_compiler_fast_bg\.wasm$/ }, () => ({
          path: './prisma-query-compiler.wasm',
          external: true,
        }));
      if (worker)
        builder.onResolve({ filter: /^node:util$/ }, (args) =>
          args.importer.endsWith('/equivalence.ts')
            ? { path: join(root, 'benchmarks/optional-sqlite-util.mjs') }
            : { path: 'node:util', external: true },
        );
      // Reuse fixture exports without building or writing this checkout's dist.
      builder.onResolve({ filter: /(?:^|\/)dist\/(generate|sqlite)\.js$/ }, (args) => ({
        path: join(artifact, 'dist', args.path.endsWith('/generate.js') ? 'generate.js' : 'sqlite.js'),
        external: worker,
      }));
      builder.onResolve({ filter: /^turbine-orm(?:\/|$)/ }, (args) => {
        const path = publicEntry(artifact, args.path);
        return { path, external: !worker };
      });
      builder.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith('node:') || args.path === '#pg') return undefined;
        // Resolve every competitor from this checkout's locked optional deps.
        // esbuild chooses workerd/browser conditions for worker package exports.
        if (worker) return undefined;
        return { path: requireDeps.resolve(args.path), external: true };
      });
    },
  };
}
function hashes(directory, predicate = () => true) {
  const out = {};
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) Object.assign(out, hashes(path, predicate));
    else if (item.isFile() && predicate(path)) out[path] = sha(path);
  }
  return out;
}
function ownedListeners() {
  const owners = descendants([identity(process.pid)]),
    sockets = new Map();
  for (const owner of owners) {
    try {
      for (const fd of readdirSync(`/proc/${owner.pid}/fd`)) {
        try {
          const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${owner.pid}/fd/${fd}`))?.[1];
          if (inode) sockets.set(inode, owner);
        } catch {}
      }
    } catch {}
  }
  const listeners = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6'])
    for (const line of readFileSync(file, 'utf8').trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && sockets.has(fields[9]))
        listeners.push({
          process: sockets.get(fields[9]),
          addressHex: fields[1],
          port: parseInt(fields[1].split(':')[1], 16),
          inode: fields[9],
        });
    }
  return { owners, listeners };
}
const npmCli = process.env.npm_execpath;

async function main(args) {
  const options = admit(args);
  assert.ok(npmCli, 'Set npm_execpath to the npm CLI JavaScript file, or run through npm exec.');
  const output = resolve(args.output);
  mkdirSync(output);
  const scratch = resolve(args.scratch ?? join(tmpdir(), 'turbine-sqlite-benchmark'));
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(join(scratch, 'run-'));
  const report = {
    format: 'optional-local-sqlite-contract-run-v1',
    invocation: process.argv,
    status: 'running',
    timingAcceptance:
      options.mode === 'preflight'
        ? 'none: correctness and control run only'
        : 'Serial candidate; comparative results require the tested artifact and an idle machine',
    source: {
      path: root,
      branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
    },
    runtime: {
      node: process.version,
      path: process.execPath,
      sha256: sha(process.execPath),
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
    },
    artifact: {
      path: resolve(args.artifact),
      sha256: args.sha256,
      sourceHead: args['artifact-head'],
      sourceHeadProvenance: 'explicit caller-supplied artifact identity; archive payload hashes also retained',
      scope: 'actual npm-installed supplied archive; no local source/dist timing or package rebuild',
      installed: {},
    },
    options,
    serviceRoot: temporary,
    commands: [],
    errors: [],
    cleanup: {},
    arms: {},
    unsupported: {
      d1: [
        'interactive callback atomicity for every arm',
        'Prisma7 D1 array transaction rollback guarantee',
        'native incremental cursor',
        'in-flight binding cancellation',
        'hosted Cloudflare certification',
        'per-arm Worker RSS',
        'network latency',
      ],
      libsql: [
        'remote libSQL/Turso',
        'replicas/sync/new Turso engines',
        'native incremental cursor',
        'in-flight native interruption',
        'hosted certification',
      ],
      general: [
        'original full-catalog campaign',
        'type/install performance',
        'cold import/first query performance',
        'Prisma8 transport inference',
      ],
    },
  };
  const save = () =>
    writeFileSync(
      join(output, 'run.json'),
      JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );
  const env = {
    PATH: `${dirname(process.execPath)}:${deps}/node_modules/.bin:/usr/bin:/bin`,
    HOME: join(scratch, 'home'),
    TMPDIR: temporary,
    npm_config_cache: join(scratch, 'npm'),
    npm_config_userconfig: '/dev/null',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    PRISMA_SKIP_POSTINSTALL_GENERATE: '1',
  };
  const owned = new OwnedChildren({ cwd: root, env, report, onChange: save });
  let interrupted;
  const seal = (signal) => {
    interrupted = signal;
    report.errors.push(signal);
    owned.seal(new Error(signal));
  };
  const term = () => seal('SIGTERM'),
    int = () => seal('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  save();
  try {
    const pkg = JSON.parse(readFileSync(join(deps, 'package.json')));
    report.lock = { path: join(deps, 'package-lock.json'), sha256: sha(join(deps, 'package-lock.json')) };
    for (const [name, pin] of Object.entries(pkg.dependencies)) {
      const actual = JSON.parse(readFileSync(join(deps, 'node_modules', name, 'package.json')));
      assert.equal(
        actual.version,
        pin.startsWith('npm:') ? pin.slice(pin.lastIndexOf('@') + 1) : pin,
        `Locked version ${name}`,
      );
      report.arms[name] = {
        version: actual.version,
        packageSha256: sha(join(deps, 'node_modules', name, 'package.json')),
      };
    }
    for (const [name, pin] of Object.entries(pkg.overrides)) {
      const actual = JSON.parse(readFileSync(join(deps, 'node_modules', name, 'package.json')));
      assert.equal(actual.version, pin, `Locked native dependency ${name}`);
      report.arms[name] = {
        version: actual.version,
        packageSha256: sha(join(deps, 'node_modules', name, 'package.json')),
      };
    }
    const installedRoot = join(temporary, 'installed');
    mkdirSync(installedRoot);
    writeFileSync(
      join(installedRoot, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: { 'turbine-orm': `file:${resolve(args.artifact)}` },
      }),
    );
    await owned.run(
      'install-exact-archive',
      process.execPath,
      [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installedRoot],
      { timeout: 120000, log: join(output, 'install.log') },
    );
    const artifact = join(installedRoot, 'node_modules/turbine-orm');
    // Optional native peer is the same locked checkout-owned install as raw and
    // both Drizzle arms, not a mutable sibling checkout or implicit fallback.
    symlinkSync(join(deps, 'node_modules/@libsql'), join(installedRoot, 'node_modules/@libsql'), 'dir');
    report.artifact.installed = hashes(artifact, (path) => /(?:\.js|\.json|\.d\.ts)$/.test(path));
    report.lockedDriverFiles = Object.fromEntries(
      [
        '@libsql/client',
        'libsql',
        '@prisma/adapter-d1',
        '@prisma/adapter-libsql',
        '@prisma/client',
        'prisma',
        'drizzle-orm',
        'drizzle-rc',
        'miniflare',
        'workerd',
      ].map((name) => [
        name,
        hashes(join(deps, 'node_modules', name), (path) => /\.(?:js|mjs|cjs|node|json|wasm)$/.test(path)),
      ]),
    );
    report.tools = {
      npmCli: { path: npmCli, sha256: sha(npmCli) },
      esbuild: {
        path: join(deps, 'node_modules/@esbuild/linux-x64/bin/esbuild'),
        sha256: sha(join(deps, 'node_modules/@esbuild/linux-x64/bin/esbuild')),
      },
      supervisor: {
        path: join(root, 'src/test/fixtures/neon-http/http-command-supervisor.py'),
        sha256: sha(join(root, 'src/test/fixtures/neon-http/http-command-supervisor.py')),
      },
    };
    report.artifact.installLockSha256 = sha(join(installedRoot, 'package-lock.json'));
    const exports = JSON.parse(readFileSync(join(artifact, 'package.json'))).exports;
    const d1Factory = Boolean(exports['./d1/generate']);
    report.artifact.d1Factory = d1Factory;
    assert.ok(
      d1Factory || args['allow-missing-d1-factory'],
      'Final tested archive must supply ./d1/generate; integration archive is preflight only',
    );
    const prismaDir = join(temporary, 'prisma');
    symlinkSync(join(deps, 'node_modules'), join(temporary, 'node_modules'), 'dir');
    const prismaSchema = readFileSync(join(root, 'benchmarks/prisma/sqlite.prisma'), 'utf8').replace(
      'output = "../generated/prisma-sqlite"',
      `output = ${JSON.stringify(prismaDir)}`,
    );
    const schemaPath = join(temporary, 'schema.prisma');
    writeFileSync(schemaPath, prismaSchema);
    await owned.run(
      'prisma7-generate-existing-sqlite-schema',
      process.execPath,
      [requireDeps.resolve('prisma/build/index.js'), 'generate', '--schema', schemaPath],
      { timeout: 120000, log: join(output, 'prisma-generate.log') },
    );
    report.prismaGenerated = hashes(prismaDir);
    cpSync(prismaDir, join(output, 'prisma-generated'), { recursive: true });
    const { build } = requireDeps('esbuild');
    const common = {
      bundle: true,
      format: 'esm',
      logLevel: 'silent',
      nodePaths: [join(deps, 'node_modules')],
      metafile: true,
      banner: {
        js: "import {createRequire as __optionalRequire} from 'node:module'; const require=__optionalRequire(import.meta.url);",
      },
    };
    const fixturePath = join(temporary, 'fixture.mjs');
    await build({
      ...common,
      entryPoints: [join(root, 'benchmarks/sqlite-seed.ts')],
      outfile: fixturePath,
      platform: 'node',
      plugins: [bundlePlugin({ artifact, generated: '', prisma: prismaDir })],
    });
    const fixture = await import(pathToFileURL(fixturePath));
    const contractPath = join(temporary, 'contract.mjs');
    await build({
      ...common,
      entryPoints: [join(root, 'benchmarks/optional-sqlite-contract.mjs')],
      outfile: contractPath,
      platform: 'node',
      plugins: [bundlePlugin({ artifact, generated: '', prisma: prismaDir })],
    });
    const { assertContractReport } = await import(pathToFileURL(contractPath));
    const { createClient } = await import(pathToFileURL(requireDeps.resolve('@libsql/client/node')));
    const url = `file:${join(temporary, 'libsql.db')}`;
    const native = createClient({ url, intMode: 'bigint' });
    let schema;
    try {
      for (const sql of fixture.ddl
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await native.execute(sql);
      const { introspectLibsql } = await import(pathToFileURL(publicEntry(artifact, 'turbine-orm/libsql/introspect')));
      schema = await introspectLibsql({ client: native, url });
      assert.equal(native.closed, false);
    } finally {
      native.close();
    }
    const { generateLibsqlFiles } = await import(pathToFileURL(publicEntry(artifact, 'turbine-orm/libsql/generate')));
    const libsqlFactory = join(temporary, 'generated-libsql');
    mkdirSync(libsqlFactory);
    for (const [name, text] of Object.entries(generateLibsqlFiles(schema, { noTimestamp: true })))
      writeFileSync(join(libsqlFactory, name), text);
    cpSync(libsqlFactory, join(output, 'libsql-generated'), { recursive: true });
    const nodeEntry = join(temporary, 'libsql.mjs');
    const nodeBuild = await build({
      ...common,
      entryPoints: [join(root, 'benchmarks/optional-sqlite-libsql.mjs')],
      outfile: nodeEntry,
      platform: 'node',
      plugins: [bundlePlugin({ artifact, generated: join(libsqlFactory, 'index.ts'), prisma: prismaDir })],
    });
    cpSync(nodeEntry, join(output, 'libsql-bundled.mjs'));
    report.libsqlGraph = nodeBuild.metafile;
    writeFileSync(
      join(output, 'libsql-generated.json'),
      JSON.stringify({ schema, files: hashes(libsqlFactory), runtimeGraph: nodeBuild.metafile }, null, 2),
    );
    await owned.run('local-libsql-contract', process.execPath, [nodeEntry], {
      timeout: 120000,
      env: {
        ...env,
        OPTIONAL_SQLITE_OPTIONS: JSON.stringify({ ...options, url, report: join(output, 'libsql.json') }),
      },
      log: join(output, 'libsql.log'),
    });
    report.libsql = JSON.parse(readFileSync(join(output, 'libsql.json')));
    assert.equal(report.libsql.status, 'passed');
    assert.equal(report.libsql.generatedFactory, true);
    assert.equal(report.libsql.cleanup.nativeClosed, true);
    assert.equal(report.libsql.cleanup.drizzleClosed, true);
    assert.ok(report.libsql.nativeObjects.length > 0);
    assertContractReport(report.libsql, 'libsql', options);
    // D1 has a separate supervised process so workerd descendants remain owned
    // even on a blocked parent event loop, deadline, or signal.
    const d1Options = { ...options, artifact, prismaDir, temporary, output, d1Factory, control: args.control, env };
    let deadlineError;
    try {
      await owned.run('local-workerd-contract', process.execPath, [fileURLToPath(import.meta.url), '--d1-child'], {
        timeout: args.control === 'deadline-after-catalog' ? 15000 : 120000,
        env: { ...env, OPTIONAL_SQLITE_CHILD: JSON.stringify(d1Options) },
        log: join(output, 'd1.log'),
        ...(args.control
          ? { failure: args.control === 'fail-after-catalog' ? /intentional-failure-after-catalog/ : /^/ }
          : {}),
      });
    } catch (error) {
      if (args.control !== 'deadline-after-catalog') throw error;
      const proof = report.commands.at(-1).ownershipProof;
      assert.equal(proof?.passed, true);
      assert.equal(proof.stopReason, 'timeout');
      assert.match(String(error), /timed out/);
      deadlineError = error.stack;
    }
    report.d1 = JSON.parse(readFileSync(join(output, 'd1.json')));
    if (args.control) {
      assert.equal(report.d1.control, args.control, 'Control must reach actual live D1 catalog/factory first');
      assert.equal(report.d1.generated.used, d1Factory);
      const command = report.commands.at(-1);
      if (args.control === 'fail-after-catalog') assert.equal(report.d1.status, 'controlled-failure');
      else if (args.control === 'signal-after-catalog')
        assert.ok(command.status === 143 || command.signal === 'SIGTERM', 'Expected SIGTERM termination');
      else assert.ok(deadlineError, 'Independent native deadline must fire');
      report.control = {
        kind: args.control,
        passed: true,
        fixtureSnapshotStatus: report.d1.status,
        deadlineError,
        observedExit: { status: command.status, signal: command.signal },
        cleanupScope:
          'independent subreaper and parent PID/starttime, process-group, listener and storage audit; Miniflare may exit before application finally',
      };
    } else assert.equal(report.d1.status, 'passed');
    if (!args.control) {
      assertContractReport(report.d1.result, 'd1', options);
      for (const field of ['writesEmpty', 'facadeClosed', 'bindingCallerOwned'])
        assert.equal(report.d1.result.cleanup[field], true, `D1 cleanup ${field}`);
      assert.equal(report.d1.generated.used, d1Factory);
    }
    report.status = interrupted ? 'failed' : 'passed';
  } catch (error) {
    report.status = 'failed';
    report.errors.push(error.stack);
  } finally {
    try {
      await owned.close();
    } catch (error) {
      report.status = 'failed';
      report.errors.push(error.stack);
    }
    report.cleanup.commandsReaped = report.commands.every(
      (command) =>
        command.ownershipProof?.passed &&
        command.ownershipProof.remaining.length === 0 &&
        !sameProcess(command.supervisor),
    );
    report.cleanup.processesAbsent = report.commands.every((command) =>
      command.ownershipProof?.processes.every((item) => !sameProcess(item)),
    );
    const groups = new Set(report.commands.map((command) => command.supervisor?.pgid).filter(Boolean));
    report.cleanup.remainingGroups = readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((name) => identity(Number(name)))
      .filter((record) => record && groups.has(record.pgid));
    // Audit listeners independently after descendant reaping, including controls.
    const d1Path = join(output, 'd1.json');
    if (existsSync(d1Path)) {
      const childReport = JSON.parse(readFileSync(d1Path));
      report.cleanup.ports = [];
      for (const port of childReport.ports ?? []) report.cleanup.ports.push({ port, closed: await portClosed(port) });
      if (report.cleanup.ports.some((port) => !port.closed)) report.status = 'failed';
    }
    report.harnessHashes = Object.fromEntries(
      [
        ...readdirSync(join(root, 'benchmarks'))
          .filter((name) => /^optional-sqlite-.*\.(mjs|ts)$/.test(name))
          .map((name) => `benchmarks/${name}`),
        'benchmarks/bench-harness.ts',
        'benchmarks/equivalence.ts',
        'benchmarks/sqlite-seed.ts',
        'benchmarks/sqlite-schema.ts',
        'benchmarks/sqlite-schema-rc.ts',
        'benchmarks/prisma/sqlite.prisma',
        'src/test/fixtures/neon-http/native-lifecycle.mjs',
        'src/test/fixtures/neon-http/http-command-supervisor.py',
      ].map((path) => [path, sha(join(root, path))]),
    );
    report.cleanup.artifactUnchanged = sha(args.artifact) === args.sha256;
    rmSync(temporary, { recursive: true, force: true });
    report.cleanup.serviceRootAbsent = !existsSync(temporary);
    requireDeps('esbuild').stop();
    if (
      !report.cleanup.commandsReaped ||
      !report.cleanup.processesAbsent ||
      report.cleanup.remainingGroups.length ||
      !report.cleanup.artifactUnchanged
    )
      report.status = 'failed';
    process.off('SIGTERM', term);
    process.off('SIGINT', int);
    save();
  }
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(output, 'run.json'),
      timingAcceptance: report.timingAcceptance,
      cleanup: report.cleanup,
    }),
  );
  if (report.status !== 'passed') process.exitCode = 1;
}
async function portClosed(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function d1Child(options) {
  const { build } = requireDeps('esbuild');
  const { Miniflare } = requireDeps('miniflare');
  const nativeRequire = createRequire(requireDeps.resolve('miniflare'));
  const executable = nativeRequire('workerd').default;
  const report = {
    status: 'running',
    ports: [],
    workerd: {
      path: executable,
      sha256: sha(executable),
      version: execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
    },
    runtime: { node: process.version, sha256: sha(process.execPath) },
    cleanup: {},
  };
  const save = () => writeFileSync(join(options.output, 'd1.json'), JSON.stringify(report, null, 2));
  let mf,
    controlTriggered = false;
  const controller = new AbortController();
  const stop = () => {
    controller.abort(new Error('intentional-signal-control'));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  save();
  try {
    assert.equal(report.workerd.version, 'workerd 2026-07-30');
    const generatedDir = join(options.temporary, 'generated-d1');
    mkdirSync(generatedDir);
    const generated = join(generatedDir, 'index.ts');
    writeFileSync(
      generated,
      "import {turbineD1} from 'turbine-orm/d1'; export function turbine(binding, options, schema){return turbineD1(binding,schema,options)}\n",
    );
    const make = async () => {
      const bundle = await build({
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        conditions: ['workerd', 'browser'],
        mainFields: ['browser', 'module', 'main'],
        nodePaths: [join(deps, 'node_modules')],
        entryPoints: [join(root, 'benchmarks/optional-sqlite-worker.mjs')],
        write: false,
        metafile: true,
        external: [
          'node:async_hooks',
          'node:assert/strict',
          'node:util',
          'node:sqlite',
          'node:fs',
          'node:path',
          'node:url',
        ],
        plugins: [bundlePlugin({ artifact: options.artifact, generated, prisma: options.prismaDir, worker: true })],
        logLevel: 'silent',
      });
      report.graph = bundle.metafile;
      report.workerSourceSha256 = createHash('sha256').update(bundle.outputFiles[0].text).digest('hex');
      writeFileSync(join(options.output, 'd1-bundled.mjs'), bundle.outputFiles[0].text);
      report.inputHashes = Object.fromEntries(
        Object.keys(bundle.metafile.inputs).map((path) => [path, sha(resolve(root, path))]),
      );
      const inputs = Object.keys(bundle.metafile.inputs);
      assert.ok(inputs.some((path) => path.endsWith('turbine-orm/dist/d1.js')));
      assert.ok(
        inputs.some((path) => path.endsWith('@prisma/adapter-d1/dist/index-workerd.mjs')),
        'Actual official workerd adapter required',
      );
      assert.ok(
        !inputs.some((path) => /node_modules\/(pg|@libsql|libsql|better-sqlite3)\//.test(path)),
        'No Node/native fallback in Worker graph',
      );
      return bundle.outputFiles[0].text;
    };
    const mfOptions = (script) => ({
      modulesRoot: options.temporary,
      modules: [
        { type: 'ESModule', path: join(options.temporary, 'worker.mjs'), contents: script },
        {
          type: 'CompiledWasm',
          path: join(options.temporary, 'prisma-query-compiler.wasm'),
          contents: readFileSync(join(options.prismaDir, 'query_compiler_fast_bg.wasm')),
        },
      ],
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      defaultPersistRoot: join(options.temporary, 'miniflare-state'),
      defaultProjectTmpPath: join(options.temporary, 'miniflare-tmp'),
      d1Databases: { DB: 'optional-sqlite-owned' },
      d1Persist: join(options.temporary, 'd1-storage'),
      host: '127.0.0.1',
      port: 0,
    });
    report.platformConfig = {
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      host: '127.0.0.1',
      port: 0,
      storageRoot: options.temporary,
    };
    mf = new Miniflare(mfOptions(await make()));
    report.ports.push(Number((await mf.ready).port));
    save();
    report.nativeOwnership = [ownedListeners()];
    const catalogResponse = await bounded(mf.dispatchFetch('http://localhost/catalog'), 30000, 'D1 catalog/seed');
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
    report.catalog = catalog;
    const nativeSchema = JSON.parse(JSON.stringify(catalog.schema), (_, value) =>
      value && typeof value === 'object' && Object.hasOwn(value, '$optionalSet') ? new Set(value.$optionalSet) : value,
    );
    if (options.d1Factory) {
      const { generateD1Files } = await import(pathToFileURL(publicEntry(options.artifact, 'turbine-orm/d1/generate')));
      for (const [name, text] of Object.entries(generateD1Files(nativeSchema, { noTimestamp: true })))
        writeFileSync(join(generatedDir, name), text);
      await mf.setOptions(mfOptions(await make()));
      report.ports.push(Number((await mf.ready).port));
      report.generated = { used: true, catalogSource: 'actual workerd D1 binding', hashes: hashes(generatedDir) };
      cpSync(generatedDir, join(options.output, 'd1-generated'), { recursive: true });
    } else
      report.generated = {
        used: false,
        reason: 'Explicit preflight integration archive exception: ./d1/generate absent',
      };
    report.nativeOwnership.push(ownedListeners());
    report.ports = [
      ...new Set([
        ...report.ports,
        ...report.nativeOwnership.flatMap((snapshot) => snapshot.listeners.map((listener) => listener.port)),
      ]),
    ];
    controlTriggered = Boolean(options.control);
    report.control = options.control ?? null;
    save();
    if (options.control === 'fail-after-catalog') throw new Error('intentional-failure-after-catalog');
    if (options.control === 'signal-after-catalog') process.kill(process.pid, 'SIGTERM');
    if (options.control)
      await new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }),
      );
    const start = performance.now();
    const response = await bounded(
      mf.dispatchFetch('http://localhost/contract', {
        method: 'POST',
        body: JSON.stringify({ ...options, generatedFactory: options.d1Factory }),
      }),
      60000,
      'D1 contract',
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    report.result = result;
    report.localDispatch = {
      elapsedMilliseconds: performance.now() - start,
      scope:
        'entire local Miniflare dispatch, validation and controls; not per-operation timing and not network latency',
    };
    report.isolateTiming = {
      scope: 'performance.now inside workerd around completed contract ORM call; retained only in campaign mode',
    };
    report.status = 'passed';
  } catch (error) {
    report.error = error.stack;
    report.status = controlTriggered ? 'controlled-failure' : 'failed';
  } finally {
    try {
      await bounded(mf?.dispose(), 10000, 'Miniflare dispose');
      report.cleanup.disposed = true;
    } catch (error) {
      report.cleanup.error = error.stack;
      report.status = 'failed';
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    report.cleanup.ports = await Promise.all(
      report.ports.map(async (port) => ({ port, closed: await portClosed(port) })),
    );
    save();
  }
  if (report.status !== 'passed') {
    console.error(report.error ?? 'intentional control failure');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--d1-child') await d1Child(JSON.parse(process.env.OPTIONAL_SQLITE_CHILD));
  else {
    const args = argumentsFor(process.argv.slice(2));
    if (args.help)
      console.log(
        'node optional-sqlite-runner.mjs --mode preflight|campaign --artifact /absolute/final-tested.tgz --artifact-head SOURCE_HEAD --sha256 HEX --output NEW_DIR [--scratch OWNED_DIR] [--rounds 200 --warmup 20]\nNode24.10.0 baseline. --runtime-control permits preflight only on another Node. --allow-missing-d1-factory is an explicit integration-archive preflight exception. --control fail-after-catalog|signal-after-catalog|deadline-after-catalog runs teardown controls.',
      );
    else await main(args);
  }
}
