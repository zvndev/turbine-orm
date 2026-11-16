import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { introspect } from '../introspect.js';
import { introspectMssqlWith, mssqlDialect } from '../mssql.js';
import { catalogColumn, catalogFixture, catalogIndex } from './fixtures/mssql-introspection-metadata.js';
import { makeQuery } from './helpers.js';

describe('SQL Server catalog metadata fidelity', () => {
  it('preserves relations when the native catalog resolves different schema casing', async () => {
    const canonical = await introspectMssqlWith(catalogFixture().exec, 'app', { logger: {} });
    const f = catalogFixture();
    const alias = await introspectMssqlWith(
      async (sql, params) => {
        assert.deepEqual(params, ['APP']);
        // Model a case-insensitive native catalog, whose canonical names remain app.
        return f.exec(sql, ['app']);
      },
      'APP',
      { logger: {} },
    );
    for (const name of ['parents', 'profiles', 'composite_links']) {
      assert.deepEqual(alias.tables[name]!.relations, canonical.tables[name]!.relations);
    }
    assert.ok(alias.tables.parents!.relations.profile);
    assert.deepEqual(Object.keys(alias.tables.profiles!.relations), ['parent'], 'cross-schema FK stays excluded');
    const query = f.queries.find((sql) => sql.includes('sys.foreign_keys'))!;
    assert.match(query, /s\.name AS TABLE_SCHEMA/);
    assert.match(query, /s\.name = @p1 AND rs\.name = @p1/);
  });
  it('protects computed/rowversion/generated-always writes and preserves identity/default/nullability facts', async () => {
    const f = catalogFixture();
    const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
    const table = schema.tables.generated_records!;
    assert.deepEqual(table.allColumns, [
      'id',
      'quantity',
      'optional_text',
      'default_count',
      'virtual_total',
      'stored_total',
      'version',
      'period_start',
    ]);
    const byName = Object.fromEntries(table.columns.map((c) => [c.name, c]));
    assert.equal(byName.id!.isGenerated, true);
    assert.equal(byName.id!.hasDefault, true);
    assert.equal(byName.quantity!.hasDefault, false);
    assert.equal(byName.optional_text!.nullable, true);
    assert.equal(byName.optional_text!.hasDefault, false);
    assert.equal(byName.default_count!.hasDefault, true);
    for (const name of ['virtual_total', 'stored_total', 'version', 'period_start']) {
      assert.equal(byName[name]!.isGeneratedStored, true, name);
      assert.equal(byName[name]!.hasDefault, true, name);
    }
    assert.equal(byName.virtual_total!.nullable, true, 'computed nullability comes from the catalog');
    const query = makeQuery('generated_records', schema, { dialect: mssqlDialect });
    assert.match(query.buildCreate({ data: { quantity: 4 } }).sql, /OUTPUT INSERTED/);
    for (const name of ['virtualTotal', 'storedTotal', 'version', 'periodStart']) {
      assert.throws(() => query.buildCreate({ data: { quantity: 4, [name]: 8 } }), /generated/i, name);
      assert.throws(() => query.buildUpdate({ where: { id: 1 }, data: { [name]: 8 } }), /generated/i, name);
    }
    const sql = f.queries.find((q) => q.includes('INFORMATION_SCHEMA.COLUMNS'))!;
    assert.match(sql, /c\.is_computed AS IS_COMPUTED/);
    assert.match(sql, /c\.is_hidden = 0/);
    assert.doesNotMatch(
      sql,
      /COLUMN_DEFAULT|generation_expression|\.definition/i,
      'native expressions are never fetched',
    );
  });

  it('scopes composite primary/foreign keys and filters tables before relation derivation', async () => {
    const f = catalogFixture();
    f.primary.reverse();
    f.foreign.reverse();
    f.indexes.reverse();
    const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
    assert.deepEqual(schema.tables.composite_parents!.primaryKey, ['code', 'tenant_id']);
    assert.deepEqual(schema.tables.composite_unique_links!.uniqueColumns, [['code', 'tenant_id']]);
    assert.deepEqual(schema.tables.composite_links!.relations.compositeParent!.foreignKey, ['tenant_id', 'code']);
    assert.deepEqual(schema.tables.composite_links!.relations.compositeParent!.referenceKey, ['tenant_id', 'code']);
    assert.deepEqual(Object.keys(schema.tables.profiles!.relations), ['parent']);
    assert.match(f.queries.find((q) => q.includes('KEY_COLUMN_USAGE'))!, /tc\.TABLE_NAME = kcu\.TABLE_NAME/);
    assert.match(
      f.queries.find((q) => q.includes('KEY_COLUMN_USAGE'))!,
      /tc\.CONSTRAINT_SCHEMA = kcu\.CONSTRAINT_SCHEMA/,
    );
    assert.match(f.queries.find((q) => q.includes('sys.foreign_keys'))!, /rs\.name = @p1/);
    const filtered = await introspectMssqlWith(f.exec, 'app', {
      include: ['parents', 'profiles'],
      exclude: ['profiles'],
      logger: {},
    });
    assert.deepEqual(Object.keys(filtered.tables), ['parents']);
    assert.deepEqual(Object.keys(filtered.tables.parents!.relations), []);
  });

  it('names system-named composite keys as PostgreSQL would, after every explicit name, whatever their suffixes', async () => {
    const XY = ['x', 'y'];
    const AB = ['a', 'b'];
    const CD = ['c', 'd'];
    const system = { IS_SYSTEM_NAMED: true };
    // `swap` exchanges the random suffixes between keys that differ only in
    // what they reference, or only in their actions.
    const read = async (swap: boolean) => {
      const f = catalogFixture();
      const tables = ['cn_links', 'cn_ties', 'cn_returns', 'cn_checked'];
      f.tables.push('cn_parents', ...tables);
      for (const name of ['a', 'b', 'c', 'd']) f.columns.push(catalogColumn('cn_parents', name));
      for (const table of tables) for (const name of ['tenant', 'x', 'y']) f.columns.push(catalogColumn(table, name));
      f.primary.push(
        { TABLE_NAME: 'cn_parents', COLUMN_NAME: 'a', ORDINAL_POSITION: 1 },
        { TABLE_NAME: 'cn_parents', COLUMN_NAME: 'b', ORDINAL_POSITION: 2 },
      );
      f.indexes.push(...catalogIndex('cn_parents', 'UQ_cn_parents_cd', CD));
      const fk = (table: string, child: string[], target: string[], name: string, extra: Record<string, unknown>) => {
        for (const [i, column] of child.entries())
          f.foreign.push({
            TABLE_NAME: table,
            COLUMN_NAME: column,
            REFERENCED_TABLE_NAME: 'cn_parents',
            REFERENCED_COLUMN_NAME: target[i],
            TABLE_SCHEMA: 'app',
            REFERENCED_TABLE_SCHEMA: 'app',
            CONSTRAINT_NAME: name,
            ORDINAL_POSITION: i + 1,
            ...extra,
          });
      };
      const [first, second] = swap ? ['F00D', '0BAD'] : ['0BAD', 'F00D'];
      fk('cn_links', XY, CD, `FK__cn_links__x__${first}`, system);
      fk('cn_links', XY, AB, `FK__cn_links__x__${second}`, system);
      fk('cn_ties', XY, AB, `FK__cn_ties__x__${first}`, { ...system, DELETE_RULE: 'CASCADE' });
      fk('cn_ties', XY, AB, `FK__cn_ties__x__${second}`, { ...system, DELETE_RULE: 'NO_ACTION' });
      // A system-named key whose default an explicit foreign key already holds.
      fk('cn_returns', ['tenant', 'y'], AB, 'FK__cn_return__tenan__1234', { ...system, DELETE_RULE: 'CASCADE' });
      fk('cn_returns', ['tenant', 'x'], AB, 'cn_returns_tenant_y_fkey', {});
      // An explicit CHECK and an explicit UNIQUE constraint hold the first two defaults.
      fk('cn_checked', XY, CD, `FK__cn_checke__x__${first}`, system);
      fk('cn_checked', XY, AB, `FK__cn_checke__x__${second}`, system);
      f.constraints.push(
        { TABLE_NAME: 'cn_checked', CONSTRAINT_NAME: 'cn_checked_x_y_fkey' },
        { TABLE_NAME: 'cn_checked', CONSTRAINT_NAME: 'cn_checked_x_y_fkey1' },
      );
      // The catalog lists keys by constraint name, so the suffixes order them.
      f.foreign.sort(
        (a, b) =>
          (String(a.CONSTRAINT_NAME) < String(b.CONSTRAINT_NAME) ? -1 : 0) ||
          (String(a.CONSTRAINT_NAME) > String(b.CONSTRAINT_NAME) ? 1 : 0) ||
          Number(a.ORDINAL_POSITION) - Number(b.ORDINAL_POSITION),
      );
      const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
      return Object.fromEntries(
        tables.map((table) => [
          table,
          Object.fromEntries(
            Object.entries(schema.tables[table]!.relations).map(([name, r]) => [
              name,
              [r.foreignKey, r.referenceKey, r.onDelete ?? null],
            ]),
          ),
        ]),
      );
    };
    const original = await read(false);
    assert.deepEqual(await read(true), original, 'exchanging generated suffixes changed the relations');
    assert.deepEqual(original, {
      // SQL Server records no declaration order: by referenced columns, then actions.
      cn_links: { cnLinksXY: [XY, AB, null], cnLinksXYFkey1: [XY, CD, null] },
      cn_ties: { cnTiesXY: [XY, AB, 'cascade'], cnTiesXYFkey1: [XY, AB, null] },
      cn_returns: {
        cnReturnsTenantY: [['tenant', 'x'], AB, null],
        cnReturnsTenantYFkey1: [['tenant', 'y'], AB, 'cascade'],
      },
      cn_checked: { cnCheckedXYFkey2: [XY, AB, null], cnCheckedXYFkey3: [XY, CD, null] },
    });
  });

  it('uses enforced plain unique keys for to-one, named as PostgreSQL names it, and the legacy opt-out', async () => {
    const f = catalogFixture();
    const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
    const rel = schema.tables.parents!.relations;
    for (const name of ['profile', 'primaryProfile']) assert.equal(rel[name]!.type, 'hasOne', name);
    for (const name of [
      'filteredProfiles',
      'computedProfiles',
      'supersetProfiles',
      'disabledProfiles',
      'hypotheticalProfiles',
    ])
      assert.equal(rel[name]!.type, 'hasMany', name);
    assert.equal(rel.profiles, undefined);
    assert.equal(schema.tables.composite_parents!.relations.compositeLink!.type, 'hasOne');
    assert.equal(schema.tables.composite_parents!.relations.compositeUniqueLink!.type, 'hasOne');
    assert.equal(schema.tables.text_parents!.relations.textProfile!.type, 'hasOne');
    assert.equal(schema.tables.text_parents!.relations.uncertainProfiles!.type, 'hasMany');
    assert.equal(schema.tables.text_parents!.relations.differentProfiles!.type, 'hasMany');
    const legacy = await introspectMssqlWith(f.exec, 'app', { logger: {}, legacyToManyUniques: true });
    // The opt-out keeps the arrays and the plural names they had before the to-one rule.
    assert.deepEqual(
      Object.keys(legacy.tables.parents!.relations).sort(),
      Object.keys(rel)
        .map((name) => (name === 'profile' ? 'profiles' : name === 'primaryProfile' ? 'primaryProfiles' : name))
        .sort(),
    );
    assert.equal(legacy.tables.parents!.relations.profiles!.type, 'hasMany');
    // Exercise the generic dialect seam with its whole options object as CLI generation does.
    const viaDialect = await introspect({
      connectionString: 'unused',
      schema: 'app',
      logger: {},
      legacyToManyUniques: true,
      relationNames: { parents: { profiles: 'profileDetails' } },
      dialect: {
        ...mssqlDialect,
        introspector: { introspect: (options) => introspectMssqlWith(f.exec, options.schema, options) },
      },
    });
    assert.equal(viaDialect.tables.parents!.relations.profileDetails!.type, 'hasMany');
  });

  it('emits and decodes to-one JSON objects alongside conservative array relations', async () => {
    const schema = await introspectMssqlWith(catalogFixture().exec, 'app', { logger: {} });
    const parent = makeQuery('parents', schema, { dialect: mssqlDialect });
    const query = parent.buildFindMany({ with: { profile: true, filteredProfiles: true } });
    assert.equal((query.sql.match(/WITHOUT_ARRAY_WRAPPER/g) ?? []).length, 1);
    const decoded = query.transform({
      rows: [
        {
          id: 1,
          profile: JSON.stringify({ id: 3, parent_id: 1, scope: 0, label: null }),
          filteredProfiles: JSON.stringify([
            { id: 4, parent_id: 1, scope: 0, label: null },
            { id: 5, parent_id: 1, scope: 0, label: null },
          ]),
        },
      ],
      rowCount: 1,
    });
    assert.deepEqual(decoded, [
      {
        id: 1,
        profile: { id: 3, parentId: 1, scope: 0, label: null },
        filteredProfiles: [
          { id: 4, parentId: 1, scope: 0, label: null },
          { id: 5, parentId: 1, scope: 0, label: null },
        ],
      },
    ]);
    const legacy = await introspectMssqlWith(catalogFixture().exec, 'app', { logger: {}, legacyToManyUniques: true });
    assert.doesNotMatch(
      makeQuery('parents', legacy, { dialect: mssqlDialect }).buildFindMany({ with: { profiles: true } }).sql,
      /WITHOUT_ARRAY_WRAPPER/,
    );
  });

  it('keeps filtered, computed, disabled, hypothetical and non-key indexes out of unique selectors', async () => {
    const f = catalogFixture();
    f.indexes.push(
      ...catalogIndex('parents', 'IX_columnstore', ['id'], {
        IS_UNIQUE: false,
        SEQ: 0,
        IS_INCLUDED: true,
        TYPE_DESC: 'NONCLUSTERED_COLUMNSTORE',
      }),
    );
    f.indexes[0]!.IS_DESCENDING = true;
    const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
    assert.deepEqual(schema.tables.profiles!.uniqueColumns, [['parent_id']]);
    assert.deepEqual(schema.tables.profiles!.indexes[0]!.columns, ['parent_id']);
    assert.match(schema.tables.profiles!.indexes[0]!.definition, /\[parent_id\] DESC.*INCLUDE \(\[label\]\)/);
    assert.deepEqual(schema.tables.filtered_profiles!.uniqueColumns, []);
    assert.equal(schema.tables.filtered_profiles!.indexes[0]!.partial, true);
    assert.equal(schema.tables.filtered_profiles!.indexes[0]!.unique, true);
    for (const name of ['computed_profiles', 'disabled_profiles', 'hypothetical_profiles']) {
      assert.deepEqual(schema.tables[name]!.uniqueColumns, [], name);
      assert.deepEqual(schema.tables[name]!.indexes[0]!.columns, [], name);
    }
    assert.equal(schema.tables.disabled_profiles!.indexes[0]!.unique, false);
    assert.match(schema.tables.disabled_profiles!.indexes[0]!.definition, /UNIQUE.*DISABLED/);
    assert.deepEqual(schema.tables.parents!.indexes[0]!.columns, []);
    const unsafe = makeQuery('filtered_profiles', schema, { dialect: mssqlDialect });
    assert.throws(
      () => unsafe.buildFindUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } }),
      /unique|Unknown/i,
    );
    const safe = makeQuery('superset_profiles', schema, { dialect: mssqlDialect });
    assert.match(safe.buildFindUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } }).sql, /\[parent_id\]/);
    assert.doesNotMatch(f.queries.find((q) => q.includes('sys.indexes'))!, /filter_definition|\.definition/i);
    for (const emitter of [generateIndex, generateMetadata, generateTypes]) {
      assert.equal(
        emitter(schema, { target: 'mssql', noTimestamp: true }),
        emitter(schema, { target: 'mssql', noTimestamp: true }),
      );
    }
  });

  it('refuses cardinality shortcuts for inactive primary keys, mismatched type dimensions and unknown collation', async () => {
    for (const change of [
      'disabled-pk',
      'precision',
      'scale',
      'length',
      'type',
      'unknown-length',
      'unknown-precision',
    ]) {
      const f = catalogFixture();
      const primary = f.primary.find((r) => r.TABLE_NAME === 'primary_profiles')!;
      const child = f.columns.find((r) => r.TABLE_NAME === 'profiles' && r.COLUMN_NAME === 'parent_id')!;
      if (change === 'disabled-pk') primary.IS_DISABLED = true;
      if (change === 'precision') child.NUMERIC_PRECISION = 19;
      if (change === 'scale') child.NUMERIC_SCALE = 2;
      if (change === 'length') child.CHARACTER_MAXIMUM_LENGTH = 12;
      if (change === 'type') child.DATA_TYPE = 'bigint';
      if (change.startsWith('unknown-')) {
        const parent = f.columns.find((r) => r.TABLE_NAME === 'parents' && r.COLUMN_NAME === 'id')!;
        for (const row of [child, parent])
          Object.assign(
            row,
            change === 'unknown-length'
              ? {
                  DATA_TYPE: 'nvarchar',
                  CHARACTER_MAXIMUM_LENGTH: null,
                  COLLATION_NAME: 'Latin1_General_100_CS_AS',
                }
              : { DATA_TYPE: 'decimal', NUMERIC_PRECISION: null, NUMERIC_SCALE: null },
          );
      }

      const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
      assert.equal(
        schema.tables.parents!.relations[change === 'disabled-pk' ? 'primaryProfiles' : 'profiles']!.type,
        'hasMany',
        change,
      );
    }
  });

  it('groups quoted/dotted names without collisions and never copies native expression literals into output', async () => {
    const f = catalogFixture();
    f.tables.push('dot.name', 'dot');
    f.columns.push(catalogColumn('dot.name', 'id'), catalogColumn('dot', 'name.id'));
    f.identities.push({ TABLE_NAME: 'dot.name', COLUMN_NAME: 'id' });
    f.indexes.push(
      ...catalogIndex('dot.name', 'key]quoted', ['id']),
      ...catalogIndex('dot', 'name.key]quoted', ['name.id']),
    );
    for (const row of [...f.columns, ...f.indexes])
      Object.assign(row, {
        definition: "N'PRIVATE_CATALOG_LITERAL'",
        filter_definition: "label=N'PRIVATE_CATALOG_LITERAL'",
        generation_expression: "N'PRIVATE_CATALOG_LITERAL'",
        COLUMN_DEFAULT: null,
      });
    f.columns.find((c) => c.TABLE_NAME === 'generated_records' && c.COLUMN_NAME === 'default_count')!.COLUMN_DEFAULT =
      "N'PRIVATE_CATALOG_LITERAL'";
    const schema = await introspectMssqlWith(f.exec, 'app', { logger: {} });
    assert.equal(schema.tables['dot.name']!.columns[0]!.hasDefault, true);
    assert.equal(schema.tables.dot!.columns[0]!.hasDefault, false);
    assert.equal(schema.tables['dot.name']!.indexes.length, 1);
    assert.equal(schema.tables.dot!.indexes.length, 1);
    assert.match(schema.tables['dot.name']!.indexes[0]!.definition, /\[key\]\]quoted\] ON \[app\]\.\[dot.name\]/);
    assert.throws(() => generateTypes(schema), /not a valid TypeScript identifier/);
    delete schema.tables['dot.name'];
    delete schema.tables.dot;
    for (const emitter of [generateIndex, generateMetadata, generateTypes])
      assert.doesNotMatch(emitter(schema, { target: 'mssql', noTimestamp: true }), /PRIVATE_CATALOG_LITERAL/);
  });
});
