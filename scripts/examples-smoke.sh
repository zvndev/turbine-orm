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
# WHAT IT DOES NOT DO. It does not RUN the examples. Four of them target a
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

failed=()
checked=0

for dir in "$ROOT"/examples/*/; do
  name="$(basename "$dir")"
  echo ""
  echo "=============================================================="
  echo "  $name"
  echo "=============================================================="

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
  echo "examples-smoke: checked NOTHING; the examples/ glob matched no directory" >&2
  exit 1
fi

if [ "${#failed[@]}" -ne 0 ]; then
  echo "examples-smoke: ${#failed[@]} failed, $checked passed" >&2
  for f in "${failed[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

echo "examples-smoke: all $checked examples push, generate and typecheck"
