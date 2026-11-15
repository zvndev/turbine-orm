// New entries only. Archive 409c5714...c046, before shared core extraction
// and independent WS corrections. These limits do not verify those fixes.
// esbuild 0.28.2, platform=node/CJS, minified, Brotli q11, less size-limit's
// 16-byte empty-project overhead: WS 118584; HTTP 100692; live 963; hub 8726 B.
// Existing convention: +5% or 1000 B minimum, round up to next 1000 B.
// These are library graph limits with drivers external; never install-size claims.
// Recompute measurements after core integration; do not raise existing 11 limits.
export const limits = { 'neon-ws': 125000, 'neon-http': 106000, 'live-query': 2000, 'notification-hub': 10000 };
export const optionalPgSizes = Object.entries(limits).map(([entry, bytes]) => ({
  name: `optional entry: turbine-orm/${entry} (drivers external)`,
  path: `dist/${entry}.js`,
  limit: `${bytes / 1000} kB`,
  ignore: ['pg', '#pg', '@neondatabase/serverless', 'ws'],
  modifyEsbuildConfig(config) { config.platform = 'node'; return config; },
}));
