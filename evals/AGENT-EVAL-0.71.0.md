# Agent eval, turbine-orm 0.71.0

**Date:** 2026-08-16
**Database:** local PostgreSQL 17.9, `turbine_eval`, seed `20260816`
**Attempts:** 360 (30 tasks x 4 arms x 3 models), **0 unscored**
**Measured spend:** $8.44
**Harness:** `evals/`, re-runnable with `npm run db:reset && npm run full`

The question this answers: does any of the "built for agents" apparatus (the
docs, the eleven MCP tools, a skill) measurably raise a model's chance of
writing a correct query against a schema it has never seen?

Short answer: **the MCP tools do, by a lot. The docs do not.**

---

## 1. Calibration, and whether the task set is sound

The spec's first two gates are that arm A (schema DDL and the task, nothing
else) must score neither near 0% nor near 100%. Otherwise every later delta is
measuring the wrong thing.

| model | arm A | verdict |
|---|---|---|
| claude-sonnet-5 | **33%** (10/30) | in band |
| claude-haiku-4-5 | **33%** (10/30) | in band |
| qwen3.5:4b (local) | **0%** (0/30) | floored |

**The task set passes calibration.** Both hosted models land at 33%, which
leaves two thirds of the range for later arms to move through, and neither is
anywhere near the ceiling. Every one of the 90 calibration attempts was
scoreable; none were dropped.

`qwen3.5:4b` scoring 0% on arm A is a property of that model, not of the tasks.
The same tasks are answerable: the same model reaches 43% once the tools are
attached, and the hosted models clear a third of them cold. A task set that
were genuinely too hard could not be moved by tooling alone.

The 30 tasks cover filters and ordering, to-one and to-many relations, a
two-level nested read, many-to-many through a junction, `some`/`none`/`every`
relation filters, `groupBy` with `having`, compound-unique lookups, JSON-path
filters and aggregates. Six are marked as traps: their natural Prisma phrasing
is wrong in Turbine.

Before any model ran, every reference query was checked against raw SQL written
from the DDL and sharing no code with the ORM (`npm run db:verify`), and each
was checked for being non-degenerate: no task's answer is empty, and no
filtered task matches the whole table. Two of my own references were wrong on
the first pass and the check caught both.

---

## 2. Pass rate per arm per model

Pass means the model's query, run once against the live database, returned rows
deeply equal to the reference. Not similar. Equal.

| model | A cold | B +docs | C +MCP tools | D +skill |
|---|---|---|---|---|
| claude-sonnet-5 | 33% (10/30) | 40% (12/30) | 70% (21/30) | 100% (30/30) |
| claude-haiku-4-5 | 33% (10/30) | 30% (9/30) | 80% (24/30) | 93% (28/30) |
| qwen3.5:4b (local) | 0% (0/30) | 3% (1/30) | 43% (13/30) | 77% (23/30) |
| **pooled** | **22%** | **24%** | **64%** | **90%** |

### Deltas, against measured noise

Run-to-run variance was measured, not assumed: three independent full 30-task
passes of arm C on `claude-haiku-4-5` gave 80.0%, 76.7% and 83.3%. That is a
**spread of 6.7 points, standard deviation 3.3**. Any delta below about 7
points is inside noise and is reported as such.

| model | A->B (docs) | B->C (tools) | C->D (skill) | A->D |
|---|---|---|---|---|
| claude-sonnet-5 | +7 | **+30** | **+30** | +67 |
| claude-haiku-4-5 | -3 | **+50** | +13 | +60 |
| qwen3.5:4b | +3 | **+40** | **+33** | +77 |

**A->B is inside the noise band for all three models.** One is negative. On
this evidence, `llms.txt` does not measurably help a model write a correct
query. That is an unflattering result and it is the honest one.

**B->C is decisive for all three models,** at 4 to 7 times the noise band. This
is the number the agent-first positioning rests on, and it holds up.

**C->D is real but confounded.** See section 6 before quoting it.

---

## 3. What the docs are and are not

