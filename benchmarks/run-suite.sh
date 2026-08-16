#!/bin/bash
# Run the full 0.71.0 benchmark round, gating every run on a quiet machine.
#
# WHY THE GATE. The 0.70.0 round's absolute numbers came in ~35% inflated
# because a parallel build was saturating the box, and that was only caught by a
# control containing none of Turbine's code. This machine currently runs a Rust
# build in bursts, so "wait once at the start" is not enough: a burst that
# begins mid-run silently taxes whichever arms happen to be executing, and
# interleaving does NOT protect against that (it spreads the tax over the arms
# present, but a suite half-run under contention is not comparable to one that
# was not). So the quiet check runs before EVERY run, and any run that starts
# dirty is re-run.
#
# Quiet = no rustc process and CPU idle above the threshold, sustained for
# QUIET_HOLD consecutive samples, so a single quiet instant between two bursts
# does not read as a quiet machine.
#
# Usage: ./run-suite.sh <outdir>

set -u
OUT="${1:?usage: run-suite.sh <outdir>}"
mkdir -p "$OUT"
cd "$(dirname "$0")" || exit 1

export DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp"
QUIET_IDLE="${QUIET_IDLE:-80}"    # minimum % CPU idle to count as quiet
QUIET_HOLD="${QUIET_HOLD:-6}"     # consecutive samples that must be quiet
QUIET_TIMEOUT="${QUIET_TIMEOUT:-5400}"

load1() { sysctl -n vm.loadavg | awk '{print $2}'; }

# THE GATE IS CPU IDLE, NOT LOAD AVERAGE, and the difference is not academic on
# this box. macOS load average counts threads blocked on I/O and on locks, and
# this machine permanently hosts a dozen idle dev servers, watchers and editor
# language servers, so its floor loadavg sits near 4-6 while the CPU is 85%
# idle. A loadavg gate therefore never opens: it would wait out its whole
# timeout and then either publish contended numbers or publish nothing. Idle
# percentage measures the thing that actually competes with a single-threaded
# benchmark for a core.
#
# `top -l 2` is required: the first sample of `top` reports since-boot averages,
# so `-l 1` would report a number that has nothing to do with right now.
idlepct() { top -l 2 -n 0 -s 1 | awk '/CPU usage/ {gsub("%","",$(NF-1)); v=$(NF-1)} END {print v+0}'; }

# NOTE: macOS pgrep has no -c. `pgrep -c rustc` exits with a usage error, which
# a `|| echo 0` then turns into a confident "no compilers running" while a
# 20-way rustc build is saturating the box. Count lines instead.
builders() { pgrep -x rustc 2>/dev/null | wc -l | tr -d ' '; }
busy() {
  [ "$(builders)" -gt 0 ] && return 0
  awk -v i="$(idlepct)" -v t="$QUIET_IDLE" 'BEGIN{exit (i>=t)?1:0}'
}

wait_quiet() {
  local held=0 waited=0
  while [ "$waited" -lt "$QUIET_TIMEOUT" ]; do
    if busy; then
      [ "$held" -gt 0 ] && echo "  [gate] contention returned at hold=$held, resetting (idle $(idlepct)%, rustc $(builders))"
      held=0
    else
      held=$((held + 1))
      [ "$held" -ge "$QUIET_HOLD" ] && { echo "  [gate] quiet for $held samples (idle $(idlepct)%, load $(load1))"; return 0; }
    fi
    sleep 10
    waited=$((waited + 10))
  done
  echo "  [gate] TIMEOUT after ${QUIET_TIMEOUT}s waiting for a quiet machine"
  return 1
}

# Run one command, but only starting from a quiet machine, and record whether
# the machine was still quiet when it finished. A run that ended dirty is
# marked so it can be discarded rather than silently averaged in.
run_gated() {
  local label="$1"; shift
  local log="$OUT/$label.log"
  local attempt=0
  while [ "$attempt" -lt 4 ]; do
    attempt=$((attempt + 1))
    echo "[$label] attempt $attempt: waiting for quiet..."
    wait_quiet || return 1
    echo "[$label] starting at $(date +%H:%M:%S), load $(load1)"
    "$@" > "$log" 2>&1
    local rc=$?
    local endload
    endload=$(load1)
    local dirty=0
    busy && dirty=1
    echo "[$label] finished rc=$rc at $(date +%H:%M:%S), load $endload, dirty=$dirty"
    if [ "$rc" -ne 0 ]; then echo "[$label] FAILED (rc=$rc), see $log"; return 1; fi
    if [ "$dirty" -eq 0 ]; then
      echo "[$label] OK (clean)"
      return 0
    fi
    echo "[$label] ended under contention, discarding and retrying"
    mv "$log" "$OUT/$label.dirty$attempt.log"
  done
  echo "[$label] gave up after $attempt attempts"
  return 1
}

echo "=== 0.71.0 benchmark round, output in $OUT ==="

run_gated control-before npx tsx machine-control.ts before || exit 1

for i in 1 2 3; do
  run_gated "default-run$i" npx tsx bench-interleaved.ts || exit 1
done

for i in 1 2 3; do
  run_gated "object-run$i" env TURBINE_JSON=object npx tsx bench-interleaved.ts || exit 1
done

for i in 1 2 3; do
  run_gated "rc-run$i" env INCLUDE_RC=1 npx tsx bench-interleaved.ts || exit 1
done

# Four arms still, with the Turbine STREAM arm pointed at the batch-yielding
# API. Directly comparable to the default suite; the only difference is which
# method one arm calls.
for i in 1 2 3; do
  run_gated "batches-run$i" env TURBINE_STREAM=batches npx tsx bench-interleaved.ts || exit 1
done

run_gated control-after npx tsx machine-control.ts after || exit 1

echo "=== round complete ==="
