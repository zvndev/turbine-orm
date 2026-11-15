import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

interface SupportData {
  routes: Array<{ id: string }>;
}
interface Generator {
  loadData(): SupportData;
  routeTier(data: SupportData, route: SupportData['routes'][number]): string;
}
// URL import avoids resolving scripts/ outside the test project's rootDir.
const { loadData, routeTier } = (await import(
  new URL('../../scripts/gen-engine-support.ts', import.meta.url).href
)) as Generator;
const data = loadData();
const root = new URL('../../', import.meta.url);

const readmeRoutes = [
  ['sqlite', 'sqlite'],
  ['better-sqlite3', 'better-sqlite3'],
  ['mysql', 'mysql'],
  ['mssql', 'mssql'],
  ['libsql', 'libsql'],
  ['d1', 'd1'],
  ['neon-ws', 'neon-ws'],
  ['neon-http', 'neon-http'],
  ['powdb', 'powdb-embedded'],
  ['powdb', 'powdb-networked'],
] as const;
const siteHeadings = [
  ['SQLite through better-sqlite3', 'better-sqlite3'],
  ['libSQL, local files', 'libsql'],
  ['Cloudflare D1', 'd1'],
  ['Neon over WebSockets', 'neon-ws'],
  ['Neon over HTTP', 'neon-http'],
] as const;

function check(file: string, wording: string, found: string, routeId: string): void {
  const route = data.routes.find((r) => r.id === routeId);
  assert.ok(route, `matrix route ${routeId} exists`);
  const computed = routeTier(data, route);
  assert.equal(found.trim(), computed, `${file}: found "${wording}"; computed tier for ${routeId} is ${computed}`);
}

describe('documented engine tiers match the computed evidence tiers', () => {
  it('checks every README engine and driver row', () => {
    const file = 'README.md';
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const [entry, route] of readmeRoutes) {
      const row = text.split('\n').find((line) => line.includes(`| \`turbine-orm/${entry}\` |`));
      assert.ok(row, `${file}: missing tier row for turbine-orm/${entry}`);
      check(file, row, row.split('|').at(-2)!, route);
    }
  });

  it('checks each tier stated in a site engine heading', () => {
    const file = 'site/app/(docs)/engines/page.mdx';
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const [name, route] of siteHeadings) {
      const heading = text.split('\n').find((line) => line.startsWith(`### ${name} (`));
      assert.ok(heading, `${file}: missing tier heading for ${name}`);
      const tier = /\(([^)]+)\)$/.exec(heading)?.[1];
      assert.ok(tier, `${file}: no tier in "${heading}"`);
      check(file, heading, tier, route);
    }
  });
});
