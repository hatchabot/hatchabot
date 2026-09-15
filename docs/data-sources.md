# Data sources — what an agent can access

An agent should have one clear answer to "what data can it see?" — not three
scattered mechanisms. A **data source** is one thing an agent can access, unified
across kinds, shown as a single list per agent (⚙ Settings → Data) with a card summary
(`reads 2 folders · 1 writable folder`).

Each source declares four things: **kind** (folder / git / …), **access** (`ro` /
`rw`), **where the agent sees it** (`/data/<name>`), and its config/credential.

## Kinds

| kind | access | mechanism | safety |
|---|---|---|---|
| **folder** | `ro` | host dir bind-mounted read-only at `/data/<name>` | kernel-enforced; blocklist refuses secrets/system paths |
| **folder** | `rw` | same bind mount, writable | machine-owner only + blocklist; the app warns — the agent can change/delete those files |
| **git** | `ro` / `rw` | repo cloned into the agent's volume, edited & committed there | repo-scoped deploy key (private in SecretStore); `rw` = write key. Never a host mount — every change is a reviewable commit |
| **git, public** | `ro` only | repo cloned over **https with no credentials** | nothing to register on the git host, no key stored; prompts disabled and https-only, push URL disabled; a private repo fails with "isn't public — add it with a deploy key" |
| **gdrive** *(Phase 2)* | `ro` / `rw` | rclone sync of a Drive folder ↔ the volume | Google OAuth, scope-limited to the chosen folder |

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
- `POST /v1/agents/:id/data-sources` `{ kind, access, path | repoUrl, public? }` — add
  (`path` for a folder, `repoUrl` for a git repo). Folder mounts
  are gated to the machine owner and pass `sharePathProblem`. `public: true`
  (git, `ro` only) stores the https URL, generates no key, and — because there is
  nothing to register first — clones immediately when the agent is running.
  CLI: `hatchabot folders <agent> add-repo <url> --public`.
- `PATCH /v1/agents/:id/data-sources/:dsId` `{ access }` — flip a source
  between read-only (`ro`) and read-write (`rw`), without remove-and-re-add;
  applies on the next Rebuild. A public repo can't be made writable (no
  credential to push with) — remove it and add it with a deploy key.
- `DELETE /v1/agents/:id/data-sources/:dsId` — remove.
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
  source scrubs the private key.
- **Phase 2:** **Google Drive** via rclone + Google sign-in.
