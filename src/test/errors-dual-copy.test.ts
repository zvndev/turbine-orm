/**
 * `instanceof` across two copies of the errors module.
 *
 * The package ships an ESM build and a CJS build. A generated client compiled
 * as CommonJS `require`s `dist/cjs`, while an `.mts` entry file `import`s
 * `dist`, so the thrown error is built by one copy's class and tested against
 * the other's. With plain prototype-chain `instanceof`, every documented
 * `if (err instanceof UniqueConstraintError)` branch is silently skipped in
 * that configuration and the error propagates as unhandled.
 *
 * tsx gives a fresh module instance per distinct URL, so `?copy=2` stands in
 * for the second build without needing `dist/` to exist. The classes are
 * ENUMERATED from the module's exports rather than listed, so a new error
 * class is covered the day it is written; the constructor table below is the
 * one thing that has to grow with it, and the test names the missing entry.
 *
 * Run: npx tsx --test src/test/errors-dual-copy.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type ErrorsModule = typeof import('../errors.js');
type ErrorClass = (new (...args: never[]) => Error) & { CODE?: string };

const copy1 = (await import('../errors.js')) as ErrorsModule;
const copy2 = (await import(new URL('../errors.js?copy=2', import.meta.url).href)) as ErrorsModule;

/**
 * How to build one instance of each class. Keyed by export name; the
 * enumeration below fails on any exported error class with no entry here.
 */
const CONSTRUCT: Record<string, (m: ErrorsModule) => Error> = {
  TurbineError: (m) => new m.TurbineError(m.TurbineErrorCode.VALIDATION, 'base'),
  NotFoundError: (m) => new m.NotFoundError({ table: 'users', where: { id: 1 }, operation: 'findUniqueOrThrow' }),
  TimeoutError: (m) => new m.TimeoutError(100),
  ValidationError: (m) => new m.ValidationError('v'),
  ConnectionError: (m) => new m.ConnectionError('c'),
  RelationError: (m) => new m.RelationError('r'),
  MigrationError: (m) => new m.MigrationError('m'),
  CircularRelationError: (m) => new m.CircularRelationError(['a', 'b']),
  UniqueConstraintError: (m) => new m.UniqueConstraintError({ constraint: 'users_email_key' }),
  ForeignKeyError: (m) => new m.ForeignKeyError(),
  NotNullViolationError: (m) => new m.NotNullViolationError(),
  CheckConstraintError: (m) => new m.CheckConstraintError(),
  DeadlockError: (m) => new m.DeadlockError(),
  SerializationFailureError: (m) => new m.SerializationFailureError(),
  PipelineError: (m) => new m.PipelineError({ results: [{ status: 'error', error: new Error('e') }] }),
  OptimisticLockError: (m) => new m.OptimisticLockError({ table: 't', versionField: 'v', expectedVersion: 1 }),
  ExclusionConstraintError: (m) => new m.ExclusionConstraintError(),
  UnsupportedFeatureError: (m) => new m.UnsupportedFeatureError('vector', 'sqlite'),
  ReadOnlyError: (m) => new m.ReadOnlyError('refused.'),
};

/** Every exported class that is TurbineError or extends it, in export order. */
function errorClassesOf(mod: ErrorsModule): Array<[name: string, cls: ErrorClass]> {
  const out: Array<[string, ErrorClass]> = [];
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;
    const proto: unknown = (value as { prototype?: unknown }).prototype;
    const isErrorClass =
      value === mod.TurbineError ||
      (typeof proto === 'object' &&
        proto !== null &&
        Object.prototype.isPrototypeOf.call(mod.TurbineError.prototype, proto));
    if (isErrorClass) out.push([name, value as unknown as ErrorClass]);
  }
  return out;
}

const classes2 = errorClassesOf(copy2);

