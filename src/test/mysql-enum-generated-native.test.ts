import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { generate, generateIndex, generateMetadata, generateTypes, generateZod } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = { target: 'mysql', noTimestamp: true } as const;
const fixture = readFileSync(join(repo, 'src/test/fixtures/mysql-enum-generated-native/metadata.json'), 'utf8');
function schema(): SchemaMetadata {
  return JSON.parse(fixture, (key, value) => (key === 'dateColumns' ? new Set(value) : value));
}

it('binds native column-local enums without changing raw metadata or adding alias names', () => {
  const input = schema();
  const before = structuredClone(input);
  const metadata = generateMetadata(input, options);
  const types = generateTypes(input, options);
  assert.match(types, /status: 'new' \| 'done';/);
  assert.match(types, /priority: 'low' \| 'high' \| null;/);
  assert.match(types, /priority\?: 'low' \| 'high' \| null \| undefined;/);
  assert.doesNotMatch(types, /export type TicketsStatus =/);
  assert.match(generateIndex(input, options), /readonly tickets: QueryInterface<Ticket,/);
  assert.match(generateZod(input, options), /z\.enum\(\['new', 'done'\]\)/);
  assert.deepEqual(input, before);
  assert.equal(generateMetadata(input, options), metadata);
  assert.match(metadata, /'tickets.status': \['new', 'done'\]/);
  assert.match(metadata, /dialectType: 'enum'/);
});

it('preserves explicit overrides and PostgreSQL enum names', () => {
  const input = schema();
  const types = generateTypes(input, {
    ...options,
    columnTypes: { 'tickets.status': 'number', 'tickets.priority': 'boolean' },
  });
  assert.match(types, /status: number;/);
  assert.match(types, /priority: boolean \| null;/);
  input.tables.tickets!.columns.find((c) => c.name === 'status')!.declaredTsType = 'number';
  assert.match(generateTypes(input, options), /status: number;/);
  input.enums = { ticket_status: ['new', 'done'], ticket_priority: ['low', 'high'] };
  for (const col of input.tables.tickets!.columns) {
    if (col.pgType === 'enum') col.dialectType = col.pgType = `ticket_${col.name}`;
  }
  assert.equal(
    generateTypes(input, { noTimestamp: true }),
    generateTypes(input, { target: 'postgresql', noTimestamp: true }),
  );
  assert.match(generateTypes(input), /export type TicketStatus = 'new' \| 'done';/);
});

