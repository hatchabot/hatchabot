#!/usr/bin/env bash
# Put the `hatchabot` and `hbt` commands on your PATH, and check the install.
#
#   ./scripts/link-cli.sh              # …and run `hatchabot doctor` at the end
#   ./scripts/link-cli.sh --no-doctor  # (setup-host.sh, which checks on its own)
#
# For a machine where the checkout exists but the command does not — after
# moving to a new laptop with Migration Assistant, a fresh shell profile, or an
# `npm link` that failed during setup. Safe to re-run.
set -euo pipefail
[ -x "$(dirname "$0")/../.node/bin/node" ] && PATH="$(cd "$(dirname "$0")/.." && pwd)/.node/bin:$PATH" && export PATH  # a bundle install's own Node (install.sh)
cd "$(dirname "$0")/.."
# A bundle install has its own Node and no npm: the commands are two small
# launchers in ~/.local/bin that run this install's CLI with its Node.
if [ -f BUNDLE.json ] && [ -x .node/bin/node ]; then
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN"
  # The folder goes inside the launcher's double quotes: a $, `, " or \ in it
  # escaped, or running the command expanded it a second time (a folder named
  # bundle$HOME, audit #039). uninstall.sh finds the launchers by the same text.
  HERE="$(printf '%s' "$PWD" | sed -e 's/[\\$`"]/\\&/g')"
  # What is already at $1 is a Hatchabot command, and so this script's to
  # replace: a launcher it wrote (for any install), or a link that ends at a
  # Hatchabot CLI (an npm-linked native install's, or hbt linked to one of
  # these), followed as far as it goes, gone or not. Anything else there is
  # another program, which a fresh launcher went in over (HB-1077).
  hatchabot_launcher() { [ -f "$1" ] && grep -q 'written by scripts/link-cli.sh' "$1" 2>/dev/null; }
  # And as hatchabot only (it wrote no hbt), the launcher the rename from
  # AgentClaw wrote (scripts/migrate-rename-host.sh): exactly its two lines,
  # and the checkout it runs gone or a Hatchabot one. Another tool's tsx
  # wrapper can look much the same (review of HB-1077).
  renamed_launcher() {
    local dir
    [ -f "$1" ] && [ ! -L "$1" ] && [ "$(wc -l < "$1" | tr -d ' ')" = 2 ] && [ "$(sed -n 1p "$1")" = '#!/usr/bin/env bash' ] || return 1
    dir="$(sed -n '2s|^cd "\([^"]*\)" && exec node_modules/\.bin/tsx src/cli\.ts "\$@"$|\1|p' "$1")"
    [ -n "$dir" ] && { [ ! -e "$dir" ] || grep -q '"name": *"hatchabot"' "$dir/package.json" 2>/dev/null; }
  }
  hatchabot_command() { # PATH NAME
    local t
    if [ -L "$1" ]; then
      t="$(readlink -f "$1" 2>/dev/null || readlink "$1" 2>/dev/null)" || return 1
      case "$t" in */bin/hatchabot.mjs) return 0 ;; esac
      hatchabot_launcher "$t"
      return
    fi
    hatchabot_launcher "$1" || { [ "$2" = hatchabot ] && renamed_launcher "$1"; }
  }
  LINKED=""; UNLINKED=0
  for name in hatchabot hbt; do
    if [ "$name" = hbt ] && OTHER="$(command -v hbt 2>/dev/null)" && [ "$OTHER" != "$BIN/hbt" ]; then
      echo "note: another program here is already called hbt ($OTHER), so use the full name: hatchabot."; continue
    fi
    if { [ -e "$BIN/$name" ] || [ -L "$BIN/$name" ]; } && ! hatchabot_command "$BIN/$name" "$name"; then
      if [ "$name" = hbt ]; then echo "note: another program here is already called hbt ($BIN/hbt), so use the full name: hatchabot."; continue; fi
      echo "$BIN/hatchabot is another program, not Hatchabot's, so it was left as it is and the hatchabot command was not linked. Move it aside, then run ./scripts/link-cli.sh again."
      UNLINKED=1; continue
    fi
    # A link there (an npm-linked native install's) is replaced, not written
    # through: the redirect followed it and overwrote that install's CLI with
    # this launcher (audit #038).
    rm -f "$BIN/$name"
    printf '#!/usr/bin/env bash\n# Hatchabot (%s) — written by scripts/link-cli.sh\nexec "%s/.node/bin/node" "%s/bin/hatchabot.mjs" "$@"\n' "$name" "$HERE" "$HERE" > "$BIN/$name"
    chmod 755 "$BIN/$name"
    LINKED="${LINKED:+$LINKED, }$BIN/$name"
  done
  [ -z "$LINKED" ] || echo "linked: $LINKED"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      # Escaped inside the line's double quotes, as the launcher's folder is:
      # a home named home$X was expanded by every new shell (audit, 2026-10-29).
      BIN_Q="$(printf '%s' "$BIN" | sed -e 's/[\\$`"]/\\&/g')"
      LINE="export PATH=\"$BIN_Q:\$PATH\""
      for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        [ -f "$rc" ] || [ "$rc" = "$HOME/.$(basename "${SHELL:-bash}")rc" ] || continue
        grep -qF "$BIN_Q" "$rc" 2>/dev/null || { printf '\n# hatchabot CLI\n%s\n' "$LINE" >> "$rc"; echo "added to $rc: $LINE"; }
      done
      echo "Open a new terminal (or run: $LINE) for the change to take effect there." ;;
  esac
  [ "$UNLINKED" = 0 ] || exit 1
  [ "${1:-}" = --no-doctor ] && exit 0
  echo; "$BIN/hatchabot" doctor || true
  exit 0
