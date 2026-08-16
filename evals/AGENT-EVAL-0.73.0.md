# Agent eval, turbine-orm 0.73.0

**Date:** 2026-08-16
**Database:** local PostgreSQL 17.9, `turbine_eval`, seed `20260816`
**Attempts:** 240, **0 unscored**, all on ONE build
**Measured spend:** $8.07
**Harness:** `evals/`, re-runnable with `npm run db:reset && npm run full`

This round exists to answer the question the release had to answer before
shipping an installable skill: **does the skill measurably help, and does it
help where people will actually use it?**

Short answer: **the skill alone takes a cold model from 73% to 97% on
`claude-sonnet-5` and from 60% to 97% on `claude-haiku-4-5`, and it beats a live
MCP connection on both.**

---

## 1. The arms, and the one that is new

| arm | what the model gets |
|---|---|
| A | the schema DDL and the task, nothing else |
| B | + `llms.txt` |
| C | + a live `turbine mcp` connection |
| D | + the packaged skill |
| **E** | **the schema DDL + the packaged skill. No docs, no tools.** |

A through D are cumulative, which prices each layer against the one below it.
**E is not a rung on that ladder**, and it was added this round because the
cumulative design cannot answer the question the skill ships for. In arm D the
MCP tools are already connected, so the model can read the declared relation
names and does not need to be told how they are derived. D measures the skill
where it has the least left to say. Most people who install a skill are not also
running an MCP server.

Arm D now reads the file that `npx turbine skill` installs, rather than a
candidate copy under `evals/`. Measuring anything else is how the 0.71.0
candidate came to assert that a snake_case column name was rejected in `orderBy`
one release after that stopped being true.

## 2. Pass rate

Every number below is the same build, so the arms are comparable to each other
without an asterisk.

| model | A cold | C tools | D tools+skill | **E skill only** |
|---|---|---|---|---|
| claude-sonnet-5 | 73% | 93% | 100% | **97%** |
| claude-haiku-4-5 | 60% | 90% | 93% | **97%** |

### Against measured noise

Run-to-run variance was measured in the 0.71.0 round, not assumed: three
independent passes of arm C on `claude-haiku-4-5` gave 80.0%, 76.7% and 83.3%, a
spread of 6.7 points, standard deviation 3.3. **Any delta below about 7 points is
inside noise and is reported as such.**

| delta | sonnet-5 | haiku-4-5 |
|---|---|---|
| **A → E, the skill on its own** | **+24** | **+37** |
| A → C, the MCP tools on their own | +20 | +30 |
| C → D, the skill on top of the tools | +7 (at the boundary) | +3 (inside noise) |
| **E − C, skill versus tools** | **+4 (inside noise)** | **+7 (at the boundary)** |

Three things follow, and the third is the one that decided what to ship.

1. **The skill on its own is the largest single lever in the round**, on both
   models, by a wide margin outside noise.
2. **On top of the tools it adds little.** That is not a disappointment, it is
   the mechanism working: with `relation_graph` and `compile_query` connected,
   the model reads the real names instead of guessing, which is most of what the
   skill is for.
3. **The skill is at least as good as the tools, and on the smaller model
   better.** A file with no network access, no database connection and no setup
   matched a live MCP server. For a user who will not configure MCP, that is the
   whole case for shipping it.

## 3. Where the cold arm actually fails

Arm A, 20 failures across both models:

| failure class | count |
|---|---|
| **a relation named inside `select`** | **12** |
| other E003 (JSON-path operator, `having` shape) | 3 |
| unknown field | 2 |
| wrong rows | 3 |

**Twelve of twenty cold failures are one mistake**: putting a relation in
`select` instead of `with`. It is the single most valuable sentence in the
skill, and it goes to **zero** in arms C, D and E.

Worth stating plainly, because it changes what the number means: this is not the
model failing at SQL. Every one of those twelve queries was otherwise correct.
It is a model reaching for the Prisma habit, which is exactly what a skill is
able to fix and what an ORM cannot fix for it. Turbine refuses that shape with a
clear E003 pointing at `with` (0.64.0), and the refusal is what makes the class
countable here rather than silent.

## 4. What the models did with the tools

Across the 120 tool-enabled attempts, 68 called at least one tool:

| tool | calls |
|---|---|
| `compile_query` | 83 |
| `relation_graph` | 31 |
| `table_detail` | 23 |
| `schema_overview` | 5 |
| the other seven | 0 |

`compile_query` (added in 0.71.0) is now the most-used tool in the set, ahead of
the relation graph. Seven of the eleven tools were never called once. That is
information about the tool surface, not about the models: on a query-writing
task, an agent wants "is this query valid" and "what are the real names", and
the rest of the surface is for other jobs.

## 5. Two things this round is honest about

- **One sentence was added to the skill after it was measured.** Arm E's single
  `haiku-4-5` failure was `Unknown JSON filter operator "not"`, and the skill did
  not say which operators a JSON path accepts. That paragraph now exists and is
  covered by `verify:skill`. The 97% above was measured WITHOUT it, so the
  shipped file carries one more true sentence than the file that produced the
  number. Disclosed rather than re-measured, because the direction is not in
  doubt and hiding an improvement to keep a number tidy is the worse trade.

- **The tasks and the skill share an author.** That was flagged in the 0.71.0
  round as a reason to read arm D as an upper bound, and it applies to arm E
  equally. What has changed is that the failures are now legible: the dominant
  cold failure class is a Prisma habit rather than anything specific to this task
  set, and the skill's fix for it is one sentence any reader can check. An
  independent task set remains the right next step.

## 6. Reproducing

```bash
cd evals && npm install
npm run db:reset && npm run db:verify
npm run verify:skill                    # every claim the skill makes, executed
npx tsx src/run.ts --full --arms A --models sonnet-5,haiku-4-5 --out results/a.jsonl
npx tsx src/run.ts --full --arms E --models sonnet-5,haiku-4-5 --out results/e.jsonl
npx tsx src/report.ts results/*.jsonl
```

Raw attempt records: `results/0.73-baseline-A.jsonl` (60),
`results/0.73-skill-E.jsonl` (60), `results/0.73-skill-CD.jsonl` (120). Every
record now carries the ANSWER the model submitted, not only the error it
produced, which is the harness gap the 0.72.0 round could not reproduce a
failure through.
