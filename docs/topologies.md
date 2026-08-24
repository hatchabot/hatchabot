# Topologies: Mesh and Cluster

Two ways to run AgentClaw across more than one machine. They are **different
axes**, not competing designs — you can run one, the other, or both at once.

The distinguishing question: **does each machine have its own control plane, or
is there one control plane plus dumb runners?**

## Mesh — independent control planes that peer

Every machine is a full, self-governing AgentClaw **node**: its own control
plane, its own DB, its own login. Nodes are linked as **peers** (⚙ Settings →
Servers / `agentclaw servers add`) and agents move between them with **Rehost**,
which carries the agent's whole state (bot token, memory, members) and re-binds
it to a vendor-matched AI profile on the destination.

- **Mechanism:** the `peers` table + Rehost (`src/orchestrator/migrate.ts`).
- **You see:** one dashboard per node.
- **Status:** shipped.
- **Good for:** your own boxes — e.g. a DGX at home + a cloud VM, for one person.
  Low incremental complexity; each node is self-contained.

## Cluster — one control plane, many runner hosts

One machine is *the* **control plane**; the others are **runners** — runtime
only, no control plane of their own. The control plane owns a single DB and a
single login, sees every agent in one dashboard, and *places* each agent on a
host (local or a remote runner).

- **Mechanism:** the `hosts` abstraction + a remote-capable provider
  (`LocalDockerProvider({ host: 'ssh://…' })` — M2). Runners are reached over a
  remote Docker endpoint; the control plane stays sqlite-on-one-box until it
  needs to scale horizontally (then, and only then, Postgres).
- **You see:** one dashboard for everything.
- **Status:** in progress (M2). Step 1 — the remote-capable provider — is done.
- **Good for:** a multi-user **hosted** product. Higher complexity: placement,
  remote lifecycle, fleet health, tenant isolation.

## How they compose

A Cluster's control plane is *just a control plane*, so it can also be a **peer
node in a Mesh**. A hosted Cluster could Rehost an agent to your personal home
node and back. Concretely: Mesh extends the `peers` abstraction, Cluster extends
the `hosts` abstraction — they never collide, so nothing built for one is thrown
away when you add the other.

Recommended path: **start as a Mesh** (shipped, cheap) for personal cloud+DGX
use; **grow a Cluster** only when a single-pane, multi-user hosted product is the
actual goal.

## Orthogonal: topology vs AI credential

Topology (Mesh/Cluster) is *how boxes relate*. It is independent of **which AI
credential an agent uses**, which is decided per host kind:

- **Claude Max — machine login** (`subscription`, no stored token) runs only on
  **local/desktop hosts**: it reuses this box's `~/.claude` via a host mount a
  remote daemon can't see, so provision refuses it on a non-local host.
- **Claude Max — setup-token** (`subscription` + a stored `claude setup-token`)
  runs **anywhere, including a runner** — the token is injected as
  `CLAUDE_CODE_OAUTH_TOKEN`, no mount (`provision.ts`, `test/provision.test.ts`).
- **API key** (`api_key` profile) runs anywhere, including **cloud** runners.

Both topologies carry both: Max agents on local/desktop hosts, API-key agents on
cloud hosts. See `cloud-hosting.md` for the Cluster build and the Max-vs-API
economics.
