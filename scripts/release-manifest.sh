#!/usr/bin/env bash
# What a release vouches for: its release-manifest.json (docs/install-bundle.md,
# "What a release vouches for"; docs/release-by-workflow-design.md part 3).
# The release workflow attaches it to every release from v2.159.0 on: each
# asset's size and sha256, and the runtime image's digest and OpenClaw version.
#
#   scripts/release-manifest.sh get vX.Y.Z              the checked manifest's path
#   scripts/release-manifest.sh asset vX.Y.Z FILE NAME  FILE is that release's asset NAME
#   scripts/release-manifest.sh image vX.Y.Z            "<repository>@<index digest> <openclaw version>"
#
# Exit codes: 0 yes; 10 the release has no manifest (made before manifests:
# callers keep their old check, marked legacy); 2 refused (a manifest that is
# unreadable or for another release, or one that does not vouch for this file
# or names no image); 3 could not fetch it (no network) — try again later.
#
# A checked manifest is kept in the data directory (release-manifests/<tag>.json)
# so a restart offline does not need GitHub. The app reads the same files
# (src/orchestrator/releaseManifest.ts).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

# ---- release manifest reader (the same text is in install.sh; test/releaseManifest.test.ts keeps them equal) ----
# Read with awk, not node or python: the installer has neither when it checks a
# bundle (the bundle's own Node is not run until the bundle is checked), and
# awk is in every base system (mawk, gawk, BusyBox, macOS).
# mf_fetch URL FILE: 0 fetched; 1 the release has none (a 404, or no such file
# on a file:// test bed); 2 could not fetch (no network, a server error).
mf_fetch() {
  local code rc=0
  code="$(curl -sSL --retry 3 --max-filesize 65536 -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" || rc=$?
  case "$rc:$code" in
    0:200|0:000) [ -s "$2" ] && return 0 ;;
    0:404|37:*) rm -f "$2"; return 1 ;;
  esac
  rm -f "$2"; return 2
}
# mf_paths FILE: the manifest as "path<TAB>value" lines (schema, assets.0.name,
# image.index, …); fails on anything that is not one well-formed JSON object.
mf_paths() {
  awk '
function bad() { exit 2 }
function ws() { while (p <= n && index(" \t\r\n", substr(s, p, 1)) > 0) p++ }
function str(   c, out) {
  p++; out = ""
  while (p <= n) {
    c = substr(s, p, 1)
    if (c == "\"") { p++; return out }
    if (c == "\t" || c == "\n" || c == "\r") bad()
    if (c == "\\") { p++; c = substr(s, p, 1); if (c == "" || index("\"\\/", c) == 0) bad() }
    out = out c; p++
  }
  bad()
}
function val(path,   c, k, i, start) {
  ws(); if (++depth > 8) bad()
  c = substr(s, p, 1)
  if (c == "{") {
    p++; ws()
    if (substr(s, p, 1) == "}") { p++; depth--; return }
    while (1) {
      ws(); if (substr(s, p, 1) != "\"") bad()
      k = str(); ws()
      if (substr(s, p, 1) != ":") bad()
      p++; val(path == "" ? k : path "." k); ws()
      c = substr(s, p, 1); p++
      if (c == "}") { depth--; return }
      if (c != ",") bad()
    }
  }
  if (c == "[") {
    p++; ws(); i = 0
    if (substr(s, p, 1) == "]") { p++; depth--; return }
    while (1) {
      val(path "." i); i++; ws()
      c = substr(s, p, 1); p++
      if (c == "]") { depth--; return }
      if (c != ",") bad()
    }
  }
  if (c == "\"") { k = str(); print path "\t" k; depth--; return }
  start = p
  while (p <= n && index("0123456789+-.eE", substr(s, p, 1)) > 0) p++
  if (p == start) {
    if (substr(s, p, 4) == "true" || substr(s, p, 4) == "null") p += 4
    else if (substr(s, p, 5) == "false") p += 5
    else bad()
  }
  print path "\t" substr(s, start, p - start); depth--
}
{ s = s $0 "\n" }
END { n = length(s); p = 1; depth = 0; ws(); if (substr(s, p, 1) != "{") bad(); val(""); ws(); if (p <= n) bad() }
' "$1"
}
# mf_value PATHS KEY: the one value at KEY (missing, or there twice, fails).
mf_value() { printf '%s\n' "$1" | awk -v k="$2" 'BEGIN { FS = "\t" } $1 == k { v = $2; c++ } END { if (c != 1) exit 1; print v }'; }
# mf_valid PATHS TAG: a manifest this reader knows (schema 1), for release TAG.
mf_valid() { [ "$(mf_value "$1" schema 2>/dev/null)" = 1 ] && [ "$(mf_value "$1" tag 2>/dev/null)" = "$2" ]; }
# mf_asset PATHS NAME: "size sha256" of the asset called NAME (listed exactly once).
mf_asset() {
  printf '%s\n' "$1" | awk -v want="$2" 'BEGIN { FS = "\t" }
    { v[$1] = $2; seen[$1]++ }
    $1 ~ /^assets\.[0-9]+\.name$/ && $2 == want { at = substr($1, 1, length($1) - 4); c++ }
    END { if (c != 1 || seen[at "size"] != 1 || seen[at "sha256"] != 1) exit 1; print v[at "size"] " " v[at "sha256"] }'
}
mf_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# mf_matches PATHS NAME FILE: FILE is the asset NAME, by its size and sha256.
mf_matches() {
  local want size sum
  want="$(mf_asset "$1" "$2")" || return 1
  size="${want%% *}"; sum="${want#* }"
  printf '%s\n' "$size" | grep -Eq '^[0-9]+$' && printf '%s\n' "$sum" | grep -Eq '^[0-9a-f]{64}$' || return 1
  [ "$(wc -c < "$3" | tr -d ' ')" = "$size" ] && [ "$(mf_sha256 "$3")" = "$sum" ]
}
# ---- end of the release manifest reader ----

