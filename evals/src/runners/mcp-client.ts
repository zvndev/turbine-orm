/**
 * A minimal MCP stdio client.
 *
 * Ollama has no MCP client of its own, so without this the local models could
 * only ever run arms A, B and D, and arm C, the one the positioning actually
 * rests on, would have no non-Anthropic data point at all. Rather than drop the
 * arm or fake it, this speaks the protocol directly: spawn `turbine mcp`,
 * exchange JSON-RPC over stdio, and hand the tool list to Ollama's native
 * function-calling API.
 *
 * It implements exactly the three methods the loop needs (initialize,
 * tools/list, tools/call). It is not a general MCP client and does not pretend
 * to be one.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EVAL_DATABASE_URL, REPO_ROOT } from '../config.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Number of times the server died and was restarted, reported per attempt. */
  restarts = 0;
  private exited = false;

  async start(): Promise<void> {
    const child = spawn(
      process.execPath,
      [`${REPO_ROOT}/dist/cli/index.js`, 'mcp', '--url', EVAL_DATABASE_URL],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.on('data', (chunk) => {
      this.buffer += String(chunk);
      // The server writes one JSON object per line.
      let idx = this.buffer.indexOf('\n');
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.startsWith('{')) this.dispatch(line);
        idx = this.buffer.indexOf('\n');
      }
    });
    // Drain stderr so a chatty server cannot fill the pipe and deadlock.
    child.stderr.on('data', () => {});
    this.exited = false;
    child.on('close', () => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error('mcp server exited'));
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'turbine-evals', version: '1' },
    });
  }

  private dispatch(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'mcp error'));
    else p.resolve(msg.result);
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('mcp client not started'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  /**
   * Call a tool, restarting the server once if it has died.
   *
   * The first full matrix lost 35 attempts to "mcp server exited" while three
   * models ran in parallel and Ollama held several gigabytes: the server was
   * being killed under memory pressure, and every one of those attempts landed
   * in the unscored bucket. Unscored is the honest place for them, but an arm
   * that reports 1 scored attempt out of 30 has measured nothing. Recovering
   * costs one respawn and turns a lost cell into a real one.
   */
  async callToolResilient(name: string, args: unknown): Promise<string> {
    if (this.exited) {
      this.restarts++;
      await this.start();
    }
    const first = await this.callTool(name, args);
    if (!first.startsWith('tool error: mcp server exited')) return first;
    this.restarts++;
    await this.start();
    return await this.callTool(name, args);
  }

  /** Returns the tool's text content, or a readable error string. Never throws:
   *  a failed tool call is information for the model, not a harness failure. */
  async callTool(name: string, args: unknown): Promise<string> {
    try {
      const result = (await this.request('tools/call', { name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      return text || '(tool returned no text)';
    } catch (err) {
      return `tool error: ${(err as Error).message}`;
    }
  }

  async stop(): Promise<void> {
    this.child?.kill('SIGKILL');
    this.child = null;
  }
}
