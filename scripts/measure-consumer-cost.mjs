#!/usr/bin/env node
/** See tooling/consumer-cost/README.md. Never builds, packs, or edits the checkout. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { homedir, release, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib';
import {
  consumerTypeSource,
  processMonitor,
  profileBehaviorSource,
  profileSource,
  profileTypeSource,
  runtimeProbe,
  syntheticSchema,
} from './measure-consumer-cost-fixtures.mjs';
import { childMemory, hostSnapshot } from './measure-consumer-cost-resources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const definitions = JSON.parse(await readFile(join(root, 'tooling/consumer-cost/profiles.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const measured = (value) => ({ status: 'measured', ...value });
const unavailable = (reason) => ({ status: 'unavailable', reason });
const failed = (reason) => ({ status: 'failed', reason });
const cleanEnv = (home) =>
  Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: tmpdir(),
      TMPDIR: tmpdir(),
      HOME: home,
      USERPROFILE: home,
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      NODE_ENV: 'production',
    }).filter(([, value]) => value !== undefined),
  );

/** No shell, credentials, ambient Node flags, database URLs, or npm configs in children. */
export async function command(
  executable,
  args,
  { cwd, home = cwd, timeoutMs = 120000, env = {}, observeResources = false } = {},
) {
  const start = performance.now();
  const hostBefore = observeResources ? await hostSnapshot() : null;
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...cleanEnv(home), ...env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputTruncated = false;
    const observations = [];
    let sampling = Promise.resolve();
    const sample = () => {
      sampling = sampling.then(async () => {
        const memory = await childMemory(child.pid);
        if (memory) observations.push({ elapsedMs: performance.now() - start, ...memory });
      });
    };
    if (observeResources) sample();
    const sampler = observeResources ? setInterval(sample, 250) : null;
    const collect = (kind, chunk) => {
      if (stdout.length + stderr.length > 8 * 1024 * 1024) {
        outputTruncated = true;
        return;
      }
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, timeoutMs);
    child.on('error', (error) => {
      stderr += `${error.code ?? 'SPAWN_ERROR'}: command could not start`;
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (sampler) clearInterval(sampler);
      await sampling;
      const exhausted = code !== 0 && /FATAL ERROR:.*(?:heap out of memory|Allocation failed)/i.test(stderr);
      resolveResult({
        status: timedOut ? 'timeout' : code === 0 ? 'measured' : exhausted ? 'resource-exhausted' : 'failed',
        code,
        signal,
        wallMs: performance.now() - start,
        stdout,
        stderr,
        outputTruncated,
        ...(observeResources
          ? {
              observation: {
                hostBefore,
                hostAfter: await hostSnapshot(),
                intervalMs: 250,
                samples: observations,
                sampledPeakRssBytes: observations.length
                  ? Math.max(...observations.map((o) => o.highWaterBytes))
                  : null,
                scope:
                  'Linux child process VmHWM/VmRSS sampled externally; may miss the final peak; no descendant accounting. Null when unobservable. A signal alone does not prove OOM.',
              },
            }
          : {}),
      });
    });
  });
}

async function logged(executable, args, options, evidence, name) {
  const result = await command(executable, args, options);
  await writeFile(join(evidence, `${name}.stdout.txt`), result.stdout);
  await writeFile(join(evidence, `${name}.stderr.txt`), result.stderr);
  const { stdout: _stdout, stderr: _stderr, ...summary } = result;
  await save(join(evidence, `${name}.command.json`), {
    executable: executable === process.execPath ? 'current-node' : executable,
    args: args.map((arg) => (arg.startsWith(options.cwd) ? relative(options.cwd, arg) : arg)),
    ...summary,
  });
  return summary;
}

// Read npm's gzip/tar metadata without extracting untrusted paths or executing package code.
export function packedMetadata(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  let manifest;
  let unpackedBytes = 0;
  let fileCount = 0;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error('Invalid npm tarball');
    const kind = field(156, 1);
    if (kind === '' || kind === '0') {
      unpackedBytes += size;
      fileCount++;
      if (name === 'package/package.json')
        manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (manifest?.name !== 'turbine-orm' || !manifest.version)
    throw new Error('Candidate must be an npm-packed turbine-orm package');
  return {
    name: manifest.name,
    version: manifest.version,
    manifestSha256: sha256(JSON.stringify(manifest)),
    manifest,
    tarballSha256: sha256(bytes),
    tarballBytes: bytes.length,
    unpackedBytes,
    fileCount,
  };
}

async function diskTree(path) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) {
      const child = await diskTree(next);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += (await stat(next)).size;
      files++;
    }
    // Symlinks (npm bin links) have no file payload; never follow them out of the consumer.
  }
  return { bytes, files };
}

