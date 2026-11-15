import { PrismaD1 } from '@prisma/adapter-d1';
import { drizzle } from 'drizzle-orm/d1';
import { drizzle as drizzleRc } from 'drizzle-rc/d1';
import { turbine } from 'optional-generated-factory';
import { PrismaClient } from 'optional-prisma';
import { introspectD1 } from 'turbine-orm/d1/introspect';
import { assertExact, runContract, seedStatements, seedTables, volumes } from './optional-sqlite-contract.mjs';
import { lanesFor, resetFor } from './optional-sqlite-lanes.mjs';
import { ddl } from './sqlite-seed.ts';

const check = (value, message) => {
  if (!value) throw new Error(message);
};
async function refuses(fn, pattern) {
  try {
    await fn();
  } catch (error) {
    check(pattern.test(String(error)), String(error));
    return String(error);
  }
  throw new Error('Expected refusal');
}
export default {
  async fetch(request, env) {
    let prisma, db;
    try {
      const raw = async (sql) => (await env.DB.prepare(sql).all()).results;
      const sqliteVersion = async () => {
        try {
          return { available: true, rows: await raw('SELECT sqlite_version() version') };
        } catch (error) {
          return {
            available: false,
            reason: String(error),
            scope: 'actual D1 authorizer; no replacement Node SQLite version inferred',
          };
        }
      };
      const url = new URL(request.url);
      if (url.pathname === '/catalog') {
        for (const sql of ddl
          .split(';')
          .map((sql) => sql.trim())
          .filter(Boolean))
          await env.DB.prepare(sql).run();
        const statements = seedStatements();
        for (let i = 0; i < statements.length; i += 100)
          await env.DB.batch(statements.slice(i, i + 100).map((s) => env.DB.prepare(s.sql).bind(...s.args)));
        const schema = await introspectD1(env.DB);
        const counts = {};
        for (const table of seedTables) {
          counts[table] = (await raw(`SELECT count(*) n FROM ${table}`))[0].n;
          check(counts[table] === volumes[table], `seed ${table}`);
        }
        const transportedSchema = JSON.parse(
          JSON.stringify(schema, (_, value) => (value instanceof Set ? { $optionalSet: [...value] } : value)),
        );
        return Response.json({ schema: transportedSchema, counts, version: await sqliteVersion() });
      }
      const options = await request.json();
      const schema = await introspectD1(env.DB);
      db = turbine(env.DB, { warnOnUnlimited: false, logger: {} }, schema);
      prisma = new PrismaClient({ adapter: new PrismaD1(env.DB) });
      const lanes = lanesFor(raw, db, drizzle(env.DB), drizzleRc(env.DB), prisma);
      const result = await runContract(lanes, resetFor(raw), options);
      const controls = [];
      const record = (id, details) => controls.push({ id, passed: true, ...details });
      // These are native atomic batches. No callback transaction is inferred.
      await env.DB.batch([
        env.DB.prepare("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'batch','one')"),
        env.DB.prepare("UPDATE bench_writes SET label='two' WHERE id=1"),
      ]);
      check((await raw('SELECT label FROM bench_writes'))[0].label === 'two', 'batch order');
      await raw('DELETE FROM bench_writes');
      await refuses(
        () =>
          env.DB.batch([
            env.DB.prepare("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'batch','one')"),
            env.DB.prepare("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'duplicate','two')"),
          ]),
        /UNIQUE|constraint/i,
      );
      check((await raw('SELECT count(*) n FROM bench_writes'))[0].n === 0, 'native batch rollback');
      record('raw-native-batch-order-rollback', {});
      for (const [name, orm] of [
        ['Turbine', db],
        ['Drizzle 0.45.4', drizzle(env.DB)],
        ['Drizzle RC 1.0.0-rc.5', drizzleRc(env.DB)],
      ]) {
        if (name === 'Turbine') {
          await db.$batchRaw([
            { sql: "INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'batch','one')" },
            { sql: "UPDATE bench_writes SET label='two' WHERE id=1" },
          ]);
          check((await raw('SELECT label FROM bench_writes'))[0].label === 'two', `${name} native order`);
          await raw('DELETE FROM bench_writes');
          await refuses(
            () =>
              db.$batchRaw([
                { sql: "INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'batch','one')" },
                { sql: "INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'duplicate','two')" },
              ]),
            /UNIQUE|constraint/i,
          );
        } else {
          // Actual ORM batch API using the arm's own SQL implementation.
          const sql = name.includes('RC') ? (await import('drizzle-rc')).sql : (await import('drizzle-orm')).sql;
          await orm.batch([
            orm.run(sql.raw("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'batch','one')")),
            orm.run(sql.raw("UPDATE bench_writes SET label='two' WHERE id=1")),
          ]);
          check((await raw('SELECT label FROM bench_writes'))[0].label === 'two', `${name} native order`);
          await raw('DELETE FROM bench_writes');
          await refuses(
            () =>
              orm.batch([
                orm.run(sql.raw("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'batch','one')")),
                orm.run(sql.raw("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(1,1,'duplicate','two')")),
              ]),
            /UNIQUE|constraint/i,
          );
          record(`${name}/interactive-refused`, {
            error: await refuses(
              () =>
                orm.transaction(async (tx) =>
                  tx.run(sql.raw("INSERT INTO bench_writes(id,org_id,slug,label) VALUES(2,1,'interactive','refused')")),
                ),
              /transaction|savepoint|BEGIN|D1_ERROR/i,
            ),
          });
        }
        check((await raw('SELECT count(*) n FROM bench_writes'))[0].n === 0, `${name} native rollback`);
        record(`${name}/native-batch-rollback`, { orderedSuccess: true });
      }
      record('turbine-interactive-refused', {
        error: await refuses(() => db.$transaction(async () => 0), /transaction|session|support/i),
      });
      record('turbine-stream-refused', {
        error: await refuses(() => db.table('users').findManyStream().next(), /cursor|stream|support/i),
      });
      const cancellation = new AbortController();
      cancellation.abort();
      record('turbine-pre-dispatch-abort', {
        error: await refuses(() => db.$batchRaw([{ sql: 'SELECT 1' }], { signal: cancellation.signal }), /abort/i),
      });
      // The client rejects callbacks; the adapter's array transaction executes
      // queries individually. Retain the actual partial write as a loss.
      record('prisma7-d1-interactive-refused', {
        error: await refuses(() => prisma.$transaction(async () => 0), /does not support interactive transactions/i),
      });
      await refuses(
        () =>
          prisma.$transaction([
            prisma.benchWrite.create({ data: { id: 1, orgId: 1, slug: 'prisma-no-tx', label: 'survives' } }),
            prisma.benchWrite.create({ data: { id: 1, orgId: 1, slug: 'duplicate', label: 'fails' } }),
          ]),
        /Unique|constraint/i,
      );
      const survived = (await raw('SELECT slug FROM bench_writes')).map((row) => row.slug);
      assertExact('Prisma7 D1 transaction caveat', survived, ['prisma-no-tx']);
      await raw('DELETE FROM bench_writes');
      record('prisma7-d1-no-rollback-guarantee', {
        survivingWrites: survived,
        classification: 'unsupported array transaction atomic guarantee',
      });
      await db.disconnect();
      check((await raw('SELECT 1 n'))[0].n === 1, 'caller binding remains open');
      record('turbine-caller-binding-ownership', {});
      await refuses(() => db.rawUnsafe('SELECT 1'), /disconnect|closed/i);
      return Response.json({
        ...result,
        controls,
        generatedFactory: options.generatedFactory,
        sqlite: await sqliteVersion(),
        cleanup: {
          writesEmpty: (await raw('SELECT count(*) n FROM bench_writes'))[0].n === 0,
          facadeClosed: true,
          bindingCallerOwned: true,
        },
      });
    } catch (error) {
      return Response.json({ error: error.stack ?? String(error) }, { status: 500 });
    } finally {
      await prisma?.$disconnect();
      await db?.disconnect();
    }
  },
};
