/**
 * Every error code is documented, and every documented code exists.
 *
 * The docs error table (site errors page) is hand-maintained, and nothing used
 * to connect it to `TurbineErrorCode`: an E019 could ship with no row, and a
 * removed code could keep a stale row, and neither would fail anything. Now
 * that every error MESSAGE links to `turbineorm.dev/errors#eNNN` (0.65), a
 * missing row is no longer a docs gap but a broken link printed into the
 * user's own logs, which is why this went from nice-to-have to a gate.
 *
 * Reads the MDX source from the repo tree rather than fetching the site, so it
 * runs in the unit lane on every publish. That checks the SOURCE stays in
 * sync; the deployed page follows on the next site deploy, which happens with
 * every release.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TurbineError, TurbineErrorCode } from '../errors.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mdxPath = resolve(repoRoot, 'site/app/(docs)/errors/page.mdx');
const mdx = readFileSync(mdxPath, 'utf-8');

const codes = Object.values(TurbineErrorCode);

describe('error docs stay in sync with TurbineErrorCode', () => {
  it('the fixture is the real docs page, not an empty read', () => {
    // Precondition: if the site moves, every case below would fail with
    // noise; this one names the actual problem.
    assert.ok(mdx.length > 1000, `errors page.mdx at ${mdxPath} is missing or empty`);
    assert.match(mdx, /## Error code table/);
  });

  it('every TurbineErrorCode has a row in the code table', () => {
    const missing = codes.filter((code) => !mdx.includes(`\`${code}\``));
    assert.deepEqual(missing, [], `codes with no docs row: ${missing.join(', ')}`);
  });

  it('every code has the anchor its docsUrl points at', () => {
    // The message suffix links to #eNNN; an anchor that is not on the page is
    // a broken link shipped inside every instance of that error.
    for (const code of codes) {
      const anchor = new TurbineError(code, 'probe').docsUrl.split('#')[1];
      assert.ok(mdx.includes(`<a id="${anchor}" />`), `page.mdx has no <a id="${anchor}"> for ${code}`);
    }
  });

  it('the docs table documents no code that does not exist', () => {
    // The reverse direction: a removed code must lose its row, or the table
    // describes errors the library can no longer throw.
    const documented = [...mdx.matchAll(/`(TURBINE_E\d{3})`/g)].map((m) => m[1] as string);
    const known = new Set<string>(codes);
    const stale = [...new Set(documented)].filter((c) => !known.has(c));
    assert.deepEqual(stale, [], `documented codes that no longer exist: ${stale.join(', ')}`);
  });
});