function npmArgs(base, options, scratch) {
  return [
    ...base,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--registry=https://registry.npmjs.org',
    '--userconfig',
    join(scratch, 'empty.npmrc'),
    '--globalconfig',
    join(scratch, 'global.npmrc'),
    '--cache',
    options.cache,
    ...(options.allowNetwork ? [] : ['--offline']),
  ];
}

async function install(base, options, project, scratch, evidence, name) {
  return logged(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    npmArgs(base, options, scratch),
    { cwd: project, home: scratch, timeoutMs: options.timeoutMs },
    evidence,
    name,
  );
}

async function sourceIdentity() {
  const git = async (args) => {
    const result = await command('git', args, { cwd: root });
    return result.code === 0 ? result.stdout.trim() : null;
  };
  return {
    head: await git(['rev-parse', 'HEAD']),
    branch: await git(['branch', '--show-current']),
    dirty: Boolean(await git(['status', '--porcelain'])),
    fileSha256: Object.fromEntries(
      await Promise.all(
        [
          'scripts/measure-consumer-cost.mjs',
          'scripts/measure-consumer-cost-fixtures.mjs',
          'scripts/measure-consumer-cost-resources.mjs',
          'tooling/consumer-cost/profiles.json',
        ].map(async (file) => [file, sha256(await readFile(join(root, file)))]),
      ),
    ),
    note: 'Runner checkout identity only. Candidate provenance requires --source-ref; tarball SHA-256 is authoritative.',
  };
}

async function inventory(project, lock, profile, candidate) {
  const entries = Object.entries(lock.packages).filter(([path, pkg]) => path && !pkg.dev);
  const packages = [];
  for (const [path, pkg] of entries) {
    if (!existsSync(join(project, path, 'package.json'))) continue; // Optional platform packages may be absent.
    const actual = await json(join(project, path, 'package.json'));
    packages.push({
      path,
      name: actual.name,
      version: actual.version,
      integrity: pkg.integrity ?? null,
      source: pkg.resolved ?? null,
      ...(await diskTree(join(project, path))),
    });
  }
  const mandatoryPg = Boolean(candidate.manifest.dependencies?.pg);
  const directNames = Object.keys(lock.packages[''].dependencies);
  const directPaths = new Set(directNames.map((name) => `node_modules/${name}`));
  return measured({
    directDependencyCount: directNames.length,
    directNames,
    productionPackageInstances: packages.length,
    productionTransitiveInstances: packages.filter((p) => !directPaths.has(p.path)).length,
    uniqueProductionNames: new Set(packages.map((p) => p.name)).size,
    install: await diskTree(join(project, 'node_modules')),
    packages,
    mandatoryPg: {
      declared: mandatoryPg,
      installed: packages.some((p) => p.name === 'pg'),
      unrelatedToSelectedEngine: mandatoryPg && !['postgres', 'serverless', 'core', 'notification-hub'].includes(profile),
    },
  });
}

async function runtime(project, options, evidence, name) {
  await writeFile(join(project, 'probe.mjs'), runtimeProbe);
  const samples = [];
  for (let i = 0; i < options.iterations; i++) {
    const file = join(evidence, `runtime-${i}.json`);
    const result = await logged(
      process.execPath,
      ['probe.mjs', file],
      { cwd: project, timeoutMs: options.timeoutMs },
      evidence,
      `runtime-${i}`,
    );
    if (result.status !== 'measured')
      return { ...result, reason: 'Cold import/init failed; see runtime logs', samples };
    samples.push(await json(file));
  }
  return measured({
    samples,
    initialization:
      samples[0].initMs === null
        ? unavailable(definitions.profiles[name].initialization)
        : measured({ scope: definitions.profiles[name].initialization }),
    process: 'Fresh Node process per sample; OS filesystem cache is not flushed',
    importScope: 'Complete profile entry including explicitly imported driver',
    initScope: definitions.profiles[name].initialization,
    cleanupScope: 'Cleanup excluded from initialization time; included in process peak RSS',
  });
}

