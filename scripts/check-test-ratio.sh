#!/usr/bin/env bash
# Warn-only check for:
#   1. Test files exceeding 500 LOC.
#   2. Test:source LOC ratio exceeding 2:1 for the source file(s) a test
#      corresponds to.
#
# Source-file matching convention (see src/main/model/ for the real pattern):
#   foo.test.ts                              -> foo.ts
#   foo.bar-baz.test.ts                       -> foo.ts (split-file convention:
#     progressively strip trailing dot-segments from the test file's base
#     name until a matching source file is found, e.g.
#     pi-config.list-configured-models.test.ts -> pi-config.ts)
#
# Never exits non-zero purely for exceeding a threshold (warn-only, matching
# this repo's `make lint`/`make test` philosophy). Exits non-zero only on a
# genuine script error (e.g. a file can't be read).

set -euo pipefail

LOC_THRESHOLD=500
RATIO_THRESHOLD=2

warned=0

find_source_file() {
  local test_file="$1"
  local dir base candidate
  dir=$(dirname "$test_file")
  base=$(basename "$test_file")

  # Strip the .test.ts / .test.tsx suffix.
  base=${base%.test.ts}
  base=${base%.test.tsx}

  # Progressively strip trailing dot-segments until a matching source file
  # is found (handles the split-file convention, e.g.
  # pi-config.list-configured-models -> pi-config).
  while [ -n "$base" ]; do
    for ext in ts tsx; do
      candidate="$dir/$base.$ext"
      if [ -f "$candidate" ]; then
        echo "$candidate"
        return 0
      fi
    done
    if [[ "$base" == *.* ]]; then
      base=${base%.*}
    else
      break
    fi
  done

  return 1
}

line_count() {
  wc -l < "$1"
}

while IFS= read -r test_file; do
  test_loc=$(line_count "$test_file")

  if [ "$test_loc" -gt "$LOC_THRESHOLD" ]; then
    echo "WARNING: $test_file has $test_loc lines (threshold: $LOC_THRESHOLD)"
    warned=1
  fi

  if source_file=$(find_source_file "$test_file"); then
    source_loc=$(line_count "$source_file")
    if [ "$source_loc" -gt 0 ]; then
      ratio_x10=$(( test_loc * 10 / source_loc ))
      if [ "$ratio_x10" -gt $((RATIO_THRESHOLD * 10)) ]; then
        ratio=$(awk -v t="$test_loc" -v s="$source_loc" 'BEGIN { printf "%.2f", t / s }')
        echo "WARNING: $test_file ($test_loc lines) is ${ratio}x its source file $source_file ($source_loc lines) (threshold: ${RATIO_THRESHOLD}x)"
        warned=1
      fi
    fi
  else
    echo "NOTE: $test_file has no matching source file found by naming convention; skipping ratio check"
  fi
done < <(find src \( -name "*.test.ts" -o -name "*.test.tsx" \) | sort)

if [ "$warned" -eq 0 ]; then
  echo "check-test-ratio: no test files exceeded thresholds"
fi

exit 0
