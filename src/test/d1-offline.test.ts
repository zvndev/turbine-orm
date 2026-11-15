import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { loadD1Runtime, resolveD1Context, withLocalD1 } from '../cli/d1-local.js';

interface Dispatcher {
  dispatch(options: { origin: string | URL }, handler: unknown): boolean;
}
interface MockDispatcher extends Dispatcher {
  disableNetConnect(): void;
  enableNetConnect(host: RegExp): void;
  close(): Promise<void>;
}

test('local D1 runs real SQL without requesting public metadata or writing its cache', {
  timeout: 120_000,
}, async () => {
  const originalCwd = process.cwd();
  const names = ['DATABASE_URL', 'NODE_ENV', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_CF_FETCH_PATH'] as const;
  const originalEnv = names.map((name) => process.env[name]);
  const require = createRequire(import.meta.url);
  // Use the exact transport used by this installed Miniflare, not global fetch.
  const nativeRequire = createRequire(require.resolve('miniflare'));
  const transport = nativeRequire('undici') as {
    getGlobalDispatcher(): Dispatcher;
    setGlobalDispatcher(dispatcher: Dispatcher): void;
    MockAgent: new () => MockDispatcher;
  };
  const previous = transport.getGlobalDispatcher();
  const mock = new transport.MockAgent();
  mock.disableNetConnect();
  mock.enableNetConnect(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
  const external: string[] = [];
  const dispatch = mock.dispatch.bind(mock);
  mock.dispatch = (options, handler) => {
    const origin = new URL(String(options.origin));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) external.push(origin.origin);
    return dispatch(options, handler);
  };
  const root = mkdtempSync(join(tmpdir(), 'd1-offline-'));
  transport.setGlobalDispatcher(mock);
  try {
    symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
    process.chdir(root);
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'true';
    const cache = join(root, 'never-created-cf.json');
    process.env.CLOUDFLARE_CF_FETCH_PATH = cache;
    const config = resolveConfig(
      { engine: 'd1', d1: { binding: 'DB', databaseId: 'offline-contract', persist: './state' } },
      {},
    );
    const context = resolveD1Context(config);
    mkdirSync(context.persist);
    const Runtime = await loadD1Runtime();
    console.info(`Offline D1 owned root before launch: ${root}; only loopback traffic admitted.`);
    await withLocalD1(
      context,
      async (binding) => {
        await binding.prepare('CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT)').all();
        await binding.prepare('INSERT INTO items VALUES (?, ?)').bind(1, 'local Ω').all();
        const result = await binding.prepare('SELECT id, title FROM items').all();
        assert.deepEqual(result.results, [{ id: 1, title: 'local Ω' }]);
      },
      Runtime,
    );
    assert.deepEqual(external, [], 'local runtime attempted public metadata or another external request');
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(join(context.persist, '.turbine-d1.lock')), false);
  } finally {
    try {
      await mock.close();
    } finally {
      transport.setGlobalDispatcher(previous);
      names.forEach((name, i) => {
        if (originalEnv[i] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[i];
      });
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
