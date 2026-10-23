#!/usr/bin/env bash
# May this commit be released as this version? scripts/release.sh runs it
# in the private dev repo before tagging, and the public repo's release
# workflow runs it (--tagged) on the tag the publisher pushed
# (.github/workflows/release.yml; docs/releasing.md):
#
#   scripts/release-check.sh <X.Y.Z> [--commit <sha>] [--repo owner/name] [--notes <file>] [--wait-ci] [--public <remote>]
#   scripts/release-check.sh <X.Y.Z> --tagged [--repo owner/name] [--notes <file>]
#
# Before tagging, it refuses unless:
#   - the commit is origin/main's head, or (with --commit) a commit on main;
#   - package.json at that commit says X.Y.Z, and CHANGELOG.md there has a
#     `## [X.Y.Z]` section with something in it (--notes writes the section);
#   - the CI run for the push to main of that commit (ci.yml, event push,
#     branch main) concluded success — a pull request's run does not count;
#     one still running is waited for with --wait-ci, refused without;
#   - the tag vX.Y.Z does not exist on origin, nor (with --public) on that
#     remote: the public repo, where a tag name is used once for good;
#   - (with --public) channels.json at that commit names no channel an
#     older release than the public repo's main or origin's main does: the
#     publisher publishes the tag's whole tree, so it would move the channel
#     (and the image :stable) back.
# With --tagged (the public repo's release workflow), the tag vX.Y.Z must
# exist on origin and name a commit on main, and that commit is the one
# checked; CI is not asked (the dev repo's CI passed before it was tagged,
# and the publisher's gate checked the tree).
# On success it prints, for $GITHUB_OUTPUT: version=, tag=, commit=,
# newest= (true when X.Y.Z is above every release tag and not a
# pre-release: the `latest` image alias follows it) and prerelease=.
# Messages go to stderr. Exit 0 ok, 1 refused, 2 usage.
set -euo pipefail
die() { echo "✗ $1" >&2; exit "${2:-1}"; }
say() { echo "$*" >&2; }

VERSION=""; COMMIT=""; REPO=""; NOTES=""; WAIT=0; TAGGED=0; PUBLIC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --tagged) TAGGED=1; shift ;;
    --public) PUBLIC="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --wait-ci) WAIT=1; shift ;;
    -*) die "unknown option $1" 2 ;;
    *) [ -z "$VERSION" ] || die "one version only" 2; VERSION="${1#v}"; shift ;;
  esac
done
[ -n "$VERSION" ] || die "usage: release-check.sh <X.Y.Z> [--commit <sha>] [--repo owner/name] [--notes <file>] [--wait-ci] [--public <remote>] | <X.Y.Z> --tagged" 2
[ "$TAGGED" = 0 ] || [ -z "$COMMIT$PUBLIC" ] || die "--tagged checks the tag's own commit: no --commit or --public with it" 2
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "\"$VERSION\" is not a version (X.Y.Z, or X.Y.Z-rc.N)." 2
TAG="v$VERSION"
if [ -z "$REPO" ]; then
  REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  echo "$REPO" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || REPO="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
fi

git fetch -q --no-tags origin +refs/heads/main:refs/remotes/origin/main || die "Could not fetch main from origin."
MAIN="$(git rev-parse refs/remotes/origin/main)"
if [ "$TAGGED" = 1 ]; then
  git fetch -q --no-tags origin "+refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || die "The tag $TAG is not on origin."
  SHA="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")" || die "The tag $TAG names no commit."
  git merge-base --is-ancestor "$SHA" "$MAIN" || die "The tag $TAG names ${SHA:0:9}, which is not on main."
elif [ -z "$COMMIT" ]; then
  SHA="$MAIN"
else
  echo "$COMMIT" | grep -qE '^[0-9a-f]{7,40}$' || die "--commit must be a commit sha."
  SHA="$(git rev-parse -q --verify "$COMMIT^{commit}" 2>/dev/null)" || die "No commit $COMMIT here (is it on main?)."
  git merge-base --is-ancestor "$SHA" "$MAIN" || die "$COMMIT is not on main — a release is made only from a commit on main."
fi

# Each file read whole into a temp file first: a reader that stops early
# (awk's exit, grep -q, sed -n 1p) left git show writing into a closed pipe,
# and with pipefail its SIGPIPE ended this script without a word on a real
# CHANGELOG, too big for the pipe buffer (the first dry run, 2026-10-10).
AT="$(mktemp -d)"; trap 'rm -rf "$AT"' EXIT
git show "$SHA:package.json" > "$AT/package.json" 2>/dev/null || die "No package.json at ${SHA:0:9}."
git show "$SHA:CHANGELOG.md" > "$AT/CHANGELOG.md" 2>/dev/null || die "No CHANGELOG.md at ${SHA:0:9}."
HAS="$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' "$AT/package.json" | sed -n 1p)"
[ "$HAS" = "$VERSION" ] || die "package.json at ${SHA:0:9} says ${HAS:-nothing}, not $VERSION — commit the version bump and land it first."
SECTION="$(awk -v v="$VERSION" '
  index($0, "## [" v "]") == 1 { f = 1; next }
  f && /^## \[/ { exit }
  f { print }' "$AT/CHANGELOG.md")"
grep -qF "## [$VERSION]" "$AT/CHANGELOG.md" || die "CHANGELOG.md at ${SHA:0:9} has no \"## [$VERSION]\" section."
[ -n "$(printf '%s' "$SECTION" | tr -d '[:space:]')" ] || die "The CHANGELOG section for $VERSION is empty."
if [ -n "$NOTES" ]; then printf '%s\n' "$SECTION" | sed -e '/./,$!d' > "$NOTES"; fi

