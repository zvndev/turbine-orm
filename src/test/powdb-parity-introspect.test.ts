/**
 * PowDB introspection keeps catalog names as data, as the SQL introspectors do.
 *
 *   - Every catalog-keyed record (tables, column maps, type maps, relations,
 *     enums) is prototype-less, so a table or column named `__proto__`,
 *     `constructor` or `toString` is an ordinary entry, and a name that is not
 *     in the catalog reads as absent.
 *   - Two columns resolving to one field are refused (E003) before relations
 *     are derived, with the names escaped in the message.
 *   - Catalog names printed in a warning are escaped.
 *
 * No engine needed: `introspectPowdbDatabase` takes the executor as a function.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { capabilitiesFromVersion, introspectPowdbDatabase, type PowdbExec } from '../powdb.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';

type Row = Record<string, unknown>;

/** A fake catalog: `schema`, `describe <T>` (quoted or bare) and `schema links`. */
function catalog(tables: Record<string, Row[]>, links: Row[] = []): PowdbExec {
  const byName = new Map(Object.entries(tables));
  return async (powql) => {
    if (powql === 'schema') return { rows: [...byName.keys()].map((name) => ({ name, columns: 1 })) };
    if (powql === 'schema links') return { rows: links };
    const m = /^describe (`?)(.*)\1$/.exec(powql);
    const rows = m ? byName.get(m[2]!) : undefined;
    if (!rows) throw new Error(`unexpected statement ${powql}`);
    return { rows };
  };
}

/** A table by name; a helper so `constructor` / `toString` are not typed as Object members. */
function table(meta: SchemaMetadata, name: string): TableMetadata {
  const t = meta.tables[name];
  assert.ok(t, `table ${name} is missing`);
  return t;
}

const pk = { column: 'id', type: 'int', nullable: 'false', index: 'unique' };
const col = (column: string, type = 'str') => ({ column, type, nullable: 'true', index: '' });

describe('powdb introspection: catalog names are data', () => {
  it('tables and columns named after Object.prototype members are kept', async () => {
    const meta = await introspectPowdbDatabase(
      catalog({
        ['__proto__']: [pk, col('constructor')],
        constructor: [pk, col('__proto__'), col('to_string')],
        toString: [pk],
      }),
    );
    assert.deepEqual(Object.keys(meta.tables).sort(), ['__proto__', 'constructor', 'toString']);
    for (const name of ['__proto__', 'constructor', 'toString']) {
      assert.ok(Object.hasOwn(meta.tables, name), `${name} is an own entry`);
      assert.equal(meta.tables[name]!.name, name);
    }
    const ctor = table(meta, 'constructor');
    // `__proto__` is a column NAME here; its field is the camel-cased `_Proto__`.
    const proto = '__proto__';
    assert.equal(ctor.reverseColumnMap[proto], '_Proto__');
    assert.equal(ctor.columnMap._Proto__, '__proto__');
    assert.equal(ctor.columnMap.toString, 'to_string');
    assert.equal(ctor.pgTypes[proto], 'str');
    assert.equal(table(meta, '__proto__').columnMap.constructor, 'constructor');
  });

  it('every catalog-keyed record is prototype-less, so an absent name reads as absent', async () => {
    const meta = await introspectPowdbDatabase(catalog({ users: [pk, col('name')] }));
    const users = meta.tables.users!;
    for (const [label, record] of [
      ['tables', meta.tables],
      ['enums', meta.enums],
      ['columnMap', users.columnMap],
      ['reverseColumnMap', users.reverseColumnMap],
      ['dialectTypes', users.dialectTypes],
      ['pgTypes', users.pgTypes],
      ['relations', users.relations],
    ] as const) {
      assert.equal(Object.getPrototypeOf(record), null, `${label} is prototype-less`);
      assert.equal((record as Record<string, unknown>).constructor, undefined, `${label}.constructor`);
      assert.equal((record as Record<string, unknown>).toString, undefined, `${label}.toString`);
    }
  });

  it('links between tables named constructor and toString derive both relations', async () => {
    const meta = await introspectPowdbDatabase(
      catalog({ constructor: [pk, col('to_string_id', 'int')], toString: [pk] }, [
        {
          owner: 'constructor',
          name: 'parent',
          target: 'toString',
          local_key: 'to_string_id',
          target_key: 'id',
          cardinality: 'to-one',
        },
      ]),
      { capabilities: capabilitiesFromVersion('0.20.0') },
    );
    assert.equal(table(meta, 'constructor').relations.parent?.type, 'belongsTo');
    assert.equal(table(meta, 'toString').relations.constructors?.type, 'hasMany');
  });

  it('two columns resolving to one field are refused, names escaped', async () => {
    await assert.rejects(
      introspectPowdbDatabase(catalog({ 'acc\u001bts': [pk, col('user_id'), col('userId')] })),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
        assert.match(err.message, /Field collision on table "acc\\u001bts"/);
        assert.match(err.message, /columns "user_id" and "userId" both resolve to the field "userId"/);
        assert.ok(!err.message.includes('\u001b'), 'the raw control character reached the message');
        return true;
      },
    );
  });

  it('a table name in the no-primary-key warning is escaped', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      await introspectPowdbDatabase(catalog({ 'lo\u001bgs': [col('line')] }));
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /table "lo\\u001bgs" has no non-nullable unique column/);
    assert.ok(!warnings[0]!.includes('\u001b'));
  });
});
