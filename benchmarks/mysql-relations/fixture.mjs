import assert from 'node:assert/strict';

export const fixtureNames = ['small', 'large', 'skewed', 'wide'];
export function fixture(name, scale = 1) {
  assert.ok(fixtureNames.includes(name), 'unknown fixture');
  assert.ok(Number.isInteger(scale) && scale >= 1 && scale <= 4, 'scale must be 1..4');
  const parents = [], children = [], leaves = [], profiles = [];
  const size = name === 'large' ? 16 : 6;
  for (let p = 1; p <= size * scale; p++) {
    parents.push({ id: p, weight: p % 2, label: `parent-${p}` });
    if (p % 3) profiles.push({ id: p, parentId: p, note: `profile-'\\-${p}` });
    const count = p === 1 ? 0 : name === 'skewed' ? (p === 2 ? 96 * scale : 2) : (name === 'large' ? 24 * scale : 5);
    for (let c = 0; c < count; c++) {
      const id = children.length + 1;
      const big = ['18446744073709551615', '9007199254740993', 42][c % 3];
      children.push({ id, parentId: p, weight: c % 3,
        amount: c % 2 ? '-1234567890123456789012.12345678' : '0.00000001', big,
        doc: { text: "quote' slash\\ nul\u0000 emoji🌊", array: [null, true, { exact: String(big) }] },
        binaryValue: Buffer.from([0, 255, 92, 39, c % 256]),
        day: new Date(c % 2 ? '1000-01-01T00:00:00.000Z' : '9999-12-31T00:00:00.000Z'),
        stamp: new Date('2038-01-19T03:14:07.123Z'),
        payload: `child-${id}-` + 'w'.repeat(name === 'wide' ? 8192 * scale : 32) });
      for (let l = 0; l < 3; l++) leaves.push({ id: leaves.length + 1, childId: id, weight: l % 2, label: `leaf-${id}-${l}` });
    }
  }
  return { name, parents, children, leaves, profiles };
}

export function windows(input) {
  return [{ name: 'page', offset: 1, limit: Math.min(4, input.parents.length - 1), childOffset: 1, childLimit: 3 },
    { name: 'complete', offset: 0, limit: input.parents.length, childOffset: 0, childLimit: 1000 }];
}
export const parentCompare = (a, b) => a.weight - b.weight || b.id - a.id;
export const childCompare = parentCompare;
export function oracle(input, window, legacy) {
  return input.parents.toSorted(parentCompare).slice(window.offset, window.offset + window.limit).map((p) => {
    const matches = input.profiles.filter((r) => r.parentId === p.id);
    return { ...p,
      children: input.children.filter((c) => c.parentId === p.id).sort(childCompare)
        .slice(window.childOffset, window.childOffset + window.childLimit).map((c) => ({ ...c,
          leaves: input.leaves.filter((l) => l.childId === c.id).sort((a, b) => b.id - a.id).slice(1, 2) })),
      profiles: legacy ? matches : matches[0] ?? null };
  });
}

export function queryArgs(window, strategy, names) {
  return { where: { id: { gte: 1 } }, select: { id: true, weight: true, label: true }, orderBy: [{ weight: 'asc' }, { id: 'desc' }],
    offset: window.offset, limit: window.limit, relationLoadStrategy: strategy, jsonEncoding: 'object',
    with: { [names.children]: { orderBy: [{ weight: 'asc' }, { id: 'desc' }], offset: window.childOffset, limit: window.childLimit,
      with: { [names.leaves]: { orderBy: { id: 'desc' }, offset: 1, limit: 1 } } }, [names.profiles]: true } };
}

export const ddl = [
  'CREATE TABLE parents (id INT PRIMARY KEY, weight INT NOT NULL, label VARCHAR(80) NOT NULL)',
  'CREATE TABLE children (id INT PRIMARY KEY, parent_id INT NOT NULL, weight INT NOT NULL, amount DECIMAL(30,8) NOT NULL, big BIGINT UNSIGNED NOT NULL, doc JSON NOT NULL, binary_value VARBINARY(20) NOT NULL, day DATE NOT NULL, stamp DATETIME(3) NOT NULL, payload MEDIUMTEXT NOT NULL, FOREIGN KEY(parent_id) REFERENCES parents(id), INDEX(parent_id, weight, id))',
  'CREATE TABLE leaves (id INT PRIMARY KEY, child_id INT NOT NULL, weight INT NOT NULL, label VARCHAR(80) NOT NULL, FOREIGN KEY(child_id) REFERENCES children(id), INDEX(child_id, id))',
  'CREATE TABLE profiles (id INT PRIMARY KEY, parent_id INT NOT NULL UNIQUE, note VARCHAR(80) NOT NULL, FOREIGN KEY(parent_id) REFERENCES parents(id))',
];
