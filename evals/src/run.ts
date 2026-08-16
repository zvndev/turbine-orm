/**
 * The harness.
 *
 * One attempt = one (task x arm x model). Each Anthropic attempt is a fresh
 * `claude` process with no session persistence, and each Ollama attempt is a
 * fresh message list, so no attempt can contaminate the next.
 *
 * Results stream to a JSONL file as they complete, so a run that dies halfway
 * still leaves everything it measured.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compare } from './canonical.js';
import { ATTEMPT_TIMEOUT_MS, EVALS_DIR, EVAL_DATABASE_URL, SEED, assertEvalDatabase } from './config.js';
import { closeClient, executeAnswer, type FailureClass } from './execute.js';
import { MODELS, SMOKE_MODEL_IDS, selectModels, type ModelSpec } from './models.js';
import { parseAnswer } from './protocol.js';
import { type Arm, systemFor, userFor } from './prompts.js';
import { runClaude } from './runners/claude-cli.js';
import { runOllama, supportsTools } from './runners/ollama.js';
import { evalSchema } from './schema-meta.js';
import { SMOKE_TASK_IDS, selectTasks, TASKS, type Task } from './tasks.js';

const ALL_ARMS: Arm[] = ['A', 'B', 'C', 'D'];

export interface AttemptRecord {
  task: string;
  shape: string;
  trap: boolean;
  arm: Arm;
  model: string;
  servedModel?: string;
  repeat: number;
  status: 'pass' | 'fail' | 'unscored';
  failure?: FailureClass;
  detail?: string;
  errorCode?: string;
  toolCalls: string[];
  turns: number;
  ms: number;
  costUsd?: number;
}

function parseArgs(): {
  arms: Arm[];
  taskIds: string[];
  modelIds: string[];
  repeats: number;
  out: string;
} {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const smoke = argv.includes('--smoke');
  const full = argv.includes('--full');

  const arms = (flag('arms')?.split(',') as Arm[] | undefined) ?? ALL_ARMS;
  const taskIds = flag('tasks')?.split(',') ?? (full ? TASKS.map((t) => t.id) : SMOKE_TASK_IDS);
  const modelIds = flag('models')?.split(',') ?? (full ? MODELS.map((m) => m.id) : SMOKE_MODEL_IDS);
  const repeats = Number(flag('repeats') ?? 1);
  const out = flag('out') ?? resolve(EVALS_DIR, 'results', `run-${Date.now()}.jsonl`);

  if (!smoke && !full && !flag('tasks') && !flag('models')) {
    console.log('no mode given, defaulting to --smoke (use --full for the whole matrix)\n');
  }
  return { arms, taskIds, modelIds, repeats, out };
}

async function attempt(
  schema: Awaited<ReturnType<typeof evalSchema>>,
  task: Task,
  arm: Arm,
  spec: ModelSpec,
  repeat: number,
  scratchDir: string,
): Promise<AttemptRecord> {
  const req = { system: systemFor(arm), user: userFor(task), withMcp: arm === 'C' || arm === 'D' };

  const res =
    spec.provider === 'claude'
      ? await runClaude(spec.model, req, scratchDir)
      : await runOllama(spec.model, req);

  const base = {
    task: task.id,
    shape: task.shape,
    trap: Boolean(task.trap),
    arm,
    model: spec.id,
    servedModel: res.servedModel,
    repeat,
    toolCalls: res.toolCalls,
    turns: res.turns,
    ms: res.ms,
    costUsd: res.costUsd,
  };

  // A harness failure is never a model failure. This is the spec's third gate.
  if (res.unscored !== undefined || res.text === undefined) {
    return { ...base, status: 'unscored', detail: res.unscored ?? 'no text returned' };
  }
  // Failing to converge IS a model failure, and belongs in the denominator.
  if (res.noAnswer) {
    return { ...base, status: 'fail', failure: 'no-answer', detail: 'exhausted tool budget without answering' };
  }

  const parsed = parseAnswer(res.text);
  if (!parsed.ok) {
    return { ...base, status: 'fail', failure: 'no-parse', detail: parsed.reason };
  }

  const out = await executeAnswer(schema, parsed.answer);
  if (!out.ok) {
    return {
      ...base,
      status: 'fail',
      failure: out.failure,
      errorCode: out.errorCode,
      detail: out.message?.slice(0, 240),
    };
  }

  const refOut = await executeAnswer(schema, task.reference);
  if (!refOut.ok) {
    // The reference itself broke. That is a harness fault and must not be
    // charged to the model.
    return { ...base, status: 'unscored', detail: `reference failed: ${refOut.message ?? refOut.failure}` };
  }

  const cmp = compare(out.rows, refOut.rows, task.order);
  if (cmp.equal) return { ...base, status: 'pass', failure: 'pass' };
  return { ...base, status: 'fail', failure: 'wrong-rows', detail: cmp.detail };
}

async function main(): Promise<void> {
  assertEvalDatabase(EVAL_DATABASE_URL);
  const { arms, taskIds, modelIds, repeats, out } = parseArgs();
  const tasks = selectTasks(taskIds);
  const models = selectModels(modelIds);
  const schema = await evalSchema();

  const scratchDir = resolve(EVALS_DIR, '.scratch');
  mkdirSync(scratchDir, { recursive: true });
  mkdirSync(resolve(EVALS_DIR, 'results'), { recursive: true });
  writeFileSync(out, '');

  // Ollama models that cannot do tool calls must be reported as such, not run
  // toolless under an arm-C label.
  const toolCapable = new Map<string, boolean>();
  for (const m of models.filter((x) => x.provider === 'ollama')) {
    toolCapable.set(m.id, await supportsTools(m.model));
  }

  const total = tasks.length * arms.length * models.length * repeats;
  console.log(`turbine agent eval`);
  console.log(`  database   ${EVAL_DATABASE_URL} (seed ${SEED})`);
  console.log(`  tasks      ${tasks.length}  (${tasks.map((t) => t.id).join(',')})`);
  console.log(`  arms       ${arms.join(',')}`);
  console.log(`  models     ${models.map((m) => m.id).join(', ')}`);
  console.log(`  repeats    ${repeats}`);
  console.log(`  attempts   ${total}`);
  console.log(`  timeout    ${ATTEMPT_TIMEOUT_MS}ms per attempt`);
  console.log(`  out        ${out}\n`);
  for (const [id, ok] of toolCapable) {
    if (!ok) console.log(`  NOTE: ${id} does not support tool calling; arms C and D will be recorded unscored.\n`);
  }

  let done = 0;
  let spend = 0;
  const started = Date.now();

  for (const spec of models) {
    for (const arm of arms) {
      for (const task of tasks) {
        for (let r = 1; r <= repeats; r++) {
          done++;
          const needsTools = arm === 'C' || arm === 'D';
          let rec: AttemptRecord;

          if (spec.provider === 'ollama' && needsTools && toolCapable.get(spec.id) === false) {
            rec = {
              task: task.id, shape: task.shape, trap: Boolean(task.trap), arm, model: spec.id,
              repeat: r, status: 'unscored', detail: 'model does not support tool calling',
              toolCalls: [], turns: 0, ms: 0,
            };
          } else {
            rec = await attempt(schema, task, arm, spec, r, scratchDir);
          }

          spend += rec.costUsd ?? 0;
          appendFileSync(out, `${JSON.stringify(rec)}\n`);
          const mark = rec.status === 'pass' ? 'PASS' : rec.status === 'fail' ? 'fail' : 'UNSC';
          const extra = rec.status === 'pass' ? '' : ` ${rec.failure ?? ''} ${rec.detail ?? ''}`.slice(0, 90);
          console.log(
            `[${String(done).padStart(3)}/${total}] ${mark} ${spec.id.padEnd(11)} ${arm} ${task.id}` +
              ` ${String(rec.ms).padStart(6)}ms tools=${rec.toolCalls.length}${extra}`,
          );
        }
      }
    }
  }

  await closeClient();
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\ncompleted ${total} attempts in ${mins} min, reported spend $${spend.toFixed(2)}`);
  console.log(`results: ${out}`);
}

main().catch(async (err) => {
  await closeClient().catch(() => {});
  console.error(err);
  process.exit(1);
});
