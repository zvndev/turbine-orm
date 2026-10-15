#!/usr/bin/env bash
# Run one full benchmark round and build the site's results JSON from it.
#
#   ./run-round.sh <outdir>
#
# Writes into <outdir>:
#   env.json          the versions and the machine, captured before anything runs
#   verify-arms.log   the arm-equivalence check (the round stops if it fails)
#   *.log             one log per suite run, plus machine-control before / after
#   results.json      the site's results file (shape of results-<version>.json)
#   summary.txt       every derived figure, per scenario, for the write-up
#
# Prerequisites (see benchmarks/README.md): the library built at the repo root,
# `npm ci && npx prisma generate` here, a database seeded by seed-neon.ts and
# ANALYZEd, and the Turbine client generated into ../generated/turbine.
#
# WHY EVERY RUN IS GATED. A round's absolute numbers are only worth publishing
# from a quiet machine, and "wait once at the start" is not enough: a burst of
# other work that begins mid-run silently taxes whichever arms happen to be
# executing. Interleaving spreads that tax over the arms present, but a suite
# half-run under contention is still not comparable to one that was not. So the
# quiet check runs before EVERY run, the machine is checked again when the run
# ends, and a run that ended dirty is discarded and repeated.
#
# Quiet = CPU idle at or above QUIET_IDLE percent and none of QUIET_PROCS
# running, for QUIET_HOLD consecutive samples QUIET_INTERVAL seconds apart. The
# gate reads CPU idle, not load average: load average counts threads blocked on
# I/O and locks, so a machine hosting idle servers never opens a load gate.
#
# Env:
#   DATABASE_URL     default postgresql:///turbine_bench?host=/tmp
#   RUNS=3           runs of each repeated suite
#   QUICK=1          a smoke run: tiny round counts and NO quiet gate (unless
#                    QUIET_IDLE is set explicitly). Proves the pipeline end to
#                    end, on any machine; its numbers mean nothing.
#   QUIET_IDLE=80    minimum CPU idle percent (0 disables the idle check)
#   QUIET_HOLD=6     consecutive quiet samples required
#   QUIET_INTERVAL=10 seconds between samples
#   QUIET_TIMEOUT=5400 seconds to wait for quiet before giving up
#   QUIET_PROCS=rustc space-separated process names that mean "busy"
#   BENCH_MACHINE_NOTE  appended to env.machine (e.g. how Postgres is hosted)
#
# Works on Linux (idle from /proc/stat) and macOS (idle from `top`).

set -u

OUT="${1:?usage: run-round.sh <outdir>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
cd "$(dirname "$0")" || exit 1

export DATABASE_URL="${DATABASE_URL:-postgresql:///turbine_bench?host=/tmp}"

RUNS="${RUNS:-3}"
QUICK="${QUICK:-0}"
QUIET_IDLE_SET="${QUIET_IDLE+set}"
QUIET_IDLE="${QUIET_IDLE:-80}"
QUIET_HOLD="${QUIET_HOLD:-6}"
QUIET_INTERVAL="${QUIET_INTERVAL:-10}"
QUIET_TIMEOUT="${QUIET_TIMEOUT:-5400}"
QUIET_PROCS="${QUIET_PROCS:-rustc}"

# Round sizes. The full values are the ones every published round uses; QUICK
# shrinks them so the whole pipeline (logs, aggregation, results.json) can be
# exercised in a few minutes.
if [ "$QUICK" = "1" ]; then
  # A smoke run checks plumbing, not timings, so it does not wait for quiet.
  [ -z "$QUIET_IDLE_SET" ] && QUIET_IDLE=0
  QUIET_HOLD=1
  QUIET_INTERVAL=1
  DEFAULT_ENV=(ROUNDS=10 WARMUP=2 STREAM_ROUNDS=2)
  EXTENDED_ENV=(ROUNDS=10 WARMUP=2 COLD_ROUNDS=10)
  STREAM_ENV=(STREAM_ROUNDS=2 WARMUP=1)
  LATENCY_ENV=(ROUNDS=3)
  DEEP_ENV=(ROUNDS=10)
  CONTROL_ENV=(ROUNDS=20 WARMUP=2)
