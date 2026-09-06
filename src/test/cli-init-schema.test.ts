/**
 * `turbine init --schema <name>` writes the RESOLVED schema into the config it
 * scaffolds.
 *
 * It probed the named schema and then wrote `schema: 'public'` regardless, so
 * the next documented step, `push`, diffed the starter schema against the
 * wrong namespace and proposed dropping every column it found there.
 *
 * Run: npx tsx --test src/test/cli-init-schema.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configTemplate } from '../cli/config.js';

describe('configTemplate: the schema line', () => {
  it('writes the resolved schema', () => {
    assert.match(configTemplate(undefined, 'app'), /^ {2}schema: 'app',$/m);
    assert.match(configTemplate('postgres://u@h/db', 'qa78_ns'), /^ {2}schema: 'qa78_ns',$/m);
  });

  it('the default is byte-identical to the template as it was: `public`, and no other line moves', () => {
    const before = configTemplate();
    assert.match(before, /^ {2}schema: 'public',$/m);
    assert.equal(configTemplate(undefined, 'public'), before);
    // Every line except the schema line is unchanged by a different schema.
    const app = configTemplate(undefined, 'app').split('\n');
    const pub = before.split('\n');
    assert.equal(app.length, pub.length);
    const changed = app.map((line, i) => (line === pub[i] ? null : i)).filter((i): i is number => i !== null);
    assert.deepEqual(
      changed.map((i) => app[i]),
      ["  schema: 'app',"],
    );
  });

  it('never writes the string "public" for a schema that is not public', () => {
    assert.ok(!configTemplate(undefined, 'tenant_a').includes("schema: 'public'"));
  });

  it('a quote or backslash in the name cannot end the emitted TS string early', () => {
    assert.match(configTemplate(undefined, "it's"), /^ {2}schema: 'it\\'s',$/m);
    assert.match(configTemplate(undefined, 'a\\b'), /^ {2}schema: 'a\\\\b',$/m);
  });
});
