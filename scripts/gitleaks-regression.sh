#!/usr/bin/env bash
# Does .gitleaks.toml still catch what it should? Its allowlist used to be a
# word list matched against the whole assignment, so a setting whose NAME
# said "example" or "fake" hid a real-looking value beside it (audit issue
# #42, 2026-10-09); later it allowed exact sample values, which the
# publisher's gate (default rules, no allowlist) then blocked (2026-10-17).
# This scans a throwaway folder of invented files and checks each one is
# reported:
#
#   scripts/gitleaks-regression.sh <gitleaks binary> [config]
#
# The credential-looking values are random, made here on each run, so no
# value that looks like a secret is ever written into the repository. CI's
# "secrets" job runs it with the pinned binary; test/gitleaksConfig.test.ts
# runs it when a gitleaks binary is on hand. Exit 0: all as expected.
set -euo pipefail
BIN="${1:?usage: gitleaks-regression.sh <gitleaks binary> [config]}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$(cd "$(dirname "${2:-$ROOT/.gitleaks.toml}")" && pwd)/$(basename "${2:-$ROOT/.gitleaks.toml}")"
case "$BIN" in /*) ;; *) BIN="$(pwd)/$BIN" ;; esac
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# One letter, one digit, sixteen times: no two letters ever touch, so a random
# value can never spell one of the generic rule's stopwords. Leaving out the
# vowels was not enough: some stopwords have none ("src", "pdf", "xml"), and
# one such draw went unreported and failed CI (2026-10-12).
rnd() {
  local letters digits out="" i
  letters="$(LC_ALL=C tr -dc 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz' </dev/urandom | head -c 16 || true)"
  digits="$(LC_ALL=C tr -dc '2346789' </dev/urandom | head -c 16 || true)"
  for i in $(seq 0 15); do out="$out${letters:$i:1}${digits:$i:1}"; done
  printf '%s' "$out"
}

mkdir -p "$WORK/src" "$WORK/test"
# Must be reported: an ordinary value, whatever its setting is called, and
# wherever it is (a random value in a test is not a known fixture either).
printf 'const exampleApiKey = "%s";\n' "$(rnd)" > "$WORK/src/example-settings.ts"
printf 'FAKE_SERVICE_TOKEN="%s"\n' "$(rnd)" > "$WORK/src/fake-env.sh"
printf "const madeUpSecret = '%s';\n" "$(rnd)" > "$WORK/test/madeup.test.ts"
# The sample values the tests once wrote out, where they were allowed: the
# gate allows none, so CI must report them too. Built here, never written out.
WSKEY="$(printf 'the sample nonce' | base64)"
DISCORD_ID="123456789""012345678"
printf 'const req = `Sec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: %s\\r\\n`;\n' "$WSKEY" > "$WORK/test/ws.test.ts"
printf "store.bindMemberIdentity('a1', 'u2', 'discord', '%s');\n" "$DISCORD_ID" > "$WORK/test/members.test.ts"
WANT_FOUND="src/example-settings.ts src/fake-env.sh test/madeup.test.ts test/ws.test.ts test/members.test.ts"

( cd "$WORK" && "$BIN" dir . --config "$CONFIG" --redact --no-banner --exit-code 0 -l error -f csv -r "$WORK/report.csv" )
found="$(cut -d, -f3 "$WORK/report.csv" | tail -n +2 | sed 's#^\./##' | sort -u)"
bad=0
for f in $WANT_FOUND; do grep -qx "$f" <<<"$found" || { echo "✗ not reported: $f"; bad=1; }; done
[ "$bad" = 0 ] && echo "✓ gitleaks config: ordinary values reported whatever they are called, and sample values wherever they are"
exit "$bad"
