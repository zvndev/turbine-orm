# Agent eval, turbine-orm 0.72.0

**Date:** 2026-08-16
**Database:** local PostgreSQL 17.9, `turbine_eval`, seed `20260816`
**Attempts:** 540 across two runs (360 + 180), **0 unscored**
**Measured spend:** $14.61
**Harness:** `evals/`, re-runnable with `npm run db:reset && npm run full`

The 0.71.0 eval measured what documentation, MCP tools and a skill buy a model
writing queries against a schema it has never seen. Its largest single failure
bucket turned out to be **our bug, not the models'**. This round fixes two of
those bugs and re-measures after each one, so the contribution of each is
separated rather than bundled.

Short answer: **fixing two API asymmetries raised cold first-try pass rate by
40 points on `claude-sonnet-5`, which is more than the documentation has ever
bought.**

---

## 1. What changed between the runs

| run | build | what it measures |
|---|---|---|
| 0.71.0 baseline | 0.71.0 | published in `AGENT-EVAL-0.71.0.md` |
| **run 1** | + column-spelling fix | a snake_case COLUMN name now resolves in `orderBy`, `groupBy`'s `by`, and the `_min`/`_max`/`_sum`/`_avg` targets, as it already did in `where`/`select`/`omit`/`distinct`/`cursor` |
| **run 2** | + relation-name fix | a snake_case RELATION name now resolves in `with`, `_count`, relation filters and `orderBy` |

Both fixes are widenings: every name that resolved before resolves to the same
thing, and an unknown name is still refused.

## 2. Pass rate, per arm, per model

Arms are cumulative: **A** = schema DDL only, **B** = + `llms.txt`, **C** = +
a live `turbine mcp` connection, **D** = + the candidate skill.

| model | arm | 0.71.0 | + column fix | + relation fix |
|---|---|---|---|---|
| claude-sonnet-5 | A cold | 33% | 60% | **73%** |
| | B +docs | 40% | 57% | **70%** |
| | C +tools | 70% | 90% | 90% |
| | D +skill | 100% | 100% | not re-run |
| claude-haiku-4-5 | A cold | 33% | 53% | **57%** |
| | B +docs | 30% | 37% | **67%** |
| | C +tools | 80% | 80% | 83% |
| | D +skill | 93% | 97% | not re-run |
| qwen3.5:4b (local) | A cold | 0% | 0% | not re-run |
| | B +docs | 3% | 3% | not re-run |
| | C +tools | 43% | 43% | not re-run |
| | D +skill | 77% | 83% | not re-run |

**Run 2 was deliberately scoped** to arms A/B/C on the two hosted models, 180
attempts rather than 360. The relation fix can only operate where a model is
guessing relation names off the DDL, which is arms A and B; arms C and D read
the real names from the tools. C is included as a no-regression check. `qwen3.5:4b`
is excluded because its cold arms are floored at 0-3%, where no ORM fix can show.
That scoping is a claim the data below tests, not an assumption: if the fix had
moved arm C, the scoping would have been wrong.

### Against measured noise

Run-to-run variance was measured in the 0.71.0 round, not assumed: three
independent passes of arm C on `claude-haiku-4-5` gave 80.0%, 76.7% and 83.3%,
a spread of 6.7 points, standard deviation 3.3. **Any delta below about 7 points
is inside noise and is reported as such.**

| delta | sonnet-5 | haiku-4-5 |
|---|---|---|
| column fix, arm A | **+27** | **+20** |
| column fix, arm B | +17 | +7 (at the noise boundary) |
| column fix, arm C | **+20** | 0 |
| relation fix, arm A | **+13** | +4 (inside noise) |
| relation fix, arm B | **+13** | **+30** |
| relation fix, arm C | 0 (inside noise) | +3 (inside noise) |

**Arm C did not move for either model under the relation fix**, which is the
predicted result and the reason to believe the mechanism: with the tools
connected, a model reads the declared relation names and never has to guess.

## 3. The failure distribution that made the case

Run 1, all 360 attempts, failures by class and arm:

