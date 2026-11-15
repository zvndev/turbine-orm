/** Observable native-driver boundary checks against an installed package. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const tools = await import(pathToFileURL(process.argv[2]).href);
const mode = process.env.MSSQL_TOOLS_MODE ?? '';
const events = () => readFileSync(process.env.MSSQL_TOOLS_LOG, 'utf8').trim().split('\n').map(JSON.parse);
const schema = mode === 'hostile-schema' ? "quoted]' ; DROP TABLE x; --" : 'app';
const pool = tools.createMssqlToolPool(mode === 'hostile-schema' ? 'mssql://host/hostile' : 'mssql://host/fixture', schema);
assert.equal(tools.mssqlToolRuntime().available, mode !== 'no-driver');
if (mode === 'no-driver') {
  await assert.rejects(pool.connect(), /optional peer/);
  await pool.end();
} else if (['connect-fail', 'pool-error'].includes(mode)) {
  await assert.rejects(pool.connect(), (error) => /connection failed/.test(error.message) && !/private/.test(error.message));
  await pool.end();
  assert.equal(events().filter((event) => event.event === 'close').length, 1);
} else if (mode === 'connect-delay') {
  const opening = pool.connect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const refused = assert.rejects(opening, /closed/);
  await pool.end();
  await refused;
  assert.equal(events().filter((event) => event.event === 'close').length, 1);
} else {
  const client = await pool.connect();
  assert.throws(() => client.query('SELECT * FROM users'), /fixed catalog/);
  assert.throws(() => client.query('SET TRANSACTION ISOLATION LEVEL SNAPSHOT'), /fixed catalog/);
  if (mode === 'query-fail') {
    await assert.rejects(tools.introspectMssqlToolClient(client, {}), (error) => /catalog read failed/.test(error.message) && !/private/.test(error.message));
  } else if (mode === 'query-delay') {
    const work = tools.introspectMssqlToolClient(client, {});
    await assert.rejects(tools.introspectMssqlToolClient(client, {}), /already active/);
    const rejected = assert.rejects(work, /released|catalog read failed/);
    await tools.releaseMssqlToolClient(client);
    await rejected;
  } else {
    const metadata = await tools.introspectMssqlToolClient(client, {});
    assert.deepEqual(Object.keys(metadata.tables), ['posts', 'users']);
    assert.equal(metadata.tables.users.columns.find((column) => column.name === 'id').isGenerated, true);
    assert.equal(metadata.tables.users.columns.find((column) => column.name === 'derived').isGeneratedStored, true);
    assert.equal(metadata.tables.users.columns.find((column) => column.name === 'display_name').hasDefault, true);
    assert.equal(metadata.tables.posts.relations.user.to, 'users');
    const index = metadata.tables.users.indexes[0];
    const summary = tools.mssqlToolIndexSummary(index);
    assert.equal(summary.partial, true);
    assert.equal(summary.computed, true);
    assert.equal(summary.hypothetical, true);
    assert.deepEqual(summary.includedColumns, ['email']);
    assert.doesNotMatch(JSON.stringify(metadata), /private-default|private-computed|private-filter/);
    assert.equal(summary.definition, '(definition withheld)');
    assert.equal(summary.definitionWithheld, true);
    const filtered = await tools.introspectMssqlToolClient(client, { include: ['users'] });
    assert.deepEqual(Object.keys(filtered.tables), ['users']);
  }
  if (mode === 'close-fail') {
    await assert.rejects(tools.releaseMssqlToolClient(client), /cleanup failed/);
    await assert.rejects(pool.end(), /cleanup failed/);
  } else {
    await tools.releaseMssqlToolClient(client);
    client.release();
    await tools.releaseMssqlToolClient(client);
    await pool.end();
    await pool.end();
  }
  await assert.rejects(tools.introspectMssqlToolClient(client, {}), /active owned/);
  assert.equal(events().filter((event) => event.event === 'close').length, 1);
  assert.equal(events().at(-1).event, 'close');
}
if (mode !== 'no-driver') {
  const all = events();
  assert.equal(all.filter((event) => event.event === 'construct').length, 1);
  assert.ok(all.findIndex((event) => event.event === 'on') < all.findIndex((event) => event.event === 'connect'));
  const reads = all.filter((event) => event.event === 'query');
  if (!['connect-delay', 'connect-fail', 'pool-error'].includes(mode)) assert.ok(reads.length > 0);
  for (const read of reads) {
    assert.match(read.sql, /^\s*SELECT /);
    assert.match(read.sql, /(?:sys\.|INFORMATION_SCHEMA\.)/);
    assert.deepEqual(read.params, { p1: schema });
    assert.doesNotMatch(read.sql, /BEGIN|COMMIT|ROLLBACK|SET /);
  }
}
console.log('SQL Server driver boundary checks passed: ' + (mode || 'normal'));
