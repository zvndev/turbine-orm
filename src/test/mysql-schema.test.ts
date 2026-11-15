import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import { cmdMysqlMigrate } from '../cli/mysql-migrate-command.js';
import { type MysqlSchemaSnapshot, planMysqlSchema } from '../cli/mysql-schema.js';
import { cmdMysqlSchema } from '../cli/mysql-schema-command.js';
import { quoteMysqlSchemaName } from '../cli/mysql-schema-ddl.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const inheritedDatabaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  if (inheritedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = inheritedDatabaseUrl;
});

const base = () =>
  defineSchema({
    users: {
      id: { type: 'serial', primaryKey: true },
      email: { type: 'varchar', maxLength: 100, notNull: true, unique: true },
    },
  });
const empty = (): MysqlSchemaSnapshot => ({
  database: 'app',
  version: '8.4.0',
  metadata: { tables: {}, enums: {} },
  fingerprint: 'f'.repeat(64),
  facts: { tables: [], columns: [], indexes: [], foreignKeys: [], unsupported: [] },
});
const existing = (): MysqlSchemaSnapshot => ({
  ...empty(),
  metadata: schemaDefToMetadata(base()),
  facts: {
    tables: [
      {
        TABLE_NAME: 'users',
        TABLE_TYPE: 'BASE TABLE',
        ENGINE: 'InnoDB',
        TABLE_COLLATION: 'utf8mb4_0900_ai_ci',
        ROW_FORMAT: 'Dynamic',
        CREATE_OPTIONS: '',
        TABLE_COMMENT: '',
      },
    ],
    columns: [
      {
        TABLE_NAME: 'users',
        COLUMN_NAME: 'id',
        COLUMN_TYPE: 'int',
        IS_NULLABLE: 'NO',
        COLUMN_DEFAULT: null,
        EXTRA: 'auto_increment',
        GENERATION_EXPRESSION: '',
        CHARACTER_SET_NAME: null,
        COLLATION_NAME: null,
        COLUMN_COMMENT: '',
      },
      {
        TABLE_NAME: 'users',
        COLUMN_NAME: 'email',
        COLUMN_TYPE: 'varchar(100)',
        IS_NULLABLE: 'NO',
        COLUMN_DEFAULT: null,
        EXTRA: '',
        GENERATION_EXPRESSION: '',
        CHARACTER_SET_NAME: 'utf8mb4',
        COLLATION_NAME: 'utf8mb4_0900_bin',
        COLUMN_COMMENT: '',
      },
    ],
    indexes: ['PRIMARY', 'email'].map((name) => ({
      TABLE_NAME: 'users',
      INDEX_NAME: name,
      NON_UNIQUE: 0,
      SEQ_IN_INDEX: 1,
      COLUMN_NAME: name === 'PRIMARY' ? 'id' : 'email',
      SUB_PART: null,
      EXPRESSION: null,
      COLLATION: 'A',
      INDEX_TYPE: 'BTREE',
      IS_VISIBLE: 'YES',
      INDEX_COMMENT: '',
    })),
    foreignKeys: [],
    unsupported: [],
  },
});

