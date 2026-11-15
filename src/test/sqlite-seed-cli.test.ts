/** Actual SQLite seed processes: effects and exits, including refusal before import. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const [major, minor] = process.versions.node.split('.').map(Number);
const sqlite = skipGate(
  !native || major! < 22 || (major === 22 && minor! < 12),
  'SQLite seed CLI requires node:sqlite (Node >=22.12)',
);
const writer = skipGate(
  typeof (native?.DatabaseSync.prototype as { setAuthorizer?: unknown } | undefined)?.setAuthorizer !== 'function',
  'SQLite migration writer requires Node >=24.10 for the fresh-project seed workflow',
);

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawnSync(
    process.execPath,
    ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'src/cli/index.ts'), ...args],
    {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1', ...env },
    },
  );
  return { status: child.status, output: `${child.stdout}\n${child.stderr}\n${child.error ?? ''}` };
}

function project(fn: (dir: string, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-seed-cli-'));
  try {
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const file = join(dir, 'app.sqlite');
    const db = new native!.DatabaseSync(file);
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    db.close();
    writeFileSync(join(dir, 'turbine.config.mjs'), "export default { engine: 'sqlite', url: './app.sqlite' };\n");
    fn(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function labels(file: string) {
  const db = new native!.DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare('SELECT label FROM items ORDER BY id')
      .all()
      .map((row) => row.label);
  } finally {
    db.close();
  }
}

describe('SQLite seed actual CLI', () => {
  writer.it('runs the documented fresh init, migrate, generate and repeatable seed workflow', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-fresh-seed-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
    for (const args of [
      ['init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes'],
      ['migrate', 'up'],
      ['generate'],
    ]) {
      const result = run(dir, args);
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.output}`);
    }
    writeFileSync(
      join(dir, 'seed.ts'),
      `import { defineSqliteSeed } from ${JSON.stringify(join(repo, 'src/sqlite-seed.ts'))};
      export default defineSqliteSeed(async (tx) => {
        await tx.raw\`INSERT INTO users (email, display_name) VALUES (${'${'}'demo@example.test'}, ${'${'}'Demo user'})
          ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name\`;
      });`,
    );
    for (let i = 0; i < 2; i++) {
      const seeded = run(dir, ['seed']);
      assert.equal(seeded.status, 0, seeded.output);
      assert.match(seeded.output, /Seed completed/);
    }
    const db = new native!.DatabaseSync(join(dir, 'app.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT email, display_name FROM users').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.email, 'demo@example.test');
      assert.equal(rows[0]!.display_name, 'Demo user');
    } finally {
      db.close();
    }
  });
  sqlite.it('never reaches a PostgreSQL listener when seed config is unreadable or selects SQLite', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-seed-no-pg-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const url = `postgres://127.0.0.1:${(server.address() as AddressInfo).port}/never-connect`;
    for (const config of [
      "throw new Error('unreadable seed config');",
      "export default { engine: 'sqlite', url: './app.sqlite' };",
    ]) {
      writeFileSync(join(dir, 'turbine.config.mjs'), config);
      const child = spawn(
        process.execPath,
        ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'src/cli/index.ts'), 'seed'],
        {
          cwd: dir,
          env: { ...process.env, DATABASE_URL: url, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const [code] = await once(child, 'close');
      assert.equal(code, 1, output);
      assert.match(output, /Refusing to select a database engine|PostgreSQL connection string/);
      assert.equal(connections, 0, output);
    }
  });
  sqlite.it('executes discovered callbacks once in ESM/CommonJS JS and TS modules across independent processes', () => {
    for (const [type, ext] of [
      ['module', 'js'],
      ['commonjs', 'js'],
      ['module', 'ts'],
      ['commonjs', 'ts'],
      ['module', 'mts'],
      ['commonjs', 'cts'],
      ['module', 'mjs'],
      ['commonjs', 'cjs'],
    ]) {
      project((dir, file) => {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ type }));
        const seed = `seed.${ext}`;
        const typed = ext!.endsWith('ts')
          ? `: import(${JSON.stringify(join(repo, 'src/sqlite-seed.ts'))}).SqliteSeedFunction`
          : '';
        const fn = `async (tx) => { await tx.raw\`INSERT INTO items VALUES (1, 'once')\`; }`;
        const source =
          type === 'commonjs' && ['js', 'cjs'].includes(ext!)
            ? `module.exports = ${fn};`
            : `const seed${typed} = ${fn}; export default seed;`;
        writeFileSync(join(dir, seed), source);
        // Explicit extension variants use the same existing seedFile selector.
        if (!['js', 'ts'].includes(ext!))
          writeFileSync(
            join(dir, 'turbine.config.mjs'),
            `export default { engine: 'sqlite', url: './app.sqlite', seedFile: './${seed}' };`,
          );
        const first = run(dir, ['s']);
        assert.equal(first.status, 0, `${type}/${ext}: ${first.output}`);
        assert.match(first.output, /Seed completed/);
        assert.deepEqual(labels(file), ['once']);
        const second = run(dir, ['seed']);
        assert.equal(second.status, 1, second.output);
        assert.doesNotMatch(second.output, /Seed completed/);
        assert.deepEqual(labels(file), ['once']);
      });
    }
  });

  sqlite.it('rolls back writes after callback failure, preserves module side effects and reruns successfully', () => {
    project((dir, file) => {
      const seed = join(dir, 'seed.js');
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(
        seed,
        `import { writeFileSync } from 'node:fs'; writeFileSync('./imported', 'outside transaction'); export default async (tx) => { await tx.raw\`INSERT INTO items VALUES (1, 'failed')\`; throw new Error('callback boom'); };`,
      );
      const failed = run(dir, ['seed']);
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, /callback boom/);
      assert.doesNotMatch(failed.output, /Seed completed/);
      assert.deepEqual(labels(file), []);
      assert.equal(readFileSync(join(dir, 'imported'), 'utf8'), 'outside transaction');
      writeFileSync(seed, `export default async (tx) => { await tx.raw\`INSERT INTO items VALUES (1, 'rerun')\`; };`);
      const rerun = run(dir, ['seed']);
      assert.equal(rerun.status, 0, rerun.output);
      assert.deepEqual(labels(file), ['rerun']);
    });
  });

  sqlite.it('honors seedFile over seed, URL overrides over env/config, and the legacy seed alias', () => {
    project((dir, file) => {
      writeFileSync(
        join(dir, 'chosen.cjs'),
        "module.exports = async tx => { await tx.raw`INSERT INTO items VALUES (1, 'chosen')`; };",
      );
      writeFileSync(join(dir, 'wrong.cjs'), "throw new Error('wrong seed selected');");
      writeFileSync(
        join(dir, 'turbine.config.mjs'),
        "export default { engine: 'sqlite', url: './wrong.sqlite', seedFile: './chosen.cjs', seed: './wrong.cjs' };",
      );
      const overridden = run(dir, ['seed', '--url', pathToFileURL(file).href], {
        DATABASE_URL: 'postgres://127.0.0.1:1/never-connect',
      });
      assert.equal(overridden.status, 0, overridden.output);
      assert.deepEqual(labels(file), ['chosen']);
      assert.equal(existsSync(join(dir, 'wrong.sqlite')), false);
      writeFileSync(
        join(dir, 'turbine.config.mjs'),
        "export default { engine: 'sqlite', url: './app.sqlite', seed: './chosen.cjs' };",
      );
      writeFileSync(
        join(dir, 'chosen.cjs'),
        "module.exports = async tx => { await tx.raw`INSERT INTO items VALUES (2, 'legacy')`; };",
      );
      const legacy = run(dir, ['seed']);
      assert.equal(legacy.status, 0, legacy.output);
      assert.deepEqual(labels(file), ['chosen', 'legacy']);
    });
  });

  sqlite.it('refuses preview, PG-only/inert flags and positional arguments before importing a module', () => {
    project((dir, file) => {
      writeFileSync(
        join(dir, 'seed.js'),
        "require('node:fs').writeFileSync('./imported', 'bad'); module.exports = () => {};",
      );
      const before = readFileSync(file);
      for (const args of [
        ['--dry-run'],
        ['--preview'],
        ['--schema', 'main'],
        ['--schema'],
        ['--schema-file', 'schema.ts'],
        ['--allow-pooler'],
        ['--force'],
        ['--out', './generated'],
        ['--out'],
        ['--include', 'items'],
        ['--exclude', 'items'],
        ['unexpected'],
        ['--verbose', 'unexpected'],
        ['--url'],
      ]) {
        const result = run(dir, ['seed', ...args]);
        assert.equal(result.status, 1, `${args.join(' ')}: ${result.output}`);
        assert.match(result.output, /Unknown flag|does not support|no positional|requires a persistent/);
        assert.equal(existsSync(join(dir, 'imported')), false);
        assert.deepEqual(readFileSync(file), before);
      }
      const help = run(dir, ['seed', '--engine', 'sqlite', '--help']);
      assert.equal(help.status, 0, help.output);
      assert.match(help.output, /defineSqliteSeed/);
      assert.match(help.output, /outside that transaction/);
    });
  });

  sqlite.it('fails closed on invalid config/URL, missing DB/module, bad exports and module exceptions', () => {
    project((dir, file) => {
      const config = join(dir, 'turbine.config.mjs');
      writeFileSync(
        join(dir, 'seed.js'),
        "require('node:fs').writeFileSync('./imported', 'bad'); module.exports = () => {};",
      );
      for (const source of [
        "throw new Error('config broken');",
        "export default { engine: 'sqlite', url: 'postgres://127.0.0.1:1/never-connect' };",
        "export default { engine: 'sqlite', url: './missing.sqlite' };",
      ]) {
        writeFileSync(config, source);
        const result = run(dir, ['seed']);
        assert.equal(result.status, 1, result.output);
        assert.equal(existsSync(join(dir, 'imported')), false);
        assert.equal(existsSync(join(dir, 'missing.sqlite')), false);
      }
      writeFileSync(config, "export default { engine: 'sqlite', url: './app.sqlite', seedFile: './absent.js' };");
      assert.match(run(dir, ['seed']).output, /file not found/);
      writeFileSync(config, "export default { engine: 'sqlite', url: './app.sqlite', seedFile: './seed.sql' };");
      writeFileSync(join(dir, 'seed.sql'), "INSERT INTO items VALUES (1, 'not supported');");
      assert.match(run(dir, ['seed']).output, /Unsupported SQLite seed extension/);
      writeFileSync(config, "export default { engine: 'sqlite', url: './app.sqlite' };");
      for (const source of ['module.exports = { nope: true };', "throw new Error('import boom');"]) {
        writeFileSync(join(dir, 'seed.js'), source);
        const result = run(dir, ['seed']);
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /callable default|import boom/);
        assert.deepEqual(labels(file), []);
      }
    });
  });

  sqlite.it('does not import or run a discovered seed during unrelated init', () => {
    project((dir, file) => {
      writeFileSync(
        join(dir, 'seed.js'),
        "require('node:fs').writeFileSync('./imported', 'bad'); throw new Error('seed must not run');",
      );
      const initialized = run(dir, ['init', '--yes', '--skip-generate']);
      assert.equal(initialized.status, 0, initialized.output);
      assert.equal(existsSync(join(dir, 'imported')), false);
      assert.deepEqual(labels(file), []);
    });
  });
});
