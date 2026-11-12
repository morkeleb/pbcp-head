#!/usr/bin/env bash
# Asserts that Tests/Invariants/*.swift fail to compile, each with the error its `// expect:` comments name. Run from ios/.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build >/dev/null
BIN="$(swift build --show-bin-path)"
# GRDB's SQLite shim, which PBCPStore's interface names.
MAPS=(); while IFS= read -r m; do MAPS+=(-Xcc "-fmodule-map-file=$m"); done < <(find .build/checkouts/GRDB.swift/Sources -name module.modulemap)
status=0
for f in Tests/Invariants/*.swift; do
  out="$(swiftc -typecheck -swift-version 6 -I "$BIN/Modules" -I "$BIN" "${MAPS[@]}" "$f" 2>&1 || true)"
  if ! grep -q "error:" <<<"$out"; then echo "FAIL $f compiled: an invariant is broken"; status=1; continue; fi
  while IFS= read -r want; do
    # Only the compiler's own error lines: its source excerpts repeat these comments.
    if grep -F "error: $want" <<<"$out" | grep -qv "// expect:"; then echo "ok   $f: $want"; else echo "FAIL $f: expected \"$want\""; echo "$out" | grep "error:" | head -5; status=1; fi
  done < <(grep -o '// expect: .*' "$f" | sed 's#// expect: ##')
done
exit $status
