#!/usr/bin/env bash
# Proves a database backup can be restored: loads a gzip'd plain-SQL pg_dump (what scheduled.yml
# uploads to R2) into a throwaway Postgres and checks that the data is really there.
#
#   .github/scripts/verify-restore.sh <dump.sql.gz>
#
# Env:
#   PG_DUMP_IMAGE  Postgres image for the throwaway server (default postgres:17-alpine; use the
#                  same one as the dump so the client and server versions match)
#   RESTORE_URL    Optional. Restore into this EMPTY database instead of starting a container
#                  (local testing: createdb sgw_restore_test, then RESTORE_URL=postgresql://...)
#
# Exits non-zero if the dump is truncated, does not load cleanly, or the key tables are empty.
set -euo pipefail

file=${1:?usage: verify-restore.sh <dump.sql.gz>}
image=${PG_DUMP_IMAGE:-postgres:17-alpine}
name=sgw-restore-test-$$
started=$(date +%s)

echo "Checking the file"
gzip -t "$file"
if ! gzip -dc "$file" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
  echo "::error::$file has no 'dump complete' trailer: pg_dump was cut short"
  exit 1
fi

if [ -n "${RESTORE_URL:-}" ]; then
  psql_run() { psql "$RESTORE_URL" -v ON_ERROR_STOP=1 "$@"; }
else
  cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  docker run -d --name "$name" -e POSTGRES_PASSWORD=restore-test "$image" >/dev/null
  # The official image first runs a temporary server for initdb, then stops it and starts the real
  # one. The temporary server listens on the Unix socket only (listen_addresses=''), so a socket
  # check can pass on it and then fail during the restart. Checking over TCP only passes once the
  # real server is up. The loop tolerates failures; the final check fails the script if it never
  # came up.
  ready() { docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; }
  for _ in $(seq 1 60); do
    ready && break
    sleep 1
  done
  ready || { echo "::error::throwaway Postgres did not become ready within 60 s"; docker logs "$name" 2>&1 | tail -n 20; exit 1; }
  psql_run() { docker exec -i "$name" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
fi

echo "Restoring (single transaction, stops at the first error)"
gzip -dc "$file" | psql_run -q -1 >/dev/null

echo "Sanity checks"
count() { psql_run -Atc "SELECT count(*) FROM $1"; }
toilets=$(count '"Toilet"')
venues=$(count '"Venue"')
users=$(count '"User"')
migrations=$(count '_prisma_migrations WHERE finished_at IS NOT NULL')
failed=$(count '_prisma_migrations WHERE finished_at IS NULL')
elapsed=$(( $(date +%s) - started ))

summary="restored in ${elapsed}s: Toilet=$toilets Venue=$venues User=$users migrations_applied=$migrations migrations_unfinished=$failed"
echo "$summary"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "- $summary" >> "$GITHUB_STEP_SUMMARY"

problems=()
[ "$toilets" -gt 0 ] || problems+=("Toilet is empty")
[ "$venues" -gt 0 ] || problems+=("Venue is empty")
[ "$migrations" -gt 0 ] || problems+=("_prisma_migrations has no applied migrations")
[ "$failed" -eq 0 ] || problems+=("$failed unfinished migration(s) in the dump")
if [ "${#problems[@]}" -gt 0 ]; then
  printf '::error::restored database looks wrong: %s\n' "${problems[@]}"
  exit 1
fi