describe('conservative MySQL schema comparison', () => {
  it('renders native types, quoting, literal defaults, ordered keys and deferred foreign keys', () => {
    const schema = defineSchema({
      parents: {
        id: { type: 'bigserial', primaryKey: true },
        code: { type: 'varchar', maxLength: 20, unique: true, default: "'O''Brien'" },
      },
      children: {
        id: { type: 'serial', primaryKey: true },
        parentId: { type: 'bigint', references: { target: 'parents.id', onDelete: 'set null', onUpdate: 'cascade' } },
        active: { type: 'boolean', notNull: true, default: true },
        note: { type: 'text' },
        config: { type: 'json' },
        day: { type: 'date' },
        count: { type: 'smallint', default: -2 },
        indexes: [{ name: 'child`key', columns: ['parentId', 'id'] }],
      },
    });
    const plan = planMysqlSchema(schema, empty());
    assert.deepEqual(
      plan.steps.map((s) => s.kind),
      ['create-table', 'create-table', 'add-foreign-key'],
    );
    assert.match(plan.up, /`id` BIGINT NOT NULL AUTO_INCREMENT/);
    assert.match(plan.up, /`parent_id` BIGINT NULL/);
    assert.match(plan.up, /`active` TINYINT\(1\) NOT NULL DEFAULT 1/);
    assert.match(plan.up, /`config` JSON NULL/);
    assert.match(plan.up, /`day` DATE NULL/);
    assert.match(plan.up, /`count` SMALLINT NULL DEFAULT -2/);
    assert.match(plan.up, /DEFAULT 'O''Brien'/);
    assert.match(plan.up, /INDEX `child``key` \(`parent_id`, `id`\)/);
    assert.match(
      plan.up,
      /FOREIGN KEY \(`parent_id`\) REFERENCES `parents` \(`id`\) ON DELETE SET NULL ON UPDATE CASCADE/,
    );
    assert.equal(plan.requiresAlterConsent, true);
    assert.match(plan.down, /^ALTER TABLE `children` DROP FOREIGN KEY/);
    assert.match(plan.down, /DROP TABLE `parents`;\nDROP TABLE `children`;$/);
    assert.equal(quoteMysqlSchemaName('order`log'), '`order``log`');
  });
  it('is a no-op on complete native definitions, accepting names implicit in column UNIQUE', () => {
    const plan = planMysqlSchema(base(), existing());
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.up, '');
    assert.equal(plan.down, '');
  });
  it('plans nullable/defaulted additions and explicit indexes without changing existing data definitions', () => {
    const schema = base();
    Object.assign(
      schema.tables.users!.columns,
      defineSchema({
        x: {
          displayName: { type: 'varchar', maxLength: 30 },
          active: { type: 'boolean', notNull: true, default: false },
        },
      }).tables.x!.columns,
    );
    schema.tables.users!.indexes = [{ columns: ['displayName'], name: 'by_display' }];
    const plan = planMysqlSchema(schema, existing());
    assert.deepEqual(
      plan.steps.map((s) => s.kind),
      ['add-column', 'add-column', 'add-index'],
    );
    assert.match(plan.up, /ADD COLUMN `active` TINYINT\(1\) NOT NULL DEFAULT 0/);
    assert.match(plan.down, /^DROP INDEX `by_display` ON `users`;\nALTER TABLE `users` DROP COLUMN `active`;/);
  });
  it('is deterministic for table declaration order and bounded long generated names', () => {
    const id = { type: 'serial' as const, primaryKey: true };
    assert.equal(
      planMysqlSchema(defineSchema({ z: { id }, a: { id } }), empty()).up,
      planMysqlSchema(defineSchema({ a: { id }, z: { id } }), empty()).up,
    );
    const schema = defineSchema({ ['t'.repeat(55)]: { id, ['c'.repeat(55)]: { type: 'integer', unique: true } } });
    const sql = planMysqlSchema(schema, empty()).up;
    const name = /UNIQUE INDEX `([^`]+)`/.exec(sql)![1]!;
    assert.ok(name.length <= 64);
    assert.match(name, /_[a-f0-9]{16}$/);
  });
  for (const [label, mutate] of Object.entries<(s: MysqlSchemaSnapshot) => void>({
    'unsigned type': (s) => {
      s.facts.columns[0]!.COLUMN_TYPE = 'int unsigned';
    },
    'generated expression': (s) => {
      s.facts.columns[1]!.GENERATION_EXPRESSION = 'lower(email)';
    },
    'on update extra': (s) => {
      s.facts.columns[1]!.EXTRA = 'on update CURRENT_TIMESTAMP';
    },
    'unmodeled default': (s) => {
      s.facts.columns[1]!.COLUMN_DEFAULT = 'native';
    },
    'collation difference': (s) => {
      s.facts.columns[1]!.COLLATION_NAME = 'utf8mb4_0900_ai_ci';
    },
    'nullability change': (s) => {
      s.facts.columns[1]!.IS_NULLABLE = 'YES';
    },
    'column comment': (s) => {
      s.facts.columns[1]!.COLUMN_COMMENT = 'native';
    },
    'column removal': (s) => {
      s.facts.columns.push({ ...s.facts.columns[1], COLUMN_NAME: 'extra' });
    },
    'table removal': (s) => {
      s.facts.tables.push({ ...s.facts.tables[0], TABLE_NAME: 'extra' });
    },
    view: (s) => {
      s.facts.tables[0]!.TABLE_TYPE = 'VIEW';
    },
    engine: (s) => {
      s.facts.tables[0]!.ENGINE = 'MyISAM';
    },
    'table options': (s) => {
      s.facts.tables[0]!.CREATE_OPTIONS = 'partitioned';
    },
    'table comment': (s) => {
      s.facts.tables[0]!.TABLE_COMMENT = 'native';
    },
    'missing metadata': (s) => {
      s.metadata.tables = {};
    },
    'prefix index': (s) => {
      s.facts.indexes[1]!.SUB_PART = 5;
    },
    'expression index': (s) => {
      s.facts.indexes[1]!.EXPRESSION = 'lower(email)';
    },
    'descending index': (s) => {
      s.facts.indexes[1]!.COLLATION = 'D';
    },
    'invisible index': (s) => {
      s.facts.indexes[1]!.IS_VISIBLE = 'NO';
    },
    'fulltext index': (s) => {
      s.facts.indexes[1]!.INDEX_TYPE = 'FULLTEXT';
    },
    'index comment': (s) => {
      s.facts.indexes[1]!.INDEX_COMMENT = 'native';
    },
    'incomplete index order': (s) => {
      s.facts.indexes[1]!.SEQ_IN_INDEX = 2;
    },
    'extra index': (s) => {
      s.facts.indexes.push({ ...s.facts.indexes[1], INDEX_NAME: 'extra' });
    },
    'primary key change': (s) => {
      s.facts.indexes.shift();
    },
    'check constraint': (s) => {
      s.facts.unsupported.push({ TABLE_NAME: 'users', KIND: 'CHECK' });
    },
    trigger: (s) => {
      s.facts.unsupported.push({ TABLE_NAME: 'users', KIND: 'TRIGGER' });
    },
    partition: (s) => {
      s.facts.unsupported.push({ TABLE_NAME: 'users', KIND: 'PARTITION' });
    },
    'foreign key removal': (s) => {
      s.facts.foreignKeys.push({ TABLE_NAME: 'users', CONSTRAINT_NAME: 'extra', COLUMN_NAME: 'id' });
    },
  }))
    it(`refuses ${label}`, () => {
      const snapshot = existing();
      mutate(snapshot);
      assert.throws(() => planMysqlSchema(base(), snapshot), /comparison refused/);
    });
  for (const type of ['timestamp', 'timestamptz', 'uuid', 'numeric', 'real', 'double', 'bytea'] as const)
    it(`refuses unmodeled ${type} semantics`, () =>
      assert.throws(() => planMysqlSchema(defineSchema({ x: { c: { type } } }), empty()), /unsupported type/));
  for (const [label, def] of Object.entries({
    expression: { type: 'integer' as const, default: '1 + 1' },
    injection: { type: 'varchar' as const, maxLength: 30, default: "'x'; DROP TABLE x;--" },
    backslash: { type: 'varchar' as const, maxLength: 30, default: "'x\\n'" },
    supplementary: { type: 'varchar' as const, maxLength: 30, default: "'😀'" },
    ambiguousQuestion: { type: 'varchar' as const, maxLength: 30, default: "'?'" },
    invalidSurrogate: { type: 'varchar' as const, maxLength: 30, default: "'\ud800'" },
    tooLong: { type: 'varchar' as const, maxLength: 2, default: "'long'" },
    noLength: { type: 'varchar' as const },
    range: { type: 'smallint' as const, default: 40000 },
    boolRange: { type: 'boolean' as const, default: 2 },
    textDefault: { type: 'text' as const, default: "'text'" },
    dateDefault: { type: 'date' as const, default: 'CURRENT_DATE' },
    jsonDefault: { type: 'json' as const, default: "'{}'" },
    array: { type: 'integer' as const, array: true },
    check: { type: 'integer' as const, check: 'c > 0' },
    updatedAt: { type: 'date' as const, updatedAt: true },
  }))
    it(`refuses unsupported default or feature: ${label}`, () =>
      assert.throws(() => planMysqlSchema(defineSchema({ x: { c: def } }), empty()), /comparison refused/));
  it('refuses required additions without a non-NULL default', () => {
    const schema = base();
    Object.assign(
      schema.tables.users!.columns,
      defineSchema({ x: { count: { type: 'integer', notNull: true } } }).tables.x!.columns,
    );
    assert.throws(() => planMysqlSchema(schema, existing()), /must be nullable/);
  });
  it('refuses changed named index definitions', () => {
    const schema = base();
    schema.tables.users!.columns.email!.isUnique = false;
    schema.tables.users!.indexes = [{ name: 'email', columns: ['id'], unique: true }];
    assert.throws(() => planMysqlSchema(schema, existing()), /index definition change/);
  });
  it('refuses foreign keys with differing native type, absent unique target, SET DEFAULT or invalid SET NULL', () => {
    for (const ref of [
      { target: 'parents.id', onDelete: 'set default' as const },
      { target: 'parents.id', onDelete: 'set null' as const },
    ])
      assert.throws(
        () =>
          planMysqlSchema(
            defineSchema({
              parents: { id: { type: 'integer', primaryKey: true } },
              children: { parentId: { type: 'integer', notNull: true, references: ref } },
            }),
            empty(),
          ),
        /comparison refused/,
      );
    assert.throws(
      () =>
        planMysqlSchema(
          defineSchema({
            parents: { id: { type: 'bigint', primaryKey: true } },
            children: { parentId: { type: 'integer', references: 'parents.id' } },
          }),
          empty(),
        ),
      /identical-type/,
    );
    assert.throws(
      () =>
        planMysqlSchema(
          defineSchema({
            parents: { id: { type: 'integer' } },
            children: { parentId: { type: 'integer', references: 'parents.id' } },
          }),
          empty(),
        ),
      /unique target/,
    );
  });
  it('refuses invalid identifiers and reserved runner objects', () => {
    for (const name of ['', 'x\n', 'x\\y', 'x/', 'x.y', 'x'.repeat(65), 'x\0'])
      assert.throws(() => quoteMysqlSchemaName(name), /invalid native identifier/);
    assert.throws(
      () => planMysqlSchema(defineSchema({ _turbine_migrations: { id: { type: 'integer' } } }), empty()),
      /reserved/,
    );
  });
  it('refuses malformed diff arguments before schema import or connection', async () => {
    const config = resolveConfig({ engine: 'mysql', url: 'mysql://127.0.0.1:1/app' }, {});
    let imports = 0;
    const load = async () => {
      imports++;
      return base();
    };
    for (const argv of [
      ['diff', '--url', '--exit-code'],
      ['diff', '--schema-file', '--help'],
      ['diff', '--force'],
    ])
      await assert.rejects(
        cmdMysqlSchema({ command: 'diff', positional: [] }, config, load, argv),
        /operand|Unsupported/,
      );
    await assert.rejects(cmdMysqlSchema({ command: 'push', positional: [] }, config, load, ['push']), /Usage/);
    await assert.rejects(
      cmdMysqlSchema({ command: 'diff', positional: [] }, { ...config, include: ['users'] }, load, ['diff']),
      /complete schema/,
    );
    await assert.rejects(
      cmdMysqlMigrate({ command: 'migrate', subcommand: 'up', positional: [], fromDiff: true }, config, load),
      /only apply/,
    );
    await assert.rejects(
      cmdMysqlMigrate({ command: 'migrate', subcommand: 'create', positional: ['x'], fromDiff: true }, config),
      /loader integration/,
    );
    for (const engine of ['postgresql', 'sqlite', 'mssql'] as const)
      await assert.rejects(cmdMysqlSchema({ command: 'diff', positional: [] }, { ...config, engine }, load, ['diff']));
    assert.equal(imports, 0);
  });
});
