import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [format] = process.argv.slice(2);
assert.ok(['esm', 'cjs'].includes(format));
const req = createRequire(resolve('consumer.cjs'));
const manifest = JSON.parse(readFileSync('node_modules/turbine-orm/package.json', 'utf8'));
const load = async (subpath) =>
  format === 'cjs'
    ? req(subpath)
    : import(
        pathToFileURL(
          resolve(
            'node_modules/turbine-orm',
            manifest.exports[subpath === 'turbine-orm' ? '.' : './sqlite'].import.default,
          ),
        ).href
      );
const main = await load('turbine-orm'),
  sqlite = await load('turbine-orm/sqlite');
const example = resolve(format, 'examples/sqlite-durable-replay/replay.js');
const { SqliteOrderReplay } = format === 'cjs' ? req(example) : await import(pathToFileURL(example));
const { DatabaseSync } = req('node:sqlite');
const root = resolve(`generated-${format}`);
mkdirSync(root, { recursive: true });
const path = join(root, 'projection.db'),
  raw = new DatabaseSync(path);
raw.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=0');
const app = new SqliteOrderReplay(raw);
try {
  await app.initialize();
  await app.append({
    tenant: 'generated',
    eventId: 'stable',
    orderId: 'order',
    title: null,
    quantity: '9007199254740993',
    amount: '12.340000000001',
    occurredAt: '2024-02-29T12:34:56.123456Z',
    body: Uint8Array.of(0, 255),
  });
  const schema = sqlite.introspectSqliteDatabase(raw, { logger: {} });
  assert.equal(Object.keys(schema.tables).length, 5);
  main.generate({ schema, target: 'sqlite', noTimestamp: true, importExtension: 'js', outDir: root });
} finally {
  await app.close();
  raw.close();
}
writeFileSync(join(root, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
writeFileSync(
  join(root, 'use.ts'),
  `import assert from 'node:assert/strict';
import {turbine} from './index.js';
async function run(){
const db=turbine(process.argv[2]!,{logger:{}});
try{
const rows=await db.replayOutbox.findMany({where:{tenant:'generated'},select:{eventId:true,title:true,quantity:true,amount:true,occurredAt:true,body:true},orderBy:{position:'asc'}});
const title:string|null=rows[0]!.title;
const quantity:string=rows[0]!.quantity;
void [title,quantity];
assert.deepEqual(rows,[{eventId:'stable',title:null,quantity:'9007199254740993',amount:'12.340000000001',occurredAt:'2024-02-29T12:34:56.123456Z',body:Uint8Array.of(0,255)}]);
if(false){
// @ts-expect-error generated text precision contract
await db.replayOutbox.findMany({where:{quantity:2}});
// @ts-expect-error generated projection excludes orderId
rows[0]!.orderId;
// @ts-expect-error generated tenant predicate remains text
await db.replayOutbox.findMany({where:{tenant:4}});
}
}finally{await db.disconnect();}
console.log('strict generated projection passed');
}
void run().catch((error:unknown)=>{console.error(error);process.exitCode=1});
`,
);
writeFileSync(
  join(root, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      outDir: 'out',
      types: ['node'],
    },
    include: ['*.ts'],
  }),
);
console.log(JSON.stringify({ format, generated: root, database: path }));
