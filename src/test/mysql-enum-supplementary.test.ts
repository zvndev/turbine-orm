/**
 * ENUM labels with supplementary Unicode never reach a type as damaged text.
 *
 * MySQL 8's `information_schema` reports `COLUMN_TYPE` in utf8mb3, so a label
 * holding a character outside the BMP arrives with `?` where the character
 * was (`雪🙂` becomes `雪?`), while the stored definition and row data are
 * intact. Emitting that text as a literal type names a label the column does
 * not have and rejects the one it does. Introspection issues SELECTs only:
 * a suspect column (a `?` on a charset that can encode past the BMP) is
 * marked `enumLabelsUnrecoverable`, warned about by name, and typed `string`.
 * The one way to exact literal types is to declare the labels explicitly.
 *
 * These cases drive `introspectMysqlWith` on a fake catalog; the native round
 * trip against a real server is mysql-enum-supplementary.integration.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMetadata, generateTypes, generateZod } from '../generate.js';
import type { TurbineLogger } from '../logger.js';
import { introspectMysqlWith, type MysqlRowExecutor } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';

const TRUE_MOOD = ['plain', '雪🙂', '😀', 'has?mark', ''];
const CATALOG_MOOD = `enum('plain','雪?','?','has?mark','')`;

function column(name: string, overrides: Record<string, unknown> = {}) {
  return {
    TABLE_NAME: 'tickets',
    COLUMN_NAME: name,
    DATA_TYPE: 'int',
    COLUMN_TYPE: 'int',
    IS_NULLABLE: 'NO',
    COLUMN_KEY: '',
    COLUMN_DEFAULT: null,
    EXTRA: '',
    CHARACTER_MAXIMUM_LENGTH: null,
    CHARACTER_SET_NAME: null,
    COLLATION_NAME: null,
    GENERATION_EXPRESSION: '',
    ...overrides,
  };
}

/**
 * A fake catalog. The executor answers the catalog SELECTs and records every
 * statement, so a test can see that nothing but those SELECTs was sent.
 */
function catalog(options: { moodCharset?: string | null; moodType?: string } = {}): {
  exec: MysqlRowExecutor;
  statements: string[];
} {
  const statements: string[] = [];
  const exec: MysqlRowExecutor = async (sql) => {
    statements.push(sql);
    if (sql.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'tickets' }];
    if (sql.includes('information_schema.COLUMNS')) {
      return [
        column('id', { COLUMN_KEY: 'PRI' }),
        column('mood', {
          DATA_TYPE: 'enum',
          COLUMN_TYPE: options.moodType ?? CATALOG_MOOD,
          CHARACTER_SET_NAME: options.moodCharset === undefined ? 'utf8mb4' : options.moodCharset,
          COLLATION_NAME: 'utf8mb4_0900_ai_ci',
        }),
        column('kind', {
          DATA_TYPE: 'enum',
          COLUMN_TYPE: `enum('a?b','雪')`,
          CHARACTER_SET_NAME: 'utf8mb3',
          COLLATION_NAME: 'utf8mb3_bin',
        }),
        column('state', {
          DATA_TYPE: 'enum',
          COLUMN_TYPE: `enum('new','done')`,
          CHARACTER_SET_NAME: 'utf8mb4',
          COLLATION_NAME: 'utf8mb4_0900_ai_ci',
        }),
      ];
    }
    if (sql.includes("CONSTRAINT_NAME = 'PRIMARY'"))
      return [{ TABLE_NAME: 'tickets', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }];
    if (sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) return [];
    if (sql.includes('information_schema.STATISTICS')) return [];
    return [];
  };
  return { exec, statements };
}

function moodColumn(schema: SchemaMetadata) {
  return schema.tables.tickets!.columns.find((c) => c.name === 'mood')!;
}

function capture(): { logger: TurbineLogger; warnings: { message: string; code: string; table?: string }[] } {
  const warnings: { message: string; code: string; table?: string }[] = [];
  return {
    warnings,
    logger: { warn: (message, entry) => warnings.push({ message, code: entry.code, table: entry.table }) },
  };
}

