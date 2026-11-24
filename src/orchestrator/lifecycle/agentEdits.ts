import { existsSync } from 'node:fs';
import { z } from 'zod';
import { effectiveMemoryCap } from '../../domain/memoryCap.js';
import { TemplateParamSchema } from '../../domain/templateParams.js';
import type { AIProfile, Agent } from '../../domain/types.js';
import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import { setTelegramDisplayName } from '../../channels/telegramName.js';
import { VOLUME_GONE, type RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import { SourceGoneError, type Store } from '../../store/store.js';
import { validIcon, validIconColor } from '../homeScreen/agentIcons.js';
import type { ChatBots } from '../channels/chatBots.js';
import { announceToMembers } from '../members/members.js';
import type { CronTriggers } from '../schedules/triggers.js';
import { isBusy } from './busy.js';
import { operationRefusal } from './operations.js';
import { OPS_NO_LOCAL } from '../ops/hatchabotAgent.js';
import { sharePathProblem } from './provision.js';
import { MACHINE_LOGIN_NO_RUNNER } from './agentRecords.js';
import type { ClassChanges, Detach } from './classChanges.js';
import { keptSaid, memoryCapProblem, swapAllowanceProblem, type Kept, type MemoryLimits } from './memoryLimits.js';
import type { RebuildQueue } from './rebuildQueue.js';
import type { SourceHolds } from './sourceHolds.js';
import { machineLoginOnly, modelOverrideProblem, type ModelRuntime } from './modelRuntime.js';

/**
 * PATCH /v1/agents/:id's body: an agent's own settings, each optional (HB-0814).
 * Parsed once, where the route first reads the body, after its owner check.
 */
export const AgentEditBody = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    /** The card's one-line description (stored persona). Cosmetic and
     *  immediate — it does NOT touch the running SOUL.md, which is edited
     *  as a file in the Definition tab. Empty string clears it. */
    persona: z.string().max(4000).optional(),
    sharedMemory: z.boolean().optional(),
    /** Switch which AI drives this agent — applied on the next rebuild. */
    aiProfileId: z.string().min(1).optional(),
    /**
     * Per-agent model override, chosen from the profile's menu — applied
     * on the next rebuild. `null` clears it (back to the profile default).
     */
    model: z.string().min(1).max(64).nullable().optional(),
    /** Clear the moved-away tombstone: "this really does run here now". */
    runsHere: z.literal(true).optional(),
    /** Host folders this agent may READ. Applied on the next rebuild. */
    sharedPaths: z.array(z.string().min(1).max(512)).max(8).optional(),
    /** Organize into a group; empty string or null clears it. Cosmetic —
     *  takes effect immediately, no rebuild. */
    group: z.string().trim().max(48).nullable().optional(),
    /**
     * Pin this agent to a runtime image (candidate build, derived image
     * with extra packages). `null` returns it to the fleet default.
     * Applied on the next rebuild.
     */
    image: z.string().trim().min(1).max(200).nullable().optional(),
    /**
     * Setup fields this agent's shares/templates ask the importer to
     * fill (sharing Phase 2a). `null`/empty clears them. Keys must be
     * unique — two fields fighting over one placeholder is authoring
     * error, not a merge.
     */
    parameters: z
      .array(TemplateParamSchema)
      .max(24)
      .refine((a) => new Set(a.map((p) => p.key)).size === a.length, {
        message: 'parameter keys must be unique',
      })
      .nullable()
      .optional(),
    /**
     * Telegram group access: off | members | room (one bound chat id,
     * mention-gated open). Applied on the next rebuild. `null` clears
     * back to OpenClaw's default (members-only).
     */
    groupAccess: z
      .object({
        mode: z.enum(['off', 'members', 'room']),
        roomId: z.string().regex(/^-?\d{1,20}$/).optional(),
      })
      .refine((g) => g.mode !== 'room' || !!g.roomId, {
        message: 'room mode needs the bound group chat id',
      })
      .nullable()
      .optional(),
    /** Telegram rich formatting. Applied on the next rebuild. `null`
     *  clears back to the managed default (on). */
    richMessages: z.boolean().nullable().optional(),
    cronTriggers: z.boolean().optional(),
    /** Its own browser (src/orchestrator/console/browser.ts). Rebuilds it to apply. */
    browser: z.boolean().optional(),
    /** Memory search engine: the image's own, or the machine's shared service. Applies on rebuild. */
    embedMode: z.enum(['baked', 'shared']).optional(),
    /** Memory cap on its container ("4g"); `null` = back to its class's / the fleet default. Applied live. */
    memoryCap: z.string().max(16).nullable().optional(),
    /** Swap on top of the cap ("2g" or "off"); `null` = back to its class's / the fleet setting. Applied live; given only where the host compresses swap. */
    swapAllowance: z.string().max(16).nullable().optional(),
    /** Home-screen icon: one emoji, and a #rrggbb tint. Cosmetic and
     *  immediate. `null` clears (the app then shows a picked default). */
    icon: z.string().refine(validIcon, { message: 'icon must be a single emoji' }).nullable().optional(),
    iconColor: z.string().refine(validIconColor, { message: 'iconColor must look like #3a8fd0' }).nullable().optional(),
    /** Clear it from Alerts: what was flagged, as the app fingerprints it; it shows again when that changes. `null` shows it again now. */
    attentionAck: z.string().max(4000).nullable().optional(),
    /** `never` keeps this agent awake whatever HATCHABOT_HIBERNATE_AFTER says; `null` follows the machine. */
    hibernate: z.enum(['never']).nullable().optional(),
    filesMaxMb: z.number().int().min(1).max(1000).nullable().optional(),
  });
