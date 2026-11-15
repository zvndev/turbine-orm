import { withNeonWs } from '../../neon-ws.js';

/** Executed in an edge VM, using that runtime's actual WebSocket and timers. */
export async function runNeonWsEdge(connectionString: string, wsProxy: string, fail: boolean) {
  let escaped: Parameters<Parameters<typeof withNeonWs>[3]>[0] | undefined;
  try {
    const rows = await withNeonWs(
      {
        connection: { connectionString, application_name: 'neon_ws_edge' },
        driver: { wsProxy, useSecureWebSocket: false, pipelineConnect: false },
      },
      { tables: {}, enums: {} },
      { sessionMode: 'persistent' },
      async (db) => {
        escaped = db;
        const rows = await db.$transaction(async (tx) => {
          await tx.raw`INSERT INTO neon_ws_edge_items VALUES (15, 'edge')`;
          return tx.raw`SELECT id, label FROM neon_ws_edge_items ORDER BY id`;
        });
        if (fail) throw new Error('edge callback marker');
        return rows;
      },
    );
    try {
      await escaped!.rawQuery('SELECT 1');
      throw new Error('escaped binding still active');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('disconnected')) throw error;
    }
    return { rows, closed: true };
  } catch (error) {
    if (!fail || !(error instanceof Error) || !error.message.includes('edge callback marker')) throw error;
    try {
      await escaped!.rawQuery('SELECT 1');
      throw new Error('failed invocation still active');
    } catch (closed) {
      if (!(closed instanceof Error) || !closed.message.includes('disconnected')) throw closed;
    }
    return { failure: 'edge callback marker', closed: true };
  }
}
