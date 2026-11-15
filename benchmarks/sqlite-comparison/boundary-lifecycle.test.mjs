/** Execute the actual boundary helper with tiny native fixtures, without timing. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import vm from 'node:vm';
import { turbineSqlite } from '../../dist/sqlite.js';

for (const mode of ['partial-open', 'cleanup-failure']) {
  test(`boundary helper owns every opened lane: ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boundary-'));
    const file = join(directory, 'fixture.db');
    const output = join(directory, 'report.json');
    const primary = new Error('original operation failure');
    const cleanup = new Error('lane cleanup failure');
    const clients = [], admins = [], events = [];
    const lane = (name) => {
      const client = turbineSqlite(file, { tables: {}, relations: [] }, { logger: {} });
      clients.push(client);
      return { kind: name, db: client, async close() {
        events.push(`close:${name}`);
        if (mode === 'cleanup-failure' && name === 'Drizzle RC') throw cleanup;
        await client.disconnect();
      } };
    };
    const fixtures = {
      async seedSqlite() { const db = new DatabaseSync(file); try { db.exec('CREATE TABLE items(v INTEGER)'); } finally { db.close(); } },
      nativeFixture: () => ({}),
      async openLane(name) { events.push(`open:${name}`); if (mode === 'partial-open' && name === 'Drizzle RC') throw primary; return lane(name); },
      openMatchedRc: () => lane('matched'),
      buildCatalog: () => { throw primary; }, disposeCatalog: () => {}, requiredIds: [], assertCatalog: () => {}, verifyScenarios: () => {},
    };
    // Peer metadata is irrelevant to this no-catalog lifecycle test. Do not
    // present this synthetic identity as native competitor evidence.
    const requireStub = () => ({ version: 'lifecycle-fixture-only' });
    requireStub.resolve = () => process.execPath;
    const context = vm.createContext({ process: { argv: [process.execPath, 'boundary', 'node', file, output, 'none'], version: process.version, execPath: process.execPath }, console: { log() {} } });
    const source = readFileSync(new URL('./sqlite-boundary.mjs', import.meta.url), 'utf8');
    const module = new vm.SourceTextModule(source, { context });
    try {
      await module.link(async (name) => {
        let values;
        if (name === 'node:module') values = { createRequire: () => requireStub };
        else if (name === 'node:sqlite') values = { DatabaseSync: class { constructor(...args) { const db = new DatabaseSync(...args); admins.push(db); return db; } } };
        else values = name.startsWith('node:') ? await import(name) : fixtures;
        const keys = Object.keys(values);
        return new vm.SyntheticModule(keys, function () { for (const key of keys) this.setExport(key, values[key]); }, { context });
      });
      await assert.rejects(module.evaluate(), (error) => error === primary);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      if (mode === 'partial-open') {
        assert.deepEqual(events, ['open:Turbine', 'open:Drizzle RC', 'close:Turbine']);
        assert.equal(clients[0].pool.db.isOpen, false);
        assert.equal(report.closed, true);
        assert.equal(existsSync(file), false);
      } else {
        assert.deepEqual(events.filter((event) => event.startsWith('close:')), ['close:matched', 'close:Raw', 'close:Drizzle RC', 'close:Turbine']);
        assert.equal(clients[0].pool.db.isOpen, false);
        assert.equal(clients[1].pool.db.isOpen, true);
        assert.equal(report.closed, false);
        assert.equal(report.cleanupErrors.length, 1);
        assert.equal(existsSync(file), true);
      }
      assert.ok(admins.every((db) => !db.isOpen));
    } finally {
      // The deliberate close fault leaves a known real handle for this fixture
      // alone to close. Never delete its files while a handle is still open.
      for (const client of clients) await client.disconnect();
      for (const db of admins) if (db.isOpen) db.close();
      assert.ok(clients.every((client) => !client.pool.db.isOpen));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