it('avoids alias collisions and safely escapes literal values', () => {
  const input = schema();
  input.tables.tickets_statuses = { ...input.tables.notes!, name: 'tickets_statuses' };
  input.enums['tickets.status'] = ["quote'", 'comma,x', 'slash\\', '', '\n', '雪', '\u2028'];
  input.enums['tickets.priority'] = [...input.enums['tickets.status']!];
  const types = generateTypes(input, options);
  assert.match(types, /export interface TicketsStatus \{/);
  assert.doesNotMatch(types, /export type TicketsStatus =/);
  assert.match(types, /status: 'quote\\'/);
  assert.match(types, /'slash\\\\'/);
  assert.match(types, /'\\n'/);
  assert.match(types, /'\\u2028'/);
  assert.equal((types.match(/'comma,x'/g) ?? []).length >= 4, true);
});

it('preserves native comment-delimiter labels without weakening caller type validation', () => {
  const input = schema();
  const labels = ['done*/archived', 'review/*comment*/', "quote'*/", 'back\\*/tail', 'literal*\\x2f', '*/', '*/\n*/'];
  input.enums['tickets.status'] = labels;
  input.enums['tickets.priority'] = labels;
  const before = structuredClone(input);
  const types = generateTypes(input, options);
  const row = /export interface Ticket \{(.*?)\n\}/s.exec(types)![1]!;
  const type = /status: (.*);/.exec(row)![1]!;
  const parsed = ts.createSourceFile('labels.ts', `type Values = ${type};`, ts.ScriptTarget.ES2022, true);
  const declaration = parsed.statements[0]!;
  assert.ok(ts.isTypeAliasDeclaration(declaration));
  assert.ok(ts.isUnionTypeNode(declaration.type));
  assert.deepEqual(
    declaration.type.types.map((member) => {
      assert.ok(ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal));
      return member.literal.text;
    }),
    labels,
  );
  assert.doesNotMatch(type, /\*\//);
  assert.match(generateTypes(input, { ...options, columnTypes: { 'tickets.status': 'string' } }), /status: string;/);
  assert.match(generateIndex(input, options), /readonly tickets:/);
  assert.ok(generateZod(input, options).includes('done*/archived'));
  assert.ok(generateMetadata(input, options).includes('done*/archived'));
  assert.deepEqual(input, before);
  const pg = structuredClone(input);
  pg.enums = Object.fromEntries(Object.entries(pg.enums).map(([name, values]) => [name.replace('.', '_'), values]));
  for (const table of Object.values(pg.tables)) {
    for (const col of table.columns) {
      if ((col.dialectType ?? col.pgType) === 'enum') col.dialectType = col.pgType = `${table.name}_${col.name}`;
    }
  }
  assert.ok(generateTypes(pg, { noTimestamp: true }).includes('done*/archived'));
  const dir = mkdtempSync(join(tmpdir(), 'mysql-enum-comment-label-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    generate({ ...options, schema: input, outDir: dir, zod: true, logger: {} });
    const sentinel = readFileSync(join(dir, 'types.ts'), 'utf8');
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(repo, join(dir, 'node_modules/turbine-orm'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          types: ['node'],
          typeRoots: [join(repo, 'node_modules/@types')],
        },
        include: ['usage.ts', 'types.ts', 'metadata.ts', 'index.ts'],
      }),
    );
    const imports = `import type { Ticket, TicketCreate, TicketUpdate } from './types.js';
import type { turbine } from './index.js';
declare const db: Awaited<ReturnType<typeof turbine>>;
`;
    const usage = join(dir, 'usage.ts');
    writeFileSync(
      usage,
      `${imports}
const values: Ticket['status'][] = ${JSON.stringify(labels)};
const nullable: Ticket['priority'][] = [null, ...values];
const creates: TicketCreate[] = values.map(status => ({ status, priority: status }));
const updates: TicketUpdate[] = values.map(status => ({ status: { set: status }, priority: status }));
db.tickets.findMany({ where: { status: { in: values }, priority: { in: nullable } } });
db.$transaction(async tx => tx.tickets.create({ data: creates[0]! }));
void updates;
`,
    );
    const compile = () =>
      spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', dir], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 120_000,
      });
    const positive = compile();
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    writeFileSync(usage, `${imports}const wrong: Ticket['status'] = ${JSON.stringify('done*\\x2farchived')};\n`);
    const negative = compile();
    process.stdout.write(negative.stdout);
    assert.equal(negative.status, 2, negative.stdout + negative.stderr);
    assert.match(negative.stdout, /usage\.ts\(4,7\): error TS(?:2322|2820)/);
    for (const field of ['tsType', 'declaredTsType'] as const) {
      for (const text of ["'done*/archived'", 'string; throw 1']) {
        const invalid = schema();
        invalid.tables.tickets!.columns.find((col) => col.name === 'status')![field] = text;
        for (const emit of [generateTypes, generateIndex, generateZod]) {
          assert.throws(() => emit(invalid, options), /cannot be emitted/);
        }
        assert.throws(() => generate({ ...options, schema: invalid, outDir: dir }), /cannot be emitted/);
        assert.equal(readFileSync(join(dir, 'types.ts'), 'utf8'), sentinel);
      }
    }
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('resolves reused column objects through their own table identity', () => {
  const input = schema();
  input.tables.mirrors = { ...input.tables.tickets!, name: 'mirrors' };
  input.enums['mirrors.status'] = ['queued', 'sent'];
  input.enums['mirrors.priority'] = ['later', 'now'];
  const before = structuredClone(input);
  const types = generateTypes(input, options);
  const ticket = /export interface Ticket \{(.*?)\n\}/s.exec(types)?.[1];
  const mirror = /export interface Mirror \{(.*?)\n\}/s.exec(types)?.[1];
  assert.ok(ticket);
  assert.ok(mirror);
  assert.match(ticket, /status: 'new' \| 'done';/);
  assert.match(ticket, /priority: 'low' \| 'high' \| null;/);
  assert.match(mirror, /status: 'queued' \| 'sent';/);
  assert.match(mirror, /priority: 'later' \| 'now' \| null;/);
  assert.deepEqual(input, before);
  assert.equal(input.tables.tickets!.columns, input.tables.mirrors!.columns);
  const status = input.tables.tickets!.columns.find((c) => c.name === 'status')!;
  assert.equal(
    status,
    input.tables.mirrors!.columns.find((c) => c.name === 'status'),
  );
  status.declaredTsType = 'number';
  const declared = generateTypes(input, { ...options, columnTypes: { 'mirrors.status': 'boolean' } });
  assert.match(/export interface Ticket \{(.*?)\n\}/s.exec(declared)![1]!, /status: number;/);
  assert.match(/export interface Mirror \{(.*?)\n\}/s.exec(declared)![1]!, /status: boolean;/);
  assert.equal(status.declaredTsType, 'number');
  assert.equal(input.tables.tickets!.columns, input.tables.mirrors!.columns);
});

it('leaves shared non-ENUM objects unchanged even when their dotted key matches a native ENUM', () => {
  const input = schema();
  const plain = {
    ...input.tables.tickets!.columns.find((c) => c.name === 'status')!,
    field: 'plainStatus',
    dialectType: 'varchar',
    pgType: 'varchar',
  };
  // Synthetic duplicate raw table names exercise lookup selection independently
  // of the native catalog, where one table cannot occur twice.
  input.tables.plain_one = { ...input.tables.notes!, name: 'tickets', columns: [plain] };
  input.tables.plain_two = { ...input.tables.notes!, name: 'plain_two', columns: [plain] };
  const before = structuredClone(input);
  const types = generateTypes(input, options);
  // Both the row and required create field stay string for each table.
  assert.equal((types.match(/plainStatus: string;/g) ?? []).length, 4);
  assert.doesNotMatch(types, /plainStatus: 'new'/);
  assert.deepEqual(input, before);
  assert.equal(input.tables.plain_one.columns[0], plain);
  assert.equal(input.tables.plain_two.columns[0], plain);
  assert.equal(plain.dialectType, 'varchar');
});

it('refuses ambiguous or unmatched native identities and validates caller text before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-enum-refusal-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const input = schema();
    input.tables.tickets!.columns.find((c) => c.name === 'status')!.tsType = 'string;\nthrow 1';
    assert.throws(() => generate({ ...options, schema: input, outDir: './out' }), /cannot be emitted/);
    assert.deepEqual(readdirSync(join(dir, 'out')), []);
    const unmatched = schema();
    unmatched.enums['unmatched.column'] = ['a'];
    assert.throws(() => generateTypes(unmatched, options), /not a valid TypeScript identifier/);
    const missing = schema();
    delete missing.enums['tickets.status'];
    assert.throws(() => generateTypes(missing, options), /Missing MySQL ENUM column identity/);
    const ambiguous = schema();
    const col = ambiguous.tables.tickets!.columns.find((c) => c.name === 'status')!;
    ambiguous.tables = {
      a: { ...ambiguous.tables.tickets!, name: 'a', columns: [{ ...col, name: 'b.c' }] },
      other: { ...ambiguous.tables.tickets!, name: 'a.b', columns: [{ ...col, name: 'c' }] },
    };
    ambiguous.enums = { 'a.b.c': ['a'] };
    assert.throws(() => generate({ ...options, schema: ambiguous, outDir: './out' }), /Ambiguous MySQL ENUM/);
    assert.deepEqual(readdirSync(join(dir, 'out')), []);
    assert.throws(() => generateTypes(schema()), /Tickets\.status.*not a valid TypeScript identifier/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('preserves existing output on caller-type and override refusals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-enum-existing-output-'));
  const cwd = process.cwd();
  const sentinel = join(dir, 'types.ts');
  writeFileSync(sentinel, 'existing generated output\n');
  try {
    process.chdir(dir);
    for (const text of ['string; throw 1', 'string\n', 'string /* unterminated']) {
      const input = schema();
      input.tables.tickets!.columns.find((c) => c.name === 'status')!.declaredTsType = text;
      assert.throws(() => generate({ ...options, schema: input, outDir: dir }), /cannot be emitted/);
      assert.equal(readFileSync(sentinel, 'utf8'), 'existing generated output\n');
      assert.deepEqual(readdirSync(dir), ['types.ts']);
    }
    const overrides: Record<string, string>[] = [
      { 'tickets.status': 'string; throw 1' },
      { 'tickets.missing': 'string' },
    ];
    for (const columnTypes of overrides) {
      assert.throws(() => generate({ ...options, schema: schema(), outDir: dir, columnTypes }));
      assert.equal(readFileSync(sentinel, 'utf8'), 'existing generated output\n');
      assert.deepEqual(readdirSync(dir), ['types.ts']);
    }
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('checks row, nullable, create, update, filter, unique-selector and transaction column types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-enum-types-'));
  try {
    const input = schema();
    input.tables.mirrors = { ...input.tables.tickets!, name: 'mirrors' };
    input.enums['mirrors.status'] = ['queued', 'sent'];
    input.enums['mirrors.priority'] = ['later', 'now'];
    // Exercise the same column resolver in unique-selector emission too.
    input.tables.tickets!.uniqueColumns.push(['status'], ['priority']);
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(repo, join(dir, 'node_modules/turbine-orm'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const [name, emitter] of Object.entries({
      types: generateTypes,
      metadata: generateMetadata,
      index: generateIndex,
    })) {
      writeFileSync(join(dir, `${name}.ts`), emitter(input, options));
    }
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          types: ['node'],
          typeRoots: [join(repo, 'node_modules/@types')],
        },
        include: ['*.ts'],
      }),
    );
    const imports = `import type { Ticket, TicketCreate, TicketUpdate, TicketWhereUnique, Mirror } from './types.js';
import type { turbine } from './index.js';
declare const db: Awaited<ReturnType<typeof turbine>>;
`;
    const usage = join(dir, 'usage.ts');
    const compile = () =>
      spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', dir], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 120_000,
      });
    writeFileSync(
      usage,
      `${imports}
const row: Ticket['status'] = 'new';
const mirror: Mirror['status'] = 'queued';
const nullable: Ticket['priority'] = null;
const create: TicketCreate = { status: 'done', priority: 'low' };
const update: TicketUpdate = { status: { set: 'done' }, priority: null };
const unique: TicketWhereUnique = { status: 'new' };
db.tickets.findMany({ where: { status: { in: ['new', 'done'] }, priority: 'high' } });
db.$transaction(async (tx) => tx.tickets.create({ data: { status: 'new', priority: null } }));
void [row, mirror, nullable, create, update, unique];
`,
    );
    const positive = compile();
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    const bad = [
      "const row: Ticket['status'] = 'bad-label';",
      "const nullable: Ticket['priority'] = 'bad-label';",
      "const create: TicketCreate = { status: 'bad-label' };",
      "const update: TicketUpdate = { status: { set: 'bad-label' } };",
      "const unique: TicketWhereUnique = { status: 'bad-label' };",
      "db.tickets.findMany({ where: { status: 'bad-label', priority: 'bad-label' } });",
      "db.$transaction(async (tx) => tx.tickets.create({ data: { status: 'bad-label' } }));",
      "const ticketCross: Ticket['status'] = 'queued';",
      "const mirrorCross: Mirror['status'] = 'new';",
    ];
    writeFileSync(usage, imports + bad.join('\n'));
    const negative = compile();
    process.stdout.write(negative.stdout);
    assert.equal(negative.status, 2, negative.stdout + negative.stderr);
    for (let i = 0; i < bad.length; i++) {
      assert.match(negative.stdout, new RegExp(`usage\\.ts\\(${i + 4},\\d+\\): error TS(?:2322|2353)`));
    }
    assert.match(negative.stdout, /bad-label/);
    const shared = input.tables.tickets!.columns.find((c) => c.name === 'status')!;
    shared.declaredTsType = 'number';
    writeFileSync(
      join(dir, 'types.ts'),
      generateTypes(input, { ...options, columnTypes: { 'mirrors.status': 'boolean' } }),
    );
    writeFileSync(
      usage,
      `${imports}\nconst ticket: Ticket['status'] = 42;\nconst mirror: Mirror['status'] = true;\nvoid [ticket, mirror];\n`,
    );
    const precedence = compile();
    assert.equal(precedence.status, 0, precedence.stdout + precedence.stderr);
    assert.equal(
      input.tables.mirrors!.columns.find((c) => c.name === 'status'),
      shared,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
