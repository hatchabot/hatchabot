#!/usr/bin/env bash
# Does .gitleaks.toml still catch what it should? Its allowlist used to be a
# word list matched against the whole assignment, so a setting whose NAME
# said "example" or "fake" hid a real-looking value beside it (audit issue
# #42, 2026-10-09). This scans a throwaway folder of invented files and
# checks each one is reported, or not, as it should be:
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
# No vowels, so a random value never spells one of the generic rule's stopwords.
rnd() { LC_ALL=C tr -dc 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz2346789' </dev/urandom | head -c 32 || true; }

mkdir -p "$WORK/src" "$WORK/test"
# Must be reported: an ordinary value, whatever its setting is called, and
# wherever it is (a random value in a test is not a known fixture either).
printf 'const exampleApiKey = "%s";\n' "$(rnd)" > "$WORK/src/example-settings.ts"
printf 'FAKE_SERVICE_TOKEN="%s"\n' "$(rnd)" > "$WORK/src/fake-env.sh"
printf "const madeUpSecret = '%s';\n" "$(rnd)" > "$WORK/test/madeup.test.ts"
# A known fixture outside the files it is allowed in.
printf 'headers["Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="];\n' > "$WORK/src/ws-sample.ts"
# Must NOT be reported: the known fixtures where they live.
printf 'const req = `Sec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n`;\n' > "$WORK/test/ws.test.ts"
printf "store.bindMemberIdentity('a1', 'u2', 'discord', '123456789012345678');\n" > "$WORK/test/members.test.ts"
WANT_FOUND="src/example-settings.ts src/fake-env.sh test/madeup.test.ts src/ws-sample.ts"
WANT_QUIET="test/ws.test.ts test/members.test.ts"

( cd "$WORK" && "$BIN" dir . --config "$CONFIG" --redact --no-banner --exit-code 0 -l error -f csv -r "$WORK/report.csv" )
found="$(cut -d, -f3 "$WORK/report.csv" | tail -n +2 | sed 's#^\./##' | sort -u)"
bad=0
for f in $WANT_FOUND; do grep -qx "$f" <<<"$found" || { echo "✗ not reported: $f"; bad=1; }; done
for f in $WANT_QUIET; do ! grep -qx "$f" <<<"$found" || { echo "✗ reported, but it is a known fixture: $f"; bad=1; }; done
[ "$bad" = 0 ] && echo "✓ gitleaks config: ordinary values reported whatever they are called; known fixtures quiet only where they live"
exit "$bad"