| failure class | A | B | C | D | total |
|---|---|---|---|---|---|
| **relation-name spelling** | 22 | 21 | **0** | **0** | 43 |
| wrong-rows | 8 | 14 | 13 | 3 | 38 |
| other E003 | 18 | 17 | 2 | 0 | 37 |
| no-parse | 3 | 5 | 5 | 3 | 16 |
| unknown-field | 4 | 2 | 1 | 0 | 7 |
| no-answer | 0 | 0 | 5 | 0 | 5 |
| driver-error | 1 | 2 | 0 | 0 | 3 |

All 43 relation-name failures are in arms A and B and **none** are in C or D.
A failure class that vanishes exactly where the tools are connected is a failure
class caused by the model having to guess, which is what the fix removes.

## 4. What this says about the docs, and it is not flattering

On the 0.71.0 build, arm B was inside noise of arm A. After the column fix it
was **below** arm A for both models (57% vs 60%, 37% vs 53%): the documentation
made models measurably worse.

The mechanism is visible in the failure classes. `llms.txt` names `with`, so
arm B models reached for relations that arm A models never attempted, and then
guessed the relation name wrong. The docs were converting "did not try" into
"tried and was refused".

The relation fix removes that penalty, and arm B goes from **below** arm A to
**above** it on both models (70% vs 73% on sonnet, 67% vs 57% on haiku). The
+30 on haiku's arm B is the largest single delta in the whole round, and it is
not a documentation change: it is the ORM no longer refusing what the docs
encouraged models to write.

**This is still not an argument that `llms.txt` is good.** A → B is now +13 on
haiku and −3 on sonnet, which straddles zero and sits inside the noise band on
sonnet. The 0.71.0 conclusion stands: that file is an index, it carries almost
no query syntax, and if the goal is a model writing correct Turbine with no
tools it would have to carry the operator list, the `with` options, and the
`having` and JSON-path shapes.

## 5. Traps

Six of the thirty tasks are written so the natural Prisma phrasing is wrong.
Pooled over arms A and B on both hosted models, they went **4/24 to 5/24**
across the two runs: inside noise, and still the hardest thing in the set.

That is the correct result. The traps test whether a model reaches for a
Prisma habit (`include` instead of `with`, naming a relation inside `select`),
and neither fix touches that. `select` naming a relation is still a
`ValidationError`, deliberately, and it still accounts for most trap failures.
Fixing an ORM asymmetry does not teach a model an API.

## 6. Open items, stated rather than smoothed over

- **One failure I could not reproduce.** `haiku-4-5`, arm B, T27 in run 2
  returned `TURBINE_E005` on the relation name `cheese_wheel` for table
  `ripening_checks`, whose declared relation is `cheeseWheel`, on a build where
  that resolves. Every shape I could construct against that same table, client
  and database accepts it, under all three relation-load strategies, bounded
  and unbounded, nested and top level. **The harness does not record the answer
  a model submitted**, only the error it produced, so the failing arguments are
  gone. That is a harness gap and it is the first thing to fix before the next
  round: record the submitted answer alongside the verdict.
- **Arm D was not re-run**, so the skill numbers in this document are 0.71.0's.
  They were already flagged there as an upper bound, because the same author
  wrote the tasks and the skill.
- **The 0.71.0 conclusion about the MCP tools is unchanged and is now the
  smaller effect.** B → C is still the largest single lever for a model with no
  other help (+20 to +30 on the hosted models). But two ORM fixes moved arm A by
  27 and 20 points, which says a meaningful part of what the tools were buying
  was working around our own inconsistencies rather than supplying knowledge.

## 7. Reproducing

```bash
cd evals && npm install
npm run db:reset && npm run db:verify
npx tsx src/run.ts --full --models sonnet-5,haiku-4-5,qwen3.5-4b --out results/run.jsonl
npx tsx src/report.ts results/run.jsonl
```

Raw attempt records: `evals/results/postfix-all.jsonl` (run 1, 360) and
`evals/results/postfix-relations.jsonl` (run 2, 180).
