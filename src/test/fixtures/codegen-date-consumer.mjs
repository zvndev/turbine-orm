import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [root, format, label] = process.argv.slice(2);
assert.ok(root && ['esm', 'cjs'].includes(format) && label);
process.chdir(root);
const require = createRequire(join(root, 'package.json'));
const packageRoot = join(root, 'node_modules/turbine-orm');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json')));
const condition = format === 'esm' ? 'import' : 'require';
const load = async (entry) => {
  const file = join(packageRoot, manifest.exports[entry][condition].default);
  return format === 'esm' ? import(pathToFileURL(file).href) : require(file);
};
const orm = await load('.');
const sqlite = await load('./sqlite');
const dir = join(root, label);
mkdirSync(dir);
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = {
  node: process.version,
  sqlite: process.versions.sqlite,
  format,
  condition,
  packageRoot,
  commands: [],
  generated: {},
  success: false,
};
const run = (args, cwd = dir) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120000 });
  const record = {
    binary: process.execPath,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  };
  report.commands.push(record);
  return record;
};
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const flags = [
  '--strict',
  '--skipLibCheck',
  'false',
  '--exactOptionalPropertyTypes',
  '--noUncheckedIndexedAccess',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--target',
  'ES2023',
  '--types',
  'node',
];
const compile = (files, emit = false) =>
  run([tsc, ...flags, ...(emit ? ['--outDir', 'output'] : ['--noEmit']), ...files]);