if [ "$TAGGED" = 1 ]; then
  say "✓ $TAG: ${SHA:0:9} is on main, package.json and CHANGELOG say $VERSION"
else
  [ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || die "The tag $TAG already exists — a version is released once. Make a new patch version."
  if [ -n "$PUBLIC" ]; then
    P="$(git ls-remote --tags "$PUBLIC" "refs/tags/$TAG")" || die "Could not read the public repo's tags ($PUBLIC)."
    [ -z "$P" ] || die "The tag $TAG already exists on the public repo — a version is released once. Make a new patch version."
    # The release commit is the tag's whole tree, channels.json and all: a
    # commit from before a promote put the channel back an hour later
    # (audit, 2026-10-20). Against origin's main too: a promote landed
    # there may not have reached the public repo yet.
    git fetch -q --no-tags "$PUBLIC" +refs/heads/main:refs/hatchabot-check/public-main 2>/dev/null \
      || die "Could not fetch main from the public repo ($PUBLIC)."
    if git show "$SHA:channels.json" > "$AT/channels.json" 2>/dev/null; then
      chan() { sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"v([^\"]+)\".*/\1/p" "$2" | sed -n 1p; }
      for REF in refs/hatchabot-check/public-main "$MAIN"; do
        git show "$REF:channels.json" > "$AT/there.json" 2>/dev/null || continue
        WHERE="origin's main"; [ "$REF" = "$MAIN" ] || WHERE="the public repo's main"
        for CH in stable beta; do
          A="$(chan "$CH" "$AT/channels.json")"; B="$(chan "$CH" "$AT/there.json")"
          [ -n "$A" ] && [ -n "$B" ] && [ "$A" != "$B" ] || continue
          [ "$(printf '%s\n%s\n' "$A" "$B" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')" != "$A" ] || continue
          # The commit has the promote (a rollback, as origin's main has it):
          # only the publisher's fast lane has not carried it yet.
          if [ "$REF" != "$MAIN" ] && git show "$MAIN:channels.json" 2>/dev/null | cmp -s - "$AT/channels.json"; then
            die "channels.json at ${SHA:0:9} says $CH → v$A, as origin's main does, but the public repo's main still says v$B: that promote is waiting for the publisher's fast lane, and this release would get there first. Release once the public repo says v$A (to go sooner: gh workflow run publish.yml -R cksci/publisher)."
          fi
          die "channels.json at ${SHA:0:9} says $CH → v$A, but $WHERE says v$B: publishing it would move $CH back. Release a commit that has the promote in it."
        done
      done
    fi
    git update-ref -d refs/hatchabot-check/public-main 2>/dev/null || true
  fi

  # The run for the push to main, as promote.sh reads it: a pull request's run
  # on the same commit tested it merged onto whatever its base was then.
  command -v gh >/dev/null 2>&1 || die "Can't check CI: the gh command is not installed."
  ci() { gh run list --repo "$REPO" --workflow ci.yml --commit "$SHA" --event push --branch main --limit 1 --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"'; }
  RUN="$(ci)" || die "Could not ask GitHub about CI for ${SHA:0:9}."
  # Right after a pull request merges, GitHub takes a few seconds to list the
  # push's run (the first v2.159.1 release stopped here, 2026-10-10): with
  # --wait-ci, give it up to HATCHABOT_CI_APPEAR_SECS (180) to appear.
  if [ -z "$RUN" ] && [ "$WAIT" = 1 ]; then
    say "No CI run listed yet for ${SHA:0:9} — waiting for it to appear…"
    APPEAR_END=$(( $(date +%s) + ${HATCHABOT_CI_APPEAR_SECS:-180} ))
    while [ -z "$RUN" ] && [ "$(date +%s)" -lt "$APPEAR_END" ]; do
      sleep "${HATCHABOT_DISPATCH_POLL:-10}"
      RUN="$(ci)" || die "Could not ask GitHub about CI for ${SHA:0:9}."
    done
  fi
  [ -n "$RUN" ] || die "No CI run for the push to main of ${SHA:0:9} — has it landed on main?"
  ID="${RUN%% *}"; ST="${RUN#* }"
  if [ "${ST%% *}" != completed ]; then
    [ "$WAIT" = 1 ] || die "CI for ${SHA:0:9} is still running: https://github.com/$REPO/actions/runs/$ID — release once it has passed."
    say "CI for ${SHA:0:9} is still running — waiting for it…"
    gh run watch "$ID" --repo "$REPO" --exit-status >/dev/null 2>&1 || die "CI failed on ${SHA:0:9}: https://github.com/$REPO/actions/runs/$ID"
  elif [ "$ST" != "completed success" ]; then
    die "CI failed on ${SHA:0:9} (${ST#completed }): https://github.com/$REPO/actions/runs/$ID"
  fi
  say "✓ $TAG: ${SHA:0:9} is on main, package.json and CHANGELOG say $VERSION, CI passed, the tag is free"
fi

# Newest: above every release tag on origin ("~" sorts a pre-release below its release).
PRE=false; case "$VERSION" in *-*) PRE=true ;; esac
TOP="$(git ls-remote --tags origin 'refs/tags/v*' | sed -nE 's#.*refs/tags/v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$#\1#p' | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')"
NEWEST=false
if [ "$PRE" = false ]; then
  if [ -z "$TOP" ] || [ "$(printf '%s\n%s\n' "$TOP" "$VERSION" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')" = "$VERSION" ]; then NEWEST=true; fi
fi
printf 'version=%s\ntag=%s\ncommit=%s\nnewest=%s\nprerelease=%s\n' "$VERSION" "$TAG" "$SHA" "$NEWEST" "$PRE"
