#!/usr/bin/env bash
set -euo pipefail

# One-command seed for the integration-test database.
# Usage: ./scripts/seed-test-db.sh
#
# Spins up the Docker Compose Postgres, waits for it, then runs the
# benchmark seed scripts. After this finishes, `npm test` works locally.

cd "$(dirname "$0")/.."

DB_URL="postgres://turbine:turbine@localhost:54329/turbine_test"

echo "→ starting turbine-test-db..."
docker compose -f scripts/docker-compose.yml up -d --wait

echo "→ seeding schema + data..."
cd benchmarks
if [ ! -d node_modules ]; then
  echo "→ installing benchmark deps..."
  npm install --silent
fi
DATABASE_URL="$DB_URL" npx tsx seed.ts

echo ""
echo "✓ Ready. Run the full test suite with:"
echo ""
echo "  DATABASE_URL=$DB_URL npm test"
echo ""
echo "Or stop the DB with:"
echo ""
echo "  docker compose -f scripts/docker-compose.yml down"
