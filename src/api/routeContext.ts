import type { IncomingMessage } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Agent } from '../domain/types.js';
import type { AppsAndSources } from '../orchestrator/apps/appsAndSources.js';
import type { Backups } from '../orchestrator/backups/backups.js';
import type { Channels } from '../orchestrator/channels/channels.js';
import type { Consoles } from '../orchestrator/console/consoles.js';
import type { ConnectionsAndAccess } from '../orchestrator/google/connectionsAndAccess.js';
import type { ProblemReports } from '../orchestrator/diagnostics/problemReports.js';
import type { HealthChecks } from '../orchestrator/health/healthChecks.js';
import type { HatchabotAgent } from '../orchestrator/ops/hatchabotAgent.js';
import type { MembersAndInvites } from '../orchestrator/members/membersAndInvites.js';
import type { Schedules } from '../orchestrator/schedules/schedules.js';
import type { AgentLifecycle } from '../orchestrator/lifecycle/agentLifecycle.js';
import type { AgentSettings } from '../orchestrator/lifecycle/agentSettings.js';
import type { Machines } from '../orchestrator/machines/machines.js';
import type { ChangeMeta } from '../orchestrator/usage/modelLedger.js';
import type { AiSources } from '../orchestrator/sources/aiSources.js';
import type { MachineSettings } from '../orchestrator/settings/machineSettings.js';
import type { Reach } from '../orchestrator/reach/reach.js';
import type { Accounts } from '../orchestrator/accounts/accounts.js';
import type { Transfers } from '../orchestrator/transfer/transfers.js';
import type { UsageAndBudgets } from '../orchestrator/usage/usageAndBudgets.js';
import type { Files } from '../orchestrator/files/files.js';
import type { Skills } from '../orchestrator/skills/skills.js';
import type { AgentVoice } from '../orchestrator/voice/agentVoice.js';
import type { MemorySearch } from '../orchestrator/memorySearch/memorySearch.js';
import type { Conversations } from '../orchestrator/conversation/conversations.js';
import type { Consults } from '../orchestrator/consult/consults.js';
import type { AgentMemory } from '../orchestrator/memory/agentMemory.js';
import type { AgentDefinition } from '../orchestrator/definition/agentDefinition.js';
import type { AgentSecrets } from '../orchestrator/agentSecrets/agentSecrets.js';
import type { HomeScreen } from '../orchestrator/homeScreen/homeScreen.js';
import type { ModelChanges } from '../orchestrator/usage/modelChanges.js';
import type { AgentEdits } from '../orchestrator/lifecycle/agentEdits.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import type { ApiDeps } from './routes.js';

/**
 * What route handlers share (HB-0806).
 *
 * `registerRoutes` (routes.ts) builds one of these, once, from its own
 * functions, and hands it to each feature file:
 *
 *   export function registerXRoutes(app: FastifyInstance, ctx: RouteContext): void
 *
 * A feature file is written against this type and its own imports, and never
 * imports routes.ts for a value. `src/api/agents/inspectRoutes.ts` is the first;
 * `src/api/agents/classRoutes.ts` and `src/api/agents/modelRoutes.ts` are the first with a
 * service behind them (HB-0807); `src/api/usage/aiSourceRoutes.ts` and
 * `src/api/chat/channelRoutes.ts`, `src/api/data/backupRoutes.ts`, `src/api/data/appRoutes.ts`,
 * `src/api/console/browserRoutes.ts`, `src/api/console/consoleRoutes.ts`, `src/api/machine/machineRoutes.ts`,
 * `src/api/machine/imageRoutes.ts`, `src/api/chat/memberRoutes.ts`, `src/api/usage/usageRoutes.ts`,
 * `src/api/data/scheduleRoutes.ts`, `src/api/data/googleRoutes.ts`, `src/api/agents/lifecycleRoutes.ts`,
 * `src/api/ops/opsAgentRoutes.ts`, `src/api/ops/problemReportRoutes.ts`, `src/api/machine/healthRoutes.ts`,
 * `src/api/data/transferRoutes.ts`, `src/api/data/adoptRoutes.ts`, `src/api/data/skillRoutes.ts`,
 * `src/api/console/voiceRoutes.ts`, `src/api/data/fileRoutes.ts`, `src/api/machine/machineSettingsRoutes.ts`,
 * `src/api/machine/embedderRoutes.ts`, `src/api/chat/conversationRoutes.ts`, `src/api/machine/tailscaleRoutes.ts`,
 * `src/api/machine/configRoutes.ts` and `src/api/signIn/accountsRoutes.ts` the next (HB-0808).
 *
 * What is NOT here, on purpose:
 *  - who is asking: `ownerIdOf`, `principalOf` and `internalPrincipal` are
 *    imported from principal.ts;
 *  - the busy flag itself: `isBusy`, `whileBusy`, `markBusy` and
 *    `AgentBusyError` are imported from orchestrator/lifecycle/busy.ts;
 *  - a feature's own state (its Maps, Sets, queues and timers). That moves
 *    with the feature, into a service in src/orchestrator/ with an explicit
 *    interface (HB-0807, HB-0808). A service other features call is a field
 *    here (`lifecycle`, `settings`, `sources`, `channels`, `backups`, `apps`, `consoles`,
 *    `machines`, `members`, `usage`, `schedules`, `google`, `hatchabotAgent`,
 *    `problemReports`, `health`, `transfers`, `files`, `skills`, `voice`,
 *    `machineSettings`, `memorySearch`, `conversations`, `reach`, `accounts`); the
 *    context exposes functions, never a Map.
 */
