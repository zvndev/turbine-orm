/**
 * Runner for Anthropic models, over the `claude` CLI in headless print mode.
 *
 * There is no API key on this machine; the CLI runs on the user's existing
 * auth. Three details are load-bearing rather than incidental:
 *
 *  1. **cwd is a scratch directory.** Run inside the repo and the CLI discovers
 *     the project CLAUDE.md, which documents this entire ORM in detail. Arm A is
 *     supposed to be cold; a model that has just been handed the ORM's internal
 *     architecture notes is not cold, and the whole A->C delta would collapse.
 *  2. **The system prompt is replaced, not appended.** `--system-prompt` drops
 *     the default agent harness prompt, so what the model sees is the arm's
 *     prompt and nothing else. Verified empirically: asked to report any
 *     instructions mentioning turbine, it answers "no".
 *  3. **Built-in tools are disallowed.** Otherwise a model in arm A could read
 *     the filesystem or shell out, and arm A would stop being arm A. Arm C gets
 *     exactly the MCP tools and nothing else.
 *
 * Timeouts are enforced with a Node timer plus a kill, because this macOS box
 * has no `timeout` binary.
 */
import { spawn } from 'node:child_process';
import { ATTEMPT_TIMEOUT_MS, EVAL_DATABASE_URL, MAX_BUDGET_USD, REPO_ROOT } from '../config.js';
import type { RunnerRequest, RunnerResult } from './types.js';

/** Everything the CLI ships that could reach the filesystem, network or repo. */
const BLOCKED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'TodoWrite', 'NotebookEdit', 'Agent', 'Artifact', 'ToolSearch',
  'ListAgents', 'ReportFindings', 'ScheduleWakeup', 'Workflow', 'SendMessage',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Monitor',
  'EnterWorktree', 'ExitWorktree', 'PushNotification', 'RemoteTrigger',
];

function mcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      turbine: {
        command: process.execPath,
        args: [`${REPO_ROOT}/dist/cli/index.js`, 'mcp', '--url', EVAL_DATABASE_URL],
      },
    },
  });
}

export async function runClaude(
  model: string,
  req: RunnerRequest,
  scratchDir: string,
): Promise<RunnerResult> {
  const args = [
    '-p', req.user,
    '--model', model,
    '--system-prompt', req.system,
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--max-budget-usd', String(MAX_BUDGET_USD),
    '--strict-mcp-config',
  ];

  if (req.withMcp) {
    args.push('--mcp-config', mcpConfig());
    // Permit the MCP tools without a prompt; everything else stays blocked.
    args.push('--allowedTools', 'mcp__turbine');
  }
  args.push('--disallowedTools', ...BLOCKED_TOOLS);

  const started = Date.now();
  return await new Promise<RunnerResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: scratchDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        unscored: `timeout after ${ATTEMPT_TIMEOUT_MS}ms`,
        toolCalls: [],
        turns: 0,
        ms: Date.now() - started,
      });
    }, ATTEMPT_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ unscored: `spawn failed: ${err.message}`, toolCalls: [], turns: 0, ms: Date.now() - started });
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseStream(stdout, stderr, Date.now() - started));
    });
  });
}

function parseStream(stdout: string, stderr: string, ms: number): RunnerResult {
  const toolCalls: string[] = [];
  let turns = 0;
  let text: string | undefined;
  let costUsd: number | undefined;
  let servedModel: string | undefined;
  let apiError: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (msg.type === 'assistant') {
      turns++;
      const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          toolCalls.push(block.name.replace(/^mcp__turbine__/, ''));
        }
      }
    }

    if (msg.type === 'result') {
      if (typeof msg.result === 'string') text = msg.result;
      if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd;
      const usage = msg.modelUsage as Record<string, unknown> | undefined;
      if (usage) servedModel = Object.keys(usage).join('+');
      if (msg.is_error === true) apiError = String(msg.subtype ?? msg.result ?? 'error');
    }
  }

  if (text === undefined || text.length === 0) {
    const why = apiError ?? (stderr.trim().split('\n').slice(-3).join(' ') || 'no result message in stream');
    return { unscored: `no completion: ${why}`.slice(0, 300), toolCalls, turns, ms, costUsd, servedModel };
  }
  // An API-level error that still produced text is a harness problem, not a
  // wrong answer, so it is unscored rather than scored against the model.
  if (apiError) {
    return { unscored: `api error: ${apiError}`.slice(0, 300), toolCalls, turns, ms, costUsd, servedModel };
  }
  return { text, toolCalls, turns, ms, costUsd, servedModel };
}
