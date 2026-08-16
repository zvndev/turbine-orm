# Benchmarks, turbine-orm 0.72.0

One question this release: **did the fast temporal decode path move the
streaming drain, and by how much?**

Streaming was Turbine's single remaining loss to Drizzle in 0.71.0 (1.28x on
the 50K drain). It is now a win.

## Method, and why it is not a before/after of two builds

Absolute numbers do not travel between runs on this machine, and
`RESULTS-0.71.0.md` records exactly what that costs: the same L2 statement
measured 18% apart across one afternoon, and a 50K drain moved from 42.35 ms to
68.45 ms between two runs of **unchanged code**. A before/after across two
builds is two processes on two machine states, and it would not be reportable.

It does not have to be here. The change under test lives entirely in
`pg.types`, a process-global parser table read per row at decode time, which
can be rewritten between two calls. So both versions run in **one process, on
one build, against one pool**, rotating within every round. The arms differ in
exactly one thing: which functions are registered for OIDs 1082 / 1114 / 1115 /
1182 / 1184 / 1185 while the arm runs. Server time, wire bytes, round trips,
row-object construction, `parseRow` and the cursor protocol are identical
between arms and cancel.

- **BEFORE** = what 0.71.0 shipped: the regex `date` / `timestamp` parsers, and
  pg's own `postgres-date` on `timestamptz`.
- **AFTER** = what `registerUtcTemporalParsers()` installs now.

15 rounds, 3 warmup, batch 1000, 50,000 rows, gated on an idle machine (85.2%
idle before, 82.8% after). Harness: `benchmarks/bench-decode-paired.ts`,
re-runnable with

```bash
DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench-decode-paired.ts
```

## Controls

| control | purpose | result |
|---|---|---|
| **Negative control** | the BEFORE profile is measured TWICE per round under two arm names. Byte-identical work, so they must land on top of each other. | **0.91 ms apart (1.9%)** — rotation is neutralising position, so the paired deltas below are reportable |
| **Drift control** | a raw cursor on stock pg parsers, constant across arms | 42.49 ms. Answers "did the box move" and nothing else. It still pays pg's own `timestamptz` decode, so it is **not** a floor for the arms |
| **Floor** | a raw cursor with no parsing at all | 21.30 ms |
| **Profile verification** | asserts the two profiles differ by identity but agree on value before timing anything | passed |

Stock decode cost on this fixture is 21.19 ms, which is the budget the change
is competing for.

## Result

Paired per-round deltas, positive means AFTER is faster:

| arm | before | after | paired delta | per row |
|---|---|---|---|---|
| `findManyStream` (yields rows) | 52.44 ms | **37.06 ms** | +14.98 ms (28.6%) | 300 ns |
| `findManyStreamBatches` (yields `T[]`) | 47.43 ms | **31.65 ms** | +16.54 ms (34.9%) | 331 ns |

## Against Drizzle 0.45.2, measured in the same rotation

| | 50K drain | ratio |
|---|---|---|
| Drizzle 0.45.2 keyset drain | 42.09 ms | 1.00x |
| Turbine `findManyStream`, AFTER | **37.06 ms** | **0.88x** |
| Turbine `findManyStreamBatches`, AFTER | **31.65 ms** | **0.75x** |
| Turbine `findManyStreamBatches`, BEFORE | 47.43 ms | 1.13x |

The row-yielding figure is the like-for-like one: it is the API 0.71.0's
streaming row compared, and the one a `for await (const row of …)` loop uses.
`findManyStreamBatches` is a different API with a different unit of work and is
listed separately for the same reason `RESULTS-0.71.0.md` separates it.

## What is NOT claimed here

- **No new full-suite numbers.** This release re-ran one scenario, the one it
  changed. The other nine scenarios' figures stand as published in
  `RESULTS-0.71.0.md`, including its two stated caveats (the contested L2/L3
  margins, and the 1.08x overhead-over-raw-`pg` figure).
- **Absolute values are not comparable to `RESULTS-0.71.0.md`.** Different day,
  and that file's own rule is that only ratios within a run are quotable. The
  Drizzle arm above is re-measured in this rotation for exactly that reason
  rather than being read off the older file.
- **Nothing about correctness comes from this file.** The fast path declines
  any value that is not the canonical ISO shape and delegates to the parser it
  replaced; that agreement is a differential test
  (`src/test/fast-temporal-decode.test.ts`), not a benchmark.