async function importedGraph(project, options, evidence, cliBin) {
  const coverageDir = join(evidence, 'v8-coverage');
  await mkdir(coverageDir);
  const result = await logged(
    process.execPath,
    cliBin ? [cliBin, '--help'] : ['probe.mjs', join(evidence, 'instrumented-runtime.json')],
    { cwd: project, timeoutMs: options.timeoutMs, env: { NODE_V8_COVERAGE: coverageDir } },
    evidence,
    'import-graph',
  );
  if (result.status !== 'measured') return { ...result, reason: 'Instrumented import/init failed' };
  const paths = new Set();
  for (const file of await readdir(coverageDir)) {
    for (const script of (await json(join(coverageDir, file))).result) {
      if (!script.url.startsWith('file:')) continue;
      const path = fileURLToPath(script.url);
      if (path.startsWith(`${join(project, 'node_modules')}${sep}`)) paths.add(path);
    }
  }
  const modules = [];
  for (const path of [...paths].sort()) {
    const content = await readFile(path);
    modules.push({ path: relative(project, path), bytes: content.length, sha256: sha256(content) });
  }
  if (!modules.length) return failed('V8 coverage returned no consumer package modules');
  return measured({
    moduleCount: modules.length,
    fileBytes: modules.reduce((sum, m) => sum + m.bytes, 0),
    modules,
    entry: cliBin ? 'Installed turbine executable --help' : 'Profile entry import/init',
    scope:
      'V8-observed imported JavaScript source files during import/init; excludes builtins, native code, JSON, unvisited dynamic edges; not executed bytes or bundle bytes',
  });
}

async function bundle(project, evidence, cliBin) {
  let esbuild;
  let version;
  try {
    const require = createRequire(import.meta.url);
    esbuild = await import(pathToFileURL(require.resolve('esbuild')).href);
    version = esbuild.version;
  } catch {
    return unavailable(
      'esbuild is not installed in the runner checkout; install existing dev tooling to measure bundles',
    );
  }
  try {
    const result = await esbuild.build({
      absWorkingDir: project,
      entryPoints: [cliBin ?? 'entry.mjs'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'cjs',
      target: `node${process.versions.node.split('.')[0]}`,
      minify: true,
      outfile: 'bundle.cjs',
      logLevel: 'silent',
      // pg-native is an optional acceleration path, absent from these standard-driver profiles.
      external: ['pg-native'],
    });
    const output = result.outputFiles[0].contents;
    await writeFile(join(evidence, 'bundle.cjs'), output);
    await save(join(evidence, 'bundle-metafile.json'), result.metafile);
    const externals = [
      ...new Set(
        Object.values(result.metafile.outputs)
          .flatMap((o) => o.imports)
          .filter((i) => i.external)
          .map((i) => i.path),
      ),
    ];
    const nonBuiltinExternals = externals.filter((p) => !p.startsWith('node:') && !builtinModules.includes(p));
    const complete = nonBuiltinExternals.every((p) => p === 'pg-native');
    return measured({
      esbuildVersion: version,
      configuration: {
        platform: 'node',
        format: 'cjs',
        minify: true,
        target: `node${process.versions.node.split('.')[0]}`,
        conditions: 'esbuild Node defaults',
      },
      bytes: output.length,
      gzipBytes: gzipSync(output).length,
      brotliBytes: brotliCompressSync(output).length,
      reachableInputs: Object.keys(result.metafile.inputs).length,
      reachableInputBytes: Object.values(result.metafile.inputs).reduce((sum, i) => sum + i.bytes, 0),
      externals,
      nonBuiltinExternals,
      allRequiredDriverJavaScriptBundled: complete,
      completeBundle: complete
        ? measured({ excludes: 'Node builtins/native runtime and absent optional pg-native' })
        : unavailable(
            'Additional external edges remain: emitted artifact bytes are partial, not a complete consumer bundle cost',
          ),
      scope:
        'Minified Node CJS artifact. Check completeBundle before interpreting bytes; builtins/native runtime excluded; absent optional pg-native external. Artifact size only, not executable validation or an edge-runtime claim.',
    });
  } catch (error) {
    await writeFile(join(evidence, 'bundle-error.txt'), String(error));
    return unavailable('Bundle could not be produced; see bundle-error.txt (never substitute zero)');
  }
}

export async function compileConsumer(project, evidence, { timeoutMs = 120000, compilerHeapMb = 2048 } = {}) {
  const tsc = join(project, 'node_modules/typescript/bin/tsc');
  if (!existsSync(tsc)) return unavailable('Consumer-local TypeScript is missing');
  const resourceFile = join(evidence, 'compiler-resource.json');
  // A killed repeat must not inherit an earlier successful compiler's resources.
  await rm(resourceFile, { force: true });
  await writeFile(join(project, 'monitor.mjs'), processMonitor);
  const result = await logged(
    process.execPath,
    [
      `--max-old-space-size=${compilerHeapMb}`,
      '--import',
      './monitor.mjs',
      tsc,
      '-p',
      'tsconfig.json',
      '--extendedDiagnostics',
    ],
    { cwd: project, timeoutMs, observeResources: true, env: { CONSUMER_COST_RESOURCE_FILE: resourceFile } },
    evidence,
    'typecheck',
  );
  return {
    ...result,
    resources: existsSync(resourceFile)
      ? await json(resourceFile)
      : unavailable('Compiler killed before exit; peak RSS not available'),
    compilerVersion: (await json(join(project, 'node_modules/typescript/package.json'))).version,
    compilerHeapMb,
    memoryBound: 'V8 old-space limit only, not total RSS or a host memory limit',
  };
}

async function compilerConfig(project) {
  await writeFile(
    join(project, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          incremental: false,
          types: ['node'],
        },
        include: ['generated/**/*.ts', 'consumer.ts'],
      },
      null,
      2,
    ),
  );
}

