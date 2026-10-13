/**
 * A private state directory for the Studio contexts these tests build by hand.
 *
 * `StudioContext.stateDir` is where saved queries are written. A fixed name in
 * the shared OS temp directory (`os.tmpdir()` itself, or `tmpdir()/some-name`)
 * is a predictable path that any local account can pre-create or point
 * elsewhere, so tests take a fresh `mkdtemp` directory instead (mode 0700,
 * random suffix) and remove it when the file's tests finish.
 *
 * Call it once at the top of a test file, outside any `describe` / `it`, so the
 * cleanup hook belongs to the file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export function studioTestStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-studio-state-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
