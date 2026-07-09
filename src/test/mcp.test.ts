import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { startMcpServer } from '../cli/mcp.js';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

async function readJsonLines(output: PassThrough, count: number): Promise<unknown[]> {
  const lines: string[] = [];
  let buffer = '';

  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) lines.push(line);
        if (lines.length === count) {
          cleanup();
          resolve(lines.map((entry) => JSON.parse(entry)));
          return;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      output.off('data', onData);
      output.off('error', onError);
    };
    output.on('data', onData);
    output.on('error', onError);
  });
}

function createHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = startMcpServer(
    {
      url: 'postgres://example.invalid/turbine',
      schema: 'public',
      migrationsDir: './turbine/migrations',
    },
    { input, output },
  );
  return { input, output, handle };
}

describe('turbine mcp protocol', () => {
  it('responds to initialize with MCP server metadata', async () => {
    const { input, output, handle } = createHarness();
    const responses = readJsonLines(output, 1);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      })}\n`,
    );

    const parsed = (await responses) as Array<{
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
        capabilities: { tools: Record<string, never> };
      };
    }>;
    const response = parsed[0];
    assert.ok(response);

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.deepEqual(response.result.serverInfo, { name: 'turbine-orm', version: packageJson.version });
    assert.deepEqual(response.result.capabilities, { tools: {} });

    await handle.dispose();
  });

  it('lists the read-only tools without touching the database', async () => {
    const { input, output, handle } = createHarness();
    const responses = readJsonLines(output, 1);

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' })}\n`);

    const parsed = (await responses) as Array<{
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> };
    }>;
    const response = parsed[0];
    assert.ok(response);

    assert.deepEqual(
      response.result.tools.map((tool) => tool.name),
      ['schema_overview', 'table_detail', 'migrate_status', 'doctor_report', 'explain_query', 'sample_rows'],
    );
    assert.equal(response.result.tools[0]?.inputSchema.type, 'object');

    await handle.dispose();
  });

  it('returns a JSON-RPC parse error for malformed frames and keeps serving requests', async () => {
    const { input, output, handle } = createHarness();
    const responses = readJsonLines(output, 2);

    input.write('{"jsonrpc":"2.0", bad json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' })}\n`);

    const parsed = (await responses) as Array<{
      id: number | null;
      error?: { code: number; message: string };
      result?: { protocolVersion: string };
    }>;
    const parseError = parsed[0];
    const initialize = parsed[1];
    assert.ok(parseError);
    assert.ok(initialize);

    assert.equal(parseError.id, null);
    assert.equal(parseError.error?.code, -32700);
    assert.match(parseError.error?.message ?? '', /Parse error/);
    assert.equal(initialize.id, 2);
    assert.equal(initialize.result?.protocolVersion, '2025-06-18');

    await handle.dispose();
  });
});
