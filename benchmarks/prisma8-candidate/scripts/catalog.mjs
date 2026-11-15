import assert from 'node:assert/strict';
import { headlineNames } from '../dist/canonical/equivalence.js';
import { extendedCatalog } from '../dist/canonical/extended-equivalence.js';

export const comparatorNames = ['Turbine', 'Drizzle stable', 'Drizzle RC', 'Prisma 7'];
export const reasons = {
  increment: 'No atomic field-expression update in this typed ORM adapter; raw SQL is not a typed ORM feature.',
  pipeline:
    'No matching autocommit pipeline API implemented. Independent parallel reads and sequential reads are separate scenarios.',
  strategy: 'No equivalent strategy selector implemented or admitted in this candidate lane.',
  cold: 'Fresh-client connection/query/disposal boundary not implemented in this slice.',
};
const supported = (route) => ({ status: 'implemented', route, metrics: null });
const refused = (reason) => ({ status: 'refused', reason, metrics: null });
function cells(raw, prisma, cursor = refused('Only the ordered full comments drain has a cursor variant.')) {
  return {
    'Raw pg 8.22.0': raw,
    'Prisma 8 buffered': prisma,
    'Prisma 8 cursor batch1000': cursor,
    'Raw pg 8.22.0 cursor batch1000':
      cursor.status === 'implemented' ? supported('native-pg-cursor-full-drain') : cursor,
    ...Object.fromEntries(comparatorNames.map((name) => [name, { status: 'optional-input-required', metrics: null }])),
  };
}
export function catalog() {
  return [
    ...headlineNames.map((scenario, index) => ({
      id: `headline-${index}`,
      scenario,
      group: 'headline',
      index,
      arms: cells(
        index === 8
          ? refused(reasons.pipeline)
          : supported(index === 6 ? 'buffered-full-drain' : index === 9 ? 'transaction-sequential' : 'raw-sql'),
        index === 7
          ? refused(reasons.increment)
          : index === 8
            ? refused(reasons.pipeline)
            : supported(index === 6 ? 'buffered-full-drain' : index === 9 ? 'transaction-sequential' : 'typed-orm'),
        index === 6 ? supported('native-pg-cursor-full-drain') : undefined,
      ),
    })),
    ...extendedCatalog.map((row) => ({
      ...row,
      arms: cells(
        row.id.startsWith('strategy-')
          ? refused(reasons.strategy)
          : row.id === 'cold-user'
            ? refused(reasons.cold)
            : supported('raw-sql'),
        row.id.startsWith('strategy-')
          ? refused(reasons.strategy)
          : row.id === 'cold-user'
            ? refused(reasons.cold)
            : supported('typed-orm'),
      ),
    })),
    ...['independent', 'sequential'].map((route) => ({
      id: `dashboard-${route}`,
      scenario: `5-query dashboard, ${route} reads`,
      group: 'appendix',
      arms: cells(supported(route), supported(route)),
    })),
  ];
}
export function assertRoute(trace, cursor, size = 1000) {
  const portals = trace.filter((t) => t.kind === 'bind' && t.portal);
  const fetches = trace.filter((t) => t.kind === 'execute' && t.rows === size);
  if (cursor && (!portals.length || !fetches.length))
    throw new Error(`Native cursor route requires named portal and Execute rows=${size}`);
  if (!cursor && fetches.length) throw new Error('Buffered route unexpectedly used cursor batching');
}

// The report and loader use the same source-owned admission rules.
export function admittedCatalog(inputs = []) {
  assert.ok(Array.isArray(inputs), 'Comparator inputs must be an array');
  const rows = catalog(),
    seen = new Set();
  const versions = { 'Drizzle stable': '0.45.4', 'Drizzle RC': '1.0.0-rc.5', 'Prisma 7': '7.10.1' };
  for (const pin of inputs) {
    assert.ok(comparatorNames.includes(pin.name) && !seen.has(pin.name), 'Unknown or duplicate comparator');
    seen.add(pin.name);
    assert.equal(pin.driver, 'pg@8.22.0');
    assert.equal(pin.implementationKind, 'typed-orm');
    assert.match(pin.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(typeof pin.version === 'string' && pin.version.length > 0);
    if (versions[pin.name]) assert.equal(pin.version, versions[pin.name]);
    for (const key of ['artifact', 'module']) {
      assert.ok(typeof pin[key]?.path === 'string' && pin[key].path.length > 0);
      assert.match(pin[key]?.sha256 ?? '', /^[a-f0-9]{64}$/);
    }
    assert.ok(
      Array.isArray(pin.supported) && pin.supported.length && new Set(pin.supported).size === pin.supported.length,
    );
    for (const id of pin.supported)
      assert.ok(
        rows.some((row) => row.id === id && row.arms['Prisma 8 buffered'].status === 'implemented'),
        `Optional comparator scenario not admitted: ${id}`,
      );
    for (const row of rows)
      row.arms[pin.name] = pin.supported.includes(row.id)
        ? { status: 'implemented', route: 'external-typed-orm', metrics: null }
        : { status: 'refused', reason: 'Not declared by supplied comparator manifest', metrics: null };
  }
  return rows;
}
