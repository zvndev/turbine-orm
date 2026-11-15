// Only the seed helper owns these wrappers and always awaits their shutdown.
// No caller rejection values are retained outside the pool's existing state.
const seeds = new WeakSet<object>();

export async function withSeedCleanup(pool: object, work: () => Promise<void>): Promise<void> {
  seeds.add(pool);
  try {
    await work();
  } finally {
    seeds.delete(pool);
  }
}

export function deferSeedCleanup(pool: object): boolean {
  return seeds.has(pool);
}
