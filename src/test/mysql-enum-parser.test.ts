import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { introspectMysqlWith, type MysqlRowExecutor } from '../mysql.js';

const fixture: {
  columnType: string;
  labels: string[];
  storedSupplementaryLabel: string;
  reportedSupplementaryLabel: string;
} = JSON.parse(readFileSync(new URL('./fixtures/mysql-enum-parser/labels.json', import.meta.url), 'utf8'));

/**
 * A fake catalog whose executor accepts only the five catalog SELECTs, so any
 * other statement (a write included) fails the test. `charset` is the ENUM
 * column's `CHARACTER_SET_NAME`; omitted, the row carries none.
 */
function catalog(columnType: unknown, dataType = 'enum', charset?: string) {
  const calls: string[] = [];
  const exec: MysqlRowExecutor = async (sql, params) => {
    calls.push(sql);
    assert.deepEqual(params, ['enum_catalog']);
    if (sql.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'labels' }, { TABLE_NAME: 'other' }];
    if (sql.includes('information_schema.COLUMNS')) {
      return [
        {
          TABLE_NAME: 'labels',
          COLUMN_NAME: 'value',
          DATA_TYPE: dataType,
          COLUMN_TYPE: columnType,
          IS_NULLABLE: 'YES',
          COLUMN_KEY: '',
          COLUMN_DEFAULT: null,
          EXTRA: '',
          GENERATION_EXPRESSION: '',
          ...(charset === undefined ? {} : { CHARACTER_SET_NAME: charset }),
        },
        {
          TABLE_NAME: 'other',
          COLUMN_NAME: 'value',
          DATA_TYPE: 'enum',
          COLUMN_TYPE: "enum('simple','')",
          IS_NULLABLE: 'NO',
          COLUMN_KEY: '',
          COLUMN_DEFAULT: null,
          EXTRA: '',
          GENERATION_EXPRESSION: '',
        },
      ];
    }
    assert.match(sql, /information_schema\.(KEY_COLUMN_USAGE|STATISTICS|TABLE_CONSTRAINTS)/);
    return [];
  };
  return { exec, calls };
}

describe('MySQL inline ENUM catalog decoding', () => {
  it('preserves ordered full labels, empty values, BMP text and every ASCII control', async () => {
    assert.equal(fixture.labels.length, 60);
    // A BMP-only column: utf8mb3 renders every label it can hold exactly, so
    // the decoded catalog text IS the label list, `?` included.
    const { exec, calls } = catalog(fixture.columnType, 'enum', 'utf8mb3');
    const metadata = await introspectMysqlWith(exec, 'enum_catalog', { logger: {} });
    assert.deepEqual(Object.keys(metadata.enums), ['labels.value', 'other.value']);
    assert.deepEqual(metadata.enums['labels.value'], fixture.labels);
    assert.deepEqual(metadata.enums['other.value'], ['simple', '']);
    assert.equal(calls.length, 6);
    assert(calls.every((sql) => /^SELECT\b/.test(sql)));
    for (let code = 0; code < 32; code++) assert(fixture.labels.includes(`ascii${String.fromCharCode(code)}mid`));
    assert(fixture.labels.includes(`del${String.fromCharCode(127)}mid`));
    assert(fixture.labels.includes('line\nmid'));
    assert(fixture.labels.includes('literal\\n'));
    assert(fixture.labels.includes('?'));
    assert(fixture.labels.includes(fixture.reportedSupplementaryLabel));
    assert(!metadata.enums['labels.value']!.includes(fixture.storedSupplementaryLabel));
  });

  it('decodes a column that can hold supplementary labels, then withholds the labels, with SELECTs only', async () => {
    // On utf8mb4 (or with no charset reported) a `?` may be a lost character,
    // so the decoded list is withheld rather than emitted. The decode still
    // ran: malformed text would have thrown, and the other column's labels
    // land as before. Default introspection never writes, so the executor,
    // which refuses every statement but the five catalog SELECTs, is enough.
    for (const charset of ['utf8mb4', undefined]) {
      const { exec, calls } = catalog(fixture.columnType, 'enum', charset);
      const warnings: string[] = [];
      const metadata = await introspectMysqlWith(exec, 'enum_catalog', { logger: { warn: (m) => warnings.push(m) } });
      assert.deepEqual(Object.keys(metadata.enums), ['other.value']);
      assert.deepEqual(metadata.enums['other.value'], ['simple', '']);
      assert.equal(metadata.tables.labels!.columns[0]!.enumLabelsUnrecoverable, true);
      assert.equal(metadata.tables.other!.columns[0]!.enumLabelsUnrecoverable, undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /"labels\.value"/);
      assert.equal(calls.length, 6);
      assert(calls.every((sql) => /^SELECT\b/.test(sql)));
    }
  });

  it('accepts single empty and quote-only labels without trimming their contents', async () => {
    for (const [source, labels] of [
      ["ENUM('')", ['']],
      ["enum('''','''''',' a ','(,)')", ["'", "''", ' a ', '(,)']],
    ] as const) {
      const metadata = await introspectMysqlWith(catalog(source).exec, 'enum_catalog', { logger: {} });
      assert.deepEqual(metadata.enums['labels.value'], labels);
    }
  });

  it('refuses malformed, omitted, truncated and unconsumed definitions without a partial result', async () => {
    for (const source of [
      undefined,
      null,
      '',
      'enum()',
      "enum('a'",
      "enum('a','b)",
      "enum('a',)",
      "enum('a')junk",
      "enum('a')\n",
      "enum('a')('b')",
      "enum('a',unquoted)",
      "enum('a' 'b')",
      "enum('a\\q')",
      "set('a')",
    ]) {
      await assert.rejects(
        introspectMysqlWith(catalog(source).exec, 'enum_catalog', { logger: {} }),
        (error: unknown) => error instanceof ValidationError && error.code === 'TURBINE_E003',
      );
    }
  });

  it('filters before decoding and leaves non-ENUM metadata and executor failures alone', async () => {
    for (const options of [{ include: ['other'] }, { exclude: ['labels'] }]) {
      const metadata = await introspectMysqlWith(catalog("enum('broken").exec, 'enum_catalog', {
        ...options,
        logger: {},
      });
      assert.deepEqual(Object.keys(metadata.tables), ['other']);
      assert.deepEqual(Object.keys(metadata.enums), ['other.value']);
    }
    const metadata = await introspectMysqlWith(catalog('varchar(10)', 'varchar').exec, 'enum_catalog', { logger: {} });
    assert.equal(metadata.enums['labels.value'], undefined);
    assert.equal(metadata.tables.labels!.columns[0]!.tsType, 'string | null');
    const failure = new Error('catalog read failed');
    await assert.rejects(
      introspectMysqlWith(async () => {
        throw failure;
      }, 'enum_catalog'),
      (error) => error === failure,
    );
  });
});
