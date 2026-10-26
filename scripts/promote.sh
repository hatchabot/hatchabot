#!/usr/bin/env bash
# Point a release channel at a tag — what new installs (and re-runs of the
# installer on that channel) get from now on.
#
#   ./scripts/promote.sh v2.31.0            # stable
#   ./scripts/promote.sh v2.32.0-beta.1 beta
#   HATCHABOT_PROMOTE_TRAILERS='Co-Authored-By: …' ./scripts/promote.sh v2.31.0
#   HATCHABOT_PROMOTE_BACK=1 ./scripts/promote.sh v2.30.0   # back, with no one to ask
#
# Tagging a release makes it `latest` and nothing more; `stable` only moves
# when you run this. That is what lets you release several times a day
# without a stranger's first install landing on whatever you tagged an hour
# ago. It lands channels.json on the dev repo's main (origin, through
# scripts/land.sh) and asks the publisher for the fast lane with a tag
# channels-YYYYMMDDTHHMMSSZ (UTC) on that commit: the publisher copies that
# one file to the public repo on its next run (gated, no wait), and the
# public repo's promote-images.yml then moves the runtime image's
# :stable/:beta to that release's image. No release tag, no rebuild.
#
# Only a published release can be promoted: the public repo (the remote
# `public`, read only) has its tag, and its GitHub release is published (not
# a draft) with release-manifest.json, which installs and promote-images.yml
# need. The fast lane refuses a channels.json naming any other tag.
set -euo pipefail
cd "$(dirname "$0")/.."
die() { echo "✗ $*" >&2; exit 1; }

TAG="${1:-}"; CH="${2:-stable}"
[ -n "$TAG" ] || die "Usage: ./scripts/promote.sh <tag> [stable|beta]"
case "$CH" in stable|beta) ;; *) die "Channel must be stable or beta (latest is always the newest tag)." ;; esac
git fetch --tags --force --quiet origin
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "No tag $TAG — tag and push the release first."
PUBLIC="${HATCHABOT_PUBLIC_REMOTE:-public}"
git remote get-url "$PUBLIC" >/dev/null 2>&1 \
  || die "No remote '$PUBLIC' for the public repo — add it, read only: git remote add --no-tags public https://github.com/hatchabot/hatchabot.git && git remote set-url --push public DISABLED"
PUB_TAG="$(git ls-remote --tags "$PUBLIC" "refs/tags/$TAG")" || die "Could not list the public repo's tags."
[ -n "$PUB_TAG" ] || die "$TAG is not published yet (the public repo has no such tag): the publisher publishes it after its wait — promote it then."
# A tag on the public repo is not a release yet: release.yml builds and
# publishes it after the tag arrives, and can fail or still be running. A
# channel naming a tag with no release sent every new install on it to a
# 404 (audit, 2026-10-20). Every release from v2.159.0 on has a manifest.
PUB_SLUG="$(git remote get-url "$PUBLIC" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
echo "$PUB_SLUG" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || PUB_SLUG="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
command -v gh >/dev/null 2>&1 || die "Can't check $TAG's release: the gh command is not installed."
REL="$(gh release view "$TAG" --repo "$PUB_SLUG" --json isDraft,assets -q '"\(.isDraft) \([.assets[].name] | index("release-manifest.json") != null)"' 2>/dev/null)" \
  || die "$TAG has no GitHub release on $PUB_SLUG yet (or GitHub did not answer): release.yml builds it after the tag arrives — promote once it is published (https://github.com/$PUB_SLUG/actions/workflows/release.yml)."
case "$REL" in
  "false true") ;;
  "true "*) die "$TAG's release on $PUB_SLUG is still a draft — promote once release.yml has published it." ;;
  "false false")
    V="${TAG#v}"; V="${V%%-*}"; MAJ="${V%%.*}"; V="${V#*.}"; MIN="${V%%.*}"
    if [ "$MAJ" -gt 2 ] || { [ "$MAJ" -eq 2 ] && [ "$MIN" -ge 159 ]; }; then
      die "$TAG's release on $PUB_SLUG has no release-manifest.json, which every release from v2.159.0 on has — its release workflow did not finish."
    fi ;;
  *) die "Could not read $TAG's release on $PUB_SLUG (gh answered: $REL)." ;;