export interface RouteContext {
  // ---- what the server was started with -----------------------------------
  /** Everything `registerRoutes` was given (the test seams too). */
  deps: ApiDeps;
  /** `deps.store` and `deps.secrets`, by the names every handler uses. */
  store: Store;
  secrets: SecretStore;

  // ---- the two things nearly every handler asks for -----------------------
  /**
   * A line to the log AND to the agent's timeline: `trace(agent.id)` gives
   * the function that takes the event's name and its detail. With no id, the
   * timeline line goes to `detail.agentId` when there is one. A new event
   * name needs its plain words in orchestrator/health/eventLabels.ts.
   */
  trace: (agentId?: string) => Trace;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;

  // ---- the principal and ownership checks ---------------------------------
  /** The agent, when it exists and the caller owns it. Everything that changes an agent asks this. */
  ownedAgent: (req: FastifyRequest, id: string) => Agent | undefined;
  /** The agent, when the caller owns it or is an active member of it. Read-only surfaces. */
  visibleAgent: (req: FastifyRequest, id: string) => Agent | undefined;
  /** Is the caller the account that set this machine up? Refuse with MACHINE_OWNER_ONLY when not. */
  ownsLocalHost: (req: FastifyRequest) => boolean;
  /** Deleted or being deleted: nothing more is stored for it. Ask again after any wait (AGENT_GONE). */
  agentGone: (id: string) => boolean;
  /**
   * Why the caller may not have one more live agent, or undefined. A pass
   * holds a place for this request until it answers, so every path that
   * creates or revives an agent asks it exactly once.
   */
  capProblem: (req: FastifyRequest) => string | undefined;
  /**
   * The agent this request makes exists now and counts itself: the place
   * capProblem held for it goes, in the turn its row is made. Held on until
   * the answer, one agent counted twice while a clone or an import went on
   * copying, and a second creation was refused as over the cap (HB-1121).
   */
  capRowMade: (req: FastifyRequest) => void;
  /** The only shape an Agent leaves this process in (no gateway token; less for a member). */
  publicAgent: (agent: Agent, extra?: Record<string, unknown>) => Record<string, unknown>;
  /**
   * The agent, when the caller owns it and it is running. Otherwise answered
   * here and undefined: 404, or 409 "Start the agent to <action>." (asleep:
   * "It is asleep — wake it to <action>."). `action` defaults to managing
   * its scheduled tasks.
   */
  runningAgent: (req: FastifyRequest, id: string, reply: FastifyReply, action?: string) => Agent | undefined;

  // ---- busy: each answers the refusal itself and returns true -------------
  /** 409 when this copy was moved to another Hatchabot. */
  movedAway: (agent: Agent, reply: FastifyReply) => boolean;
  /** 409 when a long operation on disk (operations.ts) is not over. */
  operationRefuses: (agent: Agent, reply: FastifyReply) => boolean;
  /**
   * operationRefuses, or 409 when the agent is busy or being archived.
   * `deleting`: a Delete goes through a hold it ends (operations.ts holdDeleteEnds).
   */
  busyNow: (agent: Agent, reply: FastifyReply, opts?: { deleting?: boolean }) => boolean;
  /** Is an archive of this agent under way? (busyNow's last check, for a route that words its own refusal.) */
  isArchiving: (agentId: string) => boolean;
  /**
   * One request at a time for a key (a double-click): false when another
   * request holds it. Let go when the request answers, or after ten minutes.
   */
  holdOnce: (req: FastifyRequest, key: string) => boolean;

