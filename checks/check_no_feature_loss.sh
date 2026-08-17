#!/usr/bin/env bash
# =============================================================================
# OGGI Wholesale v2 — GATE 1: NO FEATURE LOSS (zero-deletion gate)
# =============================================================================
#
# WHAT THIS IS FOR, IN PLAIN ENGLISH
# ----------------------------------
# Every time this product has been rebuilt, features disappeared. Not because
# anyone deleted them on purpose -- because a rewrite reproduced whatever the
# author REMEMBERED the app did, and quietly dropped the rest. That is how the
# 2.0 rewrite lost the size axis, and it is how Sonos deleted working features
# from their app in 2024 and told their investors it cost "at least $100
# million".
#
# The mobile-first conversion is the highest-risk moment for exactly that
# failure, because it touches a lot of files at once.
#
# THE INSIGHT THIS GATE IS BUILT ON
# ---------------------------------
# Features live in the JavaScript:  js/views/  and  js/data/
# Mobile layout lives in the CSS:   css/
# Those two sets are DISJOINT.
#
# So if a change never deletes a line from js/views/ or js/data/, a feature
# cannot have been lost. Not "probably not lost" -- structurally cannot.
# This gate enforces exactly that, mechanically, so it does not depend on
# anyone remembering to check.
#
# WHAT COUNTS AS A FAILURE
# ------------------------
#   - any deleted line in a protected directory
#   - any deleted FILE in a protected directory
# Added lines are always fine. Moved lines are NOT fine (a move is a delete
# plus an add) -- that is deliberate. If you genuinely need to move code,
# do it in its own separately-reviewed commit with ALLOW_DELETIONS=1 set,
# so the removal is a decision somebody made out loud rather than a side
# effect nobody noticed.
#
# HOW TO RUN IT
# -------------
#   ./checks/check_no_feature_loss.sh                  # working tree vs HEAD
#   ./checks/check_no_feature_loss.sh <base-ref>       # working tree vs a ref
#   ./checks/check_no_feature_loss.sh <base> <head>    # any two refs
#
#   ALLOW_DELETIONS=1 ./checks/check_no_feature_loss.sh   # deliberate removal
#
# Exit code 0 = pass. Exit code 1 = a feature may have been lost. Stop.
#
# PROVEN TO GO RED
# ----------------
# A check that has never failed will eventually lie. This one has been
# negative-tested: a line was deleted from js/views/buyer.js on purpose, the
# gate went red and named the file and the line, the line was restored, the
# gate went green. See checks/GATE-EVIDENCE.md for the recorded output.
# Do not trust any gate here that has not been through that cycle.
# =============================================================================

set -uo pipefail

# --- Directories whose contents are FEATURES. Deleting from these loses one. --
PROTECTED_DIRS=("js/views" "js/data" "js/components" "js/lib")

# --- Files that are allowed to shrink, because they are not features. --------
# tokens.css etc. are not in a protected dir at all, so they need no entry
# here. This list is for exceptions INSIDE a protected dir.
ALLOWLIST_REGEX='^js/lib/vendor/'

BASE="${1:-HEAD}"
HEAD_REF="${2:-}"

cd "$(dirname "$0")/.." || exit 1

echo "============================================================"
echo " GATE 1 — NO FEATURE LOSS (zero-deletion)"
echo "============================================================"
if [ -n "$HEAD_REF" ]; then
  echo " Comparing: $BASE .. $HEAD_REF"
  DIFF_ARGS=("$BASE" "$HEAD_REF")
else
  echo " Comparing: working tree vs $BASE"
  DIFF_ARGS=("$BASE")
fi
echo " Protected: ${PROTECTED_DIRS[*]}"
echo "------------------------------------------------------------"

FAILED=0
TOTAL_DELETED=0

# ---------------------------------------------------------------------------
# CHECK A — deleted FILES in a protected directory.
# A whole file vanishing is the loudest possible version of feature loss,
# so it is checked separately and reported first.
# ---------------------------------------------------------------------------
DELETED_FILES=$(git diff --diff-filter=D --name-only "${DIFF_ARGS[@]}" -- "${PROTECTED_DIRS[@]}" 2>/dev/null \
  | grep -Ev "$ALLOWLIST_REGEX" || true)

if [ -n "$DELETED_FILES" ]; then
  echo ""
  echo "  ✗ FILES DELETED FROM A PROTECTED DIRECTORY:"
  echo "$DELETED_FILES" | sed 's/^/      /'
  FAILED=1
fi

# ---------------------------------------------------------------------------
# CHECK B — deleted LINES, per file.
# `git diff --numstat` gives "added<TAB>deleted<TAB>path" per file, which is
# exactly what is needed and avoids parsing the diff body by hand.
# ---------------------------------------------------------------------------
while IFS=$'\t' read -r added deleted path; do
  [ -z "${path:-}" ] && continue
  # Binary files report "-" instead of a number; nothing to count.
  [ "$deleted" = "-" ] && continue
  echo "$path" | grep -Eq "$ALLOWLIST_REGEX" && continue

  if [ "$deleted" -gt 0 ]; then
    echo ""
    echo "  ✗ $path"
    echo "      +$added / -$deleted   ($deleted line(s) removed)"
    echo "      ---- the removed lines ----"
    # Show what actually went, so the reviewer judges the real thing
    # rather than a number. Capped so a huge diff stays readable.
    git diff "${DIFF_ARGS[@]}" -- "$path" \
      | grep -E '^-[^-]' | head -25 | sed 's/^/      /'
    REMOVED_COUNT=$(git diff "${DIFF_ARGS[@]}" -- "$path" | grep -cE '^-[^-]' || true)
    if [ "${REMOVED_COUNT:-0}" -gt 25 ]; then
      echo "      ... and $((REMOVED_COUNT - 25)) more"
    fi
    TOTAL_DELETED=$((TOTAL_DELETED + deleted))
    FAILED=1
  fi
done < <(git diff --numstat "${DIFF_ARGS[@]}" -- "${PROTECTED_DIRS[@]}" 2>/dev/null)

# ---------------------------------------------------------------------------
# VERDICT
# ---------------------------------------------------------------------------
echo ""
echo "------------------------------------------------------------"

if [ "$FAILED" -eq 0 ]; then
  echo " ✓ PASS — zero deletions in protected directories."
  echo "   No feature can have been lost by this change."
  exit 0
fi

if [ "${ALLOW_DELETIONS:-0}" = "1" ]; then
  echo " ⚠ OVERRIDDEN — ALLOW_DELETIONS=1 was set."
  echo "   $TOTAL_DELETED line(s) removed and allowed through DELIBERATELY."
  echo ""
  echo "   Per the standing rule, removing a feature requires explicit"
  echo "   approval. If you set this flag, say so in the commit message,"
  echo "   name what was removed, and why."
  exit 0
fi

echo " ✗ FAIL — $TOTAL_DELETED line(s) removed from protected code."
echo ""
echo "   A mobile-first CSS change should not need to delete ANY"
echo "   JavaScript. If this fired during the responsive conversion,"
echo "   the change went further than it should have -- narrow it to"
echo "   css/ and the new navigation component."
echo ""
echo "   If the removal really is intended, re-run with:"
echo "       ALLOW_DELETIONS=1 ./checks/check_no_feature_loss.sh"
echo "   and record the decision in the commit message."
exit 1
