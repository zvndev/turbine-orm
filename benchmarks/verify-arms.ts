/** Exact preflight for the selected original comparison engine. No timings. */
export async function verifySelectedEngine(): Promise<void> {
  const engine = process.env.BENCH_ENGINE ?? 'postgres';
  if (engine === 'mysql') {
    const { runMysqlComparison } = await import('./bench-mysql.js');
    await runMysqlComparison({ verifyOnly: true });
  } else if (engine === 'sqlite') {
    const { runSqlite } = await import('./bench-sqlite.js');
    await runSqlite(['--verify-only', '--full']);
  } else if (engine === 'postgres') {
    const { runHeadline } = await import('./bench-interleaved.js');
    await runHeadline({ verifyOnly: true, includeNoJit: true });
  } else throw new Error(`Unknown comparison engine: ${engine}`);
}
verifySelectedEngine().then(
  () => console.log('Selected comparison arms passed exact independent result/order/write-effect checks.'),
  (error) => { console.error('Arm verification failed:', error); process.exitCode = 1; },
);