esac
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "Promote from main."
[ -z "$(git status --porcelain channels.json)" ] || die "channels.json has uncommitted changes."
# What GitHub's main holds, and nothing else. The promote commit is pushed as
# `main`, so a local commit not yet pushed (work in progress) rode along with
# it; and the channel's current release is read from there, not from a local
# file that may be behind (review, 2026-10-09).
AHEAD="$(git rev-list --count origin/main..HEAD)"; BEHIND="$(git rev-list --count HEAD..origin/main)"
[ "$AHEAD" = 0 ] && [ "$BEHIND" = 0 ] \
  || die "Local main is not origin/main ($AHEAD commits ahead, $BEHIND behind) — push or pull first, so a promote publishes nothing but itself."
# A release that is not on main (a tag on a side branch) never passed main's CI.
git merge-base --is-ancestor "$TAG^{commit}" origin/main || die "$TAG is not on main — promote only releases tagged on main."

CURRENT="$(git show origin/main:channels.json | sed -nE "s/.*\"$CH\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p)"

# chan CHANNEL: the release the channels.json on stdin names for CHANNEL.
chan() { sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(v[^\"]+)\".*/\1/p" | sed -n 1p; }
# older A B: release A is below release B ("~" sorts a pre-release below its release).
older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sed 's/-/~/' | sort -V | sed -n 1p | sed 's/~/-/')" = "$1" ]; }

# A release tagged but not published yet goes out with its own tree, and
# with it its own channels.json: one tagged before this promote would put
# the channel back where it was an hour from now, and the image :stable
# with it (audit, 2026-10-20). Only tags above the newest published one
# are still to come (the publisher supersedes the older ones).
pending_gate() {
  if [ "${HATCHABOT_PROMOTE_IGNORE_PENDING:-}" = 1 ]; then echo "⚠ Releases waiting for the publisher not checked (HATCHABOT_PROMOTE_IGNORE_PENDING=1)."; return 0; fi
  local pubs top t says ours
  pubs="$(git ls-remote --tags "$PUBLIC" 'refs/tags/v*' | sed -nE 's#.*refs/tags/(v[^^]+)$#\1#p')" || die "Could not list the public repo's tags."
  top="$(printf '%s\n' "$pubs" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')"
  # Read whole first: a failure inside the for list would pass in silence.
  ours="$(git ls-remote --tags origin 'refs/tags/v*')" || die "Could not list origin's tags."
  # vX.Y.Z only: the publisher never publishes a pre-release tag, so one never comes to wait for.
  for t in $(printf '%s\n' "$ours" | sed -nE 's#.*refs/tags/(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p'); do
    printf '%s\n' "$pubs" | grep -qxF "$t" && continue
    [ -z "$top" ] || older "$top" "$t" || continue
    # Read from origin's tag, not a local one that may be missing or stale.
    git fetch -q --no-tags origin "+refs/tags/$t:refs/hatchabot-pending/$t" \
      || die "Could not fetch the tag $t from origin to read its channels.json."
    says="$(git show "refs/hatchabot-pending/$t:channels.json" 2>/dev/null | chan "$CH" || true)"
    git update-ref -d "refs/hatchabot-pending/$t" 2>/dev/null || true
    [ -z "$says" ] || [ "$says" = "$TAG" ] \
      || die "$t is tagged but not published yet, and its channels.json says $CH → $says: when the publisher publishes it, $CH would go back to $says. Promote once $t is published (HATCHABOT_PROMOTE_IGNORE_PENDING=1 goes on regardless). Nothing changed."
  done
}

# waiting_tag BLOB: the fast-lane tags still to come. The publisher takes
# every channels-* tag (lightweight ones too) in name order: one whose file
# the public main has already is done with no commit; one it publishes
# becomes an "Update channels" commit dated with the tag's own date
# (publish.py commit/tag_date); one its gate blocks is done and never
# published; at any other refusal it stops there for good. So a tag is
# found published by its date, and every tag dated up to the newest
# published one is done. A later one is still to come unless its file is the public
# main's now (nothing to change). Matching files to the history instead
# guessed wrong when a file came back (final audit, 2026-10-22). Of those
# still to come, WAITING_SAME names one asking for BLOB and WAITING_OTHER
# one asking for another file (or none: a tag with no channels.json stops
# the publisher). Also sets PUBC and PUBBLOBS.
waiting_tag() {
  local list pubdates cur tn td tb newest=""
  WAITING_SAME=""; WAITING_OTHER=""
  git fetch -q --no-tags "$PUBLIC" main || die "Could not fetch main from the public repo."
  PUBC="$(git rev-parse FETCH_HEAD)"
  # Every channels.json the public main has had.
  PUBBLOBS="$(git log -n 500 --format= --raw --no-abbrev "$PUBC" -- channels.json | awk '{ print $4 }')"
  cur="$(git rev-parse -q --verify "$PUBC:channels.json" 2>/dev/null || true)"
  pubdates="$(git log -n 2000 --format='%at %s' "$PUBC" | sed -n 's/^\([0-9][0-9]*\) Update channels$/\1/p')"
  # origin's tags, read whole into a namespace of their own (emptied first,
  # so a tag deleted on origin is gone here too).
  git for-each-ref --format='%(refname)' refs/hatchabot-fl/ | while read -r r; do git update-ref -d "$r"; done
  git fetch -q --no-tags origin '+refs/tags/channels-*:refs/hatchabot-fl/channels-*' \
    || die "Could not fetch origin's fast-lane tags."
  list="$(git for-each-ref --sort=refname --format='%(refname:strip=2) %(if)%(taggerdate)%(then)%(taggerdate:unix)%(else)%(*committerdate:unix)%(committerdate:unix)%(end)' refs/hatchabot-fl/)"
  # The newest fast-lane commit's date: a tag dated at or before it is done.
  # By date, not by the name of the tag it matched: a tag named by hand
  # sorts anywhere, and a deleted tag still has its commit.
  newest="$(printf '%s\n' "$pubdates" | sort -n | tail -1)"
  while read -r tn td; do
    [ -n "$tn" ] || continue
    [ -z "$newest" ] || [ "$td" -gt "$newest" ] || continue
    tb="$(git rev-parse -q --verify "refs/hatchabot-fl/$tn^{commit}:channels.json" 2>/dev/null || echo none)"
    [ "$tb" != "$cur" ] || continue
    if [ "$tb" = "$1" ]; then WAITING_SAME="$tn"; else WAITING_OTHER="$tn"; fi
  done <<EOF
$list
EOF
  git for-each-ref --format='%(refname)' refs/hatchabot-fl/ | while read -r r; do git update-ref -d "$r"; done
}
# waiting_refusal TAG: another file's fast-lane tag is still to come. A tag
# made now would be judged against that file, not the public one (its
# rollback line wrong, or "already there" when it is not), so this waits.
waiting_refusal() {
  if [ "${HATCHABOT_PROMOTE_IGNORE_WAITING:-}" = 1 ]; then
    echo "⚠ The fast-lane tag $1 is still waiting for the publisher; going on regardless (HATCHABOT_PROMOTE_IGNORE_WAITING=1)."; return 0
  fi
  die "The fast-lane tag $1 (another channels.json) is still waiting for the publisher: a promote now would be judged against that file, not the public one. Run scripts/promote.sh $TAG $CH again once $1 is published. If the publisher blocked it (its issue says \"fast lane blocked\"), delete it — git push origin :refs/tags/$1 — and run this again (HATCHABOT_PROMOTE_IGNORE_WAITING=1 goes on regardless). Nothing changed."
}

# The fast lane: a channels-<UTC time> tag on origin's main, whose
# channels.json names $TAG, asks the publisher to copy that one file to the
# public repo. Nothing to do when the public main already has that file, or
# a fast-lane tag names that commit and the public main has never had its
# file (the publisher has not got to it yet). Had it once and lost it since
# (a release tagged before the promote, audit 2026-10-20), it asks again.
fast_lane() {
  git fetch -q origin main || die "Could not fetch main from origin."
  local c pub name blob had=0 msg ch from to
  c="$(git rev-parse origin/main)"
  git show "$c:channels.json" | grep -q "\"$CH\": \"$TAG\"" \
    || die "origin/main's channels.json does not say $CH → $TAG."
  blob="$(git rev-parse "$c:channels.json")"
  waiting_tag "$blob"
  pub="$(git show "$PUBC:channels.json" 2>/dev/null || true)"
  if [ -n "$WAITING_SAME" ]; then
    echo "✓ $CH → $TAG is waiting for the publisher (the fast-lane tag $WAITING_SAME asks for this channels.json)."; return 0
  fi
  [ -z "$WAITING_OTHER" ] || waiting_refusal "$WAITING_OTHER"
  printf '%s\n' "$PUBBLOBS" | grep -qxF "$blob" && had=1
  if [ "$pub" = "$(git show "$c:channels.json")" ]; then
    echo "✓ $CH points at $TAG on the public repo."; return 0
  fi
  [ "$had" = 0 ] || echo "⚠ The public repo had this channels.json once and has lost it since (a release tagged before the promote?) — asking the publisher again."
  # The publisher's gate refuses a channel moved back (against the public
  # file) unless the tag's message states it: `rollback <channel> <from> → <to>`.
  msg="hatchabot channels: $CH → $TAG"
  for ch in stable beta; do
    from="$(printf '%s\n' "$pub" | chan "$ch")"; to="$(git show "$c:channels.json" | chan "$ch")"
    if [ -n "$from" ] && [ -n "$to" ] && older "$to" "$from"; then msg="$msg
rollback $ch $from → $to"; fi
  done
  name="channels-$(date -u +%Y%m%dT%H%M%SZ)"
  git tag -a "$name" "$c" -m "$msg"
  # One tag, by name — never `git push --tags`; the pre-push hooks check it.
  if ! git push -q origin "refs/tags/$name"; then
    git tag -d "$name" >/dev/null
    die "The push of the fast-lane tag $name was refused (above) — run scripts/promote.sh $TAG $CH again."
  fi
  echo "✓ $CH → $TAG asked of the publisher ($name): it copies channels.json to the public repo on its next run,"
  echo "  then the public repo's promote-images.yml moves the image :$CH. New installs and followers on $CH move then."
  echo "  Scheduled publisher runs come hours apart; to go sooner: gh workflow run publish.yml -R cksci/publisher"
}
pending_gate
if [ "$CURRENT" = "$TAG" ]; then echo "$CH already points at $TAG on main."; fast_lane; exit 0; fi
# Going backwards is allowed (a bad release gets rolled back this way) but it
# should never happen by accident.
# "~" sorts below everything in sort -V, so a prerelease ranks below its final release.
NEWER="$(printf '%s\n%s\n' "$CURRENT" "$TAG" | sed 's/-/~/' | sort -V | tail -1 | sed 's/~/-/')"
# The yes comes from a terminal, or a line on stdin; with no terminal and
# nothing on stdin the question used to end the script with no word (read
# failing under set -e), or wait for ever on a pipe nobody wrote to (HB-0071).
# HATCHABOT_PROMOTE_BACK=1 is the yes for a script.
if [ -n "$CURRENT" ] && [ "$NEWER" = "$CURRENT" ]; then
  ok=""
  if [ "${HATCHABOT_PROMOTE_BACK:-}" = 1 ]; then ok=y; echo "Moving $CH back from $CURRENT to $TAG (HATCHABOT_PROMOTE_BACK=1)."
  elif [ -t 0 ]; then read -r -p "$CH is at $CURRENT; move it BACK to $TAG? [y/N] " ok || ok=""
  else echo "$CH is at $CURRENT; move it BACK to $TAG? (a y on stdin within 30 s, or HATCHABOT_PROMOTE_BACK=1)" >&2; read -r -t 30 ok || ok=""
  fi
  [ "$ok" = "y" ] || die "Nothing changed: moving $CH back to $TAG needs a yes (in a terminal, or HATCHABOT_PROMOTE_BACK=1)."
fi

# CI must have passed on the commit the tag names. It failed for eight days
# unseen (2026-09-28 → 10-06: tests that passed here broke on GitHub's
# runner), and promote is where a release reaches strangers. Still running:
# wait for it. A rollback is not held to it — an older tag may predate a fix.
ci_gate() {
  if [ "${HATCHABOT_PROMOTE_IGNORE_CI:-}" = 1 ]; then echo "⚠ CI not checked (HATCHABOT_PROMOTE_IGNORE_CI=1)."; return 0; fi
  local how="HATCHABOT_PROMOTE_IGNORE_CI=1 promotes without the check"
  command -v gh >/dev/null 2>&1 || die "Can't check CI: the gh command is not installed ($how)."
  local slug sha runs id st end
  slug="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
  echo "$slug" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || slug="${HATCHABOT_DEV_SLUG:-cksci/hatchabot-dev}"
  sha="$(git rev-list -n 1 "$TAG")"
  # The dev repo's run for the push to main (origin): a pull request's run on
  # the same commit tests it merged into whatever its base was then, not as
  # main (review, 2026-10-09).
  ci_runs() { gh run list --repo "$1" --workflow ci.yml --commit "$sha" --event push --branch main --limit 1 --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"'; }
  runs="$(ci_runs "$slug")" || die "Could not ask GitHub about CI for $TAG ($how)."
  # A release from before the dev repo (v2.163.0 and older) was tested on
  # the public repo's main.
  if [ -z "$runs" ]; then
    slug="${HATCHABOT_SLUG:-hatchabot/hatchabot}"
    runs="$(ci_runs "$slug")" || die "Could not ask GitHub about CI for $TAG ($how)."
  fi
  [ -n "$runs" ] || die "No CI run for $TAG (${sha:0:9}) — was it pushed to main? ($how)"
  id="${runs%% *}"; st="${runs#* }"
  if [ "${st%% *}" != completed ]; then
    echo "CI for $TAG is still running — waiting for it…"
    # Polled through the same listing, as release-check.sh does, not `gh run
    # watch`: that reads the check-run annotations, which a fine-grained token
    # cannot (HTTP 403), so every run still going read as "CI failed" (audit #036).
    end=$(( $(date +%s) + ${HATCHABOT_CI_WAIT_SECS:-2700} ))
    while [ "${st%% *}" != completed ]; do
      [ "$(date +%s)" -lt "$end" ] || die "CI for $TAG is still running after $(( ${HATCHABOT_CI_WAIT_SECS:-2700} / 60 )) min: https://github.com/$slug/actions/runs/$id — promote once it has passed. Nothing changed."
      sleep "${HATCHABOT_DISPATCH_POLL:-20}"
      runs="$(ci_runs "$slug")" || die "Could not ask GitHub about CI for $TAG ($how)."
      [ -n "$runs" ] || die "CI run $id for $TAG is no longer listed: https://github.com/$slug/actions/runs/$id — nothing changed."
      id="${runs%% *}"; st="${runs#* }"
    done
  fi
  [ "$st" = "completed success" ] || die "CI failed on $TAG (${st#completed }): https://github.com/$slug/actions/runs/$id — nothing changed."
  echo "✓ CI passed on $TAG"
}
# The live tests (docs/live-tests.md): the unit suite and CI fake Docker,
# OpenClaw and the machines; these do not. Each is due when it has never
# passed, or a file in its area changed since the release it last passed on
# (docs/live-test-runs.md). Not for a rollback, as with CI.
live_gate() {
  if [ "${HATCHABOT_PROMOTE_IGNORE_LIVE:-}" = 1 ]; then echo "⚠ Live tests not checked (HATCHABOT_PROMOTE_IGNORE_LIVE=1)."; return 0; fi
  [ -f scripts/live.mjs ] || return 0
  command -v node >/dev/null 2>&1 || die "Can't check the live tests: node is not on PATH (HATCHABOT_PROMOTE_IGNORE_LIVE=1 promotes without the check)."
  node scripts/live.mjs gate "$TAG" \
    || die "Live tests are due for $TAG — run them (node scripts/live.mjs run <name>), commit docs/live-test-runs.md, then promote. HATCHABOT_PROMOTE_IGNORE_LIVE=1 promotes without them. Nothing changed."
  echo "✓ No live test is due for $TAG"
}
if [ -z "$CURRENT" ] || [ "$NEWER" != "$CURRENT" ]; then ci_gate; live_gate; fi

# The promote commit holds channels.json and nothing else. It used to `git
# add channels.json` and commit the whole index, so whatever the caller had
# staged went to main with it (audit issue #43, 2026-10-09). Now it commits
# with --only (git's own temporary index: HEAD plus channels.json), checks the
# commit changes exactly channels.json before pushing, and on any failure puts
# HEAD, the caller's index and channels.json back exactly as they were. Other
# staged or unstaged work is never touched.
START="$(git rev-parse HEAD)"
INDEX="$(git rev-parse --git-path index)"
SAVED="$(mktemp -d)"; trap 'rm -rf "$SAVED"' EXIT
cp -p channels.json "$SAVED/channels.json"
[ ! -f "$INDEX" ] || cp -p "$INDEX" "$SAVED/index"
undo() {
  git update-ref -m "promote: taken back" refs/heads/main "$START"
  if [ -f "$SAVED/index" ]; then cp -p "$SAVED/index" "$INDEX"; else rm -f "$INDEX"; fi
  cp -p "$SAVED/channels.json" channels.json
}
# Another file's fast-lane tag still to come: refuse before anything lands,
# not after the promote is on main with no tag asking for it. Asked before
# channels.json is edited, so a failed read (it dies) leaves it as it was.
waiting_tag "$(sed -E "s/(\"$CH\"[[:space:]]*:[[:space:]]*\")v[^\"]*(\")/\1$TAG\2/" channels.json | git hash-object --stdin)"
[ -z "$WAITING_OTHER" ] || waiting_refusal "$WAITING_OTHER"
sed -i.bak -E "s/(\"$CH\"[[:space:]]*:[[:space:]]*\")v[^\"]*(\")/\1$TAG\2/" channels.json && rm -f channels.json.bak
grep -q "\"$CH\": \"$TAG\"" channels.json || { undo; die "Could not update channels.json."; }
# Trailers only when the caller passes them (HATCHABOT_PROMOTE_TRAILERS, one
# per line): a fixed Co-Authored-By and session URL stamped every promote
# with a session that never made it (review, 2026-09-29).
MSG="Promote $TAG to $CH"
[ -z "${HATCHABOT_PROMOTE_TRAILERS:-}" ] || MSG="$MSG

$HATCHABOT_PROMOTE_TRAILERS"
git commit -q --only -m "$MSG" -- channels.json || { undo; die "Could not commit channels.json — nothing changed."; }
CHANGED="$(git diff --name-only "$START" HEAD)"
[ "$CHANGED" = channels.json ] \
  || { undo; die "The promote commit would change more than channels.json ($(echo "$CHANGED" | tr '\n' ' ')) — nothing pushed, nothing changed."; }
# A refused push (main moved on meanwhile) used to leave the promote commit
# here, and a re-run then said "already points at" with GitHub unchanged
# (review, 2026-10-09). Take it back off, as if it had not been made.
# main takes changes only through a pull request with passing checks
# (scripts/land.sh); it opens one for this commit and waits for it to merge.
LANDED=0
"$(dirname "$0")/land.sh" --footer "Promotion by scripts/promote.sh: changes channels.json only." || LANDED=$?
# 3: land.sh stopped waiting, but the pull request is still open and merges
# later (by itself with auto-merge). That is not "nothing changed": once it
# merges, only the fast-lane tag is missing, and a re-run makes it (audit,
# 2026-10-20). Local main goes back to origin's, so the pull brings it in.
if [ "$LANDED" = 3 ]; then
  undo
  echo "✗ The promote's pull request is still open (above): once it has merged, git pull --rebase and run scripts/promote.sh $TAG $CH again — that asks the publisher for the fast lane. Until then the public repo is unchanged." >&2
  exit 3
elif [ "$LANDED" != 0 ]; then
  undo
  die "The promote did not land — nothing changed here. See the message above; run it again once it is fixed."
fi
echo "✓ $CH → $TAG on the dev repo's main (was ${CURRENT:-unset})."
fast_lane
