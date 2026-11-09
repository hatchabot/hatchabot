# The mark an install's backup sets carry in .backup-owner, and its drill
# records in "owner": a fingerprint of its HATCHABOT_SECRET_KEY, never the key
# (ownerMark in src/orchestrator/backups.ts makes the same), and whose a set is
# (foreignSet there). Sourced by backup-volumes.sh, restore-drill.sh and
# uninstall.sh, never run on its own: one copy, where there were four (second
# and third reviews of HB-0540).
#
# key_owner FILE: the mark of the key that env file holds (a set's
#   secret-key.env), HATCHABOT_SECRET_KEY or the pre-rename
#   AGENTCLAW_SECRET_KEY, read by Node's dotenv parser.
# key_owner: the mark of the key in the environment, the same two names.
# Prints nothing when there is no key. HATCHABOT_SECRET_KEY set but empty is
# no key: `HATCHABOT_SECRET_KEY="$OTHER" key_owner` reads another value alone.
key_owner() {
  node -e '
    const file = process.argv[1];
    let vars = process.env;
    if (file) {
      const fs = require("node:fs");
      vars = fs.existsSync(file) ? require("node:util").parseEnv(fs.readFileSync(file, "utf8")) : {};
    }
    const key = vars.HATCHABOT_SECRET_KEY ?? vars.AGENTCLAW_SECRET_KEY;
    if (key) process.stdout.write(require("node:crypto").createHash("sha256").update("hatchabot-backup-owner\0" + key).digest("hex").slice(0, 16));' "${1:-}" 2>/dev/null || true
}

# set_owner SET [MINE]: whose the backup set in folder SET is: its .backup-owner,
# or for a set from before that file, the mark of the key it saved (a node run,
# so a caller reads it once per set). Nothing when neither says. With MINE
# given and empty (this install has no mark), the saved key is not read: there
# is nothing to compare it with, and a marked set still says whose it is.
set_owner() {
  local so
  so="$(cat "$1/.backup-owner" 2>/dev/null || true)"
  if [ -z "$so" ] && { [ $# -lt 2 ] || [ -n "$2" ]; } && [ -f "$1/secret-key.env" ]; then so="$(key_owner "$1/secret-key.env")"; fi
  printf '%s' "$so"
}
