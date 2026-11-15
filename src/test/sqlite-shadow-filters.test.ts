import assert from 'node:assert/strict';
import { it } from 'node:test';
import { applyTableFilters, DEFAULT_EXCLUDED_TABLES } from '../catalog-metadata.js';

it('preserves shared callers option observations, input order and duplicates without an extension', () => {
  const trace: string[] = [];
  const include = ['ordinary_data', '_prisma_migrations'];
  const exclude = ['absent'];
  for (const [name, values] of [
    ['include', include],
    ['exclude', exclude],
  ] as const) {
    const iterator = values[Symbol.iterator].bind(values);
    values[Symbol.iterator] = () => {
      trace.push(`${name}:iterate`);
      return iterator();
    };
  }
  const names = ['ordinary_data', '_prisma_migrations', 'ordinary_data', '_turbine_metrics'];
  assert.deepEqual(
    applyTableFilters(names, {
      get include() {
        trace.push('include:get');
        return include;
      },
      get exclude() {
        trace.push('exclude:get');
        return exclude;
      },
    }),
    ['ordinary_data', '_prisma_migrations', 'ordinary_data'],
  );
  assert.deepEqual(trace, [
    'include:get',
    'include:get',
    'include:iterate',
    'exclude:get',
    'exclude:get',
    'exclude:iterate',
  ]);
  assert.deepEqual(names, ['ordinary_data', '_prisma_migrations', 'ordinary_data', '_turbine_metrics']);
  assert.deepEqual([...DEFAULT_EXCLUDED_TABLES], ['_turbine_migrations', '_prisma_migrations', '_turbine_metrics']);
});

it('preserves exact iterator throws and stops before later getters', () => {
  for (const sentinel of [undefined, null, false, 0, 'failure', {}]) {
    let excludeRead = false;
    const include = ['ordinary'];
    include[Symbol.iterator] = () => {
      throw sentinel;
    };
    let threw = false;
    try {
      applyTableFilters(['ordinary'], {
        include,
        get exclude() {
          excludeRead = true;
          return [];
        },
      });
    } catch (error) {
      threw = true;
      assert.equal(error, sentinel);
    }
    assert.equal(threw, true);
    assert.equal(excludeRead, false);
  }
});

it('keeps per-call native defaults isolated across reentry and explicit overrides', () => {
  let nested: string[] = [];
  const names = ['ordinary', 'native_internal'];
  const result = applyTableFilters(
    names,
    {
      get include() {
        nested = applyTableFilters(names);
        return ['ordinary', 'native_internal'];
      },
      exclude: ['ordinary'],
    },
    (defaults) => {
      defaults.add('native_internal');
    },
  );
  assert.deepEqual(result, ['native_internal']);
  assert.deepEqual(nested, names);
  assert.deepEqual(applyTableFilters(names), names);
  let calls = 0;
  assert.deepEqual(
    applyTableFilters([], {}, () => {
      calls++;
    }),
    [],
  );
  assert.equal(calls, 1);
});