describe('errors module, two copies loaded', () => {
  it('precondition: the two imports really are distinct module instances', () => {
    assert.notEqual(copy1, copy2, 'the query string did not produce a second module instance');
    assert.notEqual(copy1.NotFoundError, copy2.NotFoundError);
    assert.notEqual(copy1.TurbineError, copy2.TurbineError);
  });

  it('anti-vacuous: the enumeration found every class and every class has a constructor entry', () => {
    // 19 = TurbineError plus the 18 coded classes; a new class raises this.
    assert.ok(classes2.length >= 19, `expected at least 19 error classes, enumerated ${classes2.length}`);
    const names = classes2.map(([name]) => name);
    for (const name of names) {
      assert.ok(Object.hasOwn(CONSTRUCT, name), `add a CONSTRUCT entry for the exported error class ${name}`);
    }
    // And the other direction: no stale table entry naming a class that is gone.
    for (const name of Object.keys(CONSTRUCT)) {
      assert.ok(names.includes(name), `CONSTRUCT names ${name}, which is no longer an exported error class`);
    }
  });

  for (const [name, cls2] of classes2) {
    it(`${name} thrown by copy 2 is instanceof copy 1's ${name}, TurbineError and Error`, () => {
      const cls1 = (copy1 as unknown as Record<string, ErrorClass>)[name];
      assert.ok(cls1, `copy 1 has no export named ${name}`);
      const err = CONSTRUCT[name]!(copy2);
      assert.ok(err instanceof cls2, 'sanity: the instance is recognised by the class that built it');
      assert.ok(err instanceof cls1, `${name} from copy 2 is not instanceof copy 1's ${name}`);
      assert.ok(err instanceof copy1.TurbineError, `${name} from copy 2 is not instanceof copy 1's TurbineError`);
      assert.ok(err instanceof Error);
    });
  }

  it('a copy-2 NotFoundError is NOT instanceof copy-1 UniqueConstraintError (or any other coded class)', () => {
    const notFound = CONSTRUCT.NotFoundError!(copy2);
    assert.equal(notFound instanceof copy1.UniqueConstraintError, false);
    // Full matrix: an instance of one coded class is recognised by exactly that
    // class and the base, never by a sibling.
    for (const [name] of classes2) {
      if (name === 'TurbineError') continue;
      const err = CONSTRUCT[name]!(copy2);
      for (const [otherName, other1] of errorClassesOf(copy1)) {
        if (otherName === name || otherName === 'TurbineError') continue;
        assert.equal(err instanceof other1, false, `${name} must not be instanceof ${otherName}`);
      }
    }
  });

  it('a plain Error is not instanceof TurbineError in either copy', () => {
    const plain = new Error('plain');
    assert.equal(plain instanceof copy1.TurbineError, false);
    assert.equal(plain instanceof copy2.TurbineError, false);
    assert.equal(plain instanceof copy1.NotFoundError, false);
  });

  it('a look-alike object without the brand is refused even when its code matches', () => {
    const fake = Object.assign(new Error('x'), { code: copy1.TurbineErrorCode.NOT_FOUND });
    assert.equal(fake instanceof copy1.NotFoundError, false);
    assert.equal(fake instanceof copy1.TurbineError, false);
  });

  it('a branded object whose code does not match the class is refused', () => {
    const notFound = CONSTRUCT.NotFoundError!(copy2);
    // Same brand, same base recognition, wrong code for the specific class.
    assert.ok(notFound instanceof copy1.TurbineError);
    assert.equal(notFound instanceof copy1.ValidationError, false);
  });

  it('the brand is an own, non-enumerable symbol: it never serializes', () => {
    const err = CONSTRUCT.ValidationError!(copy1);
    const brand = Symbol.for('turbine-orm.error');
    const desc = Object.getOwnPropertyDescriptor(err, brand);
    assert.ok(desc, 'instance carries the Symbol.for("turbine-orm.error") brand');
    assert.equal(desc.enumerable, false);
    assert.ok(!JSON.stringify(err).includes('turbine-orm.error'));
    assert.ok(!Object.keys(err).some((k) => k.includes('turbine-orm.error')));
  });

  it('single copy: instanceof still follows the prototype chain, and a user subclass does not absorb its parent', () => {
    class MyValidationError extends copy1.ValidationError {}
    const mine = new MyValidationError('mine');
    assert.ok(mine instanceof MyValidationError);
    assert.ok(mine instanceof copy1.ValidationError);
    assert.ok(mine instanceof copy1.TurbineError);
    // A user subclass inherits the parent's code; the shared code must not make
    // every ValidationError an instance of the user's narrower class.
    assert.equal(new copy1.ValidationError('parent') instanceof MyValidationError, false);
  });

  it("every coded class's static CODE agrees with the code its instances carry", () => {
    for (const [name, cls] of classes2) {
      const err = CONSTRUCT[name]!(copy2) as Error & { code: string };
      if (name === 'TurbineError') {
        assert.equal(cls.CODE, undefined, 'the base class matches any branded error, so it declares no CODE');
        continue;
      }
      assert.equal(cls.CODE, err.code, `${name}.CODE must equal the code passed to super()`);
    }
  });
});