const schemaSql = `
CREATE TABLE dates(id INTEGER PRIMARY KEY,title TEXT NOT NULL);
CREATE TABLE events(id INTEGER PRIMARY KEY,date_id INTEGER NOT NULL REFERENCES dates(id),at TIMESTAMP NOT NULL,maybe DATETIME,day DATE NOT NULL DEFAULT '2026-11-08',clock TIME NOT NULL DEFAULT '00:00:00',count INTEGER NOT NULL DEFAULT 7,amount REAL NOT NULL DEFAULT 0.1,flag BOOLEAN NOT NULL DEFAULT 1,payload JSON NOT NULL DEFAULT '{"ok":true}',data BLOB NOT NULL DEFAULT X'0001');
CREATE TABLE notes(id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL REFERENCES events(id),body TEXT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT '2026-11-08T01:02:03.004Z');
CREATE TABLE records(id INTEGER PRIMARY KEY,title TEXT NOT NULL);
CREATE TABLE empty_rows(id INTEGER PRIMARY KEY);
`;
try {
  const path = join(root, '..', 'native', `${label}-${format}.sqlite`);
  report.nativePath = path;
  const handle = new DatabaseSync(path);
  try {
    handle.exec(schemaSql);
    const schema = sqlite.introspectSqliteDatabase(handle);
    report.catalog = handle.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    report.schema = schema;
    orm.generate({ schema, target: 'sqlite', outDir: join(dir, 'generated'), noTimestamp: true, logger: {} });
    for (const file of ['index.ts', 'types.ts', 'metadata.ts'])
      report.generated[file] = sha(join(dir, 'generated', file));
    report.relations = Object.fromEntries(
      Object.entries(schema.tables).map(([name, table]) => [name, table.relations]),
    );
  } finally {
    handle.close();
    report.catalogHandleClosed = true;
  }
  writeFileSync(
    join(dir, 'positive.ts'),
    `
import { turbine } from './generated/index.js';
import type { Date as EntityDate, Event, EventCreate, EventUpdate, DateCreateInput, EventNestedCreateInput, EmptyRowCreateInput } from './generated/types.js';
const at = new Date('2026-11-08T01:02:03.004Z');
const entity: EntityDate = { id: 1, title: 'entity' };
declare const row: Event;
const value: globalThis.Date = row.at;
const time: number = row.at.getTime();
const maybe: globalThis.Date | null = row.maybe;
const create: EventCreate = { dateId: entity.id, at, clock: at, maybe: null };
const update: EventUpdate = { at: { set: at }, clock: at, maybe: at };
const nested: DateCreateInput = { title: 'nested', events: { create: { at, clock: at } } };
const standalone: EventNestedCreateInput = { create: { dateId: 1, at } };
const empty: EmptyRowCreateInput = {};
const db = turbine(':memory:', { logger: {} });
const promise = db.events.findMany({ with: { notes: true } }).then(rows => rows.map(r => [r.at.getTime(),r.notes.map(n => n.createdAt.getTime())]));
void [value,time,maybe,create,update,nested,standalone,empty,promise];
`,
  );
  const positive = compile(['positive.ts']);
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  writeFileSync(
    join(dir, 'negative.ts'),
    `
import type { Event, EventCreate, EventUpdate, DateCreateInput, EmptyRowCreateInput } from './generated/types.js';
const entity = { id: 1, title: 'entity' };
const a: Event['at'] = entity;
const b: EventCreate = { dateId: 1, at: entity };
const c: EventUpdate = { at: { set: entity } };
const d: EventCreate = { dateId: 1, at: new Date(), clock: entity };
const e: EventCreate = { dateId: 1, at: 42 };
const f: EventCreate = { dateId: 1, at: new Date(), maybe: entity };
const g: DateCreateInput = { title: 'nested', events: { create: { at: entity } } };
const h: EmptyRowCreateInput = { unexpected: 1 };
const i: Event['at'] = null;
void [a,b,c,d,e,f,g,h,i];
`,
  );
  const negative = compile(['negative.ts']);
  assert.equal(negative.status, 2, negative.stdout + negative.stderr);
  assert.doesNotMatch(negative.stdout + negative.stderr, /TS2307|TS2591|TS2688/);
  for (let line = 4; line <= 12; line++) assert.match(negative.stdout, new RegExp(`negative.ts\\(${line},`));
  report.unmarkedNegativeLines = 9;
  writeFileSync(
    join(dir, 'native.ts'),
    `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { turbine } from './generated/index.js';
const path = ${JSON.stringify(path)};
const at = new Date('2026-11-08T01:02:03.004Z');
const later = new Date('2026-11-09T23:59:58.123Z');
const handle = new DatabaseSync(path);
const db = turbine(handle,{logger:{}});
const result: Record<string, unknown> = {};
try {
  const created = await db.dates.create({data:{title:'parent',events:{create:{at,clock:at,notes:{create:{body:'note'}}}}}});
  assert.equal(created.id,1);assert.equal(created.title,'parent');
  const parent = await db.dates.findUniqueOrThrow({where:{id:1},with:{events:{with:{notes:true}}}});
  assert.deepEqual(created,parent);assert.equal(parent.id,1);assert.equal(parent.title,'parent');assert.equal(parent.events.length,1);
  const event = parent.events[0];assert.ok(event);assert.equal(event.notes.length,1);
  const note=event.notes[0];assert.ok(note);assert.deepEqual(note,{id:1,eventId:1,body:'note',createdAt:at});
  assert.deepEqual(event,{id:1,dateId:1,at,maybe:null,day:new Date('2026-11-08T00:00:00.000Z'),clock:'01:02:03.004',count:7,amount:0.1,flag:true,payload:{ok:true},data:new Uint8Array([0,1]),notes:[note]});
  const changed=await db.events.update({where:{id:1},data:{at:{set:later},maybe:at,clock:later,count:{increment:2}}});
  assert.deepEqual(changed,{id:1,dateId:1,at:later,maybe:at,day:new Date('2026-11-08T00:00:00.000Z'),clock:'23:59:58.123',count:9,amount:0.1,flag:true,payload:{ok:true},data:new Uint8Array([0,1])});
  await assert.rejects(db.$transaction(async tx=>{await tx.events.update({where:{id:1},data:{at,maybe:null}});await tx.records.create({data:{title:'rolled back'}});throw new Error('rollback-control');}),/rollback-control/);
  assert.equal((await db.events.findUniqueOrThrow({where:{id:1}})).at.getTime(),later.getTime());assert.equal(await db.records.count(),0);
  await db.$transaction(async tx=>{await tx.events.update({where:{id:1},data:{maybe:null}});await tx.records.create({data:{title:'committed'}});});
  const final=await db.dates.findMany({orderBy:{id:'asc'},with:{events:{with:{notes:true}}}});
  assert.deepEqual(final,[{id:1,title:'parent',events:[{...changed,maybe:null,notes:[note]}]}]);
  assert.deepEqual(await db.records.findMany(),[{id:1,title:'committed'}]);
  assert.deepEqual(await db.emptyRows.create({data:{}}),{id:1});
  const stored=handle.prepare('SELECT * FROM events ORDER BY id').all();
  assert.deepEqual(stored.map(r=>({...r})),[{id:1,date_id:1,at:'2026-11-09T23:59:58.123Z',maybe:null,day:'2026-11-08',clock:'23:59:58.123',count:9,amount:0.1,flag:1,payload:'{"ok":true}',data:new Uint8Array([0,1])}]);
  result.final=final;result.stored=stored;result.rollback=true;result.commit=true;
  await db.disconnect();assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM events').get()?.n,1);result.callerSurvivedDisconnect=true;
} finally {await db.disconnect();handle.close();result.callerClosed=true;}
const owned=turbine(path,{logger:{}});assert.equal((await owned.events.findMany()).length,1);await owned.disconnect();await assert.rejects(owned.events.findMany());result.factoryClosed=true;
writeFileSync(${JSON.stringify(join(dir, 'native-report.json'))},JSON.stringify(result,null,2)+'\\n');
`,
  );
  // CJS compilation keeps generated sources original; async execution lives in a function.
  if (format === 'cjs') {
    const file = join(dir, 'native.ts');
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('const path =');
    writeFileSync(
      file,
      `${source.slice(0, start)}async function main() {\n${source.slice(start)}\n}\nmain().catch(error=>{console.error(error);process.exitCode=1;});\n`,
    );
  }
  const emitted = compile(['native.ts'], true);
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
  const executed = run([join(dir, 'output/native.js')]);
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  report.native = JSON.parse(readFileSync(join(dir, 'native-report.json')));
  for (const [file, hash] of Object.entries(report.generated)) assert.equal(sha(join(dir, 'generated', file)), hash);
  report.generatedOriginalsUnchanged = true;
  report.success = true;
} finally {
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