  // ---- the setup and rebuild queue (the agent lifecycle service's, `lifecycle.queue`)
  /** Start setup in the background, unless one or a rebuild is in flight for the agent. */
  kickProvision: (agentId: string, opts?: { webOnlyIfNoBot?: boolean; queuedSince?: number }) => void;
  /** Setup for an answered bot-token step: now, or once what holds the agent lets go. */
  provisionWhenFree: (agentId: string, since?: number) => void;
  /**
   * Queue a rebuild in the background. False, and nothing queued, when a
   * setup or rebuild is in flight for the agent, a long operation on it is
   * not over, this copy moved away, or it has no runtime.
   */
  kickRebuild: (agentId: string, opts?: { checkpoint?: boolean; recoverOn?: string; resume?: { opId: string; was: Agent } }) => boolean;
  /** Keep a change for the agent's next start or wake, which is then a rebuild. Returns the stamp. */
  oweRebuild: (agentId: string, log?: Trace) => string;
  /**
   * A change only a new container picks up: a running agent is rebuilt now, a
   * stopped one owes it at its next start. `was` is the agent as it was
   * before the change.
   */
  rebuildOrOwe: (was: Agent, opts?: { handover?: boolean }) => 'rebuilding' | 'next-start' | 'not-started';

  // ---- the model-change ledger (orchestrator/usage/modelLedger.ts) --------------
  /**
   * Record each agent whose model moved since `before` (snapshotModels), as
   * this request's change: who made it and how are read from the request
   * (a confirmed card, a Recommended item, the app or the API; `why` in its
   * body). `source`: what moved it ('model', 'class', 'source-switch'…).
   * Never fails the change it follows.
   */
  recordLedger: (req: FastifyRequest, source: string, before: Map<string, string | undefined>) => void;
  /** Snapshot these agents' models, run the change, and record each agent whose model moved. */
  ledgered: <T>(req: FastifyRequest, source: string, agentIds: Iterable<string>, change: () => T | Promise<T>) => Promise<T>;
  /** Who made this request's change and how, as recordLedger reads it (a budget's or a step's token action uses it too). */
  ledgerMeta: (req: FastifyRequest, source: string) => ChangeMeta;

  // ---- a console request held to its browser session (consoleRoutes.ts) ---
  /**
   * Watch a console request or handshake across its waits: `valid()` is
   * false once its browser signed out, its cookie signs in someone else, or
   * at the public address the gate's rules no longer let it in. `done()`
   * when it has answered (consoleSessionWatch).
   */
  watchConsoleSession: (req: FastifyRequest | IncomingMessage, me: string) => { valid: () => boolean; done: () => void };
  /** watchConsoleSession for an HTTP request: done when its reply ends, and not valid once the reply is gone. */
  watchConsoleHttp: (req: FastifyRequest, reply: FastifyReply, me: string) => { valid: () => boolean; done: () => void };

  // ---- the machines (routes.ts, until the machines feature moves) ----------
  /** A machine already known not to answer: an agent list lookup on it ran out of time within the last minute. */
  hostKnownAway: (hostId: string) => boolean;
  /** A runner whose removal is under way (`removingHosts`): nothing is created, imported or moved onto it (HOST_GOING). */
  hostBeingRemoved: (hostId: string) => boolean;

  // ---- addresses (the reach service's) and sign-in (routes.ts) -------------
  /**
   * The address to show people (a QR code, the app's own pages, a note's
   * link): HATCHABOT_PUBLIC_URL, or the tailnet's when that is unset or
   * loopback (`reach.address.appUrl`).
   */
  appUrlFor: () => string | undefined;
  /**
   * The base of a link made for someone else (an invite): the public address
   * while public access is on and serving, else the private one. Never from a
   * request's Host.
   */
  linkUrlFor: () => string | undefined;
  /** Password accounts sign in here: accounts mode, or Google sign-in with them added (docs/identity.md). */
  localAccountsOn: () => boolean;

