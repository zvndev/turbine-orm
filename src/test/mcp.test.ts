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
      result: {
        tools: Array<{
          name: string;
          inputSchema: {
            type: string;
            required?: string[];
            properties?: Record<string, unknown>;
            additionalProperties?: boolean;
          };
        }>;
      };
    }>;
    const response = parsed[0];
    assert.ok(response);

    assert.deepEqual(
      response.result.tools.map((tool) => tool.name),
      ['schema_overview', 'table_detail', 'migrate_status', 'doctor_report', 'explain_query', 'sample_rows'],
    );
    assert.equal(response.result.tools[0]?.inputSchema.type, 'object');

    const explain = response.result.tools.find((tool) => tool.name === 'explain_query');
    assert.ok(explain);
    assert.deepEqual(explain.inputSchema.required, ['table']);
    assert.ok(explain.inputSchema.properties?.table);
    assert.ok(explain.inputSchema.properties?.where);
    assert.ok(explain.inputSchema.properties?.orderBy);
    assert.ok(explain.inputSchema.properties?.limit);
    assert.ok(explain.inputSchema.properties?.select);
    assert.equal(explain.inputSchema.properties?.sql, undefined);
    assert.equal(explain.inputSchema.additionalProperties, false);

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

  it('explain_query rejects free-form SQL without contacting the database', async () => {
    const { input, output, handle } = createHarness();
    const responses = readJsonLines(output, 2);

    // Legacy shape: arbitrary SELECT text must not be accepted.
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'explain_query',
          arguments: { sql: 'SELECT 1; DROP TABLE users' },
        },
      })}\n`,
    );

    // Missing table also fails argument validation before any pool connect.
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'explain_query',
          arguments: { where: { id: 1 } },
        },
      })}\n`,
    );

    const parsed = (await responses) as Array<{
      id: number;
      error?: { code: number; message: string };
    }>;
    const freeForm = parsed[0];
    const missingTable = parsed[1];
    assert.ok(freeForm);
    assert.ok(missingTable);

    assert.equal(freeForm.id, 10);
    assert.equal(freeForm.error?.code, -32602);
    assert.match(freeForm.error?.message ?? '', /no longer accepts free-form SQL/i);

    assert.equal(missingTable.id, 11);
    assert.equal(missingTable.error?.code, -32602);
    assert.match(missingTable.error?.message ?? '', /table is required/i);

    await handle.dispose();
  });

  it('explain_query rejects invalid builder arg shapes without contacting the database', async () => {
    const { input, output, handle } = createHarness();
    const responses = readJsonLines(output, 3);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'explain_query',
          arguments: { table: 'users', limit: 0 },
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'explain_query',
          arguments: { table: 'users', where: 'id = 1' },
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'explain_query',
          arguments: { table: 'users', select: { id: 'yes' } },
        },
      })}\n`,
    );

    const parsed = (await responses) as Array<{
      id: number;
      error?: { code: number; message: string };
    }>;

    assert.equal(parsed[0]?.id, 20);
    assert.equal(parsed[0]?.error?.code, -32602);
    assert.match(parsed[0]?.error?.message ?? '', /limit must be a positive integer/i);

    assert.equal(parsed[1]?.id, 21);
    assert.equal(parsed[1]?.error?.code, -32602);
    assert.match(parsed[1]?.error?.message ?? '', /where must be an object/i);

    assert.equal(parsed[2]?.id, 22);
    assert.equal(parsed[2]?.error?.code, -32602);
    assert.match(parsed[2]?.error?.message ?? '', /select\.id must be a boolean/i);

    await handle.dispose();
  });
});