fi
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v npm >/dev/null 2>&1 || { echo "npm is not installed — install Node 22 first (https://nodejs.org), then re-run."; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies…"; npm ci --silent; }

BIN="$(npm prefix -g)/bin"
LINK_OUT="$(npm link 2>&1)" || {
  # A system-wide Node makes the global folder root-owned: give npm one of ours.
  # Only for that failure — any other (a broken package, no network) must not
  # quietly rewrite ~/.npmrc for every node on the machine.
  case "$LINK_OUT" in *EACCES*|*"permission denied"*|*"Permission denied"*) ;; *) printf '%s\n' "$LINK_OUT"; exit 1 ;; esac
  npm config set prefix "$HOME/.npm-global"
  BIN="$HOME/.npm-global/bin"
  npm link >/dev/null
}
# `hbt` is the short name — only where nothing else already answers to it.
# (Not a package.json bin: npm link fails outright on a name another package
# owns, and would take `hatchabot` down with it.)
OTHER="$(PATH="${PATH//$BIN:/}" command -v hbt 2>/dev/null || true)"
if [ -n "$OTHER" ] && [ "$(readlink -f "$OTHER")" != "$(readlink -f "$BIN/hatchabot")" ]; then
  echo "note: another program here is already called hbt ($OTHER), so use the full name: hatchabot."
else
  [ -e "$BIN/hbt" ] || ln -s "$BIN/hatchabot" "$BIN/hbt" 2>/dev/null || true
fi
echo "linked: $BIN/hatchabot$([ -L "$BIN/hbt" ] && echo ", $BIN/hbt")"

# The shell profile, once. zsh on a Mac, bash elsewhere; both if unsure.
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    # Escaped inside the line's double quotes, as above (audit, 2026-10-29).
    BIN_Q="$(printf '%s' "$BIN" | sed -e 's/[\\$`"]/\\&/g')"
    LINE="export PATH=\"$BIN_Q:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [ -f "$rc" ] || [ "$rc" = "$HOME/.$(basename "${SHELL:-bash}")rc" ] || continue
      grep -qF "$BIN_Q" "$rc" 2>/dev/null || { printf '\n# hatchabot CLI\n%s\n' "$LINE" >> "$rc"; echo "added to $rc: $LINE"; }
    done
    export PATH="$BIN:$PATH"
    echo "Open a new terminal (or run: $LINE) for the change to take effect there."
    ;;
esac

[ "${1:-}" = --no-doctor ] && exit 0
echo
"$BIN/hatchabot" doctor || true
