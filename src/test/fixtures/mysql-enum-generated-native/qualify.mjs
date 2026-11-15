// Run a copied helper from a normally installed consumer under an owned native service.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const cwd = process.cwd();
const [portText, mode, format, evidence, compiler, baselineFlag] = process.argv.slice(2);
const port = Number(portText);
const req = createRequire(join(cwd, 'package.json'));
const load = (name) => (format === 'cjs' ? req(name) : import(name));
const { generate } = await load('turbine-orm');
const { introspectMysqlWith } = await load('turbine-orm/mysql');
const driver = req('mysql2/promise');
assert.equal(req('mysql2/package.json').version, '3.24.6');
assert.equal(process.version, cwd.includes('node22') ? 'v22.16.0' : 'v24.10.0');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const serialize = (x) => JSON.stringify(x, (_, value) => (value instanceof Set ? [...value] : value));
const dbName = 'enum_feature';
const record = {
  runtime: process.version,
  execPath: process.execPath,
  port,
  mode,
  format,
  cwd,
  queries: [],
  compilers: [],
  commands: [],
  success: false,
};
mkdirSync(evidence);
const compile = (name, directory, status) => {
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'built', 'evidence'].includes(entry.name)) continue;
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (/\.(?:ts|json)$/.test(entry.name)) files[relative] = sha(join(dir, entry.name));
    }
  };
  walk(directory);
  const args = [compiler, '-p', directory];
  const input = {
    binary: process.execPath,
    args,
    cwd,
    files,
    compilerSHA256: sha(compiler),
    executableSHA256: sha(process.execPath),
  };
  writeFileSync(join(evidence, `${name}-before.json`), `${JSON.stringify(input, null, 2)}\n`);
  const c = spawnSync(process.execPath, args, { cwd, env: process.env, encoding: 'utf8', timeout: 120_000 });
  writeFileSync(join(evidence, `${name}.stdout`), c.stdout ?? '');
  writeFileSync(join(evidence, `${name}.stderr`), c.stderr ?? '');
  const result = { ...input, status: c.status, signal: c.signal, error: c.error?.message };
  record.compilers.push(result);
  assert.equal(c.status, status, c.stdout + c.stderr);
  return c.stdout + c.stderr;
};
const tsconfig = (directory, include = ['*.ts'], emit = false) =>
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          noEmit: !emit,
          outDir: emit ? './built' : undefined,
          types: ['node'],
          typeRoots: [resolve(compiler, '../../../@types')],
        },
        include,
      },
      null,
      2,
    ),
  );
