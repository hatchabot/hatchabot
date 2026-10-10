#!/usr/bin/env bash
# May this commit be released as this version? The release workflow's first
# job runs it (.github/workflows/release.yml), and scripts/release.sh runs it
# before starting the workflow, so a refusal comes before anything is built
# (release by workflow, issue #37, 2026-10-10):
#
#   scripts/release-check.sh <X.Y.Z> [--commit <sha>] [--repo owner/name] [--notes <file>] [--wait-ci]
#
# It refuses unless:
#   - the commit is origin/main's head, or (with --commit) a commit on main;
#   - package.json at that commit says X.Y.Z, and CHANGELOG.md there has a
#     `## [X.Y.Z]` section with something in it (--notes writes the section);
#   - the CI run for the push to main of that commit (ci.yml, event push,
#     branch main) concluded success — a pull request's run does not count;
#     one still running is waited for with --wait-ci, refused without;
#   - the tag vX.Y.Z does not exist on origin.
# On success it prints, for $GITHUB_OUTPUT: version=, tag=, commit=,
# newest= (true when X.Y.Z is above every release tag and not a
# pre-release: the `latest` image alias follows it) and prerelease=.
# Messages go to stderr. Exit 0 ok, 1 refused, 2 usage.
set -euo pipefail
die() { echo "✗ $1" >&2; exit "${2:-1}"; }
say() { echo "$*" >&2; }

VERSION=""; COMMIT=""; REPO=""; NOTES=""; WAIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --wait-ci) WAIT=1; shift ;;
    -*) die "unknown option $1" 2 ;;
    *) [ -z "$VERSION" ] || die "one version only" 2; VERSION="${1#v}"; shift ;;
  esac
done
[ -n "$VERSION" ] || die "usage: release-check.sh <X.Y.Z> [--commit <sha>] [--repo owner/name] [--notes <file>] [--wait-ci]" 2
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "\"$VERSION\" is not a version (X.Y.Z, or X.Y.Z-rc.N)." 2
TAG="v$VERSION"
if [ -z "$REPO" ]; then
  REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  echo "$REPO" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || REPO="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
fi

git fetch -q --no-tags origin +refs/heads/main:refs/remotes/origin/main || die "Could not fetch main from origin."
MAIN="$(git rev-parse refs/remotes/origin/main)"
if [ -z "$COMMIT" ]; then
  SHA="$MAIN"
else
  echo "$COMMIT" | grep -qE '^[0-9a-f]{7,40}$' || die "--commit must be a commit sha."
  SHA="$(git rev-parse -q --verify "$COMMIT^{commit}" 2>/dev/null)" || die "No commit $COMMIT here (is it on main?)."
  git merge-base --is-ancestor "$SHA" "$MAIN" || die "$COMMIT is not on main — a release is made only from a commit on main."
fi

HAS="$(git show "$SHA:package.json" 2>/dev/null | sed -nE 's/^  "version": "([^"]+)".*/\1/p' | sed -n 1p)"
[ "$HAS" = "$VERSION" ] || die "package.json at ${SHA:0:9} says ${HAS:-nothing}, not $VERSION — commit the version bump and land it first."
SECTION="$(git show "$SHA:CHANGELOG.md" 2>/dev/null | awk -v v="$VERSION" '
  index($0, "## [" v "]") == 1 { f = 1; next }
  f && /^## \[/ { exit }
  f { print }')"
git show "$SHA:CHANGELOG.md" 2>/dev/null | grep -qF "## [$VERSION]" || die "CHANGELOG.md at ${SHA:0:9} has no \"## [$VERSION]\" section."
[ -n "$(printf '%s' "$SECTION" | tr -d '[:space:]')" ] || die "The CHANGELOG section for $VERSION is empty."
if [ -n "$NOTES" ]; then printf '%s\n' "$SECTION" | sed -e '/./,$!d' > "$NOTES"; fi

[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || die "The tag $TAG already exists — a version is released once. Make a new patch version."

# The run for the push to main, as promote.sh reads it: a pull request's run
# on the same commit tested it merged onto whatever its base was then.
command -v gh >/dev/null 2>&1 || die "Can't check CI: the gh command is not installed."
ci() { gh run list --repo "$REPO" --workflow ci.yml --commit "$SHA" --event push --branch main --limit 1 --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"'; }
RUN="$(ci)" || die "Could not ask GitHub about CI for ${SHA:0:9}."
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

# Newest: above every release tag on origin ("~" sorts a pre-release below its release).
PRE=false; case "$VERSION" in *-*) PRE=true ;; esac
TOP="$(git ls-remote --tags origin 'refs/tags/v*' | sed -nE 's#.*refs/tags/v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$#\1#p' | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')"
NEWEST=false
if [ "$PRE" = false ]; then
  if [ -z "$TOP" ] || [ "$(printf '%s\n%s\n' "$TOP" "$VERSION" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')" = "$VERSION" ]; then NEWEST=true; fi
fi
printf 'version=%s\ntag=%s\ncommit=%s\nnewest=%s\nprerelease=%s\n' "$VERSION" "$TAG" "$SHA" "$NEWEST" "$PRE"
