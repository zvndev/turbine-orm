#!/usr/bin/env bash
#
# Every example, from a PACKED TARBALL, against a real Postgres: push the
# schema, generate the client, typecheck.
#
# WHY THIS EXISTS. At 0.75.0 seven of the eight examples were broken and had
# been for many releases: they pinned `turbine-orm: ^0.7.x` (so `npm install`
# resolved a version from before most of the API existed), passed a file path
# to `--schema` (which is the Postgres schema NAME), and hand-built a
# `new TurbineClient(..., SCHEMA)` the generator has not emitted in a long time.
# None of it was caught, because nothing ran them. An example that does not run
# is worse than no example: it is the first thing a new user tries.
#
# WHAT IT DOES NOT DO. It does not RUN the examples, and it does not check the
# directories in NOT_PROJECTS below (each names what does). Four projects target a
# runtime this job has no business booting (Next.js, Cloudflare Workers, an edge
# function), and a smoke test that needs `wrangler` is a smoke test that gets
# disabled. push -> generate -> `tsc --noEmit` is the part that was actually
# broken and it is checked for all of them.
#
# Each example gets its OWN database, because `push` is a schema diff and eight
# schemas in one database would collide on `users`.
#
#   TARBALL=/path/to/turbine-orm-x.y.z.tgz \
#   DATABASE_URL=postgres://u:p@host:5432/postgres \
#     bash scripts/examples-smoke.sh
set -euo pipefail