BASE="${HATCHABOT_BUNDLE_BASE:-https://github.com/${HATCHABOT_SLUG:-hatchabot/hatchabot}/releases/download}"
# The data directory, read the way the server reads it: HATCHABOT_DB, from the
# environment or .env, relative to the install; data/ when unset.
data_dir() {
  local db="${HATCHABOT_DB:-}"
  [ -n "$db" ] || db="$(sed -n 's/^HATCHABOT_DB=//p' "$HERE/.env" 2>/dev/null \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//' | sed -n '$p' || true)"
  db="${db:-data/hatchabot.sqlite}"
  case "$db" in /*) ;; *) db="$HERE/$db" ;; esac
  dirname "$db"
}

TMPF=""
trap '[ -z "$TMPF" ] || rm -f "$TMPF"' EXIT
# load TAG: PATHS and FILE for that release's checked manifest, or exit 10/2/3.
load() {
  local tag="$1" cache rc=0
  printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || { echo "Not a release: $tag" >&2; exit 2; }
  cache="$(data_dir)/release-manifests"; FILE="$cache/$tag.json"
  if [ -f "$FILE" ] && PATHS="$(mf_paths "$FILE")" && mf_valid "$PATHS" "$tag"; then return 0; fi
  mkdir -p "$cache" 2>/dev/null || true
  TMPF="$(mktemp "$cache/.fetch-XXXXXX" 2>/dev/null || mktemp)"
  mf_fetch "$BASE/$tag/release-manifest.json" "$TMPF" || rc=$?
  case "$rc" in
    0) ;;
    1) echo "Release $tag has no release-manifest.json (it was made before release manifests)." >&2; exit 10 ;;
    *) echo "Could not fetch the release manifest of $tag (no network?) — try again later." >&2; exit 3 ;;
  esac
  # Present but not a manifest for this release: refused, never skipped.
  if ! PATHS="$(mf_paths "$TMPF")" || ! mf_valid "$PATHS" "$tag"; then
    echo "The release manifest of $tag is not a readable manifest for $tag — refusing it." >&2; exit 2
  fi
  if mv "$TMPF" "$FILE" 2>/dev/null; then TMPF=""; else FILE="$TMPF"; fi
}

case "${1:-}" in
  get) load "${2:?usage: release-manifest.sh get vX.Y.Z}"; echo "$FILE" ;;
  asset)
    load "${2:?usage: release-manifest.sh asset vX.Y.Z FILE NAME}"
    [ -f "${3:-}" ] && [ -n "${4:-}" ] || { echo "usage: release-manifest.sh asset vX.Y.Z FILE NAME" >&2; exit 2; }
    mf_matches "$PATHS" "$4" "$3" || { echo "$4 does not match the release manifest of $2 (its size or sha256, or it is not listed) — refusing it." >&2; exit 2; } ;;
  image)
    load "${2:?usage: release-manifest.sh image vX.Y.Z}"
    REPO="$(mf_value "$PATHS" image.repository 2>/dev/null || true)"
    INDEX="$(mf_value "$PATHS" image.index 2>/dev/null || true)"
    OPENCLAW="$(mf_value "$PATHS" image.openclaw 2>/dev/null || true)"
    printf '%s\n' "$REPO" | grep -Eq '^[a-z0-9][a-z0-9._:/-]*$' && printf '%s\n' "$INDEX" | grep -Eq '^sha256:[0-9a-f]{64}$' \
      && printf '%s\n' "$OPENCLAW" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z._-]*$' \
      || { echo "The release manifest of $2 names no usable runtime image — refusing it." >&2; exit 2; }
    echo "$REPO@$INDEX $OPENCLAW" ;;
  *) echo "usage: release-manifest.sh get|asset|image vX.Y.Z …" >&2; exit 2 ;;
esac