The A->B result is not mysterious once you read `site/public/llms.txt`. It is
an *index*: a link list, a feature summary, and a "common mistakes" section
about imports and config keys. It contains almost no query syntax. It names
`with`, and that shows up as the one thing arm B does better than arm A:
`E005-relation` (an unknown relation name) appears 8 times in arm B and 0 times
in arm A, because arm A models were not reaching for `with` at all, while arm B
models reached for it and then guessed the relation name wrong.

Arm B trades one failure mode for another and nets out at zero.

If the goal is for a model with no tool access to write Turbine queries, the
docs file would have to carry the operator list, the `with` options, the
`having` shape and the JSON-path shape. Today it carries none of them.

---

## 4. Failure classes, which is what a skill should be built from

| failure | A | B | C | D | total |
|---|---|---|---|---|---|
| `E003-snake-case-name` | 16 | 17 | 6 | 2 | **41** |
| `E003-unknown-field` | 17 | 11 | 2 | 0 | 30 |
| `wrong-rows` | 7 | 8 | 13 | 3 | 31 |
| `E003-other` | 16 | 13 | 0 | 0 | 29 |
| `no-parse` | 3 | 5 | 5 | 4 | 17 |
| `E003-relation-in-select` | 7 | 2 | 0 | 0 | 9 |
| `E005-relation` | 0 | 8 | 1 | 0 | 9 |
| `no-answer` | 0 | 0 | 5 | 0 | 5 |
| `E003-compound-unique` | 2 | 2 | 0 | 0 | 4 |
| `driver-error` | 2 | 2 | 0 | 0 | 4 |

### The single largest failure class is an ORM inconsistency, not a model error

`E003-snake-case-name` is an attempt that used the DDL's own spelling of a
column that really exists. It is the largest bucket in the whole run, and it is
caused by this:

| argument position | `ledger_handle` | `ledgerHandle` |
|---|---|---|
| `where` | accepted | accepted |
| `select` / `omit` | accepted | accepted |
| `distinct` | accepted | accepted |
| `cursor` | accepted | accepted |
| `orderBy` | **rejected, E003** | accepted |
| `groupBy` `by` | **rejected, E003** | accepted |
| `_avg` / `_sum` / `_min` / `_max` | **rejected, E003** | accepted |

Same column, same schema, same run, five positions accept it and three reject
it. A model that reads the DDL (which is snake_case, as every DDL is) and
writes back what it read is right five times and wrong three times.

This is the exact drift class `resolveColumnName` was introduced in 0.53 to
end, and the call sites are identifiable:

| site | check used | result |
|---|---|---|
| `projectionColumn` (`query/relations.ts`) | `resolveColumnName(meta, field)` | accepts both |
| `buildGroupBy` `by` (`query/aggregates.ts:88`) | `!(key in meta.columnMap)` | camelCase only |
| `_sum`/`_avg`/`_min`/`_max` (`query/aggregates.ts:995`) | `!(key in meta.columnMap)` | camelCase only |
| `_count` (`query/aggregates.ts:1005`) | `!(key in meta.columnMap)` | camelCase only |
| `orderBy` (`query/relations.ts:573`, `:614`, `:674`) | `!(key in meta.columnMap)` | camelCase only |

`resolveColumnName` tries the field map, then `camelToSnake`, then validates
against the reverse map. A bare `key in meta.columnMap` skips all of that. The
fix is to route those five sites through `resolveColumnName` like the
projection path already does. (`_count: { id: true }` works today only because
`id` is spelled identically either way, which is why this survived.)

It is reproducible in four lines against any schema and is worth fixing
independent of anything else in this document.

Because it could otherwise masquerade as evidence that models cannot write
queries, the report also gives the rate with those failures removed from both
numerator and denominator:

| model | A | B | C | D |
|---|---|---|---|---|
| claude-sonnet-5 | 42% | 52% | 81% | 100% |
| claude-haiku-4-5 | 43% | 39% | 80% | 93% |
| qwen3.5:4b | 0% | 4% | 46% | 82% |

The shape of the finding does not change: B->C still dominates. Fixing the
inconsistency would raise every arm by roughly 8 to 10 points, most of it in
arms A and B.

### Trap tasks

Six tasks were written so that the natural Prisma phrasing is wrong. Pooled
across all three models:

