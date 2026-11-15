import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import pg from 'pg';
import { command } from '../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';
import { startService } from '../../scripts/service.mjs';
import { treeDigest, verifyPins } from '../../scripts/verify-pins.mjs';
import { packageEntries, readJson, saveJson, sha256, sourceIdentity, stagePackage } from './archive.mjs';
import { verifyBundle } from './verify.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
const candidate = resolve(here, '../..');
const sourceFiles = [
  'archive.mjs',
  'build.mjs',
  'verify.mjs',
  'driver.mjs',
  'driver.d.mts',
  'arm.ts',
  'entry.ts',
  'definition.ts',
  'type-controls.ts',
  'package.json',
  'package-lock.json',
];
const isWithin = (root, path) => path === root || path.startsWith(root + sep);

// All package resolution is explicit. A missing input cannot fall through to
// repository, parent, sibling, NODE_PATH, or global node_modules.
export function bundlePlugin(stage) {
  const builtins = new Set(builtinModules.flatMap((s) => [s, `node:${s}`]));
  return {
    name: 'pinned-inputs-only',
    setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (builtins.has(path)) return { path, external: true };
        if (path === 'turbine-orm') return { path: join(stage, 'node_modules/turbine-orm/dist/index.js') };
        if (path === '#pg' || path === 'pg') return { path: join(stage, 'driver.mjs') };
        if (!path.startsWith('.') && !isAbsolute(path)) throw new Error(`Non-frozen module refused: ${path}`);
        const target = resolve(importer ? dirname(importer) : stage, path);
        assert.ok(isWithin(stage, target), `Input escaped frozen staging: ${target}`);
        // Let esbuild map the generated .js specifiers to their .ts source.
        return undefined;
      });
    },
  };
}

async function bundle(stage, entryPoints, outfile) {
  const result = await build({
    absWorkingDir: stage,
    entryPoints,
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node26',
    packages: 'bundle',
    plugins: [bundlePlugin(stage)],
    metafile: true,
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'silent',
  });
  const inputs = {};
  for (const name of Object.keys(result.metafile.inputs)) {
    const path = resolve(stage, name);
    assert.ok(isWithin(stage, path), `Non-frozen bundle input: ${path}`);
    inputs[relative(stage, path)] = sha256(readFileSync(path));
  }
  const output = Object.values(result.metafile.outputs);
  assert.equal(output.length, 1, 'Single self-contained bundle required');
  for (const item of output[0].imports)
    assert.ok(item.external && item.path.startsWith('node:'), `Nonbuiltin output import: ${item.path}`);
  return { inputs, metafile: result.metafile, sha256: sha256(readFileSync(outfile)) };
}

