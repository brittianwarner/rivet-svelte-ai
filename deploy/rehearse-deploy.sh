#!/usr/bin/env bash
# Rehearse a Railway deploy on the local replica stack:
#   1. three replicas (OLD, default app1-3) serve and hold state,
#   2. the next release (NEW, default app4-6) starts on fresh disks beside them,
#   3. after the overlap window the old replicas drain (SIGTERM),
#   4. the same actor still has its count, served only by the new release.
# Run from the repo root. Leaves the stack running; `down -v` when done.
set -euo pipefail
compose=(docker compose -f deploy/compose.replicas.yml)
edge=http://localhost:8080
overlap=${OVERLAP_SECONDS:-120}
key=rehearsal-$(date +%s)
read -r -a old <<<"${OLD:-app1 app2 app3}"
read -r -a new <<<"${NEW:-app4 app5 app6}"

ready() { for _ in $(seq 1 150); do "${compose[@]}" exec -T "$1" bun -e 'process.exit((await fetch("http://127.0.0.1:8080/api/health/actors")).ok?0:1)' >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
bump() { curl -sf -o /dev/null -X POST -H 'content-type: application/json' -H "origin: $edge" -d '{"by":1}' "$edge/api/counters/$key/increment"; }

# Replicas start with --no-deps below, so bring the bucket and its TLS proxy
# up first: on a cold stack the proxy's CA does not exist yet.
"${compose[@]}" up -d --wait minio s3 >/dev/null
"${compose[@]}" run --rm --no-deps bucket >/dev/null
"${compose[@]}" --profile next up -d --pull never --no-deps "${old[@]}" >/dev/null
"${compose[@]}" up -d --pull never edge >/dev/null
for a in "${old[@]}"; do ready $a || { echo "$a never became ready"; exit 1; }; done
SMOKE_ACTOR_KEY=$key bun apps/server/tests/deployment.ts "$edge" >/dev/null
echo "release 1 serving; $key = 9"

# A new release always boots on empty disks, as on Railway.
"${compose[@]}" --profile next rm -sf "${new[@]}" >/dev/null 2>&1 || true
"${compose[@]}" --profile next up -d --pull never --no-deps "${new[@]}" >/dev/null
for a in "${new[@]}"; do ready $a || { echo "$a never became ready"; exit 1; }; done
echo "release 2 ready; overlapping for ${overlap}s"
count=9 failed=0
end=$((SECONDS + overlap))
while [ $SECONDS -lt $end ]; do if bump; then count=$((count + 1)); else failed=$((failed + 1)); fi; sleep 2; done

echo "draining release 1"
"${compose[@]}" --profile next stop "${old[@]}" >/dev/null &
drain=$!
while kill -0 $drain 2>/dev/null; do if bump; then count=$((count + 1)); else failed=$((failed + 1)); fi; sleep 2; done
echo "release 1 stopped; $failed failed increments during the deploy"

SMOKE_ACTOR_KEY=$key SMOKE_EXPECT_COUNT=$count bun apps/server/tests/deployment.ts "$edge"