/** What PATCH /v1/agents/:id asks for, parsed. */
export type AgentEditAsk = z.infer<typeof AgentEditBody>;

/** Why not, with the status the route answers and its words; `extra` goes in the answer beside `error` (an operation's id, the public address's step-up). */
export type EditRefusal = { ok: false; status: number; error: string; extra?: Record<string, unknown> };
const refuse = (status: number, error: string): EditRefusal => ({ ok: false, status, error });
/** The change stored, and what the caller is shown: the agent as it is now, with what is still to come said. */
export type EditDone = { ok: true; answer: Record<string, unknown> };

/** The words a route answers when the caller is not this machine's owner (MACHINE_OWNER_ONLY in src/api/routeContext.ts; test/agentEditsService.test.ts holds them equal). */
const MACHINE_OWNER_ONLY =
  'Only the account that set up this machine can do that — it touches the machine itself ' +
  '(its runtime images, hosts and runners), not just your own agents.';
/** The agent deleted meanwhile (AGENT_GONE in src/api/routeContext.ts). */
const AGENT_GONE = 'It was deleted.';
/** A source switch while a rebuild, a move or a backup holds the agent (HB-0063). */
export const SOURCE_SWITCH_BUSY = 'The agent is busy (a rebuild, a move or a backup) — switch its AI source when that is done.';

/** Who is asking, as the route reads it from the request. Each is asked only where the checks ask it. */
export interface EditCaller {
  /** The caller's account (`ownerIdOf`). */
  ownerId: string;
  /** Is the caller the account that set this machine up? */
  ownsLocalHost(): boolean;
  /** This request's hold on a key until it answers (the route's `holdOnce`): false when another request holds it. */
  holdName(key: string): boolean;
  /** At the public address, the second factor again: the refusal to answer, or undefined. */
  stepUp(): EditRefusal | undefined;
  /** The model change in the ledger, with who made it and how (the routes' recordLedger, against the models as they were before the body was read). */
  ledger(source: 'model' | 'source-switch'): void;
}

/** What the checks found: the change to make, as the writes need it. */
export interface AgentEdit {
  /** The agent as the route found it. */
  agent: Agent;
  data: AgentEditAsk;
  /** The folders asked for, trimmed, blanks left out. */
  sharedPathList?: string[];
  /** A source switch (to `data.aiProfileId`). */
  switchingProfile: boolean;
  /** The source it will have. */
  target?: AIProfile;
  /** The image pinned is the one it runs (imagePinCheck). */
  sameImage?: boolean;
  /** A source switch strands its pin there (finalModelCheck). */
  dropRuntimePin: boolean;
}

/**
 * An agent's own settings changed (PATCH /v1/agents/:id; HB-0825): who may
 * change what, in the order it is checked, and (`then`) the change. Nothing
 * here knows HTTP: a refusal is a result the route answers.
 */
