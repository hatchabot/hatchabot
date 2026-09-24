# Design: a shared embedding service, and the road to OpenClaw 2026.9

Status, 2026-09-24: steps 1–5 of the build order are built (v2.40.0, v2.41.0,
v2.50.0, v2.51.0, v2.52.0), with the door as its own container (see "Revised"
below); step 6 waits for the fleet to be on `shared`. Images for OpenClaw
2026.8+ now build (engine-free), and `scripts/candidate-gate.sh` is the gate
before one is tried on a real agent. Written to be coded
from directly.

## The problem

Agents cannot move past OpenClaw 2026.7.1-2. Real test builds of 2026.9.4
found three blockers, and all three come from one design choice: **memory
search's engine is baked into every agent image**, by installing OpenClaw's
`@openclaw/llama-cpp-provider` plugin at build time and lifting its native
library out of it.

| Blocker | State |
|---|---|
| 2026.9 needs Node.js 24.16+ | Fixed in v1.30.0 (the build picks the Node line) |
| The plugin installer's options were renamed | Fixed in v1.30.0 |
| From 2026.8 the plugin no longer carries its engine. It downloads a `llama-server` later, per install, after a consent prompt, and needs glibc 2.38 on arm64 (our Debian base has 2.36) | Fixed in v2.51.0: such images are built without the plugin (`EMBED_ENGINE=none`), their agents use the shared service (this document) |

The extended-stable release (2026.7.33) is not a way round it: as published
it does not start.

The same choice also costs memory today. Each agent that searches its memory
loads its own copy of the embedding model inside its container.

## The decision

**Stop baking the engine. Run one embedding service per machine, owned by
Hatchabot, and point every agent at it.**

OpenClaw has a documented embedding provider for exactly this,
`openai-compatible`, which calls any `/v1/embeddings` endpoint. It exists in
2026.7.1-2 and in 2026.9.4.

### Proven on 2026-09-18 (throwaway containers, nothing of prod touched)

- `ghcr.io/ggml-org/llama.cpp:server` has an arm64 build. It served the
  **same EmbeddingGemma file** the images bake today: 768-dimension vectors,
  **365 MiB of RAM, once for the whole machine**.
- OpenClaw **2026.7.1-2** indexed a MEMORY.md through it and answered a
  semantic search ("what vehicle do they drive" found the Subaru line).
- OpenClaw **2026.9.4** did the same, with its renamed settings.

### Options considered

| Option | Verdict |
|---|---|
| **A. One shared service, agents call it over HTTP** | **Chosen.** Works on every OpenClaw version, ends the coupling, one model in RAM, image shrinks by about 400 MB. |
| B. Follow upstream: bake `llama-server` and hand-write the plugin's "managed" config | Rejected. Couples us to the plugin's internals again (generated presets, pinned-build checks, "do not copy between machines"), needs a new base OS for glibc, and runs a server per agent. |
| C. Let each agent download its own engine and model on first use | Rejected. About 350 MB per agent volume, an interactive consent step, and internet at first use. |
| D. Use Ollama's embeddings | Not the default (a retail install has no Ollama). Falls out of A for free: the endpoint is configurable, and Ollama speaks the same API. |

## Architecture

```
 agent container ── POST /v1/embeddings ──► hatchabot-embed-door container
   (Bearer: this agent's embed key)          │ checks the key, rate-limits, forwards
                                             │ (published on the address agents reach this machine at)
                                             ▼
                              hatchabot-embedder container (internal network only)
                              llama-server + EmbeddingGemma, no internet needed
```

**Revised 2026-09-23 (built as step 1, v2.40.0): the front door is its own
container, not the control plane.** The first draft had Hatchabot forward the
calls; that put every deploy's restart in the data path — a switched agent
would have had keyword-only recall for the seconds Hatchabot was down, several
times a day on a machine that follows every tag. The door is a small Node
script (`src/embedder/door.ts`, run like the doorman) that keeps the same
properties: every call authenticated by a per-agent key, rate-limited per
agent, bodies capped, nothing logged but agent id, count, bytes and
milliseconds. Hatchabot's part is out of the data path: it fetches the model,
mints the server's key and each agent's key, writes the door's key file
(sha256 → agent id, re-read by the door when it changes, so a rebuild re-mints
without a restart), and runs the health loop. Both containers sit on an
internal docker network; the door is also on the bridge, where its one port is
published on the bridge gateway (loopback on Docker Desktop). At scale the
same shape holds: the embedder is stateless and can be shared by many tenants
on a host or run several times behind one door.

