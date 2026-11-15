import { startNative } from './neon-ws-lifecycle-native.ts';

const pgRoot = process.env.TURBINE_NEON_WS_PG_ROOT;
if (!pgRoot) throw new Error('TURBINE_NEON_WS_PG_ROOT is required');
const native = await startNative(pgRoot);
console.log(JSON.stringify({ ready: native.root }));
await new Promise(() => {});
