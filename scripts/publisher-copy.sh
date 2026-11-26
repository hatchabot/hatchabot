# Is the publisher's copy of publish.toml known to match the commit about to
# be tagged? Sourced by scripts/release.sh (a release tag) and
# scripts/promote.sh (a fast-lane tag), never run on its own.
#
# The publisher keeps its own copy of the project's publish.toml
# (projects/<name>.toml in cksci/publisher), and its gate holds every tag to
# it: the tagged commit's publish.toml must equal that copy, compared as
# parsed TOML, or the tag stays "incomplete" on every run ("the candidate's
# publish.toml differs from the publisher's copy (<keys>)"). A change landed
# in the dev repo alone stalled v2.191.0 so until the owner changed the copy,
# and the exclusion of backlog.md before it (HB-1492). Neither this machine
# nor the dev repo's token can read the copy, so the commit's publish.toml
# is held to the newest release tag's on origin, the one the copy was last
# made to match. Byte for byte (git's blob ids), where the gate compares
# them parsed: two equal blobs are surely equal files, so a pass is never
# wrong, and a change to a comment or to spacing alone, which only stops it
# needlessly, is gone past with the caller's flag. A change made on the
# publisher's side alone is not seen here (docs/releasing.md, "A change to
# publish.toml").

# publisher_copy_check REV WHAT GO_ON PREFLIGHT_ARGS [NOTE]: returns when
# publish.toml at REV is the newest vX.Y.Z tag's on origin, or when
# PUBLISHER_COPY_MATCHES=1 (the caller's flag: the owner has changed the
# copy to match). On that pass it warns when the newest tag is not
# published yet and its publish.toml is not the newest published release's:
# a flag given before the copy was changed would hide the mismatch from
# every later release. Otherwise it says what the copy must be set to, and
# which releases and fast-lane tags not yet published a changed copy would
# strand (publish kit backlog B-010), and exits 4. No earlier release tag (a
# first release) stops the same way: nothing shows the copy matches. No
# publish.toml at REV, or origin's tags unreadable: exit 1. WHAT names the
# tag in the words ("v2.192.0", "the fast-lane tag"), GO_ON is the command
# that goes on once the copy matches, PREFLIGHT_ARGS what `kit preflight
# <name>` is given to compare them, and NOTE (if any) is said after the
# first line of a stop. It reads origin's tags and $PUBLIC's, and changes
# nothing but refs of its own (refs/hatchabot-copy/), removed again.
PUBLISHER_COPY_SEEN=""   # the publish.toml already passed this run (a blob id)
publisher_copy_clear() {
  git for-each-ref --format='%(refname)' refs/hatchabot-copy/ | while read -r r; do git update-ref -d "$r" || true; done
}
publisher_copy_check() {
  local rev="$1" what="$2" go_on="$3" preflight_args="$4" note="${5:-}" tags names last was="" now name pubs="" pubs_ok=0 top="" t td pending="" fl="" newest cur
  now="$(git rev-parse -q --verify "$rev:publish.toml" 2>/dev/null)" \
    || { echo "✗ No publish.toml at ${rev:0:9}: the publisher's gate holds no tag without one (\"the candidate has no publish.toml\"). Put it back, land it and run this again. Nothing was tagged." >&2; exit 1; }
  [ "$now" != "${PUBLISHER_COPY_SEEN:-}" ] || return 0
  publisher_copy_clear
  tags="$(git ls-remote --tags origin 'refs/tags/v*')" \
    || { echo "✗ Could not list origin's tags, to compare publish.toml with the last release's. Nothing was tagged." >&2; exit 1; }
  names="$(sed -nE 's#.*refs/tags/(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' <<<"$tags")"
  last="$(sort -V <<<"$names" | tail -1)"
  if [ -n "$last" ]; then
    git fetch -q --no-tags origin "+refs/tags/$last:refs/hatchabot-copy/last" \
      || { echo "✗ Could not fetch $last from origin to read its publish.toml. Nothing was tagged." >&2; exit 1; }
    was="$(git rev-parse -q --verify "refs/hatchabot-copy/last^{commit}:publish.toml" 2>/dev/null || true)"
  fi
  # The releases the public repo has (its newest, top): read, not required.
  if pubs="$(git ls-remote --tags "${PUBLIC:-public}" 'refs/tags/v*' 2>/dev/null)"; then
    pubs_ok=1
    pubs="$(sed -nE 's#.*refs/tags/(v[0-9]+\.[0-9]+\.[0-9]+)$#\1#p' <<<"$pubs")"
    top="$(sort -V <<<"$pubs" | tail -1)"
  fi
  if [ "$now" = "$was" ] || [ "${PUBLISHER_COPY_MATCHES:-0}" = 1 ]; then
    if [ "$now" != "$was" ]; then
      echo "⚠ publish.toml at ${rev:0:9} is not ${last:-an earlier release tag}'s; going on, as the publisher's copy was changed to match it."
    elif [ "$pubs_ok" = 1 ] && [ -n "$top" ] && ! grep -qxF -- "$last" <<<"$pubs" \
      && git fetch -q --no-tags origin "+refs/tags/$top:refs/hatchabot-copy/published" 2>/dev/null \
      && [ "$(git rev-parse -q --verify "refs/hatchabot-copy/published^{commit}:publish.toml" 2>/dev/null || true)" != "$now" ]; then
      # The newest tag is the baseline, published or not: one tagged past
      # this stop before the copy was changed would hide the mismatch here.
      echo "⚠ publish.toml at ${rev:0:9} is $last's, but $last is not published yet and its publish.toml is not $top's (the newest published release's). Unless the publisher's copy was changed to match it, $last is still waiting at the publisher's gate, and this tag will wait with it: check the publisher's issue for $last (\"the gate could not finish\")."
    fi
    PUBLISHER_COPY_SEEN="$now"
    publisher_copy_clear
    return 0
  fi
  name="$(git show "$rev:publish.toml" | sed -nE 's/^name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | sed -n 1p)"
  name="${name:-hatchabot}"
  # Tagged on origin, not on the public repo, and above its newest: still to
  # be published, each to be gated again against the copy as it is then.
  if [ "$pubs_ok" = 1 ]; then
    for t in $names; do
      grep -qxF -- "$t" <<<"$pubs" && continue
      [ -z "$top" ] || [ "$(printf '%s\n%s\n' "$top" "$t" | sort -V | tail -1)" = "$t" ] || continue
      pending="$pending $t"
    done
  else
    pending=" (the public repo's tags could not be read: ./scripts/channels.sh lists them)"
  fi
  # Fast-lane tags still to come, as promote.sh's waiting_tag reads them:
  # dated after the newest "Update channels" commit on the public main, and
  # asking for a channels.json it does not have now. No public main yet (no
  # release published): the fast lane waits for one anyway.
  if git fetch -q --no-tags "${PUBLIC:-public}" +refs/heads/main:refs/hatchabot-copy/public-main 2>/dev/null \
    && git fetch -q --no-tags origin '+refs/tags/channels-*:refs/hatchabot-copy/fl/channels-*' 2>/dev/null; then
    newest="$(git log -n 2000 --format='%at %s' refs/hatchabot-copy/public-main | sed -n 's/^\([0-9][0-9]*\) Update channels$/\1/p' | sort -n | tail -1)"
    cur="$(git rev-parse -q --verify refs/hatchabot-copy/public-main:channels.json 2>/dev/null || true)"
    while read -r t td; do
      [ -n "$t" ] || continue
      [ -z "$newest" ] || [ "$td" -gt "$newest" ] || continue
      [ "$(git rev-parse -q --verify "refs/hatchabot-copy/fl/$t^{commit}:channels.json" 2>/dev/null || echo none)" != "$cur" ] || continue
      fl="$fl $t"
    done <<EOF
$(git for-each-ref --sort=refname --format='%(refname:strip=3) %(if)%(taggerdate)%(then)%(taggerdate:unix)%(else)%(*committerdate:unix)%(committerdate:unix)%(end)' refs/hatchabot-copy/fl/)
EOF
  else
    fl=" (the public repo's main or origin's fast-lane tags could not be read: ./scripts/channels.sh lists them)"
  fi
  {
    if [ -n "$last" ]; then
      echo "✗ publish.toml at ${rev:0:9} has changed since $last, the last release tag. The publisher's gate holds $what to its own copy of the file (projects/$name.toml in cksci/publisher), which was made to match $last's: tagged now, $what would stay \"incomplete\" there on every run (\"the candidate's publish.toml differs from the publisher's copy\") until the copy matched. Nothing was tagged."
    else
      echo "✗ No release tag on origin to compare publish.toml with (a first release). The publisher's gate holds $what to its own copy of the file (projects/$name.toml in cksci/publisher; kit adopt writes both), and nothing here shows that the two match. Nothing was tagged."
    fi
    [ -z "$note" ] || echo "$note"
    if [ -n "$last" ]; then
      echo
      echo "What changed since $last:"
      git diff --no-color --no-ext-diff -U0 refs/hatchabot-copy/last "$rev" -- publish.toml | sed -nE '/^(\+\+\+|---) /d; /^[-+]/s/^/    /p' || true
    fi
    echo
    echo "The owner sets projects/$name.toml on cksci/publisher's main to exactly this (publish.toml at ${rev:0:9}):"
    echo
    git show "$rev:publish.toml" | sed 's/^/    /' || true
    echo
    [ -z "$pending" ] || echo "Releases tagged but not published yet:$pending."
    [ -z "$fl" ] || echo "Fast-lane tags not published yet:$fl."
    if [ -n "$pending$fl" ]; then
      echo "Each is gated against the copy as it is when the publisher gets to it (a release again at the end of its wait), so a copy changed before they publish strands them: each stays \"incomplete\" on every run (publish kit backlog B-010) until a newer one publishes and supersedes it. To keep them, let them publish first (to go sooner: gh workflow run publish.yml -R cksci/publisher), then change the copy. A tag the publisher blocked is listed too, though it never publishes either way; one waiting only because its publish.toml is already this new file is rescued by the change, not stranded."
    fi
    echo "kit preflight $name $preflight_args (the owner runs it, in the dev clone) compares the two before a tag."
    echo "Once the copy matches: $go_on"
  } >&2
  publisher_copy_clear
  exit 4
}