  // ---- long changes in the background (operations.ts) ---------------------
  /** `?wait=1` (or true, yes): answer when it is over, as older CLIs and scripts expect, not 202. */
  waitAsked: (req: FastifyRequest) => boolean;
  /** The 202: the operation as the page shows it, and its agent when there is one. */
  accepted: (reply: FastifyReply, opId: string) => FastifyReply;
  /** What a background operation threw (runInBackground's onError): its outcome is on its row; the journal gets the rest. */
  backgroundError: (err: unknown, opId: string) => void;

  // ---- services (src/orchestrator/) ---------------------------------------
  /**
   * The agent lifecycle: the setup and rebuild queue (`queue`, whose
   * functions are also the five above), the machine's own rebuilds and their
   * settings (`rebuilds`), Start, Stop, sleep and wake (`power`), and the
   * owner's choice for a held operation (`operations`) (HB-0808). It owns the
   * queue and the sweep's timer.
   */
  lifecycle: AgentLifecycle;
  /**
   * Classes, models and memory limits: what each agent runs on, and how a
   * change of it reaches the agent (HB-0807). It owns its queues, holds and
   * timers; a route asks it and words the answer.
   */
  settings: AgentSettings;
  /**
   * AI sources: agents moved onto a source in bulk, a new default model
   * applied to the agents on one, and the models a source can switch between
   * (HB-0808). It keeps no state: the holds on a source are `settings`'.
   */
  sources: AiSources;
  /**
   * Telegram, Discord and Slack: an agent's bots (`bots`) and the people
   * knocking on them (`knocks`) (HB-0808). It owns the bot-name cache, the
   * knock cache and the pairing sweep's timers.
   */
  channels: Channels;
  /**
   * Backups, snapshots and restores: an agent's snapshots (`snapshots`), the
   * backup sets and a restore from one (`sets`), recovery readiness and the
   * restore drills (`drills`) (HB-0808). It owns the drill schedule's timer.
   */
  backups: Backups;
  /**
   * Apps in agents and data sources: an agent's app (`installed`: install,
   * update, roll back, stop, and the install that waits for its setup) and
   * its git repos and folders (`dataSources`) (HB-0808). It owns their locks;
   * it has no timer.
   */
  apps: AppsAndSources;
  /**
   * The console and the browser panel: who may reach which agent's OpenClaw
   * console and what ends it once open (`gateway`), each agent's own browser
   * kept in step (`browsers`), and "Sign in to a site" (`panels`) (HB-0808).
   * It owns the console handshakes and sockets, the open panels, and the
   * three sweeps' timers.
   */
  consoles: Consoles;
  /**
   * Machines, runners and images: this machine and its runners (`hosts`),
   * Install image (`installs`), live CPU and memory (`resources`), and the
   * runtime images (`images`) (HB-0808). It owns the image copies, the stats
   * cache, the builds' state and the base build under way (its ceiling timer
   * and its process group, which `stop()` ends).
   */
  machines: Machines;
  /**
   * Usage, costs and budgets: the usage pass every ten minutes and the steps
   * after it (`sampler`), the budget pass, its pauses and the budgets and
   * step alarms set (`budgets`), the cost badges and the fleet's live use
   * (`readings`), and Recommended (`recommended`) (HB-0808). It owns the
   * passes, the cost cache, the context caps' back-off and three timers.
   */
  usage: UsageAndBudgets;
  /**
   * Members, invites and web chat: who may use an agent besides its owner
   * (`roster`: the members, web chat for one, sharing for web chat, removing
   * one, the people known from another agent) and how they come to
   * (`invites`: a new invite, the knock window, joining by one) (HB-0808).
   * No state and no timer.
   */
  members: MembersAndInvites;
  /**
   * Scheduled tasks: an agent's tasks (`tasks`: the list, a new one, an edit,
   * on or off, run now, its runs, delete, the template tasks still waiting),
   * the passes over every running agent's tasks (`sweeps`) and the
   * permission to run event-triggered tasks (`triggers`) (HB-0808). It owns
   * the quick pass's memory, the permission's queue and the passes' timers.
   */
  schedules: Schedules;
  /**
   * Google connections and what each agent can reach: the installation's
   * OAuth client and the consent round-trip (`client`), a new client secret
   * reaching the agents owed it (`delivery`), the connection vault, attach,
   * detach and Disconnect (`vault`), and Verify now (`access`) (HB-0808). It
   * owns the consent states, the deletes and verifications under way, the
   * secret's back-offs and the client-secret pass's timer.
   */
  google: ConnectionsAndAccess;
  /**
   * The Hatchabot agent: the account's management agent made once, a turn in
   * its own conversation and the notes posted there, asking it which agents
   * to add, who may use its door, and the operator's profile pushed into the
   * running agents (HB-0808). It owns the doormen's addresses, the profile
   * pushes' chain and the lockdown check's timer.
   */
  hatchabotAgent: HatchabotAgent;
  /**
   * Report a problem: the facts a report carries, what a public report must
   * not carry, the drafts, the known problems and the installed source
   * (HB-0808, docs/field-reports.md). No state and no timer.
   */
  problemReports: ProblemReports;
  /**
   * Health, logs and events: an agent's live health, its event trail and
   * Activity, the security posture, the limits check and each agent's
   * storage (HB-0808). It owns what the limits check has said and its two
   * timers.
   */
  health: HealthChecks;
  /**
   * Moves, import and export: an agent moved to another machine or another
   * Hatchabot and the servers this account knows (`moves`), the whole agent
   * as a file and back, a template and back, clone and derive (`copies`),
   * sharing in the app (`inbox`), and what was made outside Hatchabot brought
   * in (`adopts`) (HB-0808). It owns the deferred adopts' memory; no timer.
   */
  transfers: Transfers;
  /**
   * An agent's files: its core-files turn, the one queue every change that
   * writes its files and its AGENTS.md writers share (`turns`), its core
   * files read and saved (`core`), and its home browsed, downloaded and
   * uploaded to (`home`) (HB-0808). It owns the turn's queue and the
   * deadlines of the changes waiting for it.
   */
  files: Files;
  /**
   * Curated skills per agent: the library, an instruction file previewed and
   * changed, practice and the running agent's inventory (HB-0808). It owns
   * the practice cooldown and the coalesced status reads.
   */
  skills: Skills;
  /** Browser voice: Talk's readiness and its setup (HB-0808). No state and no timer. */
  voice: AgentVoice;
  /**
   * Keys, web search and the machine's defaults: the fleet's Gemini and
   * Brave keys (`keys`: set or not, saved, shown again to the machine's
   * owner only, removed), which search the fleet uses and an agent's search
   * test (`search`, with the one search watch), and Defaults for this
   * machine (`defaults`) (HB-0808 step 15). It owns the search watch's tick.
   */
  machineSettings: MachineSettings;
  /**
   * The memory search service: this machine's embedding service (`local`;
   * the image routes read whether it is on, or an external server is named,
   * HATCHABOT_EMBED_URL: an image without its own engine is built or
   * promoted only then), each runner's own (`serviceFor`), what provisioning
   * asks of them, the fleet's engine choice and the guests' door (HB-0808).
   * It owns the runners' services and the boot start and health loop.
   */
  memorySearch: MemorySearch;
  /**
   * An agent's conversations as Hatchabot reads them: its sessions file
   * cached, "last active", the unread mark, the Recent list (HB-0808,
   * HB-0826). It owns the sessions and quiet tasks' caches and the Recent
   * capture; no timer of its own.
   */
  conversations: Conversations;
  /**
   * The agent-to-agent consult and its peers: the one turn per agent
   * (`turns`, which the idle sweep reads), the call token, the grant and the
   * depth limit; which agents may consult which, and the mesh (HB-0808 step
   * 13). It owns `a2aInFlight`, the caller holds, the per-owner count and the
   * call token mints; no timer.
   */
  consults: Consults;
  /**
   * An agent's memory and the turns in its conversation: checkpoint, ask,
   * the chat history and Recover context, compact and the context cap, a
   * child's distillation and its merge (HB-0808 step 13). It owns
   * `recovering` and its slots' timers, which `stop()` ends.
   */
  memory: AgentMemory;
  /**
   * An agent's definition: its setup values applied to its files, and a
   * master's definition pushed to its children, each in the agent's
   * core-files turn (HB-0808 step 15, part C). No state, no timer.
   */
  definition: AgentDefinition;
  /**
   * An agent's secrets its owner hands it: its environment values (in the
   * secret store, never answered) and the bot token its parked setup waits
   * for (HB-0808 step 15, part C). No state, no timer.
   */
  agentSecrets: AgentSecrets;
  /**
   * The home screen, per owner: the order of the agents and their groups,
   * their icons, and the agents planned for later (HB-0808 step 15, part
   * C). It owns the icons' two locks (`iconRuns`, `iconIdeaRuns`); no timer.
   */
  homeScreen: HomeScreen;
  /**
   * The model steward's two reads, the model options and the model-change
   * ledger, and the ledger's start-up (HB-0808 step 15, part C). No state,
   * no timer.
   */
  modelChanges: ModelChanges;
  /**
   * How the app is reached: its addresses (`address`: the one shown and the
   * one for links sent to people, with the tailnet probe's timers),
   * Tailscale's setup (`tailscale`) and what the sign-in screen and the page
   * read, masked at the public address (`config`) (HB-0808 step 15). It owns
   * the probe's two timers.
   */
  reach: Reach;
  /**
   * Accounts, beside the sign-in itself (auth.ts, accountsAuth.ts): the
   * switch to an account per person (`family`), "Forgot password?" by
   * Telegram (`recovery`, with its throttles), the CLI tokens (`cliTokens`)
   * and the people on one's agents (`people`) (HB-0808 step 15). It owns the
   * recovery counts, the roster's thread cache and the switch's restart timer.
   */
  accounts: Accounts;
  /**
   * An agent's own settings changed (PATCH /v1/agents/:id; HB-0825): the
   * checks in their order, the holds, the one transaction and what follows
   * from it. No state, no timer.
   */
  agentEdits: AgentEdits;
}

