# Data sources — what an agent can access

An agent should have one clear answer to "what data can it see?" — not three
scattered mechanisms. A **data source** is one thing an agent can access, unified
across kinds, shown as a single list per agent (Edit → Data) with a card summary
(`reads 2 folders · 1 writable folder`).

Each source declares four things: **kind** (folder / git / …), **access** (`ro` /
`rw`), **where the agent sees it** (`/data/<name>`), and its config/credential.

## Kinds

| kind | access | mechanism | safety |
|---|---|---|---|
| **folder** | `ro` | host dir bind-mounted read-only at `/data/<name>` | kernel-enforced; blocklist refuses secrets/system paths |
| **folder** | `rw` | same bind mount, writable | machine-owner only + blocklist; the app warns — the agent can change/delete those files |
| **git** *(Slice B)* | `ro` / `rw` | repo cloned into the agent's volume, edited & committed there | repo-scoped deploy key (private in SecretStore); `rw` = write key. Never a host mount — every change is a reviewable commit |
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
  git sources will be cloned onto the volume at provision time (Slice B). Changes
  apply on the next **Rebuild**, like every other config.

## API

- `GET /v1/agents` / `GET /v1/agents/:id` → each agent carries `dataSources`
  (the unified list) and `dataSummary` (the one-liner).
- `POST /v1/agents/:id/data-sources` `{ kind, access, path }` — add. Folder mounts
  are gated to the machine owner and pass `sharePathProblem`.
- `DELETE /v1/agents/:id/data-sources/:dsId` — remove.
- Legacy folders are still managed via `PATCH /v1/agents/:id { sharedPaths }`
  (the CLI `folders` command and old clients keep working).

## Status

- **Slice A (shipped):** the unified Data view + card summary, and **folders**
  read-only *and* writable.
- **Slice B:** first-class **git** repos — generate the deploy key, clone on
  provision, pull on demand. The `data_sources` columns are already in place, so
  it's additive.
- **Phase 2:** **Google Drive** via rclone + Google sign-in.