describe('introspectMysqlWith never writes: a suspect ENUM is marked and its labels withheld', () => {
  it('marks a suspect column, warns by table and column, and issues SELECTs only', async () => {
    const { exec, statements } = catalog();
    const { logger, warnings } = capture();
    const schema = await introspectMysqlWith(exec, 'app', { logger });
    assert.equal(Object.hasOwn(schema.enums, 'tickets.mood'), false);
    assert.equal(moodColumn(schema).enumLabelsUnrecoverable, true);
    // Tables, columns, primary keys, foreign keys, constraint names, indexes.
    assert.equal(statements.length, 6);
    assert.ok(
      statements.every((sql) => /^SELECT\b/.test(sql) && sql.includes('information_schema')),
      statements.join('\n'),
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, 'introspect-enum-labels-unrecoverable');
    assert.equal(warnings[0]!.table, 'tickets');
    assert.match(warnings[0]!.message, /"tickets\.mood"/);
    assert.match(warnings[0]!.message, /typed as string/);
    // The one way to exact literal types, spelled out for CLI and library users.
    assert.match(warnings[0]!.message, /declare its labels explicitly/);
    assert.ok(warnings[0]!.message.includes(`columnTypes: { "tickets.mood": "'a' | 'b'" }`), warnings[0]!.message);
    assert.ok(warnings[0]!.message.includes(`schema.enums["tickets.mood"] = ['a', 'b']`), warnings[0]!.message);
    assert.match(warnings[0]!.message, /a label that really contains "\?" reads the same/);
    assert.doesNotMatch(warnings[0]!.message, /recoverEnumLabels|TEMPORARY/);
  });

  it('never marks a column whose charset the catalog renders exactly, or whose labels hold no ?', async () => {
    const { exec } = catalog();
    const schema = await introspectMysqlWith(exec, 'app', { logger: {} });
    assert.deepEqual(schema.enums['tickets.kind'], ['a?b', '雪']);
    assert.deepEqual(schema.enums['tickets.state'], ['new', 'done']);
    for (const name of ['kind', 'state']) {
      assert.equal(schema.tables.tickets!.columns.find((c) => c.name === name)!.enumLabelsUnrecoverable, undefined);
    }
  });

  it('a literal ? on a supplementary-capable charset, or no charset reported, is withheld too', async () => {
    // Wider than the truth, never wrong: from catalog text alone a `?` there
    // cannot be told from a lost character.
    for (const options of [{ moodType: "enum('has?mark','plain')" }, { moodCharset: null }]) {
      const { exec, statements } = catalog(options);
      const schema = await introspectMysqlWith(exec, 'app', { logger: {} });
      assert.equal(Object.hasOwn(schema.enums, 'tickets.mood'), false, JSON.stringify(options));
      assert.equal(moodColumn(schema).enumLabelsUnrecoverable, true);
      assert.ok(statements.every((sql) => /^SELECT\b/.test(sql)));
    }
  });
});

describe('generation over the fallback and over exact labels', () => {
  async function fallbackSchema(): Promise<SchemaMetadata> {
    return introspectMysqlWith(catalog().exec, 'app', { logger: {} });
  }

  it('exact labels generate the exact literal union and zod enum', async () => {
    const schema = await fallbackSchema();
    // Labels declared explicitly, with or without the marker still present.
    schema.enums['tickets.mood'] = TRUE_MOOD;
    const types = generateTypes(schema, { target: 'mysql', noTimestamp: true });
    assert.match(types, /mood: 'plain' \| '雪🙂' \| '😀' \| 'has\?mark' \| '';/);
    assert.ok(generateZod(schema, { target: 'mysql', noTimestamp: true }).includes("'雪🙂'"));
  });

  it('the fallback marker generates string and z.string(), never the damaged labels', async () => {
    const schema = await fallbackSchema();
    const types = generateTypes(schema, { target: 'mysql', noTimestamp: true });
    assert.match(types, /mood: string;/);
    assert.doesNotMatch(types, /雪\?/);
    const zod = generateZod(schema, { target: 'mysql', noTimestamp: true });
    assert.match(zod, /mood: z\.string\(\),/);
    assert.doesNotMatch(zod, /雪\?/);
    // The neighbour with exact labels keeps its union.
    assert.match(types, /state: 'new' \| 'done';/);
  });

  it('the marker survives metadata generation, and declared labels outrank it', async () => {
    const schema = await fallbackSchema();
    assert.match(generateMetadata(schema, { target: 'mysql', noTimestamp: true }), /enumLabelsUnrecoverable: true/);
    // A `columnTypes` override names the type outright.
    assert.match(
      generateTypes(schema, {
        target: 'mysql',
        noTimestamp: true,
        columnTypes: { 'tickets.mood': "'雪🙂' | 'plain'" },
      }),
      /mood: '雪🙂' \| 'plain';/,
    );
    // A caller who supplies the exact labels outranks the inferred marker.
    schema.enums['tickets.mood'] = ['雪🙂'];
    assert.match(generateTypes(schema, { target: 'mysql', noTimestamp: true }), /mood: '雪🙂';/);
  });
});