/** What `trace(agentId)` returns: an event name and its detail. */
export type Trace = (event: string, detail: Record<string, unknown>) => void;

// ---- words and helpers every feature file uses -----------------------------
// Stateless, so they are plain exports rather than fields of the context.

/** Shown when a non-machine-owner tries an action that touches the machine
 *  itself — runtime images, runner setup, host probes. Not for anything a
 *  member legitimately owns (their bots, their agents, their sources). */
export const MACHINE_OWNER_ONLY =
  'Only the account that set up this machine can do that — it touches the machine itself ' +
  '(its runtime images, hosts and runners), not just your own agents.';

/** The one answer every "add a person" route gives the management agent. */
export const OPS_ALONE = 'Your Hatchabot agent is yours alone.';

/** A pasted token is checked with its platform: the login throttle said no. */
export const TOKEN_CHECK_THROTTLED = 'Too many token checks — wait a few minutes and try again.';

/** Shown when a non-machine-owner tries to name a host path. */
export const HOST_PATH_DENIED =
  'Only the account that set up this machine can mount or adopt host folders. ' +
  'Ask them to share the folder with your agent, or import an exported agent instead.';

/** The answer while a runner is being removed: nothing is created, imported or moved onto it. */
export const HOST_GOING = 'That host is being removed.';

