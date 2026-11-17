#!/usr/bin/env bash
# Rehearse a Railway deploy of all three services on the local stack:
#   1. the current release (OLD: engine1-3, api1-2, web1-2) serves and holds state,
#   2. the next release (NEW: engine4-6, api3-4, web3-4) starts on fresh disks beside it,
#   3. after the overlap window the old release drains (SIGTERM),
#   4. the same actor still has its count, served only by the new release.
# Traffic goes through the edge on :8080 the whole time.
# Run from the repo root. Leaves the stack running; `down -v` when done.
set -euo pipefail
compose=(docker compose -f deploy/compose.replicas.yml --profile next)
edge=http://localhost:8080
overlap=${OVERLAP_SECONDS:-120}
key=rehearsal-$(date +%s)
read -r -a old <<<"${OLD:-engine1 engine2 engine3 api1 api2 web1 web2}"
read -r -a new <<<"${NEW:-engine4 engine5 engine6 api3 api4 web3 web4}"

bump() { curl -sf -o /dev/null -X POST -H 'content-type: application/json' -H "origin: $edge" -d '{"by":1}' "$edge/api/counters/$key/increment"; }

# Replicas start with --no-deps below, so bring the buckets and their TLS
# proxy up first: on a cold stack the proxy's CA does not exist yet.
"${compose[@]}" up -d --wait minio s3 >/dev/null
"${compose[@]}" run --rm --no-deps buckets >/dev/null
"${compose[@]}" up -d --wait --pull never --no-deps "${old[@]}" >/dev/null
"${compose[@]}" up -d --pull never --no-deps edge >/dev/null
SMOKE_ACTOR_KEY=$key bun apps/server/tests/deployment.ts "$edge" >/dev/null
echo "release 1 serving; $key = 9"

# A new release always boots on empty disks, as on Railway.
"${compose[@]}" rm -sf "${new[@]}" >/dev/null 2>&1 || true
"${compose[@]}" up -d --wait --pull never --no-deps "${new[@]}" >/dev/null
echo "release 2 ready; overlapping for ${overlap}s"
count=9 failed=0
end=$((SECONDS + overlap))
while [ $SECONDS -lt $end ]; do if bump; then count=$((count + 1)); else failed=$((failed + 1)); fi; sleep 2; done

echo "draining release 1"
"${compose[@]}" stop "${old[@]}" >/dev/null &
drain=$!
while kill -0 $drain 2>/dev/null; do if bump; then count=$((count + 1)); else failed=$((failed + 1)); fi; sleep 2; done
echo "release 1 stopped; $failed failed increments during the deploy"

SMOKE_ACTOR_KEY=$key SMOKE_EXPECT_COUNT=$count bun apps/server/tests/deployment.ts "$edge"