export async function buildArm(options) {
  verifyPins();
  assert.equal(esbuildVersion, '0.28.2');
  assert.equal(readJson(join(here, 'node_modules/typescript/package.json')).version, '5.9.3');
  assert.match(options.label ?? '', /^[a-z0-9][a-z0-9-]{1,79}$/, 'Explicit artifact evidence label required');
  for (const key of ['artifact', 'artifact-sha256', 'source', 'source-identity', 'out', 'service-plan'])
    assert.ok(options[key], `--${key} required`);
  const archivePath = resolve(options.artifact);
  const archiveBytes = readFileSync(archivePath);
  const { entries, manifest } = packageEntries(archiveBytes, options['artifact-sha256']);
  const sourceEvidence = readFileSync(resolve(options['source-identity']));
  sourceIdentity(JSON.parse(sourceEvidence), options.source, options['artifact-sha256']);
  if (manifest.gitHead) assert.equal(manifest.gitHead, options.source, 'Archive gitHead/source mismatch');
  const sourceTree = execFileSync('git', ['rev-parse', `${options.source}^{tree}`], {
    cwd: candidate,
    encoding: 'utf8',
  }).trim();
  const out = resolve(options.out);
  assert.ok(!existsSync(out), 'Bundle output must be NEW; immutable outputs cannot be overwritten');
  const plan = readJson(resolve(options['service-plan']));
  assert.equal(plan.format, 1);
  assert.ok(!existsSync(join(plan.root, 'data')), 'New owned preparatory cluster required');
  assert.ok(!existsSync(join(plan.out, 'report.json')), 'Service attempt already used');
  mkdirSync(out, { recursive: true });
  const stage = join(out, 'stage');
  mkdirSync(stage);
  copyFileSync(archivePath, join(out, 'turbine-orm.tgz'));
  writeFileSync(join(out, 'source-identity.json'), sourceEvidence, { flag: 'wx' });
  const packageFiles = stagePackage(entries, join(stage, 'node_modules/turbine-orm'));
  for (const file of ['arm.ts', 'entry.ts', 'definition.ts', 'driver.mjs', 'driver.d.mts', 'type-controls.ts'])
    copyFileSync(join(here, file), join(stage, file));
  saveJson(join(stage, 'package.json'), { private: true, type: 'module' });
  const identity = {
    format: 1,
    label: options.label,
    status: 'building',
    artifact: {
      path: join(out, 'turbine-orm.tgz'),
      originalPath: archivePath,
      sha256: options['artifact-sha256'],
      version: manifest.version,
    },
    sourceCommit: options.source,
    sourceTree,
    provenance: {
      kind: 'retained-operator-identity; not a reproducible-source-build proof',
      sha256: sha256(sourceEvidence),
    },
    runtime: {
      version: process.version,
      sha256: sha256(readFileSync(process.execPath)),
      platform: process.platform,
      arch: process.arch,
    },
    compiler: { typescript: '5.9.3', esbuild: esbuildVersion },
    builderDependencies: Object.fromEntries(
      Object.keys(readJson(join(here, 'package-lock.json')).packages)
        .filter((p) => p && existsSync(join(here, p)))
        .sort()
        .map((p) => [p, treeDigest(join(here, p))]),
    ),
    builderInputs: Object.fromEntries(sourceFiles.map((f) => [f, sha256(readFileSync(join(here, f)))])),
    canonicalInputs: Object.fromEntries(['canonical', 'fixture'].map((d) => [d, treeDigest(join(candidate, d))])),
    packageFiles,
  };
  const generatorSource = `import { introspect, generate } from 'turbine-orm';\nimport { dirname } from 'node:path';\nimport { installDriver } from './driver.mjs';\nexport async function generateFixture(pool, connectionString, outDir) {\n installDriver(pool, process.version, 'pg@8.22.0');\n const schema = await introspect({ connectionString, schema: 'public', logger: {} });\n const previous = process.cwd();\n try {\n  process.chdir(dirname(outDir));\n  generate({ schema, outDir, noTimestamp: true, importExtension: 'js' });\n } finally { process.chdir(previous); }\n return schema;\n}\n`;
  const generatorPath = join(stage, 'generator.mjs');
  writeFileSync(generatorPath, generatorSource, { flag: 'wx' });
  identity.generator = await bundle(stage, ['generator.mjs'], join(out, 'generator.mjs'));
  const generator = await import(pathToFileURL(join(out, 'generator.mjs')).href);
  const report = { commands: [], services: [], label: options.label, timing: 'unavailable' };
  await runWithShutdown(report, join(plan.out, 'report.json'), async (scope) => {
    const service = await startService(plan, report, scope);
    await command(
      report,
      candidate,
      process.execPath,
      [join(candidate, 'dist/canonical/seed-neon.js')],
      {
        ...process.env,
        DATABASE_URL: service.url,
        USERS: '1000',
        POSTS_PER_USER: '10',
        COMMENTS_PER_POST: '5',
        WIDE_ROWS: '2000',
        TZ: 'UTC',
        NODE_PATH: '',
        NODE_OPTIONS: '',
      },
      { scope, timeoutMs: 60000 },
    );
    const pool = new pg.Pool({ connectionString: service.url, max: 1 });
    scope.registerStop(() => pool.end());
    const schema = await generator.generateFixture(pool, service.url, join(stage, 'generated'));
    saveJson(join(out, 'introspected-schema.json'), schema);
    identity.schemaSha256 = sha256(readFileSync(join(out, 'introspected-schema.json')));
    identity.generatedFiles = Object.fromEntries(
      readdirSync(join(stage, 'generated'))
        .sort()
        .map((f) => [f, sha256(readFileSync(join(stage, 'generated', f)))]),
    );
  });
  assert.equal(report.success, true, 'Preparatory service must succeed and clean up');
  // The strict compile consumes declarations and generated types from THIS
  // archive. It cannot see repository declarations or generated overlays.
  saveJson(join(stage, 'tsconfig.json'), {
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      typeRoots: [join(here, 'node_modules/@types')],
      types: ['node'],
    },
    include: ['arm.ts', 'entry.ts', 'definition.ts', 'type-controls.ts', 'generated/**/*.ts'],
  });
  try {
    execFileSync(
      process.execPath,
      [join(here, 'node_modules/typescript/bin/tsc'), '-p', join(stage, 'tsconfig.json')],
      { encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } },
    );
  } catch (error) {
    throw new Error(`Archive-generated strict typecheck failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`, {
      cause: error,
    });
  }
  identity.module = {
    path: join(out, 'turbine-arm.mjs'),
    ...(await bundle(stage, ['entry.ts'], join(out, 'turbine-arm.mjs'))),
  };
  const arm = await import(pathToFileURL(identity.module.path).href);
  identity.policy = arm.policy;
  identity.supported = arm.supported;
  identity.status = 'built';
  identity.serviceEvidence = {
    path: join(plan.out, 'report.json'),
    sha256: sha256(readFileSync(join(plan.out, 'report.json'))),
  };
  saveJson(join(out, 'identity.json'), identity);
  const pin = {
    name: 'Turbine',
    version: manifest.version,
    driver: 'pg@8.22.0',
    implementationKind: 'typed-orm',
    sourceCommit: options.source,
    artifact: { path: identity.artifact.path, sha256: identity.artifact.sha256 },
    module: { path: identity.module.path, sha256: identity.module.sha256 },
    supported: [...arm.supported],
  };
  saveJson(join(out, 'comparators.json'), { format: 1, arms: [pin] });
  verifyBundle(out);
  for (const file of [
    'turbine-orm.tgz',
    'turbine-arm.mjs',
    'identity.json',
    'comparators.json',
    'source-identity.json',
  ])
    chmodSync(join(out, file), 0o444);
  return { comparators: join(out, 'comparators.json'), identity: join(out, 'identity.json'), label: options.label };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let n = 2; n < process.argv.length; n += 2) {
    const name = process.argv[n].replace(/^--/, '');
    assert.ok(
      ['artifact', 'artifact-sha256', 'source', 'source-identity', 'out', 'service-plan', 'label'].includes(name),
      `Unknown option: ${name}`,
    );
    assert.ok(process.argv[n + 1] && !Object.hasOwn(options, name), `Missing/duplicate option: ${name}`);
    options[name] = process.argv[n + 1];
  }
  console.log(JSON.stringify(await buildArm(options)));
}
