/**
 * Studio UI shell: the grid invariant behind the blank-page bug.
 *
 * `turbine studio --write --show-pii` rendered a COMPLETELY BLANK page. Nothing
 * threw and the accessibility tree was intact; it was pure layout. `.app` is a
 * CSS grid, the write / PII / demo banners were direct grid children, and a
 * hidden banner is `display: none`, which is not a grid item at all. So the
 * number of items moved with the number of VISIBLE banners while the track list
 * stayed fixed, and every later child slid up a track:
 *
 *   1 banner  -> .main landed in a content-sized `auto` track     (looked fine)
 *   2 banners -> .main landed in the `var(--header-h)` track      (48px: blank)
 *   3 banners -> .main landed in the `1fr` track                  (looked fine)
 *
 * The fix is structural: the banners live in ONE `.banner-stack` element, so
 * `.app` has exactly as many element children as it declares tracks no matter
 * how many banners are on. These tests assert that invariant against the HTML
 * that is actually served (`STUDIO_HTML`), because a unit test cannot see a
 * layout and a human only sees this one by launching the two flags together.
 *
 * The second suite covers what is genuinely a source-level question: that the
 * pure `builder-args` region exists and stays pure, so
 * studio-builder-roundtrip.test.ts can RUN it. The assertions that used to live
 * there ("this line of JavaScript is present") are gone: they passed while the
 * saved-query round trip they were meant to protect was broken.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STUDIO_HTML } from '../cli/studio-ui.generated.js';

/**
 * Element children of the first element with the given class, by walking tags
 * with a depth counter. Deliberately a tiny scanner rather than a DOM library:
 * the package's runtime dependency list is `pg` and nothing else, and the only
 * question asked here is "how many element children does `.app` have".
 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
  'path',
  'circle',
  'rect',
  'ellipse',
  'line',
  'polyline',
  'polygon',
]);

function directChildren(html: string, openTagMarker: string): string[] {
  const start = html.indexOf(openTagMarker);
  assert.notEqual(start, -1, `container ${openTagMarker} not found`);
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  tagRe.lastIndex = start;
  const children: string[] = [];
  let depth = 0;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = attrs.trimEnd().endsWith('/') || VOID_TAGS.has(tag);
    if (closing) {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (selfClosing) continue;
    depth++;
    // depth 1 = the container itself; depth 2 = its direct element children.
    if (depth === 2) {
      const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? '';
      children.push(cls ? `${tag}.${cls.split(/\s+/)[0]}` : tag);
    }
  }
  return children;
}

describe('Studio UI: the app grid cannot drift with the banner count', () => {
  it('declares exactly as many rows as .app has element children', () => {
    const rows = /\.app\s*\{[^}]*grid-template-rows:\s*([^;]+);/s.exec(STUDIO_HTML)?.[1];
    assert.ok(rows, 'grid-template-rows declared on .app');
    const tracks = rows.trim().split(/\s+(?![^(]*\))/);
    const children = directChildren(STUDIO_HTML, '<div class="app" id="app">');
    assert.deepEqual(
      children,
      ['div.banner-stack', 'header.header', 'div.body'],
      'the banner region is ONE child, so the child list is fixed',
    );
    assert.equal(
      tracks.length,
      children.length,
      `track count (${tracks.join(' ')}) must match the ${children.length} grid items`,
    );
  });

  it('keeps every conditionally hidden banner inside the banner stack', () => {
    // A banner moved back out to `.app` is exactly the regression: it is hidden
    // in the common case, so it changes the item count per session.
    const stack = STUDIO_HTML.indexOf('<div class="banner-stack">');
    const header = STUDIO_HTML.indexOf('<header class="header">');
    assert.ok(stack !== -1 && header > stack, 'banner stack precedes the header');
    for (const id of ['writeBanner', 'piiBanner', 'demoBanner']) {
      const at = STUDIO_HTML.indexOf(`id="${id}"`);
      assert.ok(at > stack && at < header, `#${id} sits inside .banner-stack`);
    }
  });

  it('gives the banner stack no box of its own, so it collapses when empty', () => {
    // The default session (read-only Postgres, no demo) shows no banner at all.
    // Padding or a border on the stack would reserve a strip above the header
    // forever.
    const rule = /\.banner-stack\s*\{([^}]*)\}/s.exec(STUDIO_HTML)?.[1];
    assert.ok(rule, '.banner-stack rule present');
    assert.doesNotMatch(rule, /(^|[^-])padding\s*:/, 'no padding on the stack');
    assert.doesNotMatch(rule, /(^|[^-])border\s*:/, 'no border on the stack');
    assert.doesNotMatch(rule, /(^|[^-])gap\s*:/, 'no gap on the stack');
  });
});

describe('Studio UI: the builder-args region stays extractable and pure', () => {
  // The behaviour these used to assert (args keyed by field name) is now
  // exercised end to end in studio-builder-roundtrip.test.ts, which runs the
  // code instead of matching its text. Two source-level facts still belong
  // here, because they are what makes that possible: the region markers exist,
  // and no assembly logic lives outside them where it could drift back.
  it('delimits the pure region the round-trip test runs', () => {
    const begin = STUDIO_HTML.indexOf('// === BEGIN builder-args ===');
    const end = STUDIO_HTML.indexOf('// === END builder-args ===');
    assert.ok(begin !== -1 && end > begin, 'region markers present and ordered');
    const region = STUDIO_HTML.slice(begin, end);
    for (const member of ['fieldName(', 'columnName(', 'buildFindManyArgs(', 'hydrate(', 'unresolvedColumns(']) {
      assert.ok(region.includes(member), `${member} lives inside the region`);
    }
    // Pure: the region must not reach for the DOM, app state, or the network,
    // or it stops being runnable from a Node test. Comments are stripped first,
    // since the region's prose names `State.builder.args` to explain itself.
    const code = region.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['document.', 'window.', 'State.', 'Api.', '$(']) {
      assert.ok(!code.includes(forbidden), `region does not touch ${forbidden}`);
    }
  });

  it('keeps the pane and the saved-query loader on that one implementation', () => {
    // The defect was two implementations of one mapping, only one of which was
    // updated. Both call sites now delegate.
    assert.match(STUDIO_HTML, /return BuilderArgs\.buildFindManyArgs\(localArgs, tableMeta, BuilderPane\.findTable\);/);
    assert.match(STUDIO_HTML, /return BuilderArgs\.hydrate\(argsObj, tableMeta, BuilderPane\.findTable, issues\);/);
  });

  it('shows the field name in the Schema tab', () => {
    // The only spelling of a column on screen used to be the database one,
    // which is precisely the name a query key rejects.
    assert.match(STUDIO_HTML, /\['Column', 'Field', 'TS', 'PG', 'Attributes'\]/);
    assert.match(STUDIO_HTML, /class: 'col-field'/);
  });
});
