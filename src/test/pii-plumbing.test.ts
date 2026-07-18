/**
 * turbine-orm - PII field plumbing tests (schema side)
 *
 * Verifies the code-first `pii: true` declaration flows through:
 *   defineSchema (ColumnConfig.pii)
 *     -> schemaDefToMetadata (ColumnMetadata.pii)
 *       -> generateMetadata (emitted `pii: true`, byte-stable for untagged cols)
 *
 * No query-behavior assertions here - that is a later track. Introspection must
 * NEVER auto-tag PII (code-first only), so there is no introspect assertion.
 *
 * Run: npx tsx --test src/test/pii-plumbing.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateMetadata } from '../generate.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const piiSchema = defineSchema({
  users: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', notNull: true, pii: true },
    name: { type: 'text', notNull: true },
  },
});

describe('defineSchema pii flag', () => {
  it('carries pii onto ColumnConfig', () => {
    const email = piiSchema.tables.users!.columns.email!;
    const name = piiSchema.tables.users!.columns.name!;
    assert.equal(email.pii, true);
    assert.equal(name.pii, false);
  });
});

describe('schemaDefToMetadata pii passthrough', () => {
  const meta = schemaDefToMetadata(piiSchema);
  const cols = meta.tables.users!.columns;
  const email = cols.find((c) => c.field === 'email')!;
  const name = cols.find((c) => c.field === 'name')!;

  it('sets pii: true on the tagged column', () => {
    assert.equal(email.pii, true);
  });

  it('leaves untagged columns without a pii flag (byte-stable)', () => {
    assert.equal(name.pii, undefined);
    assert.ok(!('pii' in name), 'untagged column should not carry a pii key');
  });
});

describe('generateMetadata preserves pii', () => {
  it('emits pii: true only for the tagged column', () => {
    const meta = schemaDefToMetadata(piiSchema);
    const out = generateMetadata(meta, { noTimestamp: true });
    // Exactly one column carries the marker.
    assert.equal(out.match(/pii: true/g)?.length, 1);
    // No `pii: undefined`/`pii: false` noise for untagged columns.
    assert.ok(!/pii: false/.test(out));
    assert.ok(!/pii: undefined/.test(out));
  });

  it('emits no pii markers when nothing is tagged', () => {
    const plain = defineSchema({
      widgets: { id: { type: 'serial', primaryKey: true }, label: { type: 'text' } },
    });
    const out = generateMetadata(schemaDefToMetadata(plain), { noTimestamp: true });
    assert.ok(!/pii:/.test(out));
  });
});