else
  DEFAULT_ENV=(ROUNDS=200 WARMUP=20 STREAM_ROUNDS=15)
  EXTENDED_ENV=(ROUNDS=100 WARMUP=15 COLD_ROUNDS=100)
  STREAM_ENV=(STREAM_ROUNDS=15 WARMUP=2)
  LATENCY_ENV=(ROUNDS=25)
  DEEP_ENV=(ROUNDS=150)
  CONTROL_ENV=(ROUNDS=200 WARMUP=20)
fi

# bench-latency.ts forwards a delay proxy to the Unix socket itself, so it takes
# the socket path, database and user rather than a URL. Derive them from
# DATABASE_URL unless they are set explicitly. pg-connection-string is the
# parser node-postgres itself uses, so the socket derived here is the one every
# other suite connects to.
{
  IFS= read -r DERIVED_HOST
  IFS= read -r DERIVED_PORT
  IFS= read -r DERIVED_DB
  IFS= read -r DERIVED_USER
} < <(node -e '
  const c = require("pg-connection-string").parse(process.env.DATABASE_URL);
  for (const v of [c.host || "/tmp", c.port || "5432", c.database || "", c.user || ""]) console.log(v);
')
[ -n "${DERIVED_HOST:-}" ] || { echo "could not parse DATABASE_URL"; exit 1; }
case "$DERIVED_HOST" in
  /*) ;;
  *) [ -n "${PGSOCKET:-}" ] || { echo "bench-latency needs a Unix socket: use a socket DATABASE_URL or set PGSOCKET"; exit 1; } ;;
esac
export PGSOCKET="${PGSOCKET:-$DERIVED_HOST/.s.PGSQL.$DERIVED_PORT}"
export PGDATABASE="${PGDATABASE:-$DERIVED_DB}"
if [ -z "${PGUSER:-}" ] && [ -n "$DERIVED_USER" ]; then export PGUSER="$DERIVED_USER"; fi

# --- the quiet-machine gate --------------------------------------------------

OS="$(uname -s)"

# Percent of CPU time idle over the next second.
idlepct() {
  if [ "$OS" = "Linux" ]; then
    # /proc/stat's first line is cumulative jiffies since boot, so sample it
    # twice and read the delta. Idle = idle + iowait.
    local a b
    a=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat)
    sleep 1
    b=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat)
    awk -v a="$a" -v b="$b" 'BEGIN{split(a,x," "); split(b,y," "); t=y[1]-x[1]; print (t>0) ? int(100*(y[2]-x[2])/t) : 0}'
  else
    # `top -l 2`: the first sample reports since-boot averages, not now.
    top -l 2 -n 0 -s 1 | awk '/CPU usage/ {gsub("%","",$(NF-1)); v=$(NF-1)} END {print int(v+0)}'
  fi
}

load1() {
  if [ -r /proc/loadavg ]; then awk '{print $1}' /proc/loadavg; else sysctl -n vm.loadavg | awk '{print $2}'; fi
}

# Count matching processes by lines: macOS pgrep has no -c, and a usage error
# swallowed by `|| echo 0` reads as "nothing running".
builders() {
  local n=0 p c
  for p in $QUIET_PROCS; do
    c=$(pgrep -x "$p" 2>/dev/null | wc -l | tr -d ' ')
    n=$((n + c))
  done
  echo "$n"
}

LAST_IDLE=0
busy() {
  [ "$(builders)" -gt 0 ] && return 0
  [ "$QUIET_IDLE" -le 0 ] && return 1
  LAST_IDLE="$(idlepct)"
  [ "$LAST_IDLE" -lt "$QUIET_IDLE" ]
}

wait_quiet() {
  local held=0 started=$SECONDS
  while [ $((SECONDS - started)) -lt "$QUIET_TIMEOUT" ]; do
    if busy; then
      [ "$held" -gt 0 ] && echo "  [gate] contention returned at hold=$held (idle ${LAST_IDLE}%, busy procs $(builders))"
      held=0
    else
      held=$((held + 1))
      if [ "$held" -ge "$QUIET_HOLD" ]; then
        if [ "$QUIET_IDLE" -le 0 ]; then
          echo "  [gate] off (QUIET_IDLE=0), load $(load1)"
        else
          echo "  [gate] quiet for $held samples (idle ${LAST_IDLE}%, load $(load1))"
        fi
        return 0
      fi
    fi
    sleep "$QUIET_INTERVAL"
  done
  echo "  [gate] TIMEOUT after ${QUIET_TIMEOUT}s waiting for a quiet machine"
  return 1
}

# Run one command from a quiet machine; discard and repeat a run that ended
# under contention, so a dirty run is never averaged in.
run_gated() {
  local label="$1"
  shift
  local log="$OUT/$label.log" attempt=0 rc dirty
  while [ "$attempt" -lt 4 ]; do
    attempt=$((attempt + 1))
    echo "[$label] attempt $attempt: waiting for quiet..."
    wait_quiet || return 1
    echo "[$label] starting at $(date -u +%H:%M:%SZ), load $(load1)"
    "$@" >"$log" 2>&1
    rc=$?
    dirty=0
    busy && dirty=1
    echo "[$label] finished rc=$rc at $(date -u +%H:%M:%SZ), load $(load1), dirty=$dirty"
    if [ "$rc" -ne 0 ]; then
      echo "[$label] FAILED (rc=$rc), last lines of $log:"
      tail -20 "$log"
      return 1
    fi
    [ "$dirty" -eq 0 ] && return 0
    echo "[$label] ended under contention, discarding and retrying"
    mv "$log" "$OUT/$label.dirty$attempt.log"
  done
  echo "[$label] gave up after $attempt attempts"
  return 1
}

fail() {
  echo "=== round FAILED: $1 ==="
  exit 1
}

# A smoke run with the gate off checks no processes either.
if [ "$QUICK" = "1" ] && [ "$QUIET_IDLE" -le 0 ]; then QUIET_PROCS=""; fi

# A missing pgrep would make builders() answer 0 forever, which reads as quiet.
if [ -n "$QUIET_PROCS" ] && ! command -v pgrep >/dev/null 2>&1; then
  echo "pgrep is not installed, so QUIET_PROCS cannot be checked (set QUIET_PROCS= to skip it)"
  exit 1
fi

# --- the round ---------------------------------------------------------------

echo "=== benchmark round, output in $OUT ==="
echo "node $(node -v), $OS, QUICK=$QUICK RUNS=$RUNS, gate idle>=${QUIET_IDLE}% x${QUIET_HOLD} every ${QUIET_INTERVAL}s"
echo "socket $PGSOCKET, database $PGDATABASE"

# Every number below is attributed to these versions and this machine, so they
# are captured first, from the installed packages and the server itself.
npx tsx build-results.ts env "$OUT" || fail "could not capture the environment"

# An arm is only worth timing if it does the same work as the arms it is
# compared with. Nothing is timed until that is proven.
npx tsx verify-arms.ts >"$OUT/verify-arms.log" 2>&1 || {
  tail -20 "$OUT/verify-arms.log"
  fail "verify-arms (see verify-arms.log)"
}
echo "[verify-arms] OK"

run_gated control-before env "${CONTROL_ENV[@]}" npx tsx machine-control.ts before || fail control-before
for i in $(seq 1 "$RUNS"); do
  run_gated "default-run$i" env "${DEFAULT_ENV[@]}" npx tsx bench-interleaved.ts || fail "default-run$i"
done
for i in $(seq 1 "$RUNS"); do
  run_gated "extended-run$i" env "${EXTENDED_ENV[@]}" npx tsx bench-extended.ts || fail "extended-run$i"
done
for i in $(seq 1 "$RUNS"); do
  run_gated "stream-run$i" env "${STREAM_ENV[@]}" npx tsx bench-stream-parity.ts || fail "stream-run$i"
done
for i in $(seq 1 "$RUNS"); do
  run_gated "latency-run$i" env "${LATENCY_ENV[@]}" npx tsx bench-latency.ts || fail "latency-run$i"
done
run_gated deepoffset env "${DEEP_ENV[@]}" npx tsx deepoffset.ts || fail deepoffset
run_gated control-after env "${CONTROL_ENV[@]}" npx tsx machine-control.ts after || fail control-after

npx tsx build-results.ts build "$OUT" | tee "$OUT/summary.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "build-results"
echo "=== round complete: $OUT/results.json ==="
