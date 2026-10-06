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
  for name in hatchabot hbt; do
    if [ "$name" = hbt ] && OTHER="$(command -v hbt 2>/dev/null)" && [ "$OTHER" != "$BIN/hbt" ]; then
      echo "note: another program here is already called hbt ($OTHER), so use the full name: hatchabot."; continue
    fi
    printf '#!/usr/bin/env bash\n# Hatchabot (%s) — written by scripts/link-cli.sh\nexec "%s/.node/bin/node" "%s/bin/hatchabot.mjs" "$@"\n' "$name" "$PWD" "$PWD" > "$BIN/$name"
    chmod 755 "$BIN/$name"
  done
  echo "linked: $BIN/hatchabot$([ -x "$BIN/hbt" ] && echo ", $BIN/hbt")"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      LINE="export PATH=\"$BIN:\$PATH\""
      for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        [ -f "$rc" ] || [ "$rc" = "$HOME/.$(basename "${SHELL:-bash}")rc" ] || continue
        grep -qF "$BIN" "$rc" 2>/dev/null || { printf '\n# hatchabot CLI\n%s\n' "$LINE" >> "$rc"; echo "added to $rc: $LINE"; }
      done
      echo "Open a new terminal (or run: $LINE) for the change to take effect there." ;;
  esac
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
    LINE="export PATH=\"$BIN:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [ -f "$rc" ] || [ "$rc" = "$HOME/.$(basename "${SHELL:-bash}")rc" ] || continue
      grep -qF "$BIN" "$rc" 2>/dev/null || { printf '\n# hatchabot CLI\n%s\n' "$LINE" >> "$rc"; echo "added to $rc: $LINE"; }
    done
    export PATH="$BIN:$PATH"
    echo "Open a new terminal (or run: $LINE) for the change to take effect there."
    ;;
esac

[ "${1:-}" = --no-doctor ] && exit 0
echo
"$BIN/hatchabot" doctor || true
