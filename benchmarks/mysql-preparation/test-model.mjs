// Structural validator input ONLY. Never used as a native execution result.
import {
  ARMS,
  ARTIFACT_SHA,
  CAPACITY,
  CASES,
  comparisons,
  DRIVER_VERSION,
  FLAGS,
  SHAPES,
  shuffled,
} from './oracle.mjs';
export function reportModel() {
  const digest = 'a'.repeat(64),
    files = Object.fromEntries(
      [
        'src/mysql.ts',
        'src/client.ts',
        'src/query/builder.ts',
        ...[
          'oracle',
          'routes',
          'controls',
          'run',
          'native',
          'provenance',
          'validate',
          'harness.test',
          'audit',
          'faults',
          'test-model',
        ].map((n) => `benchmarks/mysql-preparation/${n}.mjs`),
      ].map((n) => [n, digest]),
    );
  const report = {
    format: 'mysql-preparation-v1',
    status: 'passed',
    cleanupErrors: [],
    databaseRemoved: true,
    applicationSessionsClosed: true,
    provenance: {
      runtime: {
        node: 'v22.16.0',
        pid: 1,
        versions: { node: '22.16.0' },
        executable: '/unit-model/node',
        binarySha256: digest,
      },
      source: {
        head: 'a'.repeat(40),
        branch: 'unit-model',
        status: '',
        worktree: '/unit-model',
        files,
        oracleSha256: digest,
        executableSha256: digest,
      },
      dependencies: {
        lockSha256: digest,
        driver: {
          version: DRIVER_VERSION,
          integrity: 'sha512-model',
          files: Object.fromEntries(
            [
              'package.json',
              'lib/base/connection.js',
              'lib/commands/prepare.js',
              'lib/commands/execute.js',
              'lib/parsers/parser_cache.js',
            ].map((n) => [n, digest]),
          ),
        },
      },
      artifact: { sha256: ARTIFACT_SHA, exercised: false },
    },
    server: {
      version: '8.4.0',
      binarySha256: digest,
      binaryVersion: 'model Ver 8.4.0',
      pid: 1,
      root: '/unit-model',
      sqlMode: 'STRICT_TRANS_TABLES',
      mode: 'default',
      performanceSchema: 1,
    },
    config: { rounds: 4, iterations: 16, capacity: CAPACITY, flags: FLAGS, mode: 'default', seed: 1297696 },
    driverImportMs: 1,
    sourceImportMs: 1,
    fixtureInitMs: 1,
    network: Array.from({ length: 16 }, () => ({ ms: 1 })),
    sql: { read: 'SELECT * FROM items WHERE id=:p1', rollback: ['BEGIN', 'UPDATE', 'SELECT', 'ROLLBACK'] },
    samples: [],
    controls: [],
    limits: Array(7).fill('unit model'),
  };
  const occupancy = (shape, size = 0) => ({
    js: 0,
    connections: shape === 'pool' ? 2 : 1,
    driver: Array.from({ length: shape === 'pool' ? 2 : 1 }, (_, i) => ({ id: i + 1, size: i ? 0 : size })),
  });
  for (let round = 0; round < 4; round++)
    for (const shape of SHAPES)
      for (const name of CASES)
        for (const arm of ARMS)
          for (const phase of ['cold', 'warm']) {
            const n = phase === 'cold' ? 1 : 16,
              binary = !arm.startsWith('text'),
              size = binary ? (name === 'read' ? 1 : 2) : 0;
            report.samples.push({
              round,
              shape,
              name,
              arm,
              phase,
              order: shuffled(ARMS, 1297696 + round * 43 + SHAPES.indexOf(shape) * 7 + CASES.indexOf(name)),
              ms: 1 + ARMS.indexOf(arm) / 10 + round / 100,
              cpuMicros: 1,
              initMs: 1,
              wallIncludingChecksMs: 20,
              operations: n,
              checkedResults: n,
              independentlyCheckedEffects: name === 'rollback' ? n : 0,
              protocol: {
                Com_stmt_prepare: phase === 'cold' ? size : 0,
                Com_stmt_execute: binary ? n * (name === 'read' ? 1 : 2) : 0,
                Com_stmt_close: 0,
                Com_stmt_reprepare: 0,
              },
              occupancy: occupancy(shape, size),
              serverPrepared: size,
              recentWire: [{ method: 'query', sql: 'unit model' }],
              checkout: shape === 'pool' ? Array.from({ length: n }, () => ({ ms: 1, id: 1, failed: false })) : [],
              memoryBefore: { rss: 1, heapUsed: 1 },
              memoryAfter: { rss: 1, heapUsed: 1 },
            });
          }
  const names = [
    'precision-json-null-booleans-dates-unicode-buffer-parameter-changes',
    'rollback-independent-observer',
    'failed-prepare-and-failed-execute-reuse',
    'schema-change-drop-recreate-and-reuse',
    'binding-effects-independent-observer',
    'bounded-churn-driver-js-server',
    'closed-route-and-native-handle',
  ];
  for (const shape of SHAPES)
    for (const arm of ARMS)
      for (const control of names) {
        const entry = { shape, arm, control, passed: true };
        if (control === 'bounded-churn-driver-js-server')
          Object.assign(entry, {
            occupancy: occupancy(shape),
            delta: {
              Com_stmt_prepare: arm.startsWith('text') ? 0 : 64,
              Com_stmt_reprepare: 0,
              Com_stmt_execute: arm.startsWith('text') ? 0 : 64,
            },
            memory: Array.from({ length: 64 }, (_, i) => ({
              i,
              rss: 1,
              heapUsed: 1,
              occupancy: occupancy(shape),
              server: 0,
              serverBeforeDrain: 0,
            })),
          });
        report.controls.push(entry);
      }
  report.controls.push(
    ...[
      'closed-statement-rejects-and-fresh-reuse',
      'pool-checkout-released-handle-and-borrowed-ownership',
      'owned-factory-close',
      'physical-session-prepared-ownership',
    ].map((control) => ({ control, passed: true })),
  );
  report.comparisons = comparisons(report.samples);
  return report;
}
