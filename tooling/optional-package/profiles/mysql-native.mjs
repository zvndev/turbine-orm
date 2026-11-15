/** Reuse the established owned MySQL helper, with explicit ports and scope. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function withMysql({ source, root, port, mode, env, report, scope, run, driver }, body) {
  mkdirSync(root);
  let text = readFileSync(join(source, 'tooling/lifecycle-examples/mysql-service.mjs'), 'utf8');
  for (const [before, after] of [
    ["import { spawn } from 'node:child_process';\n", ''],
    ["probe.listen(0, '127.0.0.1')", `probe.listen(${port}, '127.0.0.1')`],
    ['report, registerStop })', 'report, registerStop, processLifecycle })'],
    ['  run(\n', '  await run(\n'],
    ['const child = spawn(', 'const child = processLifecycle.spawn('],
  ]) {
    assert.equal(text.split(before).length, 2, `Reviewed service helper changed: ${before}`);
    text = text.replace(before, after);
  }
  const copy = join(root, 'mysql-service.mjs'); writeFileSync(copy, text);
  const { ownedMysql } = await import(pathToFileURL(copy));
  let handle, stop, identity;
  const cleanup = async () => {
    try { if (stop) await stop(); }
    finally {
      try { if (handle) await handle.stop(true); }
      finally {
        if (handle && identity) { handle.capture(); Object.assign(identity, handle.record); }
        rmSync(join(root, 'data'), { recursive: true, force: true });
        rmSync(join(root, 'mysql.sock'), { force: true });
        if (identity) { identity.datadirRemoved = true; identity.socketRemoved = true; }
      }
    }
  };
  scope.registerStop(cleanup);
  try {
    const service = await ownedMysql({ root, mode, env, run, driver, report,
      processLifecycle: { spawn(binary, args, options) {
        handle = scope.spawn(binary, args, options, { binary, args, cwd: root }); handle.service = true;
        identity = report.services.at(-1); return handle.child;
      } },
      registerStop(callback) { stop = callback; },
    });
    assert.equal(service.port, port);
    return await body(service);
  } finally { await cleanup(); }
}