const admin = await driver.createConnection({ host: '127.0.0.1', port, user: 'root', namedPlaceholders: true });
const labels = [
  'plain',
  'comma,label',
  "apostrophe's",
  "two''quotes",
  'back\\slash',
  '',
  ' leading',
  'tab\tmid',
  'line\nmid',
  'carriage\rmid',
  'nul\0mid',
  'ctrl\x1amid',
  "combo,\\'tail",
  'A',
  'a',
  'é',
  'e\u0301',
  'literal\\n',
  'double"quote',
  'end\\',
  'BMP雪',
  'space mid',
  'backspace\bmid',
  'form\fmid',
  ...Array.from({ length: 32 }, (_, i) => `ascii${String.fromCharCode(i)}mid`),
  'del\x7fmid',
  'line\u2028mid',
  'paragraph\u2029mid',
  'done*/archived',
  'review/*comment*/',
  "quote'*/",
  'back\\*/tail',
  'literal*\\x2f',
  '*/',
  '*/\n*/',
];
const literal = (s) =>
  "'" +
  (mode.includes('NO_BACKSLASH_ESCAPES')
    ? s
    : s
        .replace(/\\/g, '\\\\')
        .replace(/\0/g, '\\0')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replaceAll(String.fromCharCode(26), '\\Z')
  ).replace(/'/g, "''") +
  "'";
let reader, columnReader;
try {
  const [[server]] = await admin.query('SELECT VERSION() AS version, @@GLOBAL.sql_mode AS mode');
  assert.equal(server.version, '8.4.0');
  assert.deepEqual(server.mode.split(',').sort(), mode.split(',').sort());
  record.server = server;
  await admin.query(`CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  await admin.query(`USE ${dbName}`);
  for (const sql of [
    "CREATE TABLE tickets(id INT PRIMARY KEY AUTO_INCREMENT,status ENUM('new','done') NOT NULL,priority ENUM('low','high'),note VARCHAR(30))",
    `CREATE TABLE labels(id INT PRIMARY KEY AUTO_INCREMENT,value ENUM(${labels.map(literal).join(',')}) NOT NULL UNIQUE)`,
    "CREATE TABLE mirrors(id INT PRIMARY KEY AUTO_INCREMENT,status ENUM('queued','sent') NOT NULL)",
    "CREATE TABLE copies(id INT PRIMARY KEY AUTO_INCREMENT,status ENUM('new','done') NOT NULL)",
    'CREATE TABLE notes(id INT PRIMARY KEY AUTO_INCREMENT,body VARCHAR(30))',
    'CREATE TABLE hidden(id INT PRIMARY KEY)',
  ]) {
    record.commands.push(sql);
    await admin.query(sql);
  }
  for (const user of ['enum_reader', 'enum_columns']) await admin.query(`CREATE USER '${user}'@'127.0.0.1'`);
  for (const table of ['tickets', 'labels', 'mirrors', 'copies', 'notes'])
    await admin.query(`GRANT SELECT ON ${dbName}.${table} TO 'enum_reader'@'127.0.0.1'`);
  await admin.query(`GRANT SELECT(id,status) ON ${dbName}.tickets TO 'enum_columns'@'127.0.0.1'`);
  const state = async (pool) =>
    (
      await pool.query(
        'SELECT CURRENT_USER() AS account,@@sql_mode AS mode,@@autocommit AS autocommit,@@transaction_isolation AS isolation,DATABASE() AS db',
      )
    )[0];
  const introspect = async (user) => {
    const pool = driver.createPool({
      host: '127.0.0.1',
      port,
      user,
      database: dbName,
      namedPlaceholders: true,
      connectionLimit: 1,
    });
    if (user === 'enum_reader') reader = pool;
    else columnReader = pool;
    const before = await state(pool),
      queries = [];
    const grants = (await pool.query('SHOW GRANTS'))[0];
    await pool.query('START TRANSACTION READ ONLY');
    const schema = await introspectMysqlWith(
      async (sql, params) => {
        assert.match(sql, /^SELECT\b/);
        const [rows] = await pool.execute(sql, Object.fromEntries(params.map((v, i) => [`p${i + 1}`, v])));
        queries.push({ sql, params, rows });
        return rows;
      },
      dbName,
      { logger: {} },
    );
    await pool.query('ROLLBACK');
    assert.equal(queries.length, 5);
    assert.deepEqual(await state(pool), before);
    assert.equal((await pool.query('SELECT 42 AS alive'))[0][0].alive, 42);
    await assert.rejects(
      pool.query("INSERT INTO tickets(status) VALUES ('new')"),
      (e) => e.code === 'ER_TABLEACCESS_DENIED_ERROR' || e.code === 'ER_COLUMNACCESS_DENIED_ERROR',
    );
    record.queries.push({ user, before, after: await state(pool), grants, queries, callerPoolSurvived: true });
    return schema;
  };
  const schema = await introspect('enum_reader');
  assert.deepEqual(Object.keys(schema.tables).sort(), ['copies', 'labels', 'mirrors', 'notes', 'tickets']);
  assert.deepEqual(schema.enums['labels.value'], labels);
  assert.deepEqual(schema.enums['tickets.status'], schema.enums['copies.status']);
  assert.deepEqual(schema.enums['mirrors.status'], ['queued', 'sent']);
  assert.deepEqual(schema.enums['tickets.priority'], ['low', 'high']);
  const limited = await introspect('enum_columns');
  assert.deepEqual(Object.keys(limited.tables), ['tickets']);
  assert.deepEqual(
    limited.tables.tickets.columns.map((c) => c.name),
    ['id', 'status'],
  );
  assert.deepEqual(Object.keys(limited.enums), ['tickets.status']);
  const before = serialize(schema);
  const references = [];
  const visit = (object) => {
    if (object === null || typeof object !== 'object') return;
    const keys = Reflect.ownKeys(object);
    references.push({ object, prototype: Object.getPrototypeOf(object), keys, values: keys.map((key) => object[key]) });
    for (const key of keys) visit(object[key]);
  };
  visit(schema);
  writeFileSync(join(evidence, 'catalog-metadata.json'), `${serialize(schema)}\n`);
  const out = join(cwd, 'generated');
  const ticketsOnly = {
    ...schema,
    tables: { tickets: schema.tables.tickets },
    enums: { 'tickets.status': schema.enums['tickets.status'], 'tickets.priority': schema.enums['tickets.priority'] },
  };
  const recordRefusal = (error) => {
    record.originalFailure = { name: error.name, code: error.code, message: error.message, stack: error.stack };
    return /Tickets\.status.*not a valid TypeScript identifier/.test(error.message);
  };
  if (baselineFlag === 'baseline') {
    assert.throws(
      () => generate({ schema: ticketsOnly, target: 'mysql', outDir: out, noTimestamp: true, logger: {} }),
      recordRefusal,
    );
    record.originalRefusal = true;
    const alias = structuredClone(schema);
    alias.enums = Object.fromEntries(Object.entries(alias.enums).map(([k, v]) => [k.replace('.', '_'), v]));
    generate({ schema: alias, target: 'mysql', outDir: out, noTimestamp: true, logger: {} });
    assert.match(readFileSync(`${out}/types.ts`, 'utf8'), /status: string;/);
    writeFileSync(
      `${out}/invalid.ts`,
      "import type { TicketCreate } from './types.js';\nconst bad: TicketCreate = {status:'bad-label'};\nvoid bad;\n",
    );
    tsconfig(out);
    compile('alias-only-string-mutant-accepts-invalid', out, 0);
    record.aliasOnlyInvalidAccepted = true;
  } else {
    assert.throws(
      () => generate({ schema: ticketsOnly, outDir: join(cwd, 'omitted'), noTimestamp: true, logger: {} }),
      recordRefusal,
    );
    assert.deepEqual(readdirSync(join(cwd, 'omitted')), []);
    generate({ schema, target: 'mysql', outDir: out, noTimestamp: true, zod: true, logger: {} });
    const types = readFileSync(`${out}/types.ts`, 'utf8');
    assert.match(types, /status: 'new' \| 'done';/);
    assert.match(types, /priority: 'low' \| 'high' \| null;/);
    assert.match(readFileSync(`${out}/zod.ts`, 'utf8'), /z\.enum\(\['new', 'done'\]\)/);
    assert.match(readFileSync(`${out}/metadata.ts`, 'utf8'), /'tickets.status': \['new', 'done'\]/);
    assert.match(readFileSync(`${out}/metadata.ts`, 'utf8'), /dialectType: 'enum'/);
    assert.match(readFileSync(`${out}/index.ts`, 'utf8'), /from 'turbine-orm\/mysql'/);
    generate({
      schema,
      target: 'mysql',
      outDir: join(cwd, 'override'),
      columnTypes: { 'tickets.status': 'number' },
      noTimestamp: true,
      logger: {},
    });
    assert.match(readFileSync(join(cwd, 'override/types.ts'), 'utf8'), /status: number;/);
    const declared = structuredClone(schema);
    declared.tables.tickets.columns.find((c) => c.name === 'status').declaredTsType = 'boolean';
    generate({ schema: declared, target: 'mysql', outDir: join(cwd, 'declared'), noTimestamp: true, logger: {} });
    assert.match(readFileSync(join(cwd, 'declared/types.ts'), 'utf8'), /status: boolean;/);
    generate({
      schema: declared,
      target: 'mysql',
      outDir: join(cwd, 'declared-override'),
      columnTypes: { 'tickets.status': 'number' },
      noTimestamp: true,
      logger: {},
    });
    assert.match(readFileSync(join(cwd, 'declared-override/types.ts'), 'utf8'), /status: number;/);
    const shared = structuredClone(schema);
    const sharedStatus = shared.tables.tickets.columns.find((c) => c.name === 'status');
    const mirrorIndex = shared.tables.mirrors.columns.findIndex((c) => c.name === 'status');
    shared.tables.mirrors.columns[mirrorIndex] = sharedStatus;
    const sharedBefore = serialize(shared);
    const sharedDir = join(cwd, 'shared');
    generate({ schema: shared, target: 'mysql', outDir: sharedDir, noTimestamp: true, logger: {} });
    writeFileSync(
      join(sharedDir, 'valid.ts'),
      "import type { Ticket, Mirror } from './types.js';\nconst ticket: Ticket['status'] = 'new';\nconst mirror: Mirror['status'] = 'queued';\nvoid [ticket,mirror];\n",
    );
    tsconfig(sharedDir);
    compile('shared-object-positive', sharedDir, 0);
    const sharedNegative = join(cwd, 'shared-negative');
    mkdirSync(sharedNegative);
    writeFileSync(
      join(sharedNegative, 'invalid.ts'),
      "import type { Ticket, Mirror } from '../shared/types.js';\nconst ticket: Ticket['status'] = 'queued';\nconst mirror: Mirror['status'] = 'new';\nvoid [ticket,mirror];\n",
    );
    tsconfig(sharedNegative);
    const sharedDiagnostics = compile('shared-object-cross-table-negative', sharedNegative, 2);
    assert.match(sharedDiagnostics, /invalid\.ts\(2,\d+\): error TS2322/);
    assert.match(sharedDiagnostics, /invalid\.ts\(3,\d+\): error TS2322/);
    assert.equal(serialize(shared), sharedBefore);
    assert.equal(shared.tables.mirrors.columns[mirrorIndex], sharedStatus);
    sharedStatus.declaredTsType = 'number';
    const precedenceDir = join(cwd, 'shared-precedence');
    generate({
      schema: shared,
      target: 'mysql',
      outDir: precedenceDir,
      columnTypes: { 'mirrors.status': 'boolean' },
      noTimestamp: true,
      logger: {},
    });
    writeFileSync(
      join(precedenceDir, 'valid.ts'),
      "import type { Ticket, Mirror } from './types.js';\nconst ticket: Ticket['status'] = 42;\nconst mirror: Mirror['status'] = true;\nvoid [ticket,mirror];\n",
    );
    tsconfig(precedenceDir);
    compile('shared-object-declared-and-override-precedence', precedenceDir, 0);
    assert.equal(sharedStatus.declaredTsType, 'number');
    assert.equal(shared.tables.mirrors.columns[mirrorIndex], sharedStatus);
    record.sharedObjectIdentityAndPerTablePrecedence = true;
    const usage = readFileSync(join(cwd, 'consumer.ts.txt'), 'utf8')
      .replace('__PACKAGE_PATH__', JSON.stringify(join(cwd, 'package.json')))
      .replace('__LABEL_VALUES__', JSON.stringify(labels));
    writeFileSync(join(cwd, 'usage.ts'), usage);
    tsconfig(cwd, ['usage.ts', 'generated/index.ts', 'generated/types.ts', 'generated/metadata.ts'], true);
    compile('positive-native-client', cwd, 0);
    const badDir = join(cwd, 'negative');
    mkdirSync(badDir);
    const imports =
      "import type { Ticket, TicketCreate, TicketUpdate, LabelWhereUnique, Mirror } from '../generated/types.js';\nimport type { turbine } from '../generated/index.js';\ndeclare const db: Awaited<ReturnType<typeof turbine>>;\n";
    const bad = [
      "const row: Ticket['status'] = 'bad-label';",
      "const nullable: Ticket['priority'] = 'bad-label';",
      "const create: TicketCreate = {status:'bad-label'};",
      "const update: TicketUpdate = {status:{set:'bad-label'}};",
      "const unique: LabelWhereUnique = {value:'bad-label'};",
      "db.tickets.findMany({where:{status:'bad-label',priority:'bad-label'}});",
      "db.$transaction(async tx=>tx.tickets.create({data:{status:'bad-label'}}));",
      "const ticketCross: Ticket['status'] = 'queued';",
      "const mirrorCross: Mirror['status'] = 'new';",
    ];
    writeFileSync(join(badDir, 'usage.ts'), `${imports + bad.join('\n')}\n`);
    tsconfig(badDir);
    const diagnostics = compile('unmarked-invalid-labels', badDir, 2);
    for (let i = 0; i < bad.length; i++)
      assert.match(diagnostics, new RegExp(`usage\\.ts\\(${i + 4},\\d+\\): error TS(?:2322|2353)`));
    assert.match(diagnostics, /bad-label/);
    const binary = join(cwd, 'built/usage.js');
    const command = { binary: process.execPath, args: [binary, String(port), dbName], cwd, sha256: sha(binary) };
    writeFileSync(join(evidence, 'native-client-before.json'), `${JSON.stringify(command, null, 2)}\n`);
    const c = spawnSync(process.execPath, command.args, { cwd, env: process.env, encoding: 'utf8', timeout: 120_000 });
    record.commands.push({ ...command, status: c.status, signal: c.signal });
    writeFileSync(join(evidence, 'native-client.stdout'), c.stdout ?? '');
    writeFileSync(join(evidence, 'native-client.stderr'), c.stderr ?? '');
    assert.equal(c.status, 0, c.stdout + c.stderr);
    record.native = JSON.parse(c.stdout.trim());
    assert.deepEqual(record.native.completeValues, labels);
    record.invalidLabelsRejected = bad.length;
    record.omissionRefused = true;
  }
  assert.equal(serialize(schema), before);
  for (const { object, prototype, keys, values } of references) {
    assert.equal(Object.getPrototypeOf(object), prototype);
    assert.deepEqual(Reflect.ownKeys(object), keys);
    for (let i = 0; i < keys.length; i++) assert.equal(object[keys[i]], values[i]);
  }
  record.rawMetadataUnchanged = true;
  record.success = true;
} finally {
  await reader?.end();
  await columnReader?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  for (const user of ['enum_reader', 'enum_columns']) await admin.query(`DROP USER IF EXISTS '${user}'@'127.0.0.1'`);
  await admin.end();
  record.cleanup = { poolsClosed: true, adminClosed: true, databaseAndUsersRemoved: true };
  writeFileSync(join(evidence, 'result.json'), `${JSON.stringify(record, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    success: record.success,
    runtime: record.runtime,
    format,
    mode,
    baseline: baselineFlag === 'baseline',
    completeValues: record.native?.rows,
  }),
);
