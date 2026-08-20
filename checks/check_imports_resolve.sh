#!/usr/bin/env bash
# =====================================================================
# check_imports_resolve.sh — can this build actually boot?
#
# RUN:  bash checks/check_imports_resolve.sh
# PASS: exit 0
# FAIL: exit 1, and every unresolved import is printed with its source
#
# WHY THIS EXISTS
# ---------------------------------------------------------------------
# 20 Aug 2026: js/views/wholesaler.js was pushed to main importing
# js/data/client-bans.js, which had not been pushed yet. Pushing to main
# auto-deploys, so a build went live whose module graph could not
# resolve.
#
# ONE unresolved import does not degrade the app. It kills it. The
# browser abandons the entire module graph, #app-root never gets a child,
# and the user sees a white page with the explanation sitting in a
# console nobody has open. The site was down for roughly thirteen
# minutes and the cause was a file that simply was not there.
#
# Every existing check in this folder tests what the SERVER does. None of
# them could have caught this, because the server was fine -- it served
# exactly what it was given. This check tests something different and
# cheaper: does the code we are about to publish actually hang together.
#
# WHAT IT WILL NOT CATCH, STATED HONESTLY
# ---------------------------------------------------------------------
# It resolves relative specifiers only ("./x.js", "../y/z.js"). It does
# not evaluate the modules, so a file that exists but throws on import
# still passes here. It does not follow bare specifiers or URLs, because
# v2 has none by design (the Supabase client is vendored -- see
# js/lib/supabase-client.js). It is a spelling-and-existence check, not a
# type checker. It catches the exact class of failure that took the site
# down, which is the job it was written for.
#
# PROVEN RED: run against commit e6daa08 (wholesaler.js present,
# client-bans.js absent) it reports
#   js/views/wholesaler.js -> ../data/client-bans.js
# and exits 1. A check that has never failed has never been tested.
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
checked=0

# Match both `from "..."` and bare `import "..."` side-effect imports.
while IFS= read -r src; do
  dir=$(dirname "$src")
  # Pull every quoted specifier that follows `from` or a bare `import`.
  specs=$(grep -oE '(from|import)[[:space:]]*"[^"]+"' "$src" 2>/dev/null \
          | sed -E 's/.*"([^"]+)"/\1/' || true)
  [ -z "$specs" ] && continue
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    case "$spec" in
      ./*|../*) ;;                 # relative — the only kind v2 uses
      *) continue ;;               # bare specifier or URL — not ours to resolve
    esac
    checked=$((checked + 1))
    target="$dir/$spec"
    if [ ! -f "$target" ]; then
      echo "  UNRESOLVED  $src"
      echo "              -> $spec"
      echo "              (looked for: $target)"
      fail=1
    fi
  done <<< "$specs"
done < <(find js -name '*.js' -not -path '*/vendor/*' | sort)

# index.html must reference real files too -- a missing <script src> is
# the same outage with a different first domino.
while IFS= read -r ref; do
  checked=$((checked + 1))
  if [ ! -f "$ref" ]; then
    echo "  UNRESOLVED  index.html"
    echo "              -> $ref"
    fail=1
  fi
done < <(grep -oE '(src|href)="(js|css)/[^"]+"' index.html 2>/dev/null | sed -E 's/.*"(.*)"/\1/' | sort -u)

if [ "$fail" -ne 0 ]; then
  echo
  echo "check_imports_resolve: FAIL — this build cannot boot."
  echo "A single unresolved import kills the whole module graph: white page, no error on screen."
  exit 1
fi

echo "check_imports_resolve: PASS ($checked specifiers, all resolve)"
exit 0