| arm | trap tasks | non-trap tasks |
|---|---|---|
| A | **0%** (0/18) | 28% |
| B | 6% (1/18) | 29% |
| C | **67%** (12/18) | 64% |
| D | 94% (17/18) | 89% |

This is the sharpest single result in the run. Cold, a Prisma-shaped habit gets
a model **zero** of six relation-shaped tasks. With the tools connected, traps
stop being harder than anything else. `include` is silently ignored by Turbine
rather than rejected, so the query runs and returns rows with no relation
attached, and nothing tells the model it was wrong. The tools prevent that by
letting it read the real relation names before it commits.

### What still fails with tools

`nested-two-level` was 0% in arm C across all three models, and `json-path`
actually got *worse* from B to C (44% to 33%). Those two, plus `wrong-rows`
rising from 8 to 13 as tools were added, are where a skill has real work to do.

---

## 5. Which MCP tools were actually used

Across all 180 tool-enabled attempts:

| tool | calls |
|---|---|
| `compile_query` | 259 |
| `relation_graph` | 50 |
| `table_detail` | 29 |
| `schema_overview` | 1 |
| `sample_rows` | 1 |
| `find_join_path` | 1 |
| `migrate_status` | 0 |
| `doctor_report` | 0 |
| `explain_query` | 0 |
| `table_stats` | 0 |
| `explain_error` | 0 |

**Three tools do essentially all the work.** `compile_query`, `relation_graph`
and `table_detail` account for 338 of 341 calls. Five tools were never called
once, and three more were called once each.

That is not automatically an argument to cut five tools: `migrate_status`,
`doctor_report`, `table_stats` and `explain_query` are operational rather than
query-authoring tools, and this eval only asks query-authoring questions. But
`find_join_path` being called once while `relation_graph` was called 50 times
is a genuine signal, since they answer nearly the same question and models
overwhelmingly picked the other one.

`explain_error` was never called because a first-try eval gives a model no
error to explain. Its value, if it has one, is in a retry loop this harness
does not measure.

Tool use was not uniform. `claude-sonnet-5` called a tool in only 17 of 60
tool-enabled attempts and still reached 70%; `claude-haiku-4-5` called one in
58 of 60. The smaller model leaned on the tools far harder, and gained more
(+50 versus +30).

---

## 6. The skill result, and why it should not be quoted yet

Arm D shows +30 / +13 / +33. Two of those are outside the noise band. On the
spec's fourth gate, that reads as "ship C5".

**I would not quote it, for one reason: I wrote both the tasks and the skill.**
The candidate skill was written after I had probed this exact API surface to
build the harness, and it documents precisely the constructs the tasks
exercise, including the snake_case table above. Arm D is therefore close to an
upper bound on what a perfectly targeted skill could buy, not an estimate of
what a skill written independently would buy. `claude-sonnet-5` reaching 100%
on 30 of 30 is the tell.

The honest use of arm D is: **a skill-shaped document can close most of the
residual gap, so C5 is worth writing.** The failure classes above say what it
must contain. The number itself should be re-measured against tasks the skill's
author has not seen.

One correction is recorded for transparency. The first arm D run used a skill
containing a false sentence ("input accepts either spelling"), which the
snake_case finding later disproved. The sentence was corrected and arm D was
re-run from scratch for both hosted models. Results were identical (100% and
93%), because every example in the skill already used camelCase.

---

## 7. Cost of a full run

Measured, from this run:

| model | $/attempt | 120 attempts (4 arms x 30 tasks) |
|---|---|---|
| claude-sonnet-5 | $0.046 | $5.50 |
| claude-haiku-4-5 | $0.025 | $2.94 |
| qwen3.5:4b (local) | $0 | $0 |

Per arm, cost rises with prompt size and tool use: arm A $0.037, arm B $0.038,
arm C $0.059, arm D $0.049 (sonnet-5).

**This run: $8.44 and 104 minutes of attempt time** (about 55 minutes wall clock
with three models in parallel).

