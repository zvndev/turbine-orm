/**
 * turbine-orm, type-level tests for `select` / `omit` on single-row writes
 *
 * The runtime narrows the returned row (write-projection.test.ts); these pin
 * that the TYPE narrows with it, and that a misspelled key is a compile error
 * exactly as it is on a read (`FieldFlags`).
 *
 * What guards this file is `npm run typecheck`, which includes src/test: tsx
 * strips types without checking them, and an unused `@ts-expect-error` is
 * itself an error.
 */

import { describe, it } from 'node:test';
import type { QueryInterface } from '../query/index.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertTrue<T extends true>(): T {
  return true as T;
}

interface Event {
  id: number;
  kind: string;
  payload: unknown;
}

declare const events: QueryInterface<Event>;

// Never called: the assertions are the compile-time checks.
async function checks(): Promise<void> {
  const selected = await events.create({ data: { kind: 'x' }, select: { id: true } });
  assertTrue<Equals<typeof selected, Pick<Event, 'id'>>>();

  const omitted = await events.update({ where: { id: 1 }, data: { kind: 'y' }, omit: { payload: true } });
  assertTrue<Equals<typeof omitted, Omit<Event, 'payload'>>>();

  const deleted = await events.delete({ where: { id: 1 }, select: { kind: true } });
  assertTrue<Equals<typeof deleted, Pick<Event, 'kind'>>>();

  const upserted = await events.upsert({
    where: { id: 1 },
    create: { id: 1, kind: 'a' },
    update: { kind: 'b' },
    select: { id: true, kind: true },
  });
  assertTrue<Equals<typeof upserted, Pick<Event, 'id' | 'kind'>>>();

  const whole = await events.create({ data: { kind: 'x' } });
  assertTrue<Equals<typeof whole, Event>>();

  // @ts-expect-error `kynd` is not a field of Event
  await events.create({ data: { kind: 'x' }, select: { kynd: true } });
}

describe('write projection types', () => {
  it('compiles (the assertions above are the test)', () => {
    void checks;
  });
});