/** An import whose body carries a template's setup answers ahead of the file (HB-0093). */
export const IMPORT_WITH_VALUES = 'application/vnd.hatchabot.import';
/** The most the answers' line may take: 24 answers of 2,000 characters, each escaped at worst. */
export const IMPORT_HEAD_MAX_BYTES = 512 * 1024;

/** The answer when `agentGone` says so. */
export const AGENT_GONE = 'It was deleted.';

/**
 * A docker image tag, with its repository: what a pin, a class's image or a
 * build may name. The repository may begin with a registry's host and port
 * (`registry.example:5000/runtime`): without it, a fleet whose default is in
 * such a registry could pin no image, the manager's own included (HB-1357).
 */
export const IMAGE_TAG_RE = /^(?:[a-z0-9][a-z0-9.-]*:[0-9]{1,5}\/)?[a-z0-9][a-z0-9._\/-]*:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Route option: never compress this response. For downloads and streams
 *  (already compressed, or sent with a length the client checks) and the
 *  console proxy (review, 2026-09-29). */
export const NO_COMPRESS = { compress: false } as const;

/** A page size from the query: a whole number in 1–max, else `def`. A
 *  fractional one reached SQLite's LIMIT as 1.5 and failed with a 500
 *  (audit, 2026-10-22). */
export function queryLimit(raw: unknown, def: number, max: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : def;
}

/** Text made safe to put in a small HTML page Hatchabot writes itself (the console's "machine away", Google's consent pages). */
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Zod issues render as "Request failed" in the app; send a sentence. */
export function zodMessage(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Invalid input';
  const where = i.path.length ? `${i.path.join('.')}: ` : '';
  return `${where}${i.message}`;
}
