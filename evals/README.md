# evals: the cross-model agent eval harness

Measures one number: **first-try pass rate** on database query tasks against a
schema the model has never seen, across four escalating levels of help.

| arm | what the model gets |
|---|---|
| A | the schema DDL and the task, nothing else |
| B | + `site/public/llms.txt` |
| C | + a live `turbine mcp` connection (11 read-only tools) |
| D | + a candidate query-writing skill (`candidate-skill.md`) |

The arms are cumulative, so `A->B` prices the docs, `B->C` prices the MCP
tools, and `C->D` prices the skill.

## Running it

```bash
cd evals
npm install
npm run db:reset      # apply schema.sql + deterministic seed into turbine_eval
npm run db:verify     # check all 30 reference queries against independent SQL
npm run smoke         # 8 tasks x 4 arms x 2 models
npm run full          # 30 tasks x 4 arms x 6 models
npx tsx src/report.ts results/*.jsonl
```

Useful flags: `--tasks T01,T12`, `--models haiku-4-5,qwen3.5-4b`, `--arms A,C`,
`--repeats 3`, `--out path.jsonl`.

## What makes the number trustworthy

**Scoring is objective.** The model emits `{table, method, args}` as JSON. The
harness runs it through the real `TurbineClient` against the live database and
deep-compares the rows to a reference implementation. No model grades anything,
and no answer is accepted for being close.

**The reference is itself checked.** Every task carries `sanityCount` and often
`sanityIds`: raw SQL written from the DDL, sharing no code with the ORM.
`npm run db:verify` refuses to pass if a reference disagrees with its SQL, or if
a task's answer is empty or is the entire table. A task that a broken query can
answer correctly is worse than no task.

**Unscored is not failed.** A crashed CLI, a transport error or a timeout is
recorded as `unscored` and left out of the denominator, and the count is printed
beside every rate. A model that loops on tools until its budget runs out is a
*failure* (`no-answer`), because that is the model not converging rather than
the harness not working.

**Model identity is recorded, not assumed.** The `haiku` alias on this CLI
resolves to `claude-sonnet-4-6`. Every result stores what the provider says
actually served it, so a mislabelled run is visible rather than silent.

**Arm A really is cold.** The `claude` CLI runs from a scratch directory with a
replaced system prompt and every built-in tool disallowed. Run inside the repo
it would discover `CLAUDE.md`, which documents this entire ORM, and arm A would
not be arm A. Verified: the model reports no instructions mentioning turbine.

**Determinism.** Fixed PRNG seed (`SEED` in `src/config.ts`), fixed data, and
greedy decoding for local models. Anthropic models are not deterministic, which
is why variance is measured with `--repeats` and reported rather than assumed
away.

## Layout

```
schema.sql            held-out schema (cheese affinage ledger)
candidate-skill.md    the arm-D skill under test
src/config.ts         seeds, timeouts, the "only ever turbine_eval" guard
src/seed.ts           deterministic seed
src/tasks.ts          the 30 tasks, references, and sanity SQL
src/verify-tasks.ts   validates the task set before any model runs
src/protocol.ts       answer parsing (reads-only method whitelist)
src/execute.ts        runs an answer, classifies the failure
src/canonical.ts      normalisation + order-aware deep compare
src/prompts.ts        per-arm prompt assembly
src/runners/          claude CLI runner, ollama runner, MCP stdio client
src/run.ts            the harness
src/report.ts         aggregation
```

## The database

Local PostgreSQL, database `turbine_eval`, created by this harness and touched
by nothing else. `assertEvalDatabase()` refuses any other database name and any
pooler host, so a stray `DATABASE_URL` cannot point it somewhere real. Only read
methods are on the protocol whitelist, so no model answer can reach a write
path.
