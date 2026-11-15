import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it } from 'node:test';
import { build } from 'esbuild';
import importOptionalPeer from '../optional-peer-import.cjs';
import { startNative } from './fixtures/neon-ws-native.js';

const pgRoot = process.env.TURBINE_NEON_WS_PG_ROOT;
if (!pgRoot && process.env.TURBINE_REQUIRE_NEON_WS === '1')
  throw new Error('Required Neon edge WebSocket suite needs TURBINE_NEON_WS_PG_ROOT and @edge-runtime/vm');

describe('Neon WebSocket edge VM invocation using local native PostgreSQL', { skip: !pgRoot }, () => {
  it('bundles the real driver without pg/TCP and closes invocation sessions on success and failure', async () => {
    const native = await startNative(pgRoot!);
    try {
      await native.admin.query('CREATE TABLE neon_ws_edge_items (id integer PRIMARY KEY, label text)');
      const bundle = await build({
        entryPoints: ['src/test/fixtures/neon-ws-edge.ts'],
        bundle: true,
        write: false,
        metafile: true,
        platform: 'neutral',
        format: 'iife',
        globalName: 'NeonWsEdge',
        conditions: ['edge-light', 'worker', 'browser'],
        mainFields: ['module', 'main'],
        external: ['node:async_hooks'],
      });
      const inputs = Object.keys(bundle.metafile!.inputs);
      assert.ok(
        inputs.some((input) => input.includes('@neondatabase/serverless')),
        'actual optional driver must be in the edge bundle',
      );
      assert.ok(
        inputs.some((input) => input.includes('pg-edge')),
        'edge #pg condition must be active',
      );
      assert.equal(
        inputs.some((input) => /node_modules\/pg\//.test(input)),
        false,
        'native pg must not enter the edge bundle',
      );
      const vmModule = (await importOptionalPeer('@edge-runtime/vm')) as {
        EdgeVM: new (options: unknown) => { evaluate(code: string): unknown };
      };
      const vm = new vmModule.EdgeVM({
        extend: (context: Record<string, unknown>) => {
          // Vercel/Next edge environments provide AsyncLocalStorage; this VM's
          // import bridge admits only that required runtime primitive.
          context.require = (name: string) => {
            assert.equal(name, 'node:async_hooks');
            return { AsyncLocalStorage };
          };
          return context;
        },
      });
      vm.evaluate(bundle.outputFiles[0]!.text);
      const proxy = native.driver.wsProxy as () => string;
      for (const fail of [false, true]) {
        await native.admin.query('TRUNCATE neon_ws_edge_items');
        const result = await vm.evaluate(
          `NeonWsEdge.runNeonWsEdge(${JSON.stringify(native.connection.connectionString)}, ${JSON.stringify(proxy())}, ${fail})`,
        );
        assert.deepEqual(
          JSON.parse(JSON.stringify(result)),
          fail
            ? { failure: 'edge callback marker', closed: true }
            : { rows: [{ id: 15, label: 'edge' }], closed: true },
        );
        assert.deepEqual((await native.admin.query('SELECT id, label FROM neon_ws_edge_items ORDER BY id')).rows, [
          { id: 15, label: 'edge' },
        ]);
      }
    } finally {
      await native.close();
    }
  });
});