async function publicEntryTypes(name, project, options, evidence) {
  const source = profileTypeSource(name);
  if (!source) return null;
  const setup = await install(['ci', '--include=dev'], options, project, options.scratch, evidence, 'tools-install');
  if (setup.status !== 'measured') return { ...setup, reason: 'Isolated compiler tooling install failed' };
  await compilerConfig(project);
  await writeFile(join(project, 'consumer.ts'), source);
  for (const file of ['consumer.ts', 'tsconfig.json']) await copyFile(join(project, file), join(evidence, file));
  return {
    ...(await compileConsumer(project, evidence, options)),
    scope: 'Strict public entry declarations and negative type assertions; no native execution',
    consumerSha256: sha256(source),
  };
}

async function behavior(name, project, options, evidence) {
  const source = profileBehaviorSource(name);
  if (!source) return null;
  await writeFile(join(project, 'behavior.mjs'), source);
  await copyFile(join(project, 'behavior.mjs'), join(evidence, 'behavior.mjs'));
  return {
    ...(await logged(
      process.execPath,
      ['behavior.mjs'],
      { cwd: project, timeoutMs: options.timeoutMs },
      evidence,
      'behavior',
    )),
    sourceSha256: sha256(source),
    scope: 'Separate untimed public behavior/refusal checks; local libSQL opens native memory clients for ownership/cleanup checks; no external service or seed execution',
  };
}

async function typeScale(project, options, evidence) {
  const setup = await install(['ci', '--include=dev'], options, project, options.scratch, evidence, 'tools-install');
  if (setup.status !== 'measured') return { ...setup, reason: 'Isolated compiler tooling install failed' };
  await compilerConfig(project);
  const cases = [];
  for (const tables of options.sizes) {
    const dir = join(evidence, `tables-${tables}`);
    await mkdir(dir);
    const schema = syntheticSchema(tables);
    // Sets need a deterministic encoding in the evidence, restored in the generator child.
    await save(join(project, 'schema.json'), schema);
    await copyFile(join(project, 'schema.json'), join(dir, 'schema.json'));
    await writeFile(
      join(project, 'generate.mjs'),
      `import { readFileSync } from 'node:fs';
import { generate } from 'turbine-orm';
const schema = JSON.parse(readFileSync('schema.json', 'utf8'));
for (const table of Object.values(schema.tables)) table.dateColumns = new Set(['created_at']);
generate({ schema, outDir: './generated', noTimestamp: true, importExtension: 'js' });
`,
    );
    const generation = await logged(
      process.execPath,
      ['generate.mjs'],
      { cwd: project, timeoutMs: options.timeoutMs },
      dir,
      'generate',
    );
    if (generation.status !== 'measured') {
      cases.push({ tables, status: generation.status, generation });
      await save(join(evidence, 'type-scale-progress.json'), { cases });
      continue;
    }
    await writeFile(join(project, 'consumer.ts'), consumerTypeSource(tables));
    const fixtureFiles = [
      'generated/index.ts',
      'generated/types.ts',
      'generated/metadata.ts',
      'consumer.ts',
      'tsconfig.json',
      'generate.mjs',
    ];
    const hashes = {};
    const fixtureBytes = {};
    for (const file of fixtureFiles) {
      const content = await readFile(join(project, file));
      hashes[file] = sha256(content);
      fixtureBytes[file] = content.length;
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), content);
    }
    const result = await compileConsumer(project, dir, options);
    cases.push({
      tables,
      ...result,
      fixtureSha256: hashes,
      fixtureBytes,
      generatedBytes: Object.entries(fixtureBytes)
        .filter(([file]) => file.startsWith('generated/'))
        .reduce((sum, [, bytes]) => sum + bytes, 0),
      generation,
    });
    await save(join(evidence, 'type-scale-progress.json'), { cases });
    console.log(
      `Generated ${tables} tables: compiler ${result.status}, ${cases.at(-1).generatedBytes} generated bytes`,
    );
  }
  return {
    status: cases.every((c) => c.status === 'measured') ? 'measured' : 'failed',
    target:
      'Generated PostgreSQL client; every table queried with nested relations and exact numeric result assertions',
    tools: {
      typescript: (await json(join(project, 'node_modules/typescript/package.json'))).version,
      nodeTypes: (await json(join(project, 'node_modules/@types/node/package.json'))).version,
    },
    cases,
  };
}

