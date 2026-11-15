/** Explicit native evidence entry. Uses the existing bounded subreaper owner. */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveIdentity, command } from '../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const root = resolve(process.env.D1_REPLAY_ROOT ?? mkdtempSync(join(tmpdir(), 'turbine-d1-replay-')));
process.once('exit', () => {
  if (!process.env.D1_REPLAY_ROOT) rmSync(root, { recursive: true, force: true });
});
const archive = process.env.D1_REPLAY_ARCHIVE;
const pin = process.env.D1_REPLAY_SHA256;
assert.ok(archive, 'D1_REPLAY_ARCHIVE must name the package archive to test.');
assert.match(pin ?? '', /^[a-f0-9]{64}$/, 'D1_REPLAY_SHA256 must contain the archive SHA256.');
assert.ok(process.env.D1_REPLAY_NPM, 'D1_REPLAY_NPM must name the npm CLI JavaScript file.');
const { createHash } = await import('node:crypto');
const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
assert.equal(hash, pin);
const identity = archiveIdentity(archive, hash);
const attempt = process.env.D1_REPLAY_ATTEMPT ?? 'native1';
const report = { root, repo, archive: identity, commands: [], cells: [], ports: [59911, 59912] };
mkdirSync(join(root, 'tmp'), { recursive: true });
await runWithShutdown(report, join(root, `${attempt}.json`), async (scope) => {
  const run = async (label, cwd, binary, args, extra = {}) => {
    const out = await command(
      report,
      cwd,
      binary,
      args,
      {
        ...process.env,
        DATABASE_URL: '',
        TMPDIR: join(root, 'tmp'),
        npm_config_cache: join(root, 'npm-cache'),
        ...extra,
      },
      { scope, timeoutMs: 240000 },
    );
    writeFileSync(join(root, `${attempt}-${label}.log`), out);
    return out;
  };
  for (const [i, major] of [22, 24].entries()) {
    const node = join(root, `node${major}`),
      cwd = join(root, `n${major}`),
      port = report.ports[i];
    mkdirSync(cwd, { recursive: true });
    const version = (await run(`version${major}`, cwd, node, ['--version'])).trim();
    assert.equal(version, major === 22 ? 'v22.16.0' : 'v24.10.0');
    if (!existsSync(join(cwd, 'node_modules'))) {
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: `d1-replay-${major}`,
          private: true,
          type: 'module',
          dependencies: {
            'turbine-orm': `file:${archive}`,
            pg: '8.23.1',
            miniflare: '4.20260730.0',
            workerd: '1.20260730.1',
            typescript: '6.0.3',
            tsx: '4.23.15',
            esbuild: '0.28.1',
            '@types/node': '22.15.30',
            '@cloudflare/workers-types': '5.20261106.1',
          },
        }),
      );
      await run(`install${major}`, cwd, node, [process.env.D1_REPLAY_NPM, 'install', '--no-audit', '--no-fund']);
    }
    for (const name of ['application.ts', 'demo.ts', 'schema.ts'])
      copyFileSync(join(repo, 'examples/d1-durable-replay', name), join(cwd, name));
    const src = readFileSync(join(cwd, 'application.ts'), 'utf8');
    writeFileSync(join(cwd, 'application.cts'), src);
    copyFileSync(join(repo, 'src/test/fixtures/d1-durable-replay/contract.mjs'), join(cwd, 'contract.mjs'));
    copyFileSync(
      join(repo, 'src/test/fixtures/d1-durable-replay/option-regressions.mjs'),
      join(cwd, 'option-regressions.mjs'),
    );
    copyFileSync(join(repo, 'src/test/fixtures/d1-durable-replay/native.mjs'), join(cwd, 'native.mjs'));
    copyFileSync(join(repo, 'src/test/fixtures/d1-durable-replay/omissions.mjs'), join(cwd, 'omissions.mjs'));
    const config = {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        types: ['node'],
        outDir: 'compiled',
      },
      include: ['application.ts', 'application.cts', 'schema.ts', 'demo.ts'],
    };
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify(config));
    await run(`compile${major}`, cwd, node, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
    const probe = createServer();
    await new Promise((yes, no) => {
      probe.once('error', no);
      probe.listen(port, '127.0.0.1', yes);
    });
    await new Promise((r) => probe.close(r));
    console.log(
      JSON.stringify({
        announcedOwnedRoot: cwd,
        publicPort: `127.0.0.1:${port}`,
        internalPorts: 'ephemeral retained in ownership proof',
      }),
    );
    await run(`native${major}`, cwd, node, ['native.mjs'], {
      D1_REPLAY_REPO: repo,
      D1_REPLAY_ARCHIVE: archive,
      D1_REPLAY_PORT: String(port),
      D1_REPLAY_ATTEMPT: attempt,
    });
    report.cells.push(JSON.parse(readFileSync(join(cwd, `${attempt}-native.json`), 'utf8')));
    // Separate processes reopen the retained private local database after runtime disposal.
    await run(`reopen${major}`, cwd, node, ['native.mjs', 'reopen'], {
      D1_REPLAY_REPO: repo,
      D1_REPLAY_ARCHIVE: archive,
      D1_REPLAY_PORT: String(port),
      D1_REPLAY_ATTEMPT: attempt,
    });
    report.cells.push(JSON.parse(readFileSync(join(cwd, `${attempt}-reopen.json`), 'utf8')));
    const interrupted = { label: `interrupt${major}`, cwd, binary: node, args: ['native.mjs', 'interrupt'] };
    report.commands.push(interrupted);
    const handle = scope.spawn(
      node,
      interrupted.args,
      {
        cwd,
        env: {
          ...process.env,
          TMPDIR: join(root, 'tmp'),
          D1_REPLAY_REPO: repo,
          D1_REPLAY_ARCHIVE: archive,
          D1_REPLAY_PORT: String(port),
          D1_REPLAY_ATTEMPT: attempt,
        },
        deadlineMs: 30000,
      },
      interrupted,
    );
    let output = '';
    handle.child.stdout.on('data', (c) => {
      output += c;
    });
    handle.child.stderr.on('data', (c) => {
      output += c;
    });
    await handle.closed;
    await handle.stop();
    writeFileSync(join(root, `${attempt}-interrupt${major}.log`), output);
    assert.equal(interrupted.signal, 'SIGKILL');
    assert(interrupted.reaped);
    assert(existsSync(join(cwd, `${attempt}-interrupt-committed.json`)));
    report.cells.push({
      mode: 'interrupt-marker',
      ...JSON.parse(readFileSync(join(cwd, `${attempt}-interrupt-committed.json`), 'utf8')),
    });
    await run(`reopen-interrupt${major}`, cwd, node, ['native.mjs', 'reopen-interrupt'], {
      D1_REPLAY_REPO: repo,
      D1_REPLAY_ARCHIVE: archive,
      D1_REPLAY_PORT: String(port),
      D1_REPLAY_ATTEMPT: attempt,
    });
    report.cells.push(JSON.parse(readFileSync(join(cwd, `${attempt}-reopen-interrupt.json`), 'utf8')));
  }
  report.success = true;
});
