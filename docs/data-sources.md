# Data sources — what an agent can access

An agent should have one clear answer to "what data can it see?" — not three
scattered mechanisms. A **data source** is one thing an agent can access, unified
across kinds, shown as a single list per agent (⚙ Settings → Data) with a card summary
(`reads 2 folders · 1 writable folder`).

Each source declares four things: **kind** (folder / git / …), **access** (`ro` /
`rw`), **where the agent sees it** (`/data/<name>`, or for a folder brought in
with an adopted agent its own host path, below), and its config/credential.

## Kinds

| kind | access | mechanism | safety |
|---|---|---|---|
| **folder** | `ro` | host dir bind-mounted read-only at `/data/<name>` | kernel-enforced; blocklist refuses secrets/system paths |
| **folder** | `rw` | same bind mount, writable | machine-owner only + blocklist; the app warns — the agent can change/delete those files |
| **git** | `ro` / `rw` | repo cloned into the agent's volume, edited & committed there | repo-scoped deploy key (private in SecretStore); `rw` = write key. Never a host mount — every change is a reviewable commit |
| **git, public** | `ro` only | repo cloned over **https with no credentials** | nothing to register on the git host, no key stored; prompts disabled and https-only, push URL disabled; a private repo fails with "isn't public — add it with a deploy key" |
| **gdrive** *(Phase 2)* | `ro` / `rw` | rclone sync of a Drive folder ↔ the volume | Google OAuth, scope-limited to the chosen folder |

## Folders at their own path (adopted OpenClaw agents)

A folder is normally mounted at `/data/<name>`. It can instead be mounted **at
the same path inside the agent as on this machine** (`mountAtHostPath` on the
source; `atHostPath: true` when it is added). This is for agents adopted from a
hand-built OpenClaw install: their prompts, memory and scheduled tasks name
folders by their absolute path on the machine (say `/srv/household/recipes`),
and mounted at that same path those references keep working without anyone
editing them.

- **Who makes them:** adopting. After the workspace is copied, Hatchabot scans
  it (`POST /v1/workspaces/scan-paths`, `scanWorkspacePaths`) for folders it
  names outside itself and offers to share them **read-only** at their
  original paths, then rebuilds the agents to mount them. The Data list shows
  such a folder as `→ /srv/household/recipes (same path)`, and the agent's
  AGENTS.md lists it at that path too.
- **The same rules as any folder:** machine owner only, an agent on this
  machine only, the blocklist (`sharePathProblem`), read-only unless made
  writable, applied on the next Rebuild, and carried by an export as a
  declaration (the copy mounts it only where the same folder exists).
- **What differs from `/data/<name>`:** the place inside the container is the
  host path itself, so a path that would cover what the agent runs from is
  refused, when added and again at every build (`hostPathTargetProblem`): `/`,
  `/home/node`, `/opt`, `/usr`, `/etc`, `/bin`, `/lib` and the like and
  anything inside them, and `/tmp`, `/var` and `/run` themselves. Share such a
  folder at `/data` instead. Two such sources clash only when they are the
  same folder; the source's name is the path flattened into a label
  (`srv-household-recipes`) and is only a label.

## Why git isn't a writable host mount
For versioned data an agent maintains, a `rw` **host** mount lets a
permission-disabled container (reachable by anyone in the agent) rewrite your
disk directly. The **git** kind keeps the agent sandboxed on its own clone and
makes every change a commit you can review or revert — strictly better whenever
the data is (or can be) a repo. Prefer it; keep `rw` folders for local,
non-versioned data you're comfortable the agent editing.

## Storage & flow

- Legacy read-only folders still live on `agents.shared_paths` and are **left
  untouched** — existing mounts must not churn. Everything richer (writable
  folders, git) is a row in the **`data_sources`** table. The API/UI merges both
  into one list, so the split is invisible.
- `buildRuntimeSpec` turns folder sources into bind mounts (`:ro` unless `rw`);
  a git source is cloned onto the volume at provision time. Changes apply on the
  next **Rebuild**, like every other config.

## API

- `GET /v1/agents` / `GET /v1/agents/:id` → each agent carries `dataSources`
  (the unified list) and `dataSummary` (the one-liner).
- `POST /v1/agents/:id/data-sources` `{ kind, access, path | repoUrl, public?, atHostPath? }` — add
  (`path` for a folder, `repoUrl` for a git repo). Folder mounts
  are gated to the machine owner and pass `sharePathProblem`; `atHostPath: true`
  mounts the folder at its own path (above) and also passes
  `hostPathTargetProblem`. `public: true`
  (git, `ro` only) stores the https URL, generates no key, and — because there is
  nothing to register first — clones immediately when the agent is running.
  CLI: `hatchabot folders <agent> add-repo <url> --public`.
- `PATCH /v1/agents/:id/data-sources/:dsId` `{ access }` — flip a source
  between read-only (`ro`) and read-write (`rw`), without remove-and-re-add;
  applies on the next Rebuild. A public repo can't be made writable (no
  credential to push with) — remove it and add it with a deploy key.
- `POST /v1/agents/:id/data-sources/:dsId/check` — the **Test** button
  (v2.165.0). A folder: it exists, the service can read it (and write it, for
  `rw`), and the agent is on this machine. A repo: `git ls-remote` from this
  machine with the source's own deploy key (or none, for a public clone),
  answering `{ ok, refs, message }` or `{ ok: false, reason, message }` with
  `reason` one of `key-not-added`, `not-found`, `host-key`, `unreachable`,
  `timeout`, `no-git`, `error`. The key is written to a private temp dir for
  the one command and removed after it. Nothing is changed by a check.
- `DELETE /v1/agents/:id/data-sources/:dsId` — remove. A repo goes from the agent
  completely: its key and clone (`removedRepo`, `removedKey` in the answer).
- Folders are bind mounts of **this** machine's disk: adding one to an agent
  on a runner is refused (400), and moving an agent that has folders to a
  runner is refused (409, `folders_stay_here`). An export carries repos with
  their deploy keys and folders as declarations (docs/moving-agents.md).
- Legacy folders are still managed via `PATCH /v1/agents/:id { sharedPaths }`
  (the CLI `folders` command and old clients keep working).

## Status

- **Slice A (shipped):** the unified Data view + card summary, and **folders**
  read-only *and* writable.
- **Slice B (shipped):** first-class **git** repos. Adding one generates a
  repo-scoped ed25519 **deploy key** (private half in the SecretStore, public
  half shown to add to the repo — read, or write for `rw`); `syncGitDataSources`
  clones it onto the volume on the next provision/rebuild (idempotent, and
  best-effort so a not-yet-authorized key never fails the boot). Deleting a git
  source scrubs the private key; since v2.167.0 it also deletes the clone from
  the agent (only a folder whose origin is still that repo), public repos' too,
  and the agent's AGENTS.md stops listing it at once on a running agent.
- **Phase 2:** **Google Drive** via rclone + Google sign-in.