**A full six-model matrix including `claude-opus-5`** would add roughly 120
opus attempts. Extrapolating from sonnet at 3 to 4 times the price, that is
**about $20 to $25 extra, and roughly 40 minutes more wall clock.** Adding the
two remaining local models costs nothing but roughly 90 minutes each, since
local inference is the slow part.

Recommendation: opus is worth buying once, to confirm the frontier tier behaves
like sonnet. It is not worth buying on every re-run.

---

## 8. Limitations

Stated plainly, because several of them bound how far this result travels.

1. **Arm D is confounded.** Same author for tasks and skill. See section 6.
2. **One schema, one domain.** 30 tasks against a single held-out schema. The
   relation-naming results in particular could look different on a schema whose
   table names singularise awkwardly. An earlier draft of this schema produced
   the relation name `wheelBatche`, which no model can guess and only a tool can
   report; it was renamed *out* of the eval precisely because keeping it would
   have manufactured an arm C win that says nothing about whether the tools
   genuinely help.
3. **Ollama and MCP.** Ollama has no MCP client, so arm C for local models runs
   through a hand-rolled tool loop in `src/runners/mcp-client.ts` (spawn
   `turbine mcp`, JSON-RPC over stdio, feed the tool list to Ollama's native
   function-calling API). It is a real MCP client and it really called the real
   server, but it is not the same client the Claude CLI uses, and the loop is
   capped at 12 tool turns. `qwen3.5:4b` hit that cap on 5 attempts, scored as
   `no-answer` failures rather than dropped.
4. **The first full matrix lost 35 attempts** to "mcp server exited" while
   three models ran in parallel and Ollama held several gigabytes. Those
   attempts were correctly recorded as unscored rather than failed, but an arm
   reporting 1 scored attempt out of 30 has measured nothing. The client now
   restarts the server and retries once, and the affected cells were re-run
   alone. **The published matrix has 0 unscored attempts.**
5. **Only one non-Anthropic model was run.** `gemma4:e4b` and `qwen3.5:2b` are
   installed and configured but were not run, for wall-clock reasons.
6. **No frontier model.** `claude-opus-5` is configured but was not run, on
   cost grounds. See section 7.
7. **First try only.** No retries, no error-driven correction loop. This is the
   harshest possible reading and it deliberately understates the value of
   `explain_error` and of typed error codes generally, which exist to be acted
   on after a failure.
8. **Structured args, not TypeScript.** Models emit `{table, method, args}` as
   JSON rather than code, so nothing here measures whether a model can write
   working TypeScript around the query, and syntax errors cannot cost a point.
9. **Anthropic models are not deterministic.** Hence the variance measurement.
   Local models run greedy (`temperature: 0`, fixed seed).
10. **The `haiku` alias is not Haiku.** On this CLI, `--model haiku` resolves to
    `claude-sonnet-4-6`. Every result records the model the provider says served
    it. Runs configured with bare aliases would have silently measured Sonnet
    twice.

---

## 9. What to do next

1. **Fix the snake_case inconsistency.** It is the largest failure class in the
   run, it is an ORM bug rather than a model limitation, and it is worth roughly
   8 to 10 points of pass rate across every arm.
2. **Write C5, and measure it against tasks its author has not seen.** The
   evidence that a skill helps is strong; the size of the effect is not yet
   trustworthy.
3. **Put query syntax in `llms.txt`,** or stop expecting it to help. Today it
   buys nothing measurable.
4. **Leave the MCP tools alone.** They are the thing that works. If anything is
   cut, look at `find_join_path`, which lost decisively to `relation_graph` for
   the same job.
5. **Consider making `include` an error.** It is currently ignored in silence,
   which is how a wrong query returns plausible rows and nothing complains.

---

## Reproducing

```bash
cd evals && npm install
npm run db:reset      # schema.sql + deterministic seed into turbine_eval
npm run db:verify     # 30 references vs independent SQL, must report 0 problems
npm run full          # 30 tasks x 4 arms x configured models
npx tsx src/report.ts results/*.jsonl
```

Raw per-attempt records for this run are in `evals/results/*.jsonl`
(`v1-superseded/` holds the arm D run against the uncorrected skill and the
MCP-crash cells, kept for audit).
