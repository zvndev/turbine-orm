#!/usr/bin/env bash
#
# quickstart-smoke.sh: simulate the real first-run a brand-new user gets from
# npm 11 defaults, and run the documented quickstart end-to-end.
#
# It reproduces the exact environment that silently broke in the field:
#   1. a "type": "commonjs" project (what `npm init -y` writes on npm 11),
#   2. a TypeScript turbine.config.ts loaded via the tsx loader,
#   3. DATABASE_URL supplied ONLY through a .env file, and
#   4. turbine() called with NO arguments in the user's script.
#
# Then it walks the published quickstart: init -> push -> generate -> query,
# asserting real rows round-trip.
#
# Environment:
#   TARBALL       Path to a prebuilt turbine-orm tarball. If unset, the script
#                 runs `npm run build && npm pack` from the repo root.
#   DATABASE_URL  Postgres connection string. When set, the full live flow runs
#                 (push/generate/query). When unset, the live-DB steps are
#                 skipped and the script still proves items 1 and 2 (a commonjs
#                 + .ts config loads, and the URL is actually read from .env)
#                 against a deliberately-unreachable database.
#
# Usage:
#   scripts/quickstart-smoke.sh                       # no DB: items 1+2 only
#   DATABASE_URL=postgres://... scripts/quickstart-smoke.sh   # full live run

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# 1. Obtain a tarball (build + pack if the caller did not provide one).
# ---------------------------------------------------------------------------
if [ -z "${TARBALL:-}" ]; then
  echo "==> Building + packing turbine-orm from $ROOT"
  ( cd "$ROOT" && npm run build >/dev/null 2>&1 )
  TARBALL="$ROOT/$(cd "$ROOT" && npm pack --silent | tail -1)"
fi
echo "==> Using tarball: $TARBALL"

# ---------------------------------------------------------------------------
# 2. Scratch project: the "brand-new user" sandbox.
# ---------------------------------------------------------------------------
SMOKE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$SMOKE_DIR"; }
trap cleanup EXIT
cd "$SMOKE_DIR"
echo "==> Scratch project: $SMOKE_DIR"

# npm init -y already writes "type":"commonjs" on npm 11, but set it explicitly
# so this job is deterministic on any npm version: commonjs is the case that
# broke (config double-wrap under the tsx loader).
npm init -y >/dev/null
npm pkg set type=commonjs
echo "==> package.json type: $(npm pkg get type)"

echo "==> Installing tarball + tsx + typescript"
npm install "$TARBALL" tsx typescript --no-audit --no-fund >/dev/null

# ---------------------------------------------------------------------------
# 3. .env is the single source of the connection string (as documented).
#    In DB-less mode we still write a (bogus) URL so we can prove the CLI
#    actually READS it: the item-1 symptom was reading undefined and then
#    printing "No database URL provided".
# ---------------------------------------------------------------------------
LIVE=0
[ -n "${DATABASE_URL:-}" ] && LIVE=1
DB_URL="${DATABASE_URL:-postgres://smoke:smoke@127.0.0.1:1/does_not_exist}"
printf 'DATABASE_URL=%s\n' "$DB_URL" > .env
echo "==> Wrote .env (live DB: $LIVE)"

# Run the CLI with DATABASE_URL unset in the shell so the ONLY way it can get a
# URL is by auto-loading .env: exercising product-review item 2 for real.
turbine() { env -u DATABASE_URL npx --no-install turbine "$@"; }

# ---------------------------------------------------------------------------
# 4. init: a commonjs project + a .ts config must load (item 1), and .env must
#    feed DATABASE_URL (item 2).
# ---------------------------------------------------------------------------
echo "==> turbine init"
turbine init

# Replace the scaffolded empty schema with a real table to push.
cat > turbine/schema.ts <<'EOF'
import { defineSchema } from 'turbine-orm';

export default defineSchema({
  notes: {
    id: { type: 'serial', primaryKey: true },
    body: { type: 'text', notNull: true },
    created_at: { type: 'timestamp', default: 'NOW()' },
  },
});
EOF

if [ "$LIVE" -eq 0 ]; then
  # No reachable DB: prove items 1+2 without a live connection. `turbine generate`
  # must fail trying to CONNECT to the bogus host, and must NEVER print "No
  # database URL provided" (the item-1 failure, where the double-wrapped config
  # made every field undefined).
  echo "==> turbine generate (expected to fail on connection, NOT on a missing URL)"
  set +e
  OUT="$(turbine generate 2>&1)"
  CODE=$?
  set -e
  printf '%s\n' "$OUT"
  if printf '%s' "$OUT" | grep -qi "No database URL provided"; then
    echo "FAIL: DATABASE_URL from .env was not read: product-review item 1/2 regression"
    exit 1
  fi
  if [ "$CODE" -eq 0 ]; then
    echo "FAIL: expected generate to fail against an unreachable database"
    exit 1
  fi
  echo "PASS (no live DB): commonjs + .ts config loaded and DATABASE_URL was read from .env."
  echo "     Skipped push/generate/query: set DATABASE_URL to run the full live flow."
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Live flow: push the schema, generate the typed client, run a real query.
# ---------------------------------------------------------------------------
echo "==> turbine push"
turbine push

echo "==> turbine generate"
turbine generate

# The user's first query: turbine() with NO arguments (product-review item 3).
# The app loads .env exactly as the quickstart documents (Node 20.12+), which is
# what populates process.env.DATABASE_URL for the no-arg factory fallback.
cat > query.ts <<'EOF'
import assert from 'node:assert/strict';
import { turbine } from './generated/turbine/index.js';

if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const db = turbine(); // no args: connection comes from DATABASE_URL

async function main() {
  await db.notes.create({ data: { body: 'hello from quickstart-smoke' } });
  const rows = await db.notes.findMany();
  assert.ok(rows.length >= 1, 'expected at least one note to round-trip');
  assert.equal(rows[0].body, 'hello from quickstart-smoke', 'row content must round-trip');
  console.log(`OK: round-tripped ${rows.length} note(s) via turbine() with no args`);
  await db.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
EOF

echo "==> Running the first query (turbine() with no args, .env-sourced URL)"
env -u DATABASE_URL npx --no-install tsx query.ts

echo "PASS: full live quickstart round-trip (init -> push -> generate -> query)."