: "${TARBALL:?TARBALL must point at a packed turbine-orm tarball}"
: "${DATABASE_URL:?DATABASE_URL must point at a Postgres server}"
[ -f "$TARBALL" ] || { echo "no such tarball: $TARBALL" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The admin URL, captured ONCE. Each iteration derives its own per-example URL
# from this and exports that; without the capture the loop would rewrite its own
# input and every example after the first would inherit the previous one's
# database. Naive string surgery is not enough either: a socket URL
# (`postgresql:///postgres?host=/tmp`) and any URL with a query string both put
# a `/` after the database name, so `${DATABASE_URL%/*}` cuts in the wrong place.
ADMIN_URL="$DATABASE_URL"

# Rewrite only the pathname, leaving host, credentials and query intact.
db_url_for() {
  ADMIN_URL="$ADMIN_URL" node -e '
    const u = new URL(process.env.ADMIN_URL);
    u.pathname = "/" + process.argv[1];
    process.stdout.write(u.href);
  ' "$1"
}

# Directories under examples/ that are NOT standalone push -> generate -> tsc
# projects. Each is source copied into a consumer by the README, or a fixture
# that a named test or harness drives against its own engine, so this job has
# nothing to push or generate for it. The list is exact in both directions: a
# directory with no package.json that is not named here fails the job (a new
# example must either ship a package.json or be added here with the thing that
# runs it), a listed directory that gains a package.json fails until it is
# removed, and a listed name with no directory fails as stale.
NOT_PROJECTS=(
  # D1 source; src/test/d1-durable-replay.test.ts runs it (unit-tests).
  d1-durable-replay
  # MySQL source; src/test/mysql-durable-replay.test.ts runs it.
  mysql-durable-replay
  # Per-engine app files; tooling/lifecycle-examples/verify.mjs installs the
  # tarball and runs them (sqlite-migrations, mysql-integration).
  native-lifecycles
  # PostgreSQL source; src/test/live-query-hub-pg.test.ts (integration-tests)
  # and src/test/fixtures/live-query-hub-pg/native-run.mjs (pgbouncer-integration).
  notification-live-query
  # PostgreSQL source; src/test/postgres-postgres-durable-replay.test.ts (integration-tests).
  postgres-durable-replay
  # PostgreSQL + MySQL source; src/test/pg-mysql-relay.test.ts.
  postgres-mysql-relay
  # SQLite source; src/test/sqlite-durable-replay.test.ts.
  sqlite-durable-replay
  # SQLite generation source; src/test/generate-sqlite-consumer.test.ts.
  sqlite-generated
  # README-only walkthrough of `turbine init --engine sqlite`; the CLI project
  # suites in sqlite-migrations run the same commands.
  sqlite-lifecycle
)

is_not_project() {
  local candidate
  for candidate in "${NOT_PROJECTS[@]}"; do
    [ "$candidate" = "$1" ] && return 0
  done
  return 1
}

failed=()
checked=0
not_projects=0

for listed in "${NOT_PROJECTS[@]}"; do
  if [ ! -d "$ROOT/examples/$listed" ]; then
    echo "  x NOT_PROJECTS names examples/$listed, which does not exist"
    failed+=("$listed: stale NOT_PROJECTS entry")
  fi
done

for dir in "$ROOT"/examples/*/; do
  name="$(basename "$dir")"
  echo ""
  echo "=============================================================="
  echo "  $name"
  echo "=============================================================="

  if is_not_project "$name"; then
    if [ -f "$dir/package.json" ]; then
      echo "  x listed in NOT_PROJECTS but has a package.json; remove it from the list"
      failed+=("$name: has package.json but is listed in NOT_PROJECTS")
    else
      echo "  -- not a standalone project (NOT_PROJECTS); driven elsewhere"
      not_projects=$((not_projects + 1))
    fi
    continue
  fi
  if [ ! -f "$dir/package.json" ]; then
    echo "  x no package.json, and not listed in NOT_PROJECTS"
    failed+=("$name: no package.json"); continue
  fi

  db="ex_$(printf '%s' "$name" | tr -c 'a-z0-9' '_')"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $db" >/dev/null
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" >/dev/null

  cp -R "$dir" "$WORK/$name"
  cd "$WORK/$name"
  rm -rf node_modules package-lock.json

  # The example's own package.json points turbine-orm at `file:../../`, which is
  # right for a checkout and wrong here: this job must prove the PUBLISHED
  # artifact works, so the tarball is substituted in.
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
    p.dependencies = p.dependencies ?? {};
    p.dependencies["turbine-orm"] = process.env.TARBALL;
    fs.writeFileSync("package.json", JSON.stringify(p, null, 2));
  '

  if ! npm install --no-audit --no-fund --silent; then
    echo "  x npm install failed"; failed+=("$name: install"); cd "$ROOT"; continue
  fi

  export DATABASE_URL="$(db_url_for "$db")"
  ok=1
  for step in db:push db:generate; do
    if ! npm run "$step" --silent; then
      echo "  x $step failed"; failed+=("$name: $step"); ok=0; break
    fi
  done
  [ "$ok" = 1 ] || { cd "$ROOT"; continue; }

  if [ ! -f tsconfig.json ]; then
    echo "  x no tsconfig.json, so nothing typechecks this example"
    failed+=("$name: missing tsconfig.json"); cd "$ROOT"; continue
  fi
  if ! npx tsc --noEmit; then
    echo "  x tsc --noEmit failed"; failed+=("$name: tsc"); cd "$ROOT"; continue
  fi

  echo "  ok  push + generate + tsc"
  checked=$((checked + 1))
  cd "$ROOT"
done

echo ""
# Anti-vacuous: a glob that matched nothing, or a loop that `continue`d every
# example, would otherwise report success.
if [ "$checked" -eq 0 ] && [ "${#failed[@]}" -eq 0 ]; then
  echo "examples-smoke: checked NOTHING; no examples/ directory was a project to push and typecheck" >&2
  exit 1
fi

if [ "${#failed[@]}" -ne 0 ]; then
  echo "examples-smoke: ${#failed[@]} failed, $checked passed, $not_projects not projects" >&2
  for f in "${failed[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

echo "examples-smoke: all $checked examples push, generate and typecheck ($not_projects listed as not projects)"
