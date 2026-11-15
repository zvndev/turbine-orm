import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [mode, label] = process.argv.slice(2);
assert.ok(['esm', 'cjs'].includes(mode));
assert.match(label, /^[a-z0-9-]+$/);
const root = process.cwd();
const require = createRequire(import.meta.url);
const orm = mode === 'esm' ? await import('turbine-orm') : require('turbine-orm');
const sqlite = mode === 'esm' ? await import('turbine-orm/sqlite') : require('turbine-orm/sqlite');
const pg = require('pg');
const compiler = process.env.BINARY_PROVENANCE_TSC;
assert.ok(compiler && process.env.BINARY_PROVENANCE_PG_URL);
const typesRoot = resolve(compiler, '../../../@types');
const ts = require(resolve(compiler, '../../lib/typescript.js'));
const evidence = join(root, label);
mkdirSync(evidence);
const report = { node: process.version, execPath: process.execPath, mode, label, compiler, compiles: [], engines: [] };
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
const reversed = Uint8Array.from(bytes).reverse();
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function clone(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.assign(
      Object.create(Object.getPrototypeOf(value)),
      Object.fromEntries(Reflect.ownKeys(value).map((key) => [key, clone(value[key])])),
    );
  }
  return value;
}
function refs(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  found.push(value);
  if (!(value instanceof Set)) for (const key of Reflect.ownKeys(value)) refs(value[key], found);
  return found;
}
function emit(schema, engine, name, extra = {}) {
  const before = clone(schema),
    references = refs(schema);
  const outDir = join(evidence, name);
  orm.generate({ schema, target: engine, outDir, noTimestamp: true, importExtension: 'js', ...extra });
  assert.deepEqual(schema, before);
  assert.deepEqual(
    refs(schema).map((item, i) => item === references[i]),
    references.map(() => true),
  );
  return { outDir, types: readFileSync(join(outDir, 'types.ts'), 'utf8') };
}
function compile(engine, generated, name, kind, expected) {
  const value =
    kind === 'native'
      ? engine === 'sqlite'
        ? 'new Uint8Array(Array.from({length:256},(_,i)=>i))'
        : 'Buffer.from(Array.from({length:256},(_,i)=>i))'
      : '{ id: 42, title: "plain entity" }';
  const relative = './' + generated.outDir.slice(evidence.length + 1);
  let source = `import type {Asset,AssetCreateInput,AssetUpdateInput,AssetWhereUnique} from '${relative}/types.js';
import type {TurbineClient} from '${relative}/index.js';
const value=${value};
const row:Asset={id:1,data:value,optional:null${engine === 'postgresql' ? ',many:null' : ''}};
const create:AssetCreateInput={id:2,data:value};
const update:AssetUpdateInput={data:value};
const unique:AssetWhereUnique={data:value};
declare const db:TurbineClient;
void db.assets.findMany({where:{data:value}});
void db.assets.findUnique({where:{data:value}});
void db.assets.create({data:{id:3,data:value}});
void db.assets.update({where:{id:1},data:{data:value}});
void db.$transaction(async tx=>{
 await tx.assets.create({data:{id:4,data:value}});
 await tx.assets.update({where:{id:1},data:{data:value}});
 return tx.assets.findMany({where:{data:value}});
});
void [row,create,update,unique];
`;
  if (engine === 'postgresql' && kind === 'native' && expected === 0) {
    source += `const arrayRow:Asset={id:8,data:value,optional:null,many:[value]};
const arrayCreate:AssetCreateInput={id:8,data:value,many:[value]};
const arrayUpdate:AssetUpdateInput={many:[value]};
void [arrayRow,arrayCreate,arrayUpdate];\n`;
  }
  if (engine === 'postgresql' && kind === 'model' && expected === 2)
    source += "const badArray:Asset['many']=[value];\n";
  const usage = join(evidence, name + '.ts'),
    config = join(evidence, name + '.json');
  writeFileSync(usage, source);
  writeFileSync(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: false,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2023',
          types: ['node'],
          typeRoots: [typesRoot],
          rootDir: evidence,
          outDir: join(evidence, 'build-' + name),
        },
        files: [usage],
      },
      null,
      2,
    ),
  );
  const args = [compiler, '-p', config, '--listFiles'];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000 });
  writeFileSync(join(evidence, name + '.stdout'), result.stdout || '');
  writeFileSync(join(evidence, name + '.stderr'), result.stderr || '');
  report.compiles.push({
    name,
    engine,
    kind,
    expected,
    status: result.status,
    signal: result.signal,
    binary: process.execPath,
    args,
    source,
    sourceSha256: sha(usage),
    configSha256: sha(config),
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, expected, name + '\n' + result.stdout + result.stderr);
  if (expected === 2) {
    for (const line of [4, 5, 6, 7, 10, 11, 12, 14, 15])
      assert.match(result.stdout, new RegExp(`${name}\\.ts\\(${line},`));
    if (engine === 'sqlite') assert.match(result.stdout, new RegExp(`${name}\\.ts\\(9,`));
  }
  return join(evidence, 'build-' + name, generated.outDir.slice(evidence.length + 1));
}
function data(schema) {
  return schema.tables.assets.columns.find((col) => col.name === 'data');
}
async function contracts(schema, engine) {
  const tag = engine === 'sqlite' ? 'Uint8Array' : 'Buffer';
  const marked = emit(schema, engine, engine + '-marked');
  assert.match(marked.types, new RegExp(`data: globalThis\\.${tag};`));
  const built = compile(engine, marked, engine + '-native', 'native', 0);
  compile(engine, marked, engine + '-model', 'model', 2);
  const runtime =
    mode === 'esm' ? await import(pathToFileURL(join(built, 'index.js'))) : require(join(built, 'index.js'));
  const loaded =
    mode === 'esm' ? await import(pathToFileURL(join(built, 'metadata.js'))) : require(join(built, 'metadata.js'));
  assert.equal(data(loaded.SCHEMA).inferredBinaryType, tag);
  const regenerated = emit(loaded.SCHEMA, engine, engine + '-regenerated');
  assert.equal(regenerated.types, marked.types);
  compile(engine, regenerated, engine + '-roundtrip-native', 'native', 0);
  const rehydrated = JSON.parse(
    JSON.stringify(schema, (_key, value) => (value instanceof Set ? { set: [...value] } : value)),
    (_key, value) => (value && typeof value === 'object' && Object.hasOwn(value, 'set') ? new Set(value.set) : value),
  );
  assert.equal(emit(rehydrated, engine, engine + '-json').types, marked.types);
  assert.equal(emit(orm.withDbFieldNames(schema), engine, engine + '-copied').types, marked.types);
  const legacy = clone(schema);
  for (const table of Object.values(legacy.tables)) for (const col of table.columns) delete col.inferredBinaryType;
  const legacyOutput = emit(legacy, engine, engine + '-legacy');
  assert.match(legacyOutput.types, new RegExp(`data: ${tag};`));
  compile(engine, legacyOutput, engine + '-legacy-model', 'model', 0);
  compile(engine, legacyOutput, engine + '-legacy-bytes', 'native', 2);
  const override = emit(schema, engine, engine + '-override', { columnTypes: { 'assets.data': tag } });
  compile(engine, override, engine + '-override-model', 'model', 0);
  const declared = clone(schema);
  data(declared).declaredTsType = tag;
  const declaredOutput = emit(declared, engine, engine + '-declared');
  const ownedBuild = compile(engine, declaredOutput, engine + '-declared-model', 'model', 0);
  const owned =
    mode === 'esm'
      ? await import(pathToFileURL(join(ownedBuild, 'metadata.js')))
      : require(join(ownedBuild, 'metadata.js'));
  assert.equal(data(owned.SCHEMA).declaredTsType, tag);
  assert.equal(emit(owned.SCHEMA, engine, engine + '-declared-roundtrip').types, declaredOutput.types);
  const custom = clone(schema);
  data(custom).tsType = `${tag} & { readonly brand: 'owned' }`;
  assert.match(
    emit(custom, engine, engine + '-custom').types,
    /data: (?:Buffer|Uint8Array) & \{ readonly brand: 'owned' \};/,
  );
  let effects = 0;
  const sentinel = readFileSync(join(marked.outDir, 'types.ts'));
  for (const descriptor of [
    { value: 'Buffer; throw 1' },
    {
      value: {
        toString() {
          throw new Error('tag coercion');
        },
      },
    },
    {
      get() {
        effects++;
        return tag;
      },
    },
  ]) {
    const invalid = clone(schema);
    Object.defineProperty(data(invalid), 'inferredBinaryType', { ...descriptor, enumerable: true });
    assert.throws(
      () => orm.generate({ schema: invalid, target: engine, outDir: marked.outDir, keepColumnNames: true }),
      /inferredBinaryType/,
    );
    assert.deepEqual(readFileSync(join(marked.outDir, 'types.ts')), sentinel);
  }
  const inherited = clone(legacy);
  Object.setPrototypeOf(data(inherited), {
    get inferredBinaryType() {
      effects++;
      return tag;
    },
  });
  assert.match(emit(inherited, engine, engine + '-inherited').types, new RegExp(`data: ${tag};`));
  assert.equal(effects, 0);
  for (const [name, table] of Object.entries(schema.tables)) {
    for (const [i, col] of table.columns.entries()) {
      if (Object.hasOwn(col, 'inferredBinaryType'))
        legacy.tables[name].columns[i].inferredBinaryType = col.inferredBinaryType;
    }
  }
  assert.equal(emit(legacy, engine, engine + '-explicit-caller-opt-in').types, marked.types);
  return {
    runtime,
    generated: marked.outDir,
    compiled: built,
    roundTrip: true,
    legacyPreserved: true,
    callerOptIn: true,
    invalidHintEffects: effects,
  };
}
function expectBytes(value, expected) {
  assert.ok(value instanceof Uint8Array);
  assert.deepEqual([...value], [...expected]);
}
async function effects(db, engine, native) {
  expectBytes((await db.assets.findUnique({ where: { id: 1 } })).data, bytes);
  await db.assets.create({
    data: {
      id: 2,
      data: native(reversed),
      optional: native(bytes),
      ...(engine === 'postgresql' ? { many: [native(bytes), native(reversed)] } : {}),
    },
  });
  const unique = await db.assets.findUnique({ where: { data: native(reversed) } });
  assert.equal(unique.id, 2);
  expectBytes(unique.optional, bytes);
  if (engine === 'postgresql') {
    assert.equal(unique.many.length, 2);
    expectBytes(unique.many[0], bytes);
    expectBytes(unique.many[1], reversed);
  }
  const next = Uint8Array.from(bytes, (n) => n ^ 0x80);
  await db.assets.update({ where: { id: 1 }, data: { data: native(next), optional: null } });
  await db.$transaction(async (tx) => {
    await tx.assets.create({ data: { id: 3, data: native(bytes), optional: null } });
    await tx.assets.update({ where: { id: 2 }, data: { optional: null } });
    expectBytes((await tx.assets.findUnique({ where: { data: native(bytes) } })).data, bytes);
  });
  const rollback = new Error('rollback control');
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.assets.update({ where: { id: 3 }, data: { optional: native(reversed) } });
      throw rollback;
    }),
    (error) => error === rollback,
  );
  const filtered = await db.assets.findMany({ where: { data: native(bytes) } });
  assert.deepEqual(
    filtered.map((row) => row.id),
    [3],
  );
  return {
    next,
    native,
    byteCount: 256,
    create: true,
    update: true,
    unique: true,
    transaction: true,
    rollback: true,
    filter: true,
  };
}
async function postgresCatalog(admin) {
  await admin.query(`CREATE DOMAIN binary_domain AS bytea; CREATE DOMAIN binary_array_domain AS bytea[];
    CREATE TABLE binary_declarations(id integer PRIMARY KEY, direct bytea, direct_array bytea[], domain_value binary_domain, domain_array binary_array_domain);
    CREATE VIEW binary_view AS SELECT * FROM binary_declarations;
    CREATE MATERIALIZED VIEW binary_materialized AS SELECT * FROM binary_declarations;
    CREATE SCHEMA binary_custom; CREATE TYPE binary_custom.bytea AS ENUM ('one','two');
    CREATE TYPE binary_custom."Buffer" AS ENUM ('one','two');
    CREATE TABLE binary_custom.custom_types(id integer, named_bytea binary_custom.bytea, named_buffer binary_custom."Buffer");`);
  const original = pg.Pool.prototype.query,
    calls = [];
  pg.Pool.prototype.query = function (...args) {
    calls.push({ sql: args[0], binds: args[1] });
    return Reflect.apply(original, this, args);
  };
  let schema;
  try {
    schema = await orm.introspect({ connectionString: process.env.BINARY_PROVENANCE_PG_URL, includeViews: true });
  } finally {
    pg.Pool.prototype.query = original;
  }
  assert.equal(calls.length, 11);
  const columns = calls.find(
    (call) => typeof call.sql === 'string' && call.sql.includes('FROM information_schema.columns'),
  );
  assert.match(columns.sql, /udt_schema,\s+domain_name,\s+data_type,/);
  assert.deepEqual(columns.binds, ['public']);
  for (const name of ['binary_declarations', 'binary_view', 'binary_materialized']) {
    const table = schema.tables[name];
    assert.ok(table);
    assert.deepEqual(
      table.columns.map((col) => col.inferredBinaryType),
      [undefined, 'Buffer', 'Buffer', undefined, undefined],
    );
    for (const col of table.columns) assert.equal(Object.hasOwn(col, 'domain_name'), false);
  }
  const filtered = await orm.introspect({
    connectionString: process.env.BINARY_PROVENANCE_PG_URL,
    includeViews: true,
    include: ['assets'],
  });
  assert.deepEqual(Object.keys(filtered.tables), ['assets']);
  const custom = await orm.introspect({
    connectionString: process.env.BINARY_PROVENANCE_PG_URL,
    schema: 'binary_custom',
  });
  assert.equal(custom.tables.custom_types.columns.length, 3);
  assert.ok(custom.tables.custom_types.columns.every((col) => !Object.hasOwn(col, 'inferredBinaryType')));
  // A fresh role checks the existing information_schema visibility boundary.
  await admin.query(
    'CREATE ROLE binary_limited LOGIN; GRANT USAGE ON SCHEMA public TO binary_limited; GRANT SELECT ON assets TO binary_limited',
  );
  const limitedUrl = new URL(process.env.BINARY_PROVENANCE_PG_URL);
  limitedUrl.username = 'binary_limited';
  const limited = await orm.introspect({ connectionString: limitedUrl.href });
  assert.deepEqual(Object.keys(limited.tables), ['assets']);
  assert.equal(data(limited).inferredBinaryType, 'Buffer');
  return {
    filtered,
    queryCount: calls.length,
    queries: calls,
    domainsExcluded: true,
    ordinaryView: true,
    materializedView: true,
    customEnumsUnmarked: true,
    permissionVisibility: true,
  };
}
async function uniqueProjectionContracts(schema, engine, nativeHandle) {
  const tag = engine === 'sqlite' ? 'Uint8Array' : 'Buffer';
  const nativeValue = engine === 'sqlite' ? 'new Uint8Array([0,127,255])' : 'Buffer.from([0,127,255])';
  const getColumn = (input) => input.tables.assets.columns.find((col) => col.name === 'raw_data');
  const native = (value) => (engine === 'sqlite' ? value : Buffer.from(value));
  function compileProbe(name, source, expected) {
    const usage = join(evidence, name + '.ts');
    const config = join(evidence, name + '.json');
    const build = join(evidence, 'build-' + name);
    writeFileSync(usage, source);
    writeFileSync(
      config,
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes: true,
            skipLibCheck: false,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2023',
            types: ['node'],
            typeRoots: [typesRoot],
            rootDir: evidence,
            outDir: build,
          },
          files: [usage],
        },
        null,
        2,
      ),
    );
    const args = [compiler, '-p', config, '--listFiles'];
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000 });
    writeFileSync(usage + '.stdout', result.stdout || '');
    writeFileSync(usage + '.stderr', result.stderr || '');
    report.compiles.push({
      name,
      expected,
      status: result.status,
      signal: result.signal,
      binary: process.execPath,
      args,
      source,
      sourceSha256: sha(usage),
      configSha256: sha(config),
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.equal(result.status, expected, name + '\n' + result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /TS2307/);
    if (expected === 2) assert.match(result.stdout, /error TS/);
    return build;
  }
  const routes = [];
  for (const [routeIndex, route] of ['direct', 'copied', 'keep'].entries()) {
    const input = clone(schema);
    const marked = input.tables.assets.columns.filter((col) => Object.hasOwn(col, 'inferredBinaryType'));
    for (const col of marked) {
      Object.defineProperty(col, 'inferredBinaryType', {
        value: tag,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      Object.freeze(col);
    }
    const before = marked.map((col) => Object.getOwnPropertyDescriptors(col));
    const chosen = route === 'copied' ? orm.withDbFieldNames(input) : input;
    const name = engine + '-unique-' + route;
    const outDir = join(evidence, name);
    orm.generate({
      schema: chosen,
      target: engine,
      outDir,
      noTimestamp: true,
      importExtension: 'js',
      keepColumnNames: route === 'keep',
    });
    const field = route === 'direct' ? getColumn(input).field : 'raw_data';
    const types = readFileSync(join(outDir, 'types.ts'), 'utf8');
    const unique = /export type AssetWhereUnique = ([^\n]+);/.exec(types)?.[1];
    assert.ok(unique?.includes(`{ ${field}: globalThis.${tag} }`), unique);
    if (engine === 'postgresql') assert.ok(unique.includes('{ many: globalThis.Buffer[] }'), unique);
    for (const [i, col] of marked.entries()) assert.deepEqual(Object.getOwnPropertyDescriptors(col), before[i]);
    const imports = `import type {Asset,AssetCreateInput,AssetUpdateInput,AssetWhereUnique} from './${name}/types.js';\nimport type {TurbineClient} from './${name}/index.js';\n`;
    compileProbe(
      name + '-row',
      imports +
        `const value=${nativeValue};\nconst row:Asset={id:1,${field}:value${engine === 'postgresql' ? ',many:null' : ''}};\nconst create:AssetCreateInput={id:2,${field}:value};\nconst update:AssetUpdateInput={${field}:value};\nvoid [row,create,update];\n`,
      0,
    );
    const uniqueSource = (value) =>
      imports +
      `const value=${value};\nconst one:AssetWhereUnique={${field}:value};\nconst compound:AssetWhereUnique={id:1,${field}:value};\ndeclare const db:TurbineClient;\nvoid db.assets.findUnique({where:one});\nvoid db.assets.update({where:one,data:{${field}:value}});\nvoid db.$transaction(tx=>tx.assets.findUnique({where:compound}));\n${engine === 'postgresql' ? 'const arrayUnique:AssetWhereUnique={many:[value]};void arrayUnique;\n' : ''}`;
    const build = compileProbe(name + '-native', uniqueSource(nativeValue), 0);
    compileProbe(name + '-model', uniqueSource('{id:42,title:"plain entity"}'), 2);
    const runtimePath = join(build, name, 'index.js');
    const runtime = mode === 'esm' ? await import(pathToFileURL(runtimePath)) : require(runtimePath);
    const client =
      engine === 'sqlite'
        ? runtime.turbine(nativeHandle, { logger: {} })
        : runtime.turbine({ pool: nativeHandle, logger: {} });
    const value = native(Uint8Array.from(bytes, (n) => (n + routeIndex + 1) & 255));
    const changed = native(Uint8Array.from(bytes, (n) => (n + routeIndex + 17) & 255));
    const rolledBack = native(Uint8Array.from(bytes, (n) => (n + routeIndex + 33) & 255));
    const id = routeIndex + 2;
    try {
      expectBytes((await client.assets.findUnique({ where: { [field]: native(bytes) } }))[field], bytes);
      await client.assets.create({
        data: { id, [field]: value, ...(engine === 'postgresql' ? { many: [value] } : {}) },
      });
      assert.equal((await client.assets.findUnique({ where: { [field]: value } })).id, id);
      assert.equal((await client.assets.findUnique({ where: { id, [field]: value } })).id, id);
      if (engine === 'postgresql') {
        // Array selectors are typed, but the existing single-row runtime guard
        // admits scalar identities only. Preserve that refusal without SQL.
        const query = nativeHandle.query;
        let queryCalls = 0;
        nativeHandle.query = function (...args) {
          queryCalls++;
          return Reflect.apply(query, this, args);
        };
        try {
          await assert.rejects(
            client.assets.findUnique({ where: { many: [value] } }),
            (error) => error.code === 'TURBINE_E003' && /does not identify a single row/.test(error.message),
          );
          assert.equal(queryCalls, 0);
          const byScalar = await client.assets.findUnique({ where: { [field]: value } });
          assert.ok(queryCalls > 0, 'The supplied-pool query observer must see the scalar control');
          assert.equal(byScalar.many.length, 1);
          expectBytes(byScalar.many[0], value);
        } finally {
          nativeHandle.query = query;
        }
      }
      await client.assets.update({ where: { [field]: value }, data: { [field]: changed } });
      await client.$transaction(async (tx) => {
        assert.equal((await tx.assets.findUnique({ where: { [field]: changed } })).id, id);
      });
      const reason = new Error('unique rollback');
      await assert.rejects(
        client.$transaction(async (tx) => {
          await tx.assets.update({ where: { [field]: changed }, data: { [field]: rolledBack } });
          throw reason;
        }),
        (error) => error === reason,
      );
      expectBytes((await client.assets.findUnique({ where: { [field]: changed } }))[field], changed);
    } finally {
      await client.disconnect();
    }
    const stored =
      engine === 'sqlite'
        ? nativeHandle.prepare('SELECT raw_data FROM assets WHERE id=?').get(id).raw_data
        : (await nativeHandle.query('SELECT raw_data FROM assets WHERE id=$1', [id])).rows[0].raw_data;
    expectBytes(stored, changed);
    for (const [i, col] of marked.entries()) assert.deepEqual(Object.getOwnPropertyDescriptors(col), before[i]);
    routes.push({
      route,
      field,
      fullBytes: [...stored],
      unique: true,
      compound: true,
      arrayUniqueType: engine === 'postgresql',
      arrayOnlyIdentityRefusedBeforeSql: engine === 'postgresql',
      fullArrayReadThroughScalar: engine === 'postgresql',
      create: true,
      update: true,
      transaction: true,
      rollback: true,
      callerSurvived: true,
      descriptorsUnchanged: true,
    });
  }
  // Aggregate meaningful strict controls for all ownership branches without
  // replaying the producer's full catalog/native matrix.
  let positives = '',
    negatives = '',
    getterEffects = 0;
  for (const [i, kind] of ['unmarked', 'undefined', 'inherited', 'declared', 'override', 'custom', 'enum'].entries()) {
    const input = clone(schema),
      col = getColumn(input),
      extra = {};
    Object.defineProperty(col, 'inferredBinaryType', { value: tag, enumerable: false, configurable: true });
    if (kind === 'unmarked' || kind === 'inherited') delete col.inferredBinaryType;
    if (kind === 'undefined') Object.defineProperty(col, 'inferredBinaryType', { value: undefined });
    if (kind === 'inherited')
      Object.setPrototypeOf(
        col,
        Object.create(Object.getPrototypeOf(col), {
          inferredBinaryType: {
            get() {
              getterEffects++;
              return tag;
            },
          },
        }),
      );
    if (kind === 'declared') col.declaredTsType = tag;
    if (kind === 'override') extra.columnTypes = { 'assets.raw_data': tag };
    if (kind === 'custom') col.tsType = `${tag} & { readonly brand: 'owned' } | null`;
    if (kind === 'enum') input.enums[col.dialectType ?? col.pgType] = ['owned'];
    const name = engine + '-unique-' + kind,
      field = col.field;
    orm.generate({
      schema: input,
      target: engine,
      outDir: join(evidence, name),
      noTimestamp: true,
      importExtension: 'js',
      ...extra,
    });
    const value =
      kind === 'enum'
        ? "'owned'"
        : kind === 'custom'
          ? '{id:42,title:"plain entity",brand:"owned" as const}'
          : '{id:42,title:"plain entity"}';
    positives += `import type {AssetWhereUnique as U${i}} from './${name}/types.js';\nconst u${i}:U${i}={${field}:${value}};void u${i};\n`;
    negatives += `import type {AssetWhereUnique as U${i}} from './${name}/types.js';\nconst u${i}:U${i}={${field}:${nativeValue}};void u${i};\n`;
  }
  compileProbe(engine + '-unique-ownership-positive', positives, 0);
  compileProbe(engine + '-unique-ownership-negative', negatives, 2);
  assert.equal(getterEffects, 0);
  const output = join(evidence, engine + '-unique-direct');
  const sentinel = readFileSync(join(output, 'types.ts'));
  for (const descriptor of [
    { value: 'globalThis.Buffer' },
    {
      get() {
        getterEffects++;
        return tag;
      },
    },
  ]) {
    const input = clone(schema);
    Object.defineProperty(getColumn(input), 'inferredBinaryType', descriptor);
    assert.throws(
      () => orm.generate({ schema: input, target: engine, outDir: output, keepColumnNames: true }),
      /inferredBinaryType/,
    );
    assert.deepEqual(readFileSync(join(output, 'types.ts')), sentinel);
  }
  assert.equal(getterEffects, 0);
  return { engine, routes, ownershipBranches: 7, invalidHintGetterEffects: getterEffects };
}

async function uniqueProjectionNative() {
  const handle = new DatabaseSync(':memory:');
  try {
    handle.exec(
      'CREATE TABLE uint8_arrays(id INTEGER PRIMARY KEY,title TEXT NOT NULL); CREATE TABLE buffers(id INTEGER PRIMARY KEY,title TEXT NOT NULL); CREATE TABLE assets(id INTEGER PRIMARY KEY,raw_data BLOB UNIQUE,UNIQUE(id,raw_data))',
    );
    handle.prepare('INSERT INTO assets VALUES (?,?)').run(1, bytes);
    const schema = sqlite.introspectSqliteDatabase(handle);
    report.engines.push(await uniqueProjectionContracts(schema, 'sqlite', handle));
    assert.equal(handle.prepare('SELECT count(*) AS n FROM assets').get().n, 4);
  } finally {
    handle.close();
  }
  const pool = new pg.Pool({ connectionString: process.env.BINARY_PROVENANCE_PG_URL });
  try {
    await pool.query(
      'CREATE TABLE uint8_arrays(id integer PRIMARY KEY,title text NOT NULL); CREATE TABLE buffers(id integer PRIMARY KEY,title text NOT NULL); CREATE TABLE assets(id integer PRIMARY KEY,raw_data bytea UNIQUE,many bytea[] UNIQUE,UNIQUE(id,raw_data))',
    );
    await pool.query('INSERT INTO assets VALUES ($1,$2,$3)', [1, Buffer.from(bytes), null]);
    const schema = await orm.introspect({ connectionString: process.env.BINARY_PROVENANCE_PG_URL });
    report.engines.push(await uniqueProjectionContracts(schema, 'postgresql', pool));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0].n, 4);
  } finally {
    try {
      await pool.query('DROP TABLE assets,buffers,uint8_arrays');
    } finally {
      await pool.end();
    }
  }
}

