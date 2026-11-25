#!/usr/bin/env bash
# ENGINE-NEXT-04: exact cumulative MarginLife P3 tree + Next in disposable worktree.
# No refs, original branches, main, or deployment configuration are modified.
set -euo pipefail
BASE_SHA=df9a494647db3261658a5108a098e82cff927208
MARGIN_SHA=dd1a91324fe4f00f7989e0efefd2a92a6c8d144f
OUT="${1:?provide evidence directory}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d "${RUNNER_TEMP:-/tmp}/next04-combined.XXXXXX")"
BASELINE="$TMP/margin"
COMBINED="$TMP/combined"
cleanup() {
  git -C "$ROOT" worktree remove --force "$COMBINED" 2>/dev/null || true
  git -C "$ROOT" worktree remove --force "$BASELINE" 2>/dev/null || true
  rm -f "$TMP/margin.patch" "$TMP/expected-paths" "$TMP/actual-paths"
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT
cd "$ROOT"
git fetch --no-tags --depth=1 origin "$BASE_SHA" "$MARGIN_SHA"
git cat-file -e "$BASE_SHA^{commit}"
git cat-file -e "$MARGIN_SHA^{commit}"
printf 'next_checkout=%s\nmargin=%s\ncommon_base=%s\n' "$(git rev-parse HEAD)" "$MARGIN_SHA" "$BASE_SHA" | tee "$OUT/provenance.txt"
git diff --binary --full-index "$BASE_SHA" "$MARGIN_SHA" > "$TMP/margin.patch"
git diff --name-only "$BASE_SHA" "$MARGIN_SHA" | LC_ALL=C sort > "$TMP/expected-paths"
git worktree add --detach "$BASELINE" "$MARGIN_SHA"
git worktree add --detach "$COMBINED" HEAD
# --index requires matching old blobs; overlapping changes must fail, not be silently resolved.
git -C "$COMBINED" apply --check --index "$TMP/margin.patch"
git -C "$COMBINED" apply --index "$TMP/margin.patch"
git -C "$COMBINED" diff --cached --name-only | LC_ALL=C sort > "$TMP/actual-paths"
diff -u "$TMP/expected-paths" "$TMP/actual-paths"
while IFS= read -r p; do
  test "$(git -C "$COMBINED" rev-parse ":$p")" = "$(git rev-parse "$MARGIN_SHA:$p")"
done < "$TMP/expected-paths"
cp "$TMP/actual-paths" "$OUT/combined-paths.txt"
printf 'PASS exact MarginLife P3 changed blobs applied without conflict\n' | tee -a "$OUT/provenance.txt"
# Run P3's own baseline and the complete combined tree, not just an RNG fixture.
(cd "$BASELINE" && npm run check:all) 2>&1 | tee "$OUT/margin-baseline.log"
(cd "$COMBINED" && npm run check:all) 2>&1 | tee "$OUT/combined-legacy-margin.log"
(cd "$COMBINED" && node tools/check-next-all.mjs) 2>&1 | tee "$OUT/combined-next.log"
(cd "$COMBINED" && node tools/next/rng-restore-stress.mjs) 2>&1 | tee "$OUT/combined-rng.log"
for log in "$OUT/margin-baseline.log" "$OUT/combined-legacy-margin.log"; do
  for expected in 754a144e 7eb7f2df 0d316768; do
    grep -F "hash=$expected" "$log"
  done
  grep -F "Snapshot checks" "$log"
  grep -F "MARGINLIFE P1:" "$log"
  grep -F "MARGINLIFE P3 survival:" "$log"
done
grep -F "ALL NEXT CHECKS PASSED" "$OUT/combined-next.log"
grep -F "PASS RNG compatibility assertions: 16032" "$OUT/combined-rng.log"
printf 'PASS combined MarginLife + Next regression and legacy deterministic hashes\n' | tee -a "$OUT/provenance.txt"
