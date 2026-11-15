import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripCheckWrapper } from '../introspect.js';

describe('stripCheckWrapper catalog expressions', () => {
  it('recovers a PostgreSQL check expression with nested function arguments', () => {
    assert.equal(stripCheckWrapper('CHECK ((price >= (round(cost, 2) + tax)))'), 'price >= (round(cost, 2) + tax)');
  });

  it('accepts keyword case, surrounding whitespace and multiline catalog output', () => {
    assert.equal(stripCheckWrapper(' \n check (\n (quantity > 0)\n) \t'), 'quantity > 0');
  });

  it('preserves parentheses belonging to separate operands', () => {
    assert.equal(stripCheckWrapper('CHECK ((low > 0) AND (high < 100))'), '(low > 0) AND (high < 100)');
    assert.equal(stripCheckWrapper('(low > 0) OR (high < 100)'), '(low > 0) OR (high < 100)');
  });

  it('unwraps only the catalog pair and one balanced expression pair', () => {
    assert.equal(stripCheckWrapper('CHECK (((price > 0)))'), '(price > 0)');
    assert.equal(stripCheckWrapper('(price > 0)'), 'price > 0');
    assert.equal(stripCheckWrapper('CHECK (price > 0)'), 'price > 0');
    assert.equal(stripCheckWrapper('CHECK(price > 0)'), 'price > 0');
  });

  it('keeps unexpected input without a matching CHECK wrapper', () => {
    assert.equal(stripCheckWrapper('  price > 0  '), 'price > 0');
    assert.equal(stripCheckWrapper('CHECK (price > 0'), 'CHECK (price > 0');
    assert.equal(stripCheckWrapper('CHECK (price > 0) NOT VALID'), 'CHECK (price > 0) NOT VALID');
    assert.equal(stripCheckWrapper('  '), '');
  });
});
