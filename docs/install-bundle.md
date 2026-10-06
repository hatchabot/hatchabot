# The installer and the release bundle

```bash
curl -fsSL https://hatchabot.com/install.sh | bash
```

**One prerequisite: a container runtime (Docker).** The installer offers to install
it, and does not stop to have you log out afterwards. Everything else comes in a
prebuilt bundle on supported machines.

## Where the bundle is used

| Machine | What the installer does |
|---|---|
| Ubuntu 22.04 or newer, Debian 12 or newer (x64 or arm64; glibc 2.35+) | Downloads the bundle |
| Apple-silicon Mac | Downloads the bundle; offers Docker Desktop through Homebrew if Docker is missing |
| Anything else: Alpine (musl), older glibc, 32-bit, Intel Mac | The native install: git, Node 22 and build tools, then a clone at the release |
| A release with no bundle, a checksum mismatch, or a bundle that fails its self-check | Falls back to the native install automatically |

`HATCHABOT_NATIVE=1` forces the native install. A clone that is already
installed (`~/hatchabot/.git`) keeps upgrading as a clone; a bundle install
upgrades by bundle.

## The bundle

It is a plain archive per platform, attached to each GitHub release by
`.github/workflows/bundles.yml` (`scripts/build-bundle.sh`):
`hatchabot-<tag>-<linux-x64|linux-arm64|darwin-arm64>.tar.gz` and its
`.sha256`. About 65 MB. Inside:

- the release's files;
- `node_modules`, production dependencies only, with the database driver
  **compiled on Ubuntu 22.04**. The driver's own Linux binaries need glibc 2.38,
  so the bundle removes them and compiles its own;
- `.node/bin/node`, a Node private to Hatchabot. Every script, the service and
  the `hatchabot` command use it; nothing is installed on the system;
- `BUNDLE.json` (version, tag, platform, Node), and `.bundle-files`, the
  bundle's own top-level names.

It checks itself when it is built (its Node opens a database with its driver),
and the installer checks it again before it moves in.

## Docker without logging out

Right after `usermod -aG docker`, nothing already running has the group yet:
your shell, and the systemd user manager that starts Hatchabot. So Docker
refused them until you logged out and back in, and the installer stopped and
had to be run a second time.

Now the installer runs its own Docker steps through `sg docker`. The service and
the nightly backup start through `scripts/with-docker.sh`, which does the same
when Docker is not reachable but `/etc/group` lists you. Once you have logged in
again it simply runs the command.

## The end of the install

`scripts/first-run-link.sh` waits for Hatchabot to answer, then prints:

- its address on your network;
- a QR code a phone can scan;
- while no account exists, the first-run setup code.

The code is read from the service log and carried in the link after a `#`, the
part a browser never sends to a server. The first-run page fills it in and wipes
it from the address bar.

## Upgrades

`hatchabot upgrade` (and the channel timer, `follow-channel.sh`) on a bundle install:

1. Resolves the channel without git (`scripts/release-target.sh`: `channels.json`
   on main, or the newest release).
2. Downloads the next bundle beside the install, checks its `.sha256`, unpacks
   it, and runs its self-check.
3. Swaps only the bundle's own top-level files. `.env`, `data/` and backups are
   never touched, and the old files are kept aside.
4. Restarts. If the new release does not come up, the old files go back and the
   old release restarts.

Exit codes are the same as a clone's upgrade: `3` means it is worth trying
again (no bundle yet, network), `1` means the release did not start and was
rolled back. Upgrades do not depend on the npm registry.

## The driver on a native install

A native install on Ubuntu 22.04 or Debian 12 had the same driver problem: the
driver loads its shipped binary, which needs glibc 2.38, and Hatchabot could not
open its database. `scripts/ensure-deps.sh` now runs `scripts/sqlite-driver.sh`
after `npm ci`. When the shipped binary does not load, it compiles the driver for
the machine.

## Testing it

`scripts/clean-install-test.sh` installs in a fresh LXD VM, the way a stranger
would. These options test a branch before release:

- `--image ubuntu:22.04`: the oldest supported base;
- `--installer-url` and `--bundle-base`: an installer and bundles served from
  this machine (build them with `HATCHABOT_BUNDLE_REF=<branch> scripts/build-bundle.sh
  v0.0.0-test linux-arm64 <dir>` in an Ubuntu 22.04 container);
- `--upgrade-to`: the upgrade step's target.

It checks:

- the install finishes in one run;
- the system gained no Node, git or compiler;
- the install ends with the link.