The sections below describe the first draft's Hatchabot-side route; step 1
replaced it with the door container, and step 2 (the per-agent switch) writes
the door's address into each agent's config instead of a Hatchabot route.
Superseded by what was built: `POST /v1/embed/v1/embeddings` and
`src/api/embed.ts` (the door is `src/embedder/door.ts`), the ops-door path,
`baseUrl=${HATCHABOT_INTERNAL_URL}/v1/embed/v1/` (it is the door's address),
`settings.embedDefault` and the label forcing `shared` (step 3/4, not yet),
the server "published on 127.0.0.1 only" (it has no published port; the door
is on the bridge gateway), "Hatchabot is in the data path" (it is not), the
server key "known only to Hatchabot" (the door holds it too), "when set,
Hatchabot forwards there" for `HATCHABOT_EMBED_URL` (switched agents are
given that server's address, key and model directly), the "inline health"
row (the result is on the agent's Settings → Advanced engine row), and a
runner agent reaching the control plane (runners are built baked, for now).
The test files are test/embedDoor.test.ts, test/embedder.test.ts and
test/embedSwitch.test.ts.

### The embedder

- New module `src/embedder/embedder.ts`, and two provider methods on
  `RuntimeProvider`: `ensureEmbedder(spec)` and `embedderStatus()`
  (implemented in `localDockerProvider.ts`; the mock returns a fixed URL).
- Container `<prefix>-embedder`, image pinned **by digest** in a constant
  `EMBEDDER_IMAGE` (override: `HATCHABOT_EMBEDDER_IMAGE`). Published on
  `127.0.0.1:${HATCHABOT_EMBED_PORT:-8093}` only.
- Hardening: read-only root, `--cap-drop ALL`, `no-new-privileges`, memory
  limit 1 GB, `--restart unless-stopped`, web UI off, prompt logging off.
- Flags: `--embeddings --alias embeddinggemma -c 2048 -ub 2048 --api-key <k>`.
  The key is a machine secret (`embedder/key`) known only to Hatchabot.
- **The model file** lives in the data directory
  (`<data>/models/embeddinggemma-300m-qat-Q8_0.gguf`), mounted read-only.
  First start gets it, in this order:
  1. copy it out of an existing runtime image (`docker create` + `docker cp`),
     so today's installs download nothing;
  2. else download the same URL the Dockerfile pins, checked against the same
     SHA-256 before it is used.
- Started lazily, by the first provision or rebuild that needs it, and
  checked by the existing health loop. If `/health` fails, Hatchabot restarts
  it and records a fleet event.
- Override for people who already run a server (or Ollama):
  `HATCHABOT_EMBED_URL` + `HATCHABOT_EMBED_KEY` + `HATCHABOT_EMBED_MODEL`. When
  set, Hatchabot starts no container and forwards there instead.

### The front door

- Route `POST /v1/embed/v1/embeddings` in a new `src/api/embed.ts`. Exempt
  from user sign-in (like `/v1/mgmt/mcp`); authenticated by **a per-agent
  embed key**.
- New table `embed_tokens (agent_id PRIMARY KEY, token_hash, created_at)`.
  Minted in `buildRuntimeSpec` on every build, exactly like `ops_tokens`;
  dead unless the agent is RUNNING, PROVISIONING or REBUILDING; deleted on
  archive and delete (`setAgentState`).
- It forwards the JSON body unchanged, swaps the Authorization header for the
  embedder's key, and streams the answer back. It accepts only this one path
  and method.
- Limits: body at most 2 MB, at most 256 inputs per call, per-agent token
  bucket (default 600 calls a minute, `HATCHABOT_EMBED_PER_MIN`), 60-second
  timeout. Over the limit returns 429, which OpenClaw retries.
- **It never logs or stores request bodies.** They are people's memories.
  Log only: agent id, input count, bytes, milliseconds.
- The ops agent cannot reach the main port, so `opsServer.ts` gains the same
  path on its door (Bearer: the ops key) calling the same handler.
- Add the route to `src/mgmt/coverage.ts` as `app: internal`.

### What each agent is told (`configWriter.ts`)

`ConfigPatch` gains `embed?: { baseUrl: string; token: string; model: string }`.
When present, write these **instead of** the three baked-plugin commands
(`plugins install --link`, `plugins enable llama-cpp`, `…local.modelPath`):

| OpenClaw | Keys |
|---|---|
| before 2026.8 | `agents.defaults.memorySearch.provider = openai-compatible`, `….model`, `….remote.baseUrl`, `….remote.apiKey` |
| 2026.8 and later | the same four under `memory.search.*` |

- The key set is chosen from the image's OpenClaw version. `buildRuntimeSpec`
  already reads the image label; pass it as `patch.openclawVersion`. One
  helper, `memoryKeyPrefix(version)`, owns the rule.
- `remote.apiKey` commands are marked `sensitive`.
- `baseUrl` is `${HATCHABOT_INTERNAL_URL}/v1/embed/v1/` (for the ops agent,
  its door's address).
- When `embed` is absent the writer keeps today's baked behaviour untouched.

### Which agents use it: a per-agent switch first

- New column `agents.embed_mode`: `baked` (default, today) or `shared`.
- `PATCH /v1/agents/:id` accepts `embedMode`; it takes effect on the next
  rebuild. Agent sheet → Advanced gets one row, "Memory search engine".
- A fleet default, `settings.embedDefault`, is what new agents get. It stays
  `baked` until the soak below is done.
- Rule: an image **without** a baked engine forces `shared` regardless. The
  image declares this with a label (next section).

### Switching re-indexes, deliberately

Changing the provider changes OpenClaw's "index identity". It pauses vector
search until the index is rebuilt; it does not rebuild by itself.

- After a rebuild that changed `embed_mode`, run
  `openclaw memory index --force --agent <slug>` (new step in
  `runProvisionSteps`, after the gateway is healthy, 10-minute timeout,
  failure is a warning on the agent, not a failed rebuild).
- Verify with `openclaw memory status --deep --agent <slug>`: expect
  `Embeddings: ready` and `Semantic vectors: ready`. Surface the result in
  the agent's inline health ("Memory search: ready / rebuilding / off").
- Record `agents.embed_indexed_at`, so a repeat rebuild does not re-index.

### The image

`docker/Dockerfile.runtime` gains `ARG EMBED_ENGINE=baked`:

- `baked`: today's steps, unchanged. The proven default does not move.
- `none`: skip the plugin and model steps entirely, and set
  `LABEL org.hatchabot.embed-engine=none`.

`scripts/build-runtime-image.sh` passes `EMBED_ENGINE=none` for 2026.8 and
later (`scripts/runtime-pins.mjs embed-engine`), so those builds stop
refusing; asked for on a version that could bake (`EMBED_ENGINE=none`,
`hatchabot upgrade-image --no-engine`, the Images tick box), the image gets
its own `-lite` tag. `needsSharedEmbedder(version)` (src/orchestrator/
buildFailure.ts) is what is left of the old "can't build" gate: such a build
is refused up front unless the shared service is on.

`listImageTags` and `currentImageInfo` read the label (`RuntimeInfo.embedEngine`);
the Images list says "shared memory search only". Provisioning an agent onto
such an image uses the shared service whatever its switch says (and sets the
switch to match); with the service unavailable the build fails with the reason
rather than leaving the agent without memory search. *Built in v2.51.0.*

### Machines other than this one

An agent on a remote runner reaches the control plane on that host's
configured internal address, as its consult tool does today. No second
embedder in the first version. If the control plane is unreachable, memory
search reports unavailable and replies continue; OpenClaw's active-memory pass
does not block a reply on it.

## Risks

| Risk | Answer |
|---|---|
| One service down = no semantic recall anywhere | Health loop restarts it. Replies do not block on it. The agent's health row shows it. `baked` remains available on the old image line as the way back. |
| Memories pass through a shared process | It is stateless, holds nothing after the call, logs no bodies, has no internet need, and listens on loopback only. Every caller is authenticated per agent. |
| Hatchabot is in the data path | Payloads are small JSON. A full re-index is a few hundred calls. Rate-limited per agent so one agent cannot starve the rest. |
| A leaked embed key | It can only turn text into numbers. It dies with the agent's state and is reminted on every rebuild. |
| The llama.cpp image changes under us | Pinned by digest; moved deliberately, with the proof test below. |
| Vectors differ between the old in-process engine and the server | Irrelevant: every switch re-indexes. |

## The rest of the 2026.9 port

The embedding engine is the blocker, not the whole job. Before any agent is
trusted on a 2026.9 candidate, check each of these against a real candidate
container and fix what moved. Each is a place Hatchabot reads or writes
OpenClaw's own formats:

1. Config keys `configWriter.ts` writes. 2026.9 moved `memorySearch` and
   renamed `agents.list` to `agents.entries`. Run `openclaw doctor` on a
   freshly written candidate and treat every migration it offers as a key to
   version in the writer. *Found on the first 2026.9.6 candidate (2026-09-24,
   v2.53.0): a 2026.7 volume fails validation on `meta.lastTouchedAt` and
   `agents.defaults.memorySearch` (unrecognized), needs
   `agents.ownership="explicit"` for a two-agent roster, and its state
   database needs a schema migration (`audit-events-v2`) that only `openclaw
   doctor --fix` performs — and the CLI refuses every command until it has.
   The writer now heals the JSON by hand and runs `doctor --fix
   --non-interactive` before its first command on 2026.8+ (`needsPortHeal`).
   `agents.list` → `agents.entries` is migrated by doctor with a warning.*
2. `plugins install --link` options (only matters for channel plugins now).
   *Unchanged in 2026.9.6 (`--link`, `--accept-capabilities`,
   `--acknowledge-install-policy-warning`, `--force`). New: the DuckDuckGo
   web-search plugin is no longer bundled — doctor tries to install
   `@openclaw/duckduckgo-plugin` from npm on first sight of the config. The
   image now bakes it (`BAKED_PLUGINS`, label `org.hatchabot.plugins`) and the
   writer links it like a channel plugin (v2.53.0). Bigger: 2026.9's plugin
   trust model refuses a LINKED Slack/Discord plugin anything keyed
   (`PluginTrustRefusalError: openKeyedStore is only available for trusted
   plugins… origin-path; --link and --force do not grant trusted plugin
   state`) — found on Taco Agent. From v2.56.0 a 2026.8+ image bakes an npm
   cache (`PLUGIN_INSTALL=npm`, label `org.hatchabot.plugin-install`) and the
   seed installs `@openclaw/<channel>@<baked version>` into the volume
   offline from it, which OpenClaw records as `trusted-official`. DuckDuckGo
   stays linked (no keyed store).*
3. The management agent's lockdown: tool and group names in `OPS_TOOLS_ALLOW`
   and `OPS_TOOLS_DENY`, and `mcp set`. The drift check will flag a miss; the
   management agent stays pinned and moves last.
4. CLI JSON shapes we parse: `sessions list`, `cron list`, `pairing list`,
   `models`, `--version`.
5. Files we read directly: `sessions.json` (unread mark, last seen) and
   `devices/pending.json` (console approval). *2026.8+: the session records
   moved into the agent's `openclaw-agent.sqlite` (`session_nodes.entry_json`,
   same entry shape, `delivery.kind` instead of `lastTo`); read there with
   `node:sqlite` when the file is gone (`sessionsReadShell`, v2.53.3).
   `devices/pending.json` unchanged.*
6. The console address and its `?session=agent:<slug>:main` parameter.
   *Unchanged (gate).*
7. Claude Code CLI pin and the subscription-token path. *The second
   `models auth paste-token` (agent main's store) needs `--agent main` once
   two agents are configured (v2.53.2).*

**Memory, 2026-09-24:** a 2026.9 gateway is ~1.0–1.2 GB RSS against ~380 MB
on 2026.7 — measured from inside: main heap 424 MB live (GC tight, a heap cap
gains nothing), the rest in the 6+4 worker isolates 2026.9 added and the
SQLite caches of its three databases. Real usage, not slack; affordable on the
Spark (45 × ~1 GB), a cost driver for shared hosts.

**Status 2026-09-24:** `hatchabot-runtime:2026.9.6` passes the gate 16/16
(v2.53.3, after four fixes found by five gate runs). Not yet exercised on a
2026.9 container: a Telegram-connected agent (channel config keys), the
management agent's lockdown, and the `agents.defaults.systemAgent.agentId`
hint doctor prints under explicit ownership. Next: try on one real agent.

**Found on real agents (2026-09-24):** (a) the gateway refuses routes that
carry `X-Forwarded-*` or `Tailscale-*` headers from an address it does not
trust (`proxy_attribution_required`) — the console proxy strips both
(v2.60.0/1); (b) the Control UI page is served with an empty base path and
root-absolute asset links, which through `/v1/agents/<id>/ui/` never load
("Control UI did not start") — the proxy moves the document onto its prefix
(v2.60.3, `src/api/controlUiRebase.ts`). Both passed the gate, which reaches
the gateway from inside the container; the gate now also loads the console
through the proxy (`hatchabot console <agent> --check`).

Make this repeatable: `scripts/candidate-gate.sh <image tag>` (`npm run
gate:candidate -- <tag>`) makes a web-only agent on the live control plane,
pins it to the candidate with `hatchabot image try`, and asserts items 1
(`openclaw doctor --lint` has no errors, `--post-upgrade` no findings, the
memory keys are under the right prefix), 4 (`sessions list`, `cron list`,
`models list`, `devices list` JSON shapes, `--version`), 5 (`sessions.json`,
`devices/pending.json`) and 6 (the console answers at
`?session=agent:<slug>:main`), plus one memory index and a semantic search
(through the shared service when the image has no engine), one real model
turn, and the channel plugins the image claims. Item 3 (the management
agent's lockdown) is not covered: that agent stays pinned and moves last.
The script is the gate for "Try on one agent". *Built in v2.52.0; first run
against `2026.7.1-2-lite`.*

## Build order

Each step ships alone and leaves the fleet as it was.

1. **Embedder + front door** (no agent uses it yet): module, provider
   methods, table, route, ops-door path, Settings → Hosts row showing
   "Embedding service: running / stopped" with Restart. *Built in v2.40.0 as
   a door container: no Hatchabot route, no ops-door path; the row is
   "Memory search service" with Start/Stop/Restart.*
2. **Per-agent switch on today's OpenClaw**: column, writer branch, re-index
   step, health row. Try it on one low-stakes agent, then a handful, for a few
   days. *Built in v2.41.0 (`agents.embed_mode`, `reindexMemoryIfSwitched`);
   first real agent: To Do Agent, 2026-09-23.*
3. **Flip the fleet default** to `shared` for new agents; a Fleet action
   "Move all to the shared memory engine" rebuilds the rest in batches.
   *Built in v2.50.0 (Status → Tools; `HATCHABOT_EMBED_DEFAULT`; move-all now /
   overnight through the rebuild queue and the quiet hours). The default is
   still `baked` until Chris flips it.*
4. **Engine-free images**: `EMBED_ENGINE=none`, the label, the build-script
   rule. 2026.9 candidates now build. Delete the "can't build" sentence.
   *Built in v2.51.0/.1; `hatchabot-runtime:2026.7.1-2-lite` (384 MB
   lighter) is the first such image, proven on To Do Agent on 2026-09-24:
   6/6 files indexed through the shared service, semantic search answers,
   325 MiB. The first try failed on the baked plugin's stale `--link`
   pointer, fixed in v2.51.1.*
5. **The port checklist and the candidate gate script.** Only then "Try on
   one agent" with a 2026.9 candidate. *Gate built in v2.52.0
   (`scripts/candidate-gate.sh`); the 2026.9 candidate itself is item 9 of
   the roadmap.*
6. Later, when every agent is on `shared`: drop the baked steps from the
   Dockerfile default too.

## Tests

- `embedder.test.ts`: container spec (loopback only, read-only, digest pin);
  model bootstrap order; SHA mismatch refuses; override URL starts nothing.
- `embedRoute.test.ts`: no key 401; key of a stopped agent 401; only the one
  path; body and input caps; 429 on the bucket; header swap; bodies never in
  logs; the ops door reaches the same handler.
- `configWriter.test.ts`: `embed` writes the right key family per version,
  marks the key sensitive, and writes none of the baked commands; absent
  `embed` is byte-for-byte today's output.
- `provision.test.ts`: token minted per build, dies on archive; label
  `embed-engine=none` forces `shared`; re-index runs once per mode change.
- `runtimePins.test.ts`: 2026.8+ builds pass `EMBED_ENGINE=none`.
- Drift guard: the Dockerfile's model URL and SHA equal the embedder's.