export interface AgentEdits {
  /**
   * Every check made before the first write, in its order, with its waits
   * (a bot's token read, the image's and the runtime's checks). The change
   * goes to `then` in the same tick as the last check: the source looked up
   * last is held by `then` from that look (HB-0570), as nothing may run
   * between the two.
   */
  check<T>(agent: Agent, data: AgentEditAsk, caller: EditCaller, then: (edit: AgentEdit) => Promise<T>): Promise<T | EditRefusal>;
  /**
   * The change, checked (`check`) and made: the agent's own cap and swap
   * allowance on its container in its limits turn, every store write in one
   * transaction, judged again there, under the hold on the source it
   * switches to; then what follows outside the store (the traces, a
   * rebuild or a start owed, the triggers and the files limit applied, the
   * renames, the ledger, the memory budget). A refusal from inside the
   * holds comes once they let go, the container put back on what is stored.
   */
  edit(agent: Agent, data: AgentEditAsk, caller: EditCaller): Promise<EditDone | EditRefusal>;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface AgentEditsDeps {
  store: Store;
  /** A Telegram bot's token, read to see it is still here ("runs here"). */
  secrets: SecretStore;
  /** Is this machine's memory search service on, or an external one named (HATCHABOT_EMBED_URL)? */
  searchServiceOn: () => boolean;
  /** The image pin's check (the agent settings service's). */
  imagePinCheck: ModelRuntime['imagePinCheck'];
  /** The one check of what it will run (the agent settings service's). */
  finalModelCheck: ModelRuntime['finalModelCheck'];
  /** A line to the log AND to the agent's timeline: `trace(agent.id)` gives the function that takes the event and its detail. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** The Telegram bots: the pool a pool bot's rename goes through. */
  channel: Pick<CompositeTelegramProvisioner, 'pool' | 'syncDisplayName'>;
  /** Telegram's Bot API for the owner's own bot's rename, as the routes hand it in (the global fetch without one). */
  telegramFetch?: typeof fetch;
  /** Deleted, or being deleted (the routes' agentGone). */
  agentGone: (id: string) => boolean;
  /** The agent settings service's: the source's hold, the agent's limits turn and its limits, and a class let go. */
  withSourceHold: SourceHolds['withSourceHold'];
  inLimitsTurn: MemoryLimits['inLimitsTurn'];
  applyCurrentLimits: MemoryLimits['applyCurrentLimits'];
  setMemoryCap: MemoryLimits['setMemoryCap'];
  setSwapAllowance: MemoryLimits['setSwapAllowance'];
  tellMemoryBudget: MemoryLimits['tellMemoryBudget'];
  detachClassIfDrifted: ClassChanges['detachClassIfDrifted'];
  /** The rebuild queue's: a rebuild owed at its next start, or started now. */
  oweRebuild: RebuildQueue['oweRebuild'];
  rebuildOrOwe: RebuildQueue['rebuildOrOwe'];
  /** The event-trigger permission applied (the schedules service's). */
  applyCronTriggers: CronTriggers['applyCronTriggers'];
  /** Its file ceiling written to each of its apps (the routes' applyFilesCap). */
  applyFilesCap: (agent: Agent) => Promise<{ gone: boolean }>;
  /** The chat bots service's: a bot's name and the other apps' renames. */
  forgetBotName: ChatBots['forgetBotName'];
  connectorFor: ChatBots['connectorFor'];
  renameChannelBot: ChatBots['renameChannelBot'];
  /** The agent as the routes show it (publicAgent). */
  view: (agent: Agent, extra?: Record<string, unknown>) => Record<string, unknown>;
}

export function createAgentEdits(deps: AgentEditsDeps): AgentEdits {
  const { store, secrets, searchServiceOn, imagePinCheck, finalModelCheck, trace, providerFor, channel, agentGone } = deps;
  const { withSourceHold, inLimitsTurn, applyCurrentLimits, setMemoryCap, setSwapAllowance, tellMemoryBudget, detachClassIfDrifted } = deps;
  const { oweRebuild, rebuildOrOwe, applyCronTriggers, applyFilesCap, forgetBotName, connectorFor, renameChannelBot, view } = deps;

  /** 409 while a long operation on disk (operations.ts) is not over: its line, and its id beside it (the routes' operationRefuses). */
  const refusedOnDisk = (agent: Agent): EditRefusal | undefined => {
    const onDisk = operationRefusal(store, agent.id);
    if (!onDisk) return undefined;
    return { ok: false, status: 409, error: onDisk, extra: { operation: store.activeOperationFor(agent.id)?.id } };
  };

  const check: AgentEdits['check'] = async (agent, data, caller, then) => {
    const { name, persona, sharedMemory: shared, aiProfileId, model, runsHere, group } = data;
    // Two of your agents with one name: the CLI's "matches more than one" follows (create refuses it too).
    if (name !== undefined && name.trim().toLowerCase() !== agent.name.trim().toLowerCase()) {
      const same = store.listAgents(agent.ownerId).find((x) => x.id !== agent.id && x.state !== 'DELETED' && x.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (same) return refuse(409, `You already have an agent called "${same.name}". Pick another name.`);
      // Held until this request answers: two renames to one name, each past
      // the check above while the other awaited its memory cap, both saved
      // it (HB-0305).
      if (!caller.holdName(`agent-name:${agent.ownerId}:${name.trim().toLowerCase()}`)) {
        return refuse(409, `An agent of yours is being renamed "${name.trim()}" right now. Pick another name, or try again in a moment.`);
      }
    }
    if (
      name === undefined &&
      persona === undefined &&
      shared === undefined &&
      aiProfileId === undefined &&
      model === undefined &&
      !runsHere &&
      data.sharedPaths === undefined &&
      group === undefined &&
      data.image === undefined &&
      data.parameters === undefined &&
      data.groupAccess === undefined &&
      data.richMessages === undefined &&
      data.cronTriggers === undefined &&
      data.browser === undefined &&
      data.embedMode === undefined &&
      data.memoryCap === undefined &&
      data.swapAllowance === undefined &&
      data.attentionAck === undefined &&
      data.hibernate === undefined &&
      data.filesMaxMb === undefined &&
      data.icon === undefined &&
      data.iconColor === undefined
    ) {
      return refuse(400, 'Nothing to update');
    }

    // Every refusal comes before the first write: a request that sets a
    // valid icon and an image the caller may not pin used to keep the icon
    // and answer 403 (use-case audit lows, 2026-09-27). The manager's
    // browser refusal came after the plain writes, so a file limit sent
    // with it was saved under a 400 (#57).
    // A browser or a pin needs a new container: not while an operation decides what runs next.
    if ((data.browser !== undefined && data.browser !== !!agent.browser)
      || data.cronTriggers !== undefined
      || (data.image !== undefined && data.image !== (agent.image ?? null))) {
      const onDisk = refusedOnDisk(agent);
      if (onDisk) return onDisk;
    }
    if (agent.ops && data.browser && !agent.browser) return refuse(400, 'The manager has no browser: its tools are Hatchabot\'s only.');
    if (data.embedMode === 'shared' && !searchServiceOn() && !caller.ownsLocalHost()) {
      // `shared` needs the machine's service, which its owner turns on; anyone
      // else switching first would only get the baked engine and a warning.
      return refuse(400, "The memory search service is not turned on. The machine's owner turns it on under Settings → Hosts; then agents can be switched to it.");
    }
    if (data.memoryCap !== undefined && data.memoryCap !== null) {
      const problem = memoryCapProblem(data.memoryCap, () => caller.ownsLocalHost());
      if (problem) return refuse(problem.status, problem.error);
    }
    if (data.swapAllowance !== undefined && data.swapAllowance !== null) {
      // Against the cap it will sit on: this request's, else the one it has.
      const cls = agent.classId ? store.getAgentClass(agent.classId) : undefined;
      const cap = data.memoryCap !== undefined ? effectiveMemoryCap({ memoryCap: data.memoryCap ?? undefined }, cls) : effectiveMemoryCap(agent, cls);
      const problem = swapAllowanceProblem(data.swapAllowance, cap, () => caller.ownsLocalHost());
      if (problem) return refuse(problem.status, problem.error);
    }

    if (runsHere) {
      // A rehost took a pool bot's token away with it: "runs here" with no
      // token would fail every rebuild (use-case audit, 2026-09-27).
      const ch = store.getChannelForAgent(agent.id, 'telegram');
      if (ch && !(await secrets.get(ch.secretRef).then(() => true, () => false))) {
        return refuse(409, 'Its Telegram bot went with it to the other Hatchabot, so it cannot run here on that bot. Detach Telegram first (it keeps everything it knows), then give it another bot.');
      }
    }

    let sameImage: boolean | undefined;
    if (data.image !== undefined) {
      // Which image runs on this box is the MACHINE owner's call, like host
      // paths: any local image is runnable by name, including ones that have
      // nothing to do with Hatchabot. Agent ownership is not enough.
      if (!caller.ownsLocalHost()) {
        return refuse(403, MACHINE_OWNER_ONLY);
      }
      // Not against `docker images`, but across the 2026.8 line (imagePinCheck).
      const pin = await imagePinCheck(agent, data.image);
      if (pin.problem) return refuse(400, pin.problem);
      sameImage = pin.sameImage;
    }

    const sharedPathList = data.sharedPaths?.map((p) => p.trim()).filter(Boolean);
    if (sharedPathList) {
      const paths = sharedPathList;
      // Giving an agent a folder of this machine is machine-level: at the
      // public address it needs the second factor again, like the Folders
      // routes (publicRoutes.ts), although the rest of this route does not.
      // Taking folders away needs nothing more.
      const had = new Set(agent.sharedPaths ?? []);
      if (paths.some((p) => !had.has(p))) {
        const again = caller.stepUp();
        if (again) return again;
      }
      // Mounting host folders is the machine owner's privilege only — the
      // blocklist below is owner-blind, so on a shared box a second account
      // could otherwise read another user's files through their own agent.
      if (paths.length && !caller.ownsLocalHost()) {
        return refuse(403, MACHINE_OWNER_ONLY);
      }
      // The same rule as a folder data source: a runner's docker cannot see
      // this machine's disk, and the folder was saved but never mounted (HB-0284).
      if (paths.some((p) => !had.has(p)) && store.getHost(agent.hostId)?.kind !== 'local') {
        return refuse(400, `"${agent.name}" runs on another machine, which cannot see this machine's folders. Move it here first, or give it a git repo instead.`);
      }
      for (const p of paths) {
        // Refuse the dangerous ones by name, and require the folder to
        // exist — a typo would otherwise mount an empty directory and the
        // agent would simply report finding nothing.
        const problem = sharePathProblem(p);
        if (problem) return refuse(400, problem);
        if (!existsSync(p)) {
          return refuse(400, `No such folder on this machine: ${p}`);
        }
      }
      if (new Set(paths.map((p) => p.replace(/\/+$/, '').split('/').pop())).size !== paths.length) {
        return refuse(400, 'Two folders share a name — the agent would see them at the same place.');
      }
      // A legacy folder must not shadow a data source at the same /data/<name>:
      // both mount there and Docker would silently keep only one.
      const dsNames = new Set(store.listDataSources(agent.id).map((d) => d.mountName));
      const clash = paths.map((p) => p.replace(/\/+$/, '').split('/').pop()!).find((n) => dsNames.has(n));
      if (clash) {
        return refuse(409, `A data source already lives at /data/${clash}. Remove it before mounting a folder with the same name.`);
      }
    }

    // Validate the AI-source switch AND the model override together, BEFORE
    // writing either. A combined request with a valid profile but an off-menu
    // model must be rejected whole — not leave the agent half-switched.
    let switchingProfile = false;
    let target = store.getAIProfile(agent.aiProfileId); // the profile it WILL have
    if (aiProfileId !== undefined && aiProfileId !== agent.aiProfileId) {
      // The caller's own profile, or one shared with the installation —
      // same rule as agent creation.
      const next = store.getAIProfile(aiProfileId);
      if (!next || (next.ownerId !== caller.ownerId && !next.shared)) {
        return refuse(400, 'Unknown AI profile');
      }
      // A machine-login Max source is its owner's ~/.claude; another account
      // switching an agent onto it would mount that directory into their
      // container. Block cross-owner selection (family-member hardening).
      if (next.kind === 'subscription' && !next.secretRef && next.ownerId !== caller.ownerId) {
        return refuse(400,
          'That Max source uses its owner\'s machine login and can\'t be used by another account. ' +
          'Use a setup-token source or your own API key.',
        );
      }
      const host = store.getHost(agent.hostId);
      // Same rule as create/move: a setup-token Max profile (secretRef
      // present) rides to a runner; only the machine-login flavour is
      // desktop-only. Without the secretRef check a runner agent couldn't be
      // switched to a setup-token source it could have been created with.
      if (machineLoginOnly(next) && host?.kind !== 'local') return refuse(400, MACHINE_LOGIN_NO_RUNNER);
      if (agent.ops && next.vendor === 'local') return refuse(400, OPS_NO_LOCAL);
      target = next;
      switchingProfile = true;
    }
    if (model !== undefined) {
      if (!target) return refuse(400, 'Unknown AI profile');
      const problem = modelOverrideProblem(target, model);
      if (problem) return refuse(400, problem);
    }
    // One check of what it will run (finalModelCheck): a pin set or cleared,
    // a source switch, or an image alone, which went unchecked (HB-0555, HB-0459).
    const landsOn = data.image !== undefined ? data.image : agent.image ?? null;
    let dropRuntimePin = false;
    if (target && (model !== undefined || switchingProfile || data.image !== undefined)) {
      const runtime = await finalModelCheck(agent, target, {
        ...(model !== undefined ? { pin: model } : {}), switching: switchingProfile,
        rebuildOn: switchingProfile || data.image !== undefined ? landsOn : undefined,
      });
      if (runtime.problem) return refuse(400, runtime.problem);
      dropRuntimePin = !!runtime.dropPin;
    }
    // An operation on disk (held, interrupted) resumes on the source it began
    // with: refused as the bulk switch refuses it, after the checks above (HB-0573).
    if (switchingProfile) {
      const onDisk = refusedOnDisk(agent);
      if (onDisk) return onDisk;
    }
    // A rebuild or a move holding the agent reads its source as it goes: a
    // switch meanwhile could finish it on a mix of the two (HB-0063).
    if (switchingProfile && isBusy(agent.id)) return refuse(409, SOURCE_SWITCH_BUSY);

    // Memory is always shared now (2026-09-29): an agent's memory is one,
    // reachable from every conversation, so "private" could not be kept.
    // `sharedMemory: true` from an old client changes nothing: every agent
    // but the Hatchabot agent is shared, and that one keeps its own (HB-0094).
    if (shared === false && !agent.ops) {
      return refuse(400, "An agent's memory is always shared with everyone who talks to it. For something private, give that person their own agent.");
    }
    // The source was looked up before the runtime checks above: deleted
    // during them, the agent was left on a source that no longer existed (HB-0570).
    if (switchingProfile && !store.getAIProfile(aiProfileId!)) return refuse(409, new SourceGoneError().userMessage);
    // Held from this look until the change is stored or refused (`then`
    // takes the hold before it waits for anything).
    return then({ agent, data, sharedPathList, switchingProfile, target, sameImage, dropRuntimePin });
  };

  /** The change `check` passed: made, in the order the route made it. */
  const apply = async (change: AgentEdit, caller: EditCaller): Promise<EditDone | EditRefusal> => {
    const { agent, data, sharedPathList, switchingProfile, target, sameImage, dropRuntimePin } = change;
    const { name, persona, aiProfileId, model, runsHere, group } = data;
    /** The browser switch was stored but no rebuild started to apply it: what the caller is told. */
    let browserPending: string | undefined;
    let triggerRebuildClaim: string | undefined;
    // One live apply can fail (the memory cap's docker update, 502). Every
    // refusal is in `check` or here, the cap's docker update next, then every
    // store write in one transaction, and what follows from them last: a
    // 400/409 or a 502 changes nothing.
    // The source is held from `check`'s last look until the change is
    // stored or refused: its delete is refused meanwhile, so nothing below
    // can find it gone. Once stored, the agent is on it, and the delete
    // says it is in use.
    // A class dropped, by the image's step or by the source's and model's
    // (detachClassIfDrifted, in one transaction with what it writes): the
    // one that dropped it, and the limits that apply without it (HB-0561).
    let dropped: Detach | undefined;
    const detachLimits: Array<Promise<Kept> | undefined> = [];
    const noteDetach = (d: Detach) => { detachLimits.push(d.limits); if (d.detached) dropped = d; };
    // Its traces wait for the commit: a change rolled back logged what it
    // never stored.
    const traced: Array<[string, Record<string, unknown>]> = [];
    const traceLater = (event: string, detail: Record<string, unknown>) => { traced.push([event, detail]); };
    let capSet: Awaited<ReturnType<MemoryLimits['setMemoryCap']>> | undefined;
    let swapSet: Awaited<ReturnType<MemoryLimits['setSwapAllowance']>> | undefined;
    // Its own cap or swap allowance changes in the agent's limits turn,
    // held from their docker calls until they are stored or put back: a
    // class's limits that apply to it meanwhile wait, and then read it as
    // stored, rather than land between the docker call and the record.
    const ownLimits = data.memoryCap !== undefined || data.swapAllowance !== undefined;
    const inItsLimitsTurn = <T>(fn: () => Promise<T>): Promise<T> => (ownLimits ? inLimitsTurn(agent.id, fn) : fn());
    // A refusal made inside the holds: answered once they let go.
    const refusedInside = await withSourceHold(switchingProfile ? aiProfileId : undefined, () => inItsLimitsTurn(async (): Promise<EditRefusal | undefined> => {
      // Once a docker call has moved its limits, any stop before the change
      // is stored puts the container back on what the store says
      // (applyCurrentLimits with no change, in this same turn).
      let limitsMoved = false;
      const putBack = () => (limitsMoved ? applyCurrentLimits(agent.id).then(() => undefined, () => undefined) : Promise.resolve());
      if (data.memoryCap !== undefined) {
        capSet = await setMemoryCap(agent, data.memoryCap, () => caller.ownsLocalHost());
        if (capSet.error) return refuse(capSet.status ?? 400, capSet.error);
        limitsMoved = !!capSet.live;
      }
      // Every store write of the change in one transaction, the source's
      // first: refused there (the agent or the source deleted meanwhile, or
      // a rebuild or a move begun during the waits above), nothing is stored
      // and nothing that follows is done (HB-0570).
      let refused: 'no-agent' | 'no-source' | 'busy' | 'triggers-busy' | 'runner' | 'moving' | 'folder-runner' | undefined;
      try {
        if (data.swapAllowance !== undefined) {
          // As it is after the cap's docker call, not as read at the start.
          const now = store.getAgent(agent.id);
          if (!now || agentGone(agent.id)) { await putBack(); return refuse(404, AGENT_GONE); }
          swapSet = await setSwapAllowance(now, data.swapAllowance, capSet ? { memoryCap: capSet.own ?? null } : {});
          if (swapSet.error) { await putBack(); return refuse(swapSet.status ?? 400, swapSet.error); }
          if (swapSet.live) limitsMoved = true;
        }
        store.transact(() => {
          // Deleted meanwhile: none of the change is written, a source switch or not.
          if (agentGone(agent.id)) { refused = 'no-agent'; return; }
          // A host move depends on its checked image and mounts. A PATCH
          // may have waited for a cap/image check while that move began or
          // finished, so judge these settings again at the write (HB-0709).
          if ((data.image !== undefined || sharedPathList !== undefined) && store.activeOperationFor(agent.id)?.kind === 'move-host') { refused = 'moving'; return; }
          const current = store.getAgent(agent.id)!;
          if (sharedPathList?.some((p) => !(current.sharedPaths ?? []).includes(p)) && store.getHost(current.hostId)?.kind !== 'local') { refused = 'folder-runner'; return; }
          // A rebuild may have rendered its permission while this request
          // waited for a cap/image check. It would clear an obligation made
          // here without applying this flag. Refuse before any store write.
          if (data.cronTriggers !== undefined && (isBusy(agent.id) || operationRefusal(store, agent.id))) { refused = 'triggers-busy'; return; }
          if (switchingProfile) {
            if (isBusy(agent.id)) { refused = 'busy'; return; }
            // Where it is now: moved to a runner during the waits above, this machine's login cannot reach it.
            if (target && machineLoginOnly(target) && store.getHost(store.getAgent(agent.id)!.hostId)?.kind !== 'local') { refused = 'runner'; return; }
            const set = store.setAgentAIProfile(agent.id, aiProfileId!);
            if (set !== 'ok') { refused = set; return; }
          }
          if (model !== undefined) {
            store.setAgentModel(agent.id, model);
          } else if (switchingProfile && agent.model && target && (dropRuntimePin || modelOverrideProblem(target, agent.model))) {
            // The switch strands the old pin (new source lacks it, is local, or its
            // runtime cannot use it there). Drop it so the agent falls back to the
            // new source's default.
            store.setAgentModel(agent.id, null);
          }
          capSet?.record?.(traceLater);
          swapSet?.record?.();
          if (data.attentionAck !== undefined) store.setAgentAttentionAck(agent.id, data.attentionAck);
          if (data.hibernate !== undefined) store.setHibernatePolicy(agent.id, data.hibernate);
          if (data.filesMaxMb !== undefined) store.setAgentFilesMaxMb(agent.id, data.filesMaxMb);
          if (data.icon !== undefined || data.iconColor !== undefined) {
            store.setAgentIcon(agent.id, data.icon, data.iconColor);
          }
          if (data.parameters !== undefined) store.setAgentParameters(agent.id, data.parameters);
          if (data.groupAccess !== undefined) store.setAgentGroupAccess(agent.id, data.groupAccess);
          if (data.richMessages !== undefined) store.setAgentRichMessages(agent.id, data.richMessages);
          if (data.embedMode !== undefined) {
            store.setAgentEmbedMode(agent.id, data.embedMode);
            traceLater('embed.mode', { mode: data.embedMode });
          }
          if (data.browser !== undefined && data.browser !== !!agent.browser) {
            store.setAgentBrowser(agent.id, data.browser);
            traceLater('browser.switched', { on: data.browser });
          }
          if (data.cronTriggers !== undefined) {
            store.setAgentCronTriggers(agent.id, data.cronTriggers);
            // Stored with the flag for running agents too: a service crash
            // before the live apply leaves the obligation on disk. Existing
            // obligations belong to other changes and cannot be cleared by
            // a successful trigger write.
            const now = store.getAgent(agent.id);
            if (now?.runtimeRef && !now.rebuildOnStart) triggerRebuildClaim = oweRebuild(agent.id, traceLater);
          }
          if (persona !== undefined) {
            store.setAgentPersona(agent.id, persona.trim());
            // Same layer-sync rule as direct file edits: without it, the next
            // "Apply values" re-renders the persona from the stale layer and
            // reverts this edit. Its one key, the rest as it is now (HB-0567).
            if (store.getAgent(agent.id)?.paramFiles) store.setAgentParamFile(agent.id, 'persona', persona.trim());
          }
          if (group !== undefined) store.setAgentGroup(agent.id, group ? group : null);
          if (runsHere) store.setAgentMigratedTo(agent.id, null);
          if (data.image !== undefined) {
            store.setAgentImage(agent.id, data.image);
            // No rebuild is started here (the page and the manager's
            // pin_image send one after), so a running agent that leaves its
            // class gets the limits that apply without it now.
            noteDetach(detachClassIfDrifted(agent.id));
            // Stopped or asleep, it moves onto it when it next starts, as the app says
            // (HB-0441). Running, the caller rebuilds it or tells the owner to.
            if (sameImage !== true && (agent.image ?? null) !== data.image && agent.runtimeRef && store.getAgent(agent.id)?.state === 'STOPPED') oweRebuild(agent.id, traceLater);
          }
          if (sharedPathList) store.setAgentSharedPaths(agent.id, sharedPathList);
          if (name !== undefined && name !== agent.name) store.setAgentName(agent.id, name);
          // Either step may detach it: the image's, or this one for the
          // source or model. Once one let it go (or will, once its class's
          // change under way is done), it is not asked again. A source
          // switch waits for its rebuild, which writes the budget
          // (tellMemoryBudget leaves it to that).
          if ((switchingProfile || model !== undefined) && !dropped) noteDetach(detachClassIfDrifted(agent.id));
        });
      } catch (err) {
        await putBack();
        throw err;
      }
      if (refused) await putBack();
      if (refused === 'no-agent') return refuse(404, AGENT_GONE);
      if (refused === 'no-source') return refuse(409, new SourceGoneError().userMessage);
      if (refused === 'busy') return refuse(409, SOURCE_SWITCH_BUSY);
      if (refused === 'triggers-busy') return refuse(409, 'The agent is busy. Change its event-trigger permission once its current operation finishes.');
      if (refused === 'runner') return refuse(400, MACHINE_LOGIN_NO_RUNNER);
      if (refused === 'moving') return refuse(409, 'Its move to another machine is not over. Change its image or folders once that finishes.');
      if (refused === 'folder-runner') return refuse(400, 'It runs on another machine now, which cannot see this machine\'s folders. Move it here first, or give it a git repo instead.');
      return undefined;
    }));
    if (refusedInside) return refusedInside;
    for (const [event, detail] of traced) trace(agent.id)(event, detail);
    // true, or 'pending' while its class's change under way is applied (as the model route says).
    const classDetached = dropped?.detached ?? false;
    // Stored; a container that kept its old limits is said (memoryPending).
    const ownKept: Kept = capSet?.memoryPending ? capSet : swapSet?.memoryPending ? swapSet : {};
    const capOn = !!capSet?.live;

    // Stored: what follows from it, outside the store.
    await swapSet?.after?.();
    if (data.browser !== undefined && data.browser !== !!agent.browser) {
      // OpenClaw reads the browser profile at start: a rebuild writes it and
      // the sweep then starts (or removes) the browser beside it. A rebuild
      // already under way may have read the old switch: the caller is told
      // to rebuild once it is done, instead of hearing "rebuilding" for a
      // rebuild that never came (2026-10-09).
      // A stopped or sleeping agent stays so, and has it from its next start (HB-0420).
      const was = store.getAgent(agent.id) ?? agent;
      const settled = was.state === 'RUNNING' || was.state === 'STOPPED';
      const applied = settled ? rebuildOrOwe(was) : undefined;
      if (applied === 'next-start') {
        browserPending = `Saved. It stays ${was.hibernatedAt ? 'asleep' : 'stopped'}, and ${data.browser ? 'has its browser' : 'loses its browser'} when it next starts.`;
      } else if (was.runtimeRef && (was.state === 'REBUILDING' || applied === 'not-started')) {
        browserPending = 'Saved. A rebuild was already under way and may have begun before this change: if its browser is not as you set it once that rebuild ends, rebuild the agent.';
        trace(agent.id)('browser.rebuild_pending', {});
      }
    }
    const cronTriggersPending = data.cronTriggers !== undefined ? await applyCronTriggers(agent.id, triggerRebuildClaim) : undefined;
    const filesCapGone = data.filesMaxMb !== undefined && (await applyFilesCap(store.getAgent(agent.id)!)).gone;
    if (name !== undefined && name !== agent.name) {
      // And inside OpenClaw, whose console otherwise keeps the old name (or
      // the slug) until the next rebuild. Live, cosmetic, best-effort.
      if (agent.runtimeRef && agent.state === 'RUNNING') {
        void providerFor(agent.hostId)
          .exec(agent.runtimeRef, ['agents', 'set-identity', '--agent', agent.slug, '--name', name], { timeoutMs: 20_000 })
          .catch(() => {});
      }
      // Keep Telegram in step: the bot's display name is what people see in
      // the chat header, and it previously froze at whatever the agent was
      // called when its token was first leased (or, for a hand-pasted bot,
      // at whatever BotFather was told). Fire-and-forget — cosmetic, and
      // Telegram rate-limits setMyName.
      const chan = store.getChannelForAgent(agent.id);
      forgetBotName(agent.id);
      // A pool bot's queued name (a rename Telegram refused earlier) must be
      // this one now, or the sweep would put the old name back later.
      // One rename call, not two: Telegram grants about one per bot every few
      // hours, and the loser of two concurrent calls either skipped the
      // members' notice or queued a "pending" name that had landed (night
      // review). A pool bot goes through the pool, which parks a refusal.
      const poolBot = chan?.kind === 'telegram' && channel.pool.owns(chan.accountId);
      const renamed = !chan || chan.kind !== 'telegram' ? undefined
        : poolBot
          ? (channel.syncDisplayName?.(chan.accountId, name) ?? Promise.resolve())
              .then(() => ({ ok: !channel.pool.pendingName?.(chan.accountId), via: 'pool' as const }))
          : secrets.get(chan.secretRef).then((tok) => setTelegramDisplayName(tok, name, deps.telegramFetch));
      if (chan?.kind === 'telegram' && renamed) {
        void renamed
          .then((res) => {
            trace(agent.id)('channel.renamed', { name, ...res });
            // Document the change in the chat itself, so members aren't left
            // wondering why the label changed under them. Only on success.
            if (res.ok && agent.runtimeRef) {
              void announceToMembers(
                { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
                {
                  agentId: agent.id, runtimeRef: agent.runtimeRef, accountId: chan.accountId,
                  text: `🏷 This agent was renamed: it's now “${name}”. Same agent, same chat — only the name changed.`,
                },
              ).catch(() => 0);
            }
          })
          .catch(() => {});
      }
      // Slack and Discord bots follow the name the same way.
      for (const other of store.listChannelsForAgent(agent.id)) {
        if (other.kind !== 'telegram' && connectorFor(other.kind)?.rename) void renameChannelBot({ ...agent, name }, other, name).catch(() => undefined);
      }
    }
    if (switchingProfile || model !== undefined) caller.ledger(model !== undefined ? 'model' : 'source-switch');
    const kept = (await Promise.all(detachLimits)).find((r) => r?.memoryPending) ?? ownKept;
    // A new memory cap of its own: tell the agent its budget (AGENTS.md),
    // off the request, once its container took it (capOn), as limitsTold
    // does: one that kept its old limits is not told a budget it does not
    // have. Last, so the sync reads everything this change stored. A class
    // dropped asks too (detachClassIfDrifted): one sync.
    if (capOn) void tellMemoryBudget(agent.id).catch(() => undefined);

    return { ok: true, answer: {
      ...view(store.getAgent(agent.id)!, { classDetached }), ...(sameImage !== undefined ? { sameImage } : {}),
      ...keptSaid(agent.name, kept),
      ...(filesCapGone ? { filesCapPending: `The limit is saved, but it could not be written to the agent. ${VOLUME_GONE}` } : {}),
      ...(browserPending ? { browserPending } : {}),
      ...(cronTriggersPending ? { cronTriggersPending } : {}),
    } };
  };

  const edit: AgentEdits['edit'] = (agent, data, caller) => check(agent, data, caller, (change) => apply(change, caller));

  return { check, edit };
}
