#!/usr/bin/env bash
# Every gateway test, each in its own process (they stub fs and fetch globally).
set -uo pipefail
cd "$(dirname "$0")"
fails=0
# If an ignore rule ever hides the tests again, fail loudly instead of passing on half.
count=$(ls test-*.js test-*.cjs 2>/dev/null | wc -l | tr -d " ")
[ "$count" -ge 12 ] || { echo "only $count gateway test files found (expected at least 12)"; exit 1; }
for t in test-*.js; do
  if timeout 120 node "$t" > /tmp/gw-test.out 2>&1; then echo "pass  $t"; else echo "FAIL  $t"; tail -20 /tmp/gw-test.out; fails=$((fails+1)); fi
done
for t in test-*.cjs; do
  if timeout 120 node --test "$t" > /tmp/gw-test.out 2>&1; then echo "pass  $t"; else echo "FAIL  $t"; tail -20 /tmp/gw-test.out; fails=$((fails+1)); fi
done
[ "$fails" -eq 0 ] && echo "all gateway tests pass" || { echo "$fails gateway test file(s) failed"; exit 1; }
