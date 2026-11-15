/** Installed project-workflow controls for preserving existing files. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function preservation({ consumer, bins, run, report }) {
  const { createClient } = await import(pathToFileURL(join(consumer, 'node_modules/@libsql/client/lib-esm/node.js')));
  const snapshot = (dir, prefix = '') =>
    Object.fromEntries(
      readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
        const name = `${prefix}${item.name}`,
          path = join(dir, item.name);
        if (item.isSymbolicLink()) return [[name, `symlink:${readlinkSync(path)}`]];
        if (item.isDirectory()) return [[`${name}/`, 'directory'], ...Object.entries(snapshot(path, `${name}/`))];
        return [[name, createHash('sha256').update(readFileSync(path)).digest('hex')]];
      }),
    );
  const retained = async (file, initialize = false) => {
    const db = createClient({ url: pathToFileURL(file).href, intMode: 'bigint' });
    try {
      if (initialize)
        await db.executeMultiple(
          "CREATE TABLE retained(id INTEGER PRIMARY KEY, content TEXT NOT NULL); INSERT INTO retained VALUES(1,'must survive generation');",
        );
      assert.equal((await db.execute('SELECT content FROM retained WHERE id=1')).rows[0][0], 'must survive generation');
    } finally {
      db.close();
      assert.equal(db.closed, true);
    }
  };
  report.preservation = [];
  const failures = [];
  const check = async (details, dir, fn) => {
    const before = snapshot(dir);
    try {
      await fn();
      assert.deepEqual(snapshot(dir), before, 'Refusal must preserve all files, directories and aliases');
      report.preservation.push({ ...details, passed: true });
    } catch (error) {
      failures.push(error);
      report.preservation.push({
        ...details,
        passed: false,
        error: String(error?.stack ?? error),
        before,
        after: snapshot(dir),
      });
    }
  };
  for (const [binIndex, bin] of bins.entries()) {
    for (const leaf of ['index.ts', 'types.ts', 'metadata.ts'])
      for (const alias of ['direct', 'hardlink', 'parent-link']) {
        const dir = join(consumer, `preserve-${binIndex}-${leaf}-${alias}`),
          out = join(dir, 'generated');
        mkdirSync(out, { recursive: true });
        writeFileSync(
          join(dir, 'NO-GIT-FIXTURE'),
          'Generated destinations must never overwrite the selected native database or aliases.\n',
        );
        const database = alias === 'hardlink' ? join(dir, 'app.sqlite') : join(out, leaf);
        await retained(database, true);
        if (alias === 'hardlink') linkSync(database, join(out, leaf));
        if (alias === 'parent-link') symlinkSync(out, join(dir, 'db-alias'));
        for (const name of ['index.ts', 'types.ts', 'metadata.ts'])
          if (name !== leaf) writeFileSync(join(out, name), `preserve ${name}\n`);
        const url = pathToFileURL(alias === 'parent-link' ? join(dir, 'db-alias', leaf) : database).href;
        writeFileSync(
          join(dir, 'turbine.config.mjs'),
          `export default ${JSON.stringify({ engine: 'libsql', url, out: './generated' })};\n`,
        );
        await check({ control: 'generate-destination', bin: binIndex, leaf, alias }, dir, async () => {
          const output = await run(dir, process.execPath, [bin, 'generate', '--no-timestamp'], 1);
          assert.match(output, /database|destination|generated|same|symlink|alias|collision/i);
          await retained(database);
        });
      }
    for (const [label, extra] of [
      ['column-types', { columnTypes: { 'absent.col': 'string' } }],
      ['malformed-column-types', { columnTypes: { malformed: 'string' } }],
    ]) {
      const dir = join(consumer, `init-preserve-${binIndex}-${label}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'NO-GIT-FIXTURE'), 'Init generation failures must precede persistent effects.\n');
      writeFileSync(join(dir, 'package.json'), '{"private":true}');
      writeFileSync(
        join(dir, 'turbine.config.mjs'),
        `export default ${JSON.stringify({ engine: 'libsql', url: 'file:./nested/new.sqlite', out: './generated', ...extra })};\n`,
      );
      await check({ control: 'init-generation', bin: binIndex, label }, dir, async () => {
        const output = await run(dir, process.execPath, [bin, 'init', '--yes'], 1);
        assert.match(output, /columnTypes|import|extension/i);
        assert.equal(existsSync(join(dir, 'nested/new.sqlite')), false);
      });
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} installed preservation controls failed`);
}
