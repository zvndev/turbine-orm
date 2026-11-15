import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The caller imports the public entry with the format being qualified.
export function prove({ generate, introspectSqliteDatabase, consumer, format, omitted = false }) {
  const dir = join(consumer, `${format}-v4${omitted ? '-omitted' : ''}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
  const nativePath = join(dir, 'native.db');
  const native = new DatabaseSync(nativePath);
  const report = { node: process.version, format, omitted, commands: [], negativeCases: [], generated: {}, nativePath };
  const command = (args) => {
    const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    report.commands.push({ cwd: dir, binary: process.execPath, args, code: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
    return result;
  };
  const ext = format === 'esm' ? 'mts' : 'cts';
  const tsc = join(consumer, 'node_modules/typescript/bin/tsc');
  try {
    native.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE records(id INTEGER PRIMARY KEY, title TEXT NOT NULL, amount REAL NOT NULL,
        memo TEXT, exact_value BIGINT NOT NULL, active BOOLEAN NOT NULL, payload BLOB NOT NULL);
      CREATE TABLE defaults(id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'ready');
      CREATE TABLE links(record_id INTEGER NOT NULL PRIMARY KEY REFERENCES records(id));
      CREATE TABLE details(id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES records(id), body TEXT NOT NULL);
      CREATE TABLE notes(id INTEGER PRIMARY KEY, record_id INTEGER REFERENCES records(id), body TEXT NOT NULL);`);
    const catalog = () => native.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const before = catalog();
    const schema = introspectSqliteDatabase(native);
    assert.ok(schema.tables.records);
    assert.ok(schema.tables.records.relations.links);
    assert.ok(schema.tables.records.relations.details);
    const options = { schema, target: 'sqlite', exactNativeIntegers: true, noTimestamp: true,
      importExtension: 'js', logger: {} };
    for (const folder of ['generated', 'repeat']) generate({ ...options, outDir: join(dir, folder) });
    for (const file of ['types.ts', 'index.ts', 'metadata.ts']) {
      const bytes = readFileSync(join(dir, 'generated', file));
      assert.deepEqual(bytes, readFileSync(join(dir, 'repeat', file)));
      report.generated[file] = createHash('sha256').update(bytes).digest('hex');
    }
    assert.deepEqual(catalog(), before);
    report.catalog = before;
    report.schema = schema;
    const typeChecks = `
import type { Record, RecordCreateInput, RecordNestedToOneUpdateInput, DefaultCreateInput } from './generated/types.js';
import type { TurbineClient } from './generated/index.js';
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
const context: Parameters<TurbineClient['$withSession']>[0] = { tenant: 'one', count: 2, enabled: true };
const connected: RecordNestedToOneUpdateInput = { disconnect: {}, delete: { id: 1 } };
const byFlag: RecordNestedToOneUpdateInput = { disconnect: true, delete: false };
const defaults: DefaultCreateInput = {};
const entity: Record = { id: 1, title: 'typed', amount: 1.25, memo: null, exactValue: '9223372036854775807', active: true, payload: Buffer.from([1]) };
type ContextKeys = Assert<Same<keyof Parameters<TurbineClient['$withSession']>[0], string>>;
void context; void connected; void byFlag; void defaults; void entity;
`;
    const valid = `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { turbine } from './generated/index.js';
${typeChecks}
async function main() {
  const handle = new DatabaseSync(${JSON.stringify(nativePath)});
  const db = turbine(handle, { foreignKeys: true, logger: {} });
  let callerClosed = false;
  try {
  const data: RecordCreateInput = { title: 'first', amount: 1.2345678901234567, memo: null,
    exactValue: 9223372036854775807n, active: true, payload: Buffer.from([0, 128, 255]),
    links: { create: {} }, details: { create: { body: 'required child' } } };
  const row = await db.records.create({ data });
  const id = row.id;
  const expected = { id: 1, title: 'first', amount: 1.2345678901234567, memo: null,
    exactValue: '9223372036854775807', active: true, payload: Uint8Array.from([0, 128, 255]) };
  assert.deepEqual(row, { ...expected, links: { recordId: 1 }, details: [{ id: 1, recordId: 1, body: 'required child' }] });
  assert.deepEqual(await db.defaults.create({ data: {} }), { id: 1, label: 'ready' });
  const joined = await db.records.findUniqueOrThrow({ where: { id }, with: { links: true, details: true } });
  const body: string = joined.details[0]!.body;
  const amount: number = joined.amount;
  const nullable: string | null = joined.memo;
  const exact: number | string = joined.exactValue;
  const bytes: Uint8Array = joined.payload;
  assert.equal(body, 'required child'); assert.equal(amount, expected.amount); assert.equal(nullable, null);
  assert.equal(exact, expected.exactValue); assert.deepEqual(bytes, expected.payload);
  assert.deepEqual(joined, { ...expected, links: { recordId: 1 }, details: [{ id: 1, recordId: 1, body: 'required child' }] });
  const note = await db.notes.create({ data: { body: 'optional parent', record: { connect: { id } } } });
  await db.notes.update({ where: { id: note.id }, data: { record: { disconnect: {} } } });
  assert.equal((await db.notes.findUniqueOrThrow({ where: { id: note.id } })).recordId, null);
  await db.notes.update({ where: { id: note.id }, data: { record: { connect: { id } } } });
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.records.update({ where: { id }, data: { title: 'rolled back' } });
    await tx.defaults.create({ data: { label: 'rolled back' } });
    throw new Error('rollback marker');
  }), /rollback marker/);
  assert.equal((await db.records.findUniqueOrThrow({ where: { id } })).title, 'first');
  assert.equal(await db.defaults.count(), 1);
  await db.$transaction(async (tx) => { await tx.records.update({ where: { id }, data: { memo: 'committed' } }); });
  await db.disconnect();
  assert.equal(handle.prepare('SELECT title FROM records').get()!.title, 'first');
  const nativeRows = handle.prepare('SELECT id,title,amount,memo,CAST(exact_value AS TEXT) AS exact_value,active,hex(payload) AS payload FROM records ORDER BY id').all();
  assert.deepEqual(nativeRows.map((value) => ({ ...value })), [{ id: 1, title: 'first', amount: 1.2345678901234567,
    memo: 'committed', exact_value: '9223372036854775807', active: 1, payload: '0080FF' }]);
  assert.deepEqual(handle.prepare('SELECT record_id FROM links').all().map((value) => ({ ...value })), [{ record_id: 1 }]);
  assert.deepEqual(handle.prepare('SELECT id,record_id,body FROM details').all().map((value) => ({ ...value })), [{ id: 1, record_id: 1, body: 'required child' }]);
  assert.deepEqual(handle.prepare('SELECT id,label FROM defaults').all().map((value) => ({ ...value })), [{ id: 1, label: 'ready' }]);
  handle.close(); callerClosed = true; assert.throws(() => handle.prepare('SELECT 1'));
  const owned = turbine(':memory:', { logger: {} }); await owned.disconnect();
  await assert.rejects(owned.records.findMany({ limit: 1 }), /closed|disconnect/i);
  console.log(JSON.stringify({ success: true, nativeRows, callerSurvived: true, callerClosed: true, ownedClosed: true, rollback: true }));
  } finally { await db.disconnect(); if (!callerClosed) handle.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;
    writeFileSync(join(dir, `app.${ext}`), valid);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false,
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], outDir: 'compiled' },
      include: [`app.${ext}`, 'generated/*.ts'] }));
    const positive = command([tsc, '-p', 'tsconfig.json', '--pretty', 'false']);
    if (omitted) {
      assert.notEqual(positive.status, 0);
      assert.match(positive.stdout, /TS2315: Type 'Record' is not generic/);
      assert.doesNotMatch(positive.stdout, /TS2307|TS2688|TS7016|Cannot find module/);
      report.omissionDetected = true;
    } else {
      assert.equal(positive.status, 0, positive.stdout + positive.stderr);
      const runtime = command([join(dir, 'compiled', format === 'esm' ? 'app.mjs' : 'app.cjs')]);
      assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
      report.native = JSON.parse(runtime.stdout.trim());
      const negatives = [
        "const bad: RecordCreateInput = { title: 12 };",
        "const bad: RecordCreateInput = { title: 'x', amount: 1, memo: null, exactValue: 1, active: true, payload: Buffer.alloc(0), details: { create: {} } };",
        "const bad: RecordNestedToOneUpdateInput = { disconnect: { id: true } };",
        "const bad: Parameters<TurbineClient['$withSession']>[0] = { nested: {} };",
        "const bad: Parameters<TurbineClient['$withSession']>[0] = { nullable: null };",
        "const bad: DefaultCreateInput = { label: 12 };",
        "declare const db: TurbineClient; db.records.findMany({ with: { missingRelation: true } });",
        "declare const db: TurbineClient; db.records.findMany({ select: { title: true } }).then(rows => rows[0]!.amount);",
        "const bad: Record = { id: 1, title: 'x', amount: 1, memo: 1, exactValue: 1, active: true, payload: Buffer.alloc(0) };",
      ];
      for (const [i, negative] of negatives.entries()) {
        writeFileSync(join(dir, `negative.${ext}`), typeChecks + '\n' + negative + '\n');
        writeFileSync(join(dir, 'tsconfig-negative.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], noEmit: true }, include: [`negative.${ext}`, 'generated/*.ts'] }));
        const args = [tsc, '-p', 'tsconfig-negative.json', '--pretty', 'false'];
        const result = command(args);
        assert.notEqual(result.status, 0, negative);
        assert.match(result.stdout, /negative\.(mts|cts)\(\d+,\d+\): error TS/);
        assert.doesNotMatch(result.stdout, /TS2307|TS2688|TS7016|Cannot find module|generated\/.+error TS/);
        report.negativeCases.push({ i, source: negative, diagnostics: result.stdout });
        writeFileSync(join(dir, `negative-${i}.${ext}.txt`), typeChecks + '\n' + negative + '\n');
      }
    }
    report.success = true;
  } finally {
    native.close();
    assert.throws(() => native.prepare('SELECT 1'));
    report.introspectionHandleClosed = true;
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, (_, value) => value instanceof Set ? [...value] : value, 2) + '\n');
  }
  return report;
}