function regressionControls() {
  const input = orm.schemaDefToMetadata(
    orm.defineSchema({
      dates: { id: { type: 'serial', primaryKey: true } },
      records: { id: { type: 'serial', primaryKey: true } },
      events: { id: { type: 'serial', primaryKey: true }, at: { type: 'timestamptz' } },
    }),
  );
  input.tables.empty_rows = {
    ...clone(input.tables.records),
    name: 'empty_rows',
    columns: [],
    columnMap: {},
    reverseColumnMap: {},
    allColumns: [],
    primaryKey: [],
    uniqueColumns: [],
  };
  const types = emit(input, 'postgresql', 'regression-intrinsics').types;
  assert.match(types, /at: globalThis.Date \| null;/);
  assert.match(types, /export type EmptyRowCreateInput = \{ \[key in string\]: never \};/);
  const ticket = clone(input.tables.events);
  ticket.name = 'tickets';
  ticket.columns = ticket.columns.slice(0, 1);
  ticket.columns.push({
    name: 'status',
    field: 'status',
    dialectType: 'enum',
    pgType: 'enum',
    tsType: 'unknown',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
  });
  ticket.columnMap = { id: 'id', status: 'status' };
  ticket.reverseColumnMap = { id: 'id', status: 'status' };
  ticket.allColumns = ['id', 'status'];
  const labels = ['done*/archived', 'review/*comment*/', "quote'*/", 'back\\*/tail', 'literal*\\x2f', '*/', '*/\n*/'];
  const mysql = { tables: { tickets: ticket }, enums: { 'tickets.status': labels } };
  const generated = emit(mysql, 'mysql', 'regression-mysql-enum').types;
  const field = /export interface Ticket \{[\s\S]*?status: (.*);/.exec(generated)[1];
  const parsed = ts.createSourceFile('labels.ts', 'type Values = ' + field, ts.ScriptTarget.ES2023, true);
  assert.deepEqual(
    parsed.statements[0].type.types.map((member) => member.literal.text),
    labels,
  );
  assert.doesNotMatch(field, /\*\//);
  return { Date: true, Record: true, mysqlEnumF1Labels: labels };
}
try {
  if (process.env.BINARY_PROVENANCE_UNIQUE_ONLY === '1') {
    await uniqueProjectionNative();
  } else {
    const handle = new DatabaseSync(':memory:');
    try {
      handle.exec(
        'CREATE TABLE uint8_arrays(id INTEGER PRIMARY KEY,title TEXT NOT NULL); CREATE TABLE buffers(id INTEGER PRIMARY KEY,title TEXT NOT NULL); CREATE TABLE assets(id INTEGER PRIMARY KEY,data BLOB NOT NULL UNIQUE,optional BLOB)',
      );
      handle.prepare('INSERT INTO assets VALUES (?,?,?)').run(1, bytes, null);
      const schema = sqlite.introspectSqliteDatabase(handle);
      const contract = await contracts(schema, 'sqlite');
      const client = contract.runtime.turbine(handle, { logger: {} });
      let result;
      try {
        result = await effects(client, 'sqlite', (value) => value);
      } finally {
        await client.disconnect();
      }
      const rows = handle.prepare('SELECT id,data,optional,typeof(data) AS storage FROM assets ORDER BY id').all();
      assert.deepEqual(
        rows.map((row) => row.id),
        [1, 2, 3],
      );
      for (const [i, expected] of [result.next, reversed, bytes].entries()) {
        expectBytes(rows[i].data, expected);
        assert.equal(rows[i].optional, null);
        assert.equal(rows[i].storage, 'blob');
      }
      report.engines.push({
        engine: 'sqlite',
        sqlite: handle.prepare('select sqlite_version() as v').get().v,
        bytes: [...bytes],
        nativeRows: rows.map((row) => ({
          id: row.id,
          bytes: [...row.data],
          optional: row.optional,
          storage: row.storage,
        })),
        callerHandleSurvived: true,
        effects: { ...result, next: [...result.next], native: undefined },
        roundTrip: true,
      });
    } finally {
      handle.close();
    }
    const admin = new pg.Client({ connectionString: process.env.BINARY_PROVENANCE_PG_URL });
    await admin.connect();
    try {
      await admin.query(
        'CREATE TABLE uint8_arrays(id integer PRIMARY KEY,title text NOT NULL); CREATE TABLE buffers(id integer PRIMARY KEY,title text NOT NULL); CREATE TABLE assets(id integer PRIMARY KEY,data bytea NOT NULL UNIQUE,optional bytea,many bytea[])',
      );
      await admin.query('INSERT INTO assets VALUES ($1,$2,$3,$4)', [1, Buffer.from(bytes), null, null]);
      const catalog = await postgresCatalog(admin);
      report.nativeCatalog = catalog;
      // Include both public colliding entities for the generated client.
      const colliding = await orm.introspect({
        connectionString: process.env.BINARY_PROVENANCE_PG_URL,
        include: ['assets', 'buffers', 'uint8_arrays'],
      });
      const contract = await contracts(colliding, 'postgresql');
      const pool = new pg.Pool({ connectionString: process.env.BINARY_PROVENANCE_PG_URL });
      const client = contract.runtime.turbine({ pool, logger: {} });
      let result;
      try {
        result = await effects(client, 'postgresql', (value) => Buffer.from(value));
      } finally {
        await client.disconnect();
      }
      assert.equal((await pool.query('SELECT 17 AS alive')).rows[0].alive, 17);
      await pool.end();
      const rows = (
        await admin.query('SELECT id,data,optional,many,pg_typeof(data)::text AS storage FROM assets ORDER BY id')
      ).rows;
      assert.deepEqual(
        rows.map((row) => row.id),
        [1, 2, 3],
      );
      for (const [i, expected] of [result.next, reversed, bytes].entries()) {
        assert.ok(Buffer.isBuffer(rows[i].data));
        expectBytes(rows[i].data, expected);
        assert.equal(rows[i].optional, null);
        assert.equal(rows[i].storage, 'bytea');
      }
      assert.equal(rows[0].many, null);
      expectBytes(rows[1].many[0], bytes);
      expectBytes(rows[1].many[1], reversed);
      assert.equal(rows[2].many, null);
      report.engines.push({
        engine: 'postgresql',
        version: (await admin.query('SELECT version()')).rows[0].version,
        bytes: [...bytes],
        nativeRows: rows.map((row) => ({
          id: row.id,
          bytes: [...row.data],
          optional: row.optional,
          many: row.many?.map((value) => [...value]) ?? null,
          storage: row.storage,
        })),
        callerPoolSurvived: true,
        catalog,
        effects: { ...result, next: [...result.next], native: undefined },
        filterQualification: 'Existing broad union already admits Buffer; no native Buffer filter-rejection claim.',
      });
      await admin.query(
        'DROP SCHEMA binary_custom CASCADE; DROP MATERIALIZED VIEW binary_materialized; DROP VIEW binary_view; DROP TABLE binary_declarations,assets,buffers,uint8_arrays; DROP DOMAIN binary_domain,binary_array_domain; DROP OWNED BY binary_limited; DROP ROLE binary_limited',
      );
    } finally {
      await admin.end();
    }
  }
  report.regressions = regressionControls();
  report.success = true;
} finally {
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(
  JSON.stringify({
    node: process.version,
    mode,
    label,
    success: report.success,
    compilers: report.compiles.length,
    engines: report.engines.map((item) => item.engine),
  }),
);
