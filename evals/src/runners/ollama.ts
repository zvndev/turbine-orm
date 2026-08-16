/**
 * Runner for local Ollama models, including a hand-rolled tool-calling loop so
 * arm C is real for non-Anthropic models rather than skipped.
 *
 * The loop is the standard shape: send the messages with the MCP tool list
 * attached, and while the model replies with tool_calls, execute them against
 * the live `turbine mcp` server and feed the results back as `tool` messages.
 * It stops at MAX_TOOL_TURNS, which is a guard against a small model looping on
 * the same call forever, and a stop there is recorded rather than hidden: the
 * final assistant text is still scored if there is one.
 *
 * Not every installed model supports tool calling. That is detected per model
 * and reported, never silently downgraded to a no-tools run, because a silent
 * downgrade would show up in the results as "tools did not help this model".
 */
import { ATTEMPT_TIMEOUT_MS } from '../config.js';
import { McpStdioClient, type McpTool } from './mcp-client.js';
import type { RunnerRequest, RunnerResult } from './types.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MAX_TOOL_TURNS = 12;

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
}

function toOllamaTools(tools: McpTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description.slice(0, 900),
      parameters: t.inputSchema,
    },
  }));
}

async function chat(
  model: string,
  messages: OllamaMessage[],
  tools: unknown[] | undefined,
  signal: AbortSignal,
): Promise<{ message: OllamaMessage }> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(tools && tools.length ? { tools } : {}),
      options: {
        // Greedy decoding: a pass rate that changes between identical runs
        // because of sampling is not a pass rate.
        temperature: 0,
        seed: 7,
        num_ctx: 16384,
      },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { message: OllamaMessage };
}

export async function runOllama(model: string, req: RunnerRequest): Promise<RunnerResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

  const messages: OllamaMessage[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];
  const toolCalls: string[] = [];
  let turns = 0;
  let mcp: McpStdioClient | null = null;

  try {
    let tools: unknown[] | undefined;
    if (req.withMcp) {
      mcp = new McpStdioClient();
      await mcp.start();
      tools = toOllamaTools(await mcp.listTools());
      if (tools.length === 0) throw new Error('mcp server returned no tools');
    }

    let lastText = '';
    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      const { message } = await chat(model, messages, tools, controller.signal);
      turns++;
      lastText = message.content ?? '';

      const calls = message.tool_calls ?? [];
      if (!mcp || calls.length === 0) {
        clearTimeout(timer);
        return {
          text: lastText,
          toolCalls,
          turns,
          ms: Date.now() - started,
          servedModel: model,
        };
      }

      messages.push({ role: 'assistant', content: lastText, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name ?? 'unknown';
        toolCalls.push(name);
        const args = typeof call.function?.arguments === 'string'
          ? safeParse(call.function.arguments)
          : (call.function?.arguments ?? {});
        const out = await mcp.callToolResilient(name, args);
        messages.push({ role: 'tool', tool_name: name, content: out.slice(0, 6000) });
      }
    }

    clearTimeout(timer);
    // Ran out of tool turns. If the model left usable text, score it. If it
    // never stopped calling tools, that is the model failing to converge, so
    // it is returned as an EMPTY completion and scored as a failure. It is not
    // unscored: the unscored bucket exists for harness faults, and a model
    // that loops on compile_query until its budget runs out has answered the
    // question badly rather than not been asked it.
    if (lastText.trim().length > 0) {
      return { text: lastText, toolCalls, turns, ms: Date.now() - started, servedModel: model };
    }
    return { text: '', noAnswer: true, toolCalls, turns, ms: Date.now() - started, servedModel: model };
  } catch (err) {
    clearTimeout(timer);
    const message = (err as Error).message ?? String(err);
    const reason = controller.signal.aborted ? `timeout after ${ATTEMPT_TIMEOUT_MS}ms` : message;
    return { unscored: reason.slice(0, 300), toolCalls, turns, ms: Date.now() - started, servedModel: model };
  } finally {
    clearTimeout(timer);
    await mcp?.stop();
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Does this model accept a tools array at all? Asked once per model so arm C
 *  can be reported as genuinely unsupported rather than quietly toolless. */
export async function supportsTools(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        tools: [
          {
            type: 'function',
            function: {
              name: 'noop',
              description: 'does nothing',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        options: { num_predict: 1 },
      }),
    });
    if (res.ok) return true;
    const body = (await res.text()).toLowerCase();
    return !body.includes('does not support tools');
  } catch {
    return false;
  }
}
