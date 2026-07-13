/**
 * optional-peer-import.cts — unit tests for the dual-build dynamic-import
 * helper (T-5: `turbinePowDB` broken under CommonJS with ESM-only
 * `@zvndev/powdb-client` ≥ 0.9).
 *
 * These cover the helper's runtime contract from the source tree. The
 * dist-level behavior (the CJS build's lowered `require()` falling back to the
 * NodeNext copy's real `import()`) is exercised by the build verification and
 * the pack-smoke CI job, since it depends on the emitted file layout.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import importOptionalPeer from '../optional-peer-import.cjs';

describe('optional-peer-import', () => {
  it('imports an available module (namespace shape usable by the engine loaders)', async () => {
    const mod = (await importOptionalPeer('node:path')) as {
      join?: unknown;
      default?: { join?: unknown };
    };
    // The loaders read named exports with a `default` interop fallback — both
    // shapes must expose the API.
    assert.equal(typeof (mod.join ?? mod.default?.join), 'function');
  });

  it('rethrows the original not-found error for a missing package (no misleading fallback)', async () => {
    await assert.rejects(importOptionalPeer('@zvndev/definitely-not-installed-turbine-test'), (err: unknown) => {
      const code = (err as { code?: string }).code;
      assert.ok(
        code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND',
        `expected a module-not-found code, got ${String(code)}`,
      );
      return true;
    });
  });

  it('loads @zvndev/powdb-client, which ships no `require` export condition (the T-5 shape)', async () => {
    const mod = (await importOptionalPeer('@zvndev/powdb-client')) as {
      Pool?: unknown;
      default?: { Pool?: unknown };
    };
    assert.equal(typeof (mod.Pool ?? mod.default?.Pool), 'function');
  });
});
