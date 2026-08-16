#!/bin/bash
# Re-measure the DEFAULT configuration only, with the encoding-matched raw L2
# control in place, so the recorded overhead figure can be compared against the
# 1.08x that RESULTS-0.71.0.md had to publish as a DERIVED number.
#
# This is run-suite.sh's gate, narrowed to the one configuration the control fix
# changes. The gate is the point: an earlier round on this box was inflated ~35%
# by a parallel build, and a later one by the measuring agent's own wait loops
# spinning at 78% CPU. It tests CPU IDLE, never load average, because this
# machine idles at load 4-6 while 85% idle and a load gate never opens.
#
# Usage: ./run-control-check.sh <outdir> [runs]

set -u
OUT="${1:?usage: run-control-check.sh <outdir> [runs]}"
RUNS="${2:-3}"
mkdir -p "$OUT"
cd "$(dirname "$0")" || exit 1

export DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp"
QUIET_IDLE="${QUIET_IDLE:-80}"
QUIET_HOLD="${QUIET_HOLD:-5}"
QUIET_TIMEOUT="${QUIET_TIMEOUT:-3600}"

idlepct() { top -l 2 -n 0 -s 1 | awk '/CPU usage/ {gsub("%","",$(NF-1)); v=$(NF-1)} END {print v+0}'; }
builders() { pgrep -x rustc 2>/dev/null | wc -l | tr -d ' '; }
busy() {
  [ "$(builders)" -gt 0 ] && return 0
  awk -v i="$(idlepct)" -v t="$QUIET_IDLE" 'BEGIN{exit (i>=t)?1:0}'
}

wait_quiet() {
  local held=0 waited=0
  while [ "$waited" -lt "$QUIET_TIMEOUT" ]; do
    if busy; then
      [ "$held" -gt 0 ] && echo "  [gate] contention returned at hold=$held, resetting"
      held=0
    else
      held=$((held + 1))
      [ "$held" -ge "$QUIET_HOLD" ] && { echo "  [gate] quiet for $held samples (idle $(idlepct)%)"; return 0; }
    fi
    sleep 8
    waited=$((waited + 8))
  done
  echo "  [gate] TIMEOUT waiting for a quiet machine"
  return 1
}

echo "=== encoding-matched raw control check, $RUNS run(s) into $OUT ==="

wait_quiet || exit 1
npx tsx machine-control.ts before > "$OUT/control-before.log" 2>&1 || exit 1

for i in $(seq 1 "$RUNS"); do
  echo "[default-run$i] waiting for quiet..."
  wait_quiet || exit 1
  echo "[default-run$i] starting at $(date +%H:%M:%S)"
  npx tsx bench-interleaved.ts > "$OUT/default-run$i.log" 2>&1 || { echo "FAILED"; exit 1; }
  dirty=0; busy && dirty=1
  echo "[default-run$i] done at $(date +%H:%M:%S), dirty=$dirty"
  if [ "$dirty" -eq 1 ]; then
    echo "[default-run$i] ended under contention, discarding and retrying once"
    mv "$OUT/default-run$i.log" "$OUT/default-run$i.dirty.log"
    wait_quiet || exit 1
    npx tsx bench-interleaved.ts > "$OUT/default-run$i.log" 2>&1 || exit 1
  fi
done

wait_quiet || exit 1
npx tsx machine-control.ts after > "$OUT/control-after.log" 2>&1 || exit 1

echo "=== done ==="