function parse(argv) {
  const options = {
    profiles: Object.keys(definitions.profiles),
    sizes: [5],
    iterations: 3,
    timeoutMs: 120000,
    compilerHeapMb: 2048,
    cache: join(homedir(), '.npm'),
    allowNetwork: false,
    keepWork: false,
  };
  const valued = {
    '--tarball': 'tarball',
    '--prepare-locks': 'prepareLocks',
    '--locks': 'locks',
    '--out': 'out',
    '--source-ref': 'sourceRef',
    '--profiles': 'profiles',
    '--sizes': 'sizes',
    '--iterations': 'iterations',
    '--timeout-ms': 'timeoutMs',
    '--compiler-heap-mb': 'compilerHeapMb',
    '--cache': 'cache',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-network') options.allowNetwork = true;
    else if (arg === '--keep-work') options.keepWork = true;
    else if (arg === '--help' || arg === '--list') options.help = arg;
    else if (valued[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[valued[arg]] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  options.profiles = typeof options.profiles === 'string' ? options.profiles.split(',') : options.profiles;
  for (const name of options.profiles)
    if (!definitions.profiles[name]) throw new Error(`Unknown consumer profile: ${name}`);
  if (new Set(options.profiles).size !== options.profiles.length) throw new Error('Duplicate profiles');
  options.sizes = typeof options.sizes === 'string' ? options.sizes.split(',').map(Number) : options.sizes;
  if (options.sizes.some((n) => !Number.isSafeInteger(n) || n < 2 || n > 10000))
    throw new Error('Sizes must be integers in [2, 10000]');
  if (new Set(options.sizes).size !== options.sizes.length) throw new Error('Duplicate sizes');
  for (const key of ['iterations', 'timeoutMs', 'compilerHeapMb']) {
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!options.tarball) throw new Error('--tarball is required (build and pack the candidate separately)');
  if (Boolean(options.prepareLocks) === Boolean(options.locks))
    throw new Error('Use exactly one of --prepare-locks or --locks');
  if (options.locks && !options.out) throw new Error('--out is required for measurement evidence');
  for (const key of ['tarball', 'prepareLocks', 'locks', 'out', 'cache'])
    if (options[key]) options[key] = resolve(options[key]);
  return options;
}

async function prepareLocks(options, candidate, scratch) {
  await mkdir(options.prepareLocks); // Never overwrite an existing lock campaign.
  const meta = {
    schemaVersion: 1,
    candidateSha256: candidate.tarballSha256,
    definitionsSha256: sha256(await readFile(join(root, 'tooling/consumer-cost/profiles.json'))),
    profiles: {},
  };
  for (const name of options.profiles) {
    const project = join(scratch, name);
    const evidence = join(options.prepareLocks, name);
    await mkdir(project);
    await mkdir(evidence);
    await copyFile(options.tarball, join(project, 'candidate.tgz'));
    await save(join(project, 'package.json'), {
      name: `consumer-cost-${name}`,
      private: true,
      type: 'module',
      dependencies: { 'turbine-orm': 'file:./candidate.tgz', ...definitions.profiles[name].drivers },
      devDependencies: definitions.tools,
    });
    const result = await install(
      ['install', '--package-lock-only', '--include=dev'],
      options,
      project,
      scratch,
      evidence,
      'lock',
    );
    if (result.status !== 'measured') throw new Error(`Lock preparation failed for ${name}; evidence: ${evidence}`);
    for (const file of ['package.json', 'package-lock.json']) await copyFile(join(project, file), join(evidence, file));
    const lock = await json(join(evidence, 'package-lock.json'));
    if (lock.lockfileVersion !== 3) throw new Error('npm lockfile v3 is required');
    meta.profiles[name] = {
      lockSha256: sha256(await readFile(join(evidence, 'package-lock.json'))),
      manifestSha256: sha256(await readFile(join(evidence, 'package.json'))),
    };
    await save(join(options.prepareLocks, 'locks.json'), meta);
  }
  return meta;
}

async function runProfile(name, options, candidate, lockMeta, scratch) {
  const evidence = join(options.out, name);
  await mkdir(evidence);
  const project = join(scratch, name);
  await mkdir(project);
  const locked = lockMeta.profiles[name];
  if (!locked) return unavailable(`Profile ${name} is missing from the prepared locks`);
  for (const [file, expected] of [
    ['package.json', locked.manifestSha256],
    ['package-lock.json', locked.lockSha256],
  ]) {
    const content = await readFile(join(options.locks, name, file));
    if (sha256(content) !== expected) return failed(`Saved ${name}/${file} hash mismatch`);
    await writeFile(join(project, file), content);
    await writeFile(join(evidence, file), content);
  }
  await copyFile(options.tarball, join(project, 'candidate.tgz'));
  await writeFile(join(project, 'entry.mjs'), profileSource(name));
  await copyFile(join(project, 'entry.mjs'), join(evidence, 'entry.mjs'));
  const installation = await install(['ci', '--omit=dev'], options, project, scratch, evidence, 'production-install');
  if (installation.status !== 'measured') return { ...installation, reason: 'Production install failed; see logs' };
  const productionInventory = await inventory(project, await json(join(project, 'package-lock.json')), name, candidate);
  const installed = await json(join(project, 'node_modules/turbine-orm/package.json'));
  const entry = definitions.profiles[name].entry;
  const subpath = entry === 'turbine-orm' ? '.' : `.${entry.slice('turbine-orm'.length)}`;
  if (!installed.exports?.[subpath])
    return {
      status: 'unavailable',
      installation,
      inventory: productionInventory,
      reason: `Packed candidate does not expose the public ${subpath} entry`,
    };
  if (name === 'sqlite' && !builtinModules.includes('node:sqlite') && !builtinModules.includes('sqlite')) {
    return {
      status: 'unavailable',
      installation,
      inventory: productionInventory,
      reason: 'Native node:sqlite is unavailable on this Node version; no substitute adapter was measured',
    };
  }
  let cliBin;
  if (name === 'cli') {
    const pkg = await json(join(project, 'node_modules/turbine-orm/package.json'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.turbine;
    const absolute = bin ? resolve(project, 'node_modules/turbine-orm', bin) : '';
    if (absolute.startsWith(`${join(project, 'node_modules/turbine-orm')}${sep}`)) cliBin = absolute;
  }
  const result = {
    definition: definitions.profiles[name],
    installation,
    inventory: productionInventory,
    runtime: await runtime(project, options, evidence, name),
    importedGraph: await importedGraph(project, options, evidence, cliBin),
    bundle: await bundle(project, evidence, cliBin),
  };
  if (profileBehaviorSource(name)) {
    result.behavior = await behavior(name, project, options, evidence);
    result.publicTypes = await publicEntryTypes(name, project, { ...options, scratch }, evidence);
  }
  if (name === 'cli') {
    if (!cliBin) result.cliStartup = unavailable('No safe public turbine executable');
    else
      result.cliStartup = await logged(
        process.execPath,
        [cliBin, '--help'],
        { cwd: project, timeoutMs: options.timeoutMs },
        evidence,
        'cli-help',
      );
  }
  if (name === 'postgres') result.typeScale = await typeScale(project, { ...options, scratch }, evidence);
  result.status = Object.values(result).some((v) => ['failed', 'timeout', 'resource-exhausted'].includes(v?.status))
    ? 'failed'
    : Object.values(result).some((v) => v?.status === 'unavailable')
      ? 'unavailable'
      : 'measured';
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--compare')) {
    const { compareConsumers } = await import('../tooling/consumer-cost/compare.mjs');
    return compareConsumers(argv, { command, compileConsumer, packedMetadata });
  }
  const options = parse(argv);
  if (options.help) {
    console.log(
      options.help === '--list'
        ? JSON.stringify(definitions, null, 2)
        : `Consumer cost measurement (no database query benchmarks; local libSQL admission probe only)
Prepare immutable locks: node scripts/measure-consumer-cost.mjs --tarball candidate.tgz --prepare-locks /tmp/locks [--allow-network]
Replay: node scripts/measure-consumer-cost.mjs --tarball candidate.tgz --locks /tmp/locks --out /tmp/evidence
Options: --profiles ${Object.keys(definitions.profiles).join(',')} --sizes 5 (campaign: 100,500,1000)
         --iterations 3 --timeout-ms 120000 --compiler-heap-mb 2048 --keep-work --cache PATH --source-ref REF
Default installs are offline, scripts disabled. Existing output/lock directories are never overwritten.
Type scale runs on postgres only. See tooling/consumer-cost/README.md for scopes and limitations.`,
    );
    return 0;
  }
  const candidate = packedMetadata(await readFile(options.tarball));
  const scratch = await mkdtemp(join(tmpdir(), 'turbine-consumer-cost-'));
  await writeFile(join(scratch, 'empty.npmrc'), '');
  await writeFile(join(scratch, 'global.npmrc'), '');
  let retain = options.keepWork;
  try {
    if (options.prepareLocks) {
      await prepareLocks(options, candidate, scratch);
      console.log(`Locked ${options.profiles.length} profiles: ${options.prepareLocks}`);
      return 0;
    }
    const lockMeta = await json(join(options.locks, 'locks.json'));
    if (lockMeta.schemaVersion !== 1 || lockMeta.candidateSha256 !== candidate.tarballSha256)
      throw new Error('Candidate/lock identity mismatch; prepare new locks for this exact tarball');
    if (lockMeta.definitionsSha256 !== sha256(await readFile(join(root, 'tooling/consumer-cost/profiles.json'))))
      throw new Error('Profile definitions changed; prepare new locks');
    await mkdir(options.out);
    const npmVersion = await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { cwd: scratch });
    const report = {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      interpretation:
        'Uncalibrated local measurements. Concurrent smoke runs are correctness evidence, never performance leadership. No cross-ORM comparisons or CI thresholds.',
      environment: {
        node: process.version,
        childNodeEnv: 'production',
        versions: process.versions,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        npm: npmVersion.stdout.trim(),
        timing: 'Serial fresh child processes; filesystem cache and host contention uncontrolled',
      },
      runner: await sourceIdentity(),
      candidate: {
        ...candidate,
        sourceRef: options.sourceRef ?? null,
        sourceRefTrust: options.sourceRef ? 'Caller assertion; not independently verified' : 'unavailable',
      },
      options: {
        profiles: options.profiles,
        sizes: options.sizes,
        iterations: options.iterations,
        timeoutMs: options.timeoutMs,
        compilerHeapMb: options.compilerHeapMb,
        allowNetwork: options.allowNetwork,
      },
      profiles: {},
    };
    for (const name of options.profiles) {
      console.log(`Measuring ${name}...`);
      try {
        report.profiles[name] = await runProfile(name, options, candidate, lockMeta, scratch);
      } catch (error) {
        report.profiles[name] = failed(String(error));
      }
      if (report.profiles[name].status !== 'measured') retain = true;
      await save(join(options.out, 'report.json'), { ...report, retainedWork: retain ? scratch : null });
    }
    report.status = Object.values(report.profiles).some((p) =>
      ['failed', 'timeout', 'resource-exhausted'].includes(p.status),
    )
      ? 'failed'
      : Object.values(report.profiles).some((p) => p.status === 'unavailable')
        ? 'unavailable'
        : 'measured';
    report.finishedAt = new Date().toISOString();
    report.retainedWork = retain ? scratch : null;
    await save(join(options.out, 'report.json'), report);
    console.log(`Evidence: ${join(options.out, 'report.json')}`);
    if (retain) console.log(`Retained consumer projects: ${scratch}`);
    return report.status === 'measured' ? 0 : report.status === 'unavailable' ? 2 : 1;
  } finally {
    if (!retain) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`consumer-cost: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
