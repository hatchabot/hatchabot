import { randomUUID } from 'node:crypto';
import type { AIProfile, Agent } from '../../domain/types.js';
import { batchConfigCommands, hasModelPolicy, needsPortHeal, seedInvocation } from '../../openclaw/configWriter.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { keyedLock, semaphore } from '../../util/queues.js';
import { containerUp, type UpWait } from './afterRestart.js';
import { freedWithin, isBusy, OWED_BUSY_WAIT_MS, OWED_BUSY_WAITS } from './busy.js';
import { SUBSCRIPTION_MIN_OPENCLAW, subscriptionModelProblem } from '../sources/modelOptions.js';
import { effectiveModel, prefixedModelRef, recordApplied, switchableModelsFor } from './provision.js';

/**
 * Model application (HB-0807): how an agent's model reaches its runtime, and
 * the checks of what an agent may run. One of the three parts of the agent
 * settings service (agentSettings.ts), which builds it.
 *
 * State: `modelApplies`, each agent's queue of model writes to its runtime.
 * An in-process lock (HB-0809): what it orders is the `openclaw models set`
 * calls of this process, and the record of what was applied is in the store.
 * The write a queue still owes when the process ends is not lost with it:
 * each is asked for in the store (`agent_holds`, 'model-apply'), with the
 * model where the caller can (`Store.setAgentModel`'s `apply`) and when it
 * is queued otherwise, and the asks an earlier process left are served by
 * the next one (`applyOwed`).
 */

/**
 * A per-agent model override is only valid for a cloud profile and must be one
 * the profile actually offers — its default plus its switchable menu — so a
 * typo can't provision green and fail on first use. Returns an error string,
 * or undefined when the override is acceptable (or absent).
 */
export function modelOverrideProblem(profile: AIProfile, model: string | null | undefined): string | undefined {
  if (model == null) return undefined; // clearing / not setting is always fine
  if (profile.vendor === 'local') {
    return 'Local sources run one model at a time, so agents follow the source’s model — set it on the source, not per agent.';
  }
  const menu = new Set([profile.model, ...(profile.models ?? [])]);
  if (!menu.has(model)) {
    return `"${model}" isn’t one of this source’s models. Add it to the source’s switchable list first.`;
  }
  return undefined;
}

/** A machine-login Max source is this machine's ~/.claude: an agent on a runner cannot reach it. */
export const machineLoginOnly = (p: AIProfile): boolean => p.vendor !== 'local' && p.kind === 'subscription' && !p.secretRef;

/** How a model reached a runtime (applyModelToRuntime). */
export type ModelApplied = 'live' | 'staged' | 'none' | 'failed' | 'rebuild' | 'gone';

/** What model application needs from the process it runs in. */
export interface ModelRuntimeDeps {
  store: Store;
  /** The runtime provider of a host. Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log and to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The setup or rebuild in flight for an agent (the setup and rebuild queue), or undefined. */
  inFlight: (agentId: string) => Promise<void> | undefined;
  /** After a restart: how long a container the record says is running is waited for (afterRestart.ts). */
  upWait: UpWait;
  /**
   * After a restart: an ask an earlier process left (`ask`, its value) that
   * the runtime refused, not one cut off, with no newer ask for the agent
   * since, and no model written for it since in this process (a choice of
   * the same model included: theirs, served with it, is not to be undone).
   * Whoever made it may undo what it stored with it (a budget's switch to a
   * cheaper model, HB-1404). Never throws. `how`: what the runtime answered
   * ('refused': held back before it was tried); 'rebuild' is a source switch
   * waiting for its rebuild, which may be one made after the ask (HB-1444).
   */
  owedRefused?: (agentId: string, ask: string, how: OwedRefusal) => void;
}

/** Why an owed ask did not land at a start, as owedRefused is told it. */
export type OwedRefusal = 'refused' | 'failed' | 'gone' | 'rebuild';

export interface ModelRuntime {
  /**
   * Apply an agent's effective model to its runtime, in the agent's own
   * queue. `live`: on a running container; `staged`: on a stopped one's
   * volume; `rebuild`: a source switch waits for a rebuild, which brings it;
   * `none`: stored only (busy, mid-operation, no runtime); `failed`: the
   * runtime refused it; `gone`: its volume is missing.
   */
  applyModelToRuntime(agentId: string): Promise<ModelApplied>;
  /**
   * Ask in the store for an agent's model to be put on its runtime, as a
   * write with Store.setAgentModel's `apply` does, for one whose model moves
   * with no write of its own (a ticked follower of a source's new default,
   * HB-0832). In the transaction that moves it; applyModelToRuntime after,
   * or the next start (applyOwed), serves it.
   */
  askToApply(agentId: string): void;
  /**
   * After a restart: each model an earlier process stored and had still to
   * put on a runtime (its ask is in the store) is put on now, unless its
   * runtime has it, a rebuild brings it, or its runtime would refuse it.
   * Each once `ready` says its agent is (its own operations the start
   * settles are settled, HB-0839), not once every agent's are. Never rejects.
   */
  applyOwed(ready?: (agentId: string) => Promise<void>): Promise<void>;
  /** At shutdown: no more of applyOwed is started. */
  stop(): void;
  /** A source's model list changed: each of its agents gets the new list, one after another. Never rejects. */
  pushModelList(profileId: string): Promise<void>;
  /**
   * The checks every image pin makes before it is stored: no way back across
   * the 2026.8 line. `unanswered`: the container or the image gave no
   * OpenClaw version (its machine did not answer, or no such image yet).
   */
  imagePinCheck(agent: Agent, image: string | null): Promise<{ problem?: string; sameImage?: boolean; unanswered?: true }>;
  /** A model Anthropic refuses for the Claude Code version this agent's OpenClaw presents on a subscription. */
  subscriptionRuntimeProblem(agent: Agent, profile: AIProfile, model: string | null | undefined, rebuildOn?: string | null): Promise<string | undefined>;
  /**
   * The one check of what an agent will run once a change is stored: its
   * source, its model and the OpenClaw that model runs on. `unanswered`: a
   * runtime it asked gave no version, which passes (subscriptionModelProblem).
   */
  finalModelCheck(a: Agent, target: AIProfile, next: { pin?: string | null; switching?: boolean; rebuildOn?: string | null }): Promise<{ dropPin?: boolean; problem?: string; unanswered?: true }>;
  /** finalModelCheck for a source switch, which lands with a rebuild on the agent's own image. */
  sourceSwitchRuntime(a: Agent, target: AIProfile, image?: string | null): Promise<{ dropPin?: boolean; problem?: string }>;
  /** Why this agent may not be put on `model` now (null: back to its source's default). */
  modelChoiceProblem(agent: Agent, profile: AIProfile, model: string | null): Promise<{ status: 400 | 409; error: string } | undefined>;
}

export function createModelRuntime(deps: ModelRuntimeDeps): ModelRuntime {
  const { store, providerFor, trace, inFlight } = deps;
  /**
   * Apply an agent's effective model to its runtime. RUNNING: `openclaw models
   * set` in the container (read per turn — live). STOPPED: the same command
   * against the agent's volume in a throwaway container, so the change is in
   * place when it next starts (a plain start does NOT re-provision config).
   * Records the applied model on success. Returns how it was applied.
   * One at a time per agent, each reading the model when its turn comes: an
   * older `models set` still running when a newer choice was applied
   * finished last and left the runtime on the older model (HB-0323).
   */
  const modelApplies = keyedLock();
  /**
   * A model to put on a runtime is asked for in the store before it is
   * queued here (HB-0809): a queue is gone after a restart, and a model
   * stored but not applied then waited for a rebuild, shown as pending, with
   * nothing to say it had been meant to go on at once. The ask goes when
   * the runtime was asked (it took the model, refused it, or its volume is
   * gone: the caller says which) or a rebuild is to bring it. It stays
   * while the write was put off (busy, mid-operation) or cut off (its
   * machine did not answer, the process ended): the next write for the
   * agent serves it, or the next start of Hatchabot (applyOwed). Only the
   * ask it began with: one made while it worked is for a later write.
   * `tellable`: there is a runtime of this agent's to write a model to.
   */
  const tellable = (a: Agent | undefined): a is Agent =>
    !!a && !!a.runtimeRef && !a.migratedTo && a.state !== 'ARCHIVED' && a.state !== 'DELETING' && a.state !== 'DELETED' && !!store.getAIProfile(a.aiProfileId);
  const applyModelToRuntime = (agentId: string): Promise<ModelApplied> => {
    // A caller that stored the model without asking (Store.setAgentModel's `apply`): asked here, as it is queued.
    if (store.agentHold(agentId, 'model-apply') === undefined && tellable(store.getAgent(agentId))) store.setAgentHold(agentId, 'model-apply', randomUUID());
    return modelApplies.run(agentId, () => applyAsked(agentId));
  };
  const askToApply = (agentId: string): void => {
    // A new ask, not one there already: a write under way serves only the ask it began with.
    if (tellable(store.getAgent(agentId))) store.setAgentHold(agentId, 'model-apply', randomUUID());
  };
  const applyAsked = async (agentId: string): Promise<ModelApplied> => {
    const asked = store.agentHold(agentId, 'model-apply');
    let how: ModelApplied | undefined;
    // A write whose answer never came (its machine did not answer, it timed
    // out): 'failed' to its caller, but not a refusal, so still asked (HB-1084).
    const write: { cutOff?: boolean } = {};
    try {
      how = await applyModelNow(agentId, write);
      return how;
    } finally {
      const served = how !== undefined && !write.cutOff && (how !== 'none' || !tellable(store.getAgent(agentId)));
      // The database may be closed by now (a shutdown while it worked): the ask is then still there, which is right.
      if (served && asked !== undefined) { try { store.clearAgentHold(agentId, 'model-apply', asked); } catch { /* still asked */ } }
    }
  };
  /**
   * The asks an earlier process left, read once as this one starts (any
   * made after are this process's own, and its queues serve them).
   */
  // With each its agent's model generation as the list is read: a model
  // written for it from here on (the owner's, the same model included) is
  // theirs, though its turn comes later (a seventh agent waits for a slot):
  // read in its slot, a write before it was not seen, and a refusal undid it (HB-1444).
  const owed = store.agentHolds('model-apply').map((o) => ({ ...o, generation: store.modelGeneration(o.agentId) }));
  let stopped = false;
  /** Ends the waits for a busy agent at stop(). */
  const waits = new AbortController();
  // Six at a time, each on its own: one that waits for its rebuild's turn holds up none of the others,
  // and one whose own operation is still being settled waits outside the six (HB-0839). One put off
  // because something held its agent (the boot's own AGENTS.md sync for it, what follows its start, a
  // backup) waits for it to be free outside the six too, then takes its turn again, a few times, rather
  // than being left for the next restart (HB-0834 review): six busy agents held up every other one.
  const applyOwed = async (ready: (agentId: string) => Promise<void> = async () => undefined): Promise<void> => {
    const slots = semaphore(6);
    await Promise.all(owed.splice(0).map(async (o) => {
      await ready(o.agentId).catch(() => undefined);
      for (let waited = 0; ; waited++) {
        await slots.acquire();
        let putOff: boolean;
        try { putOff = await serveOwed(o, waited < OWED_BUSY_WAITS); } finally { slots.release(); }
        if (!putOff) return;
        if (!(await freedWithin(o.agentId, OWED_BUSY_WAIT_MS, waits.signal))) {
          if (!stopped) trace(o.agentId)('model.after_restart', { how: 'none', why: 'it stayed busy' });
          return;
        }
      }
    }));
  };
  /** One owed ask served. True when it was put off because the agent was busy, and `mayWait`: to be asked again once it is free. */
  const serveOwed = async ({ agentId, value, generation }: { agentId: string; value: string; generation: number }, mayWait: boolean): Promise<boolean> => {
    if (stopped) return false;
    const nothingToTell = (): false => { store.clearAgentHold(agentId, 'model-apply', value); return false; };
    // A model written for it since the list was read (the owner's choice, the
    // same model included) moves this on: a refusal is then no longer the ask's alone to undo.
    const stillTheirs = () => store.modelGeneration(agentId) === generation;
    try {
      // Served, or asked again, by this process since: its own.
      if (store.agentHold(agentId, 'model-apply') !== value) return false;
      // A setup or rebuild put back in its queue at this start: it writes the model from the record.
      for (let flight = inFlight(agentId), n = 0; flight && n < 2; flight = inFlight(agentId), n++) await flight.catch(() => undefined);
      if (stopped) return false;
      const a = store.getAgent(agentId);
      const p = a && store.getAIProfile(a.aiProfileId);
      if (!tellable(a) || !p) return nothingToTell();
      // Mid-setup, mid-rebuild or failed: that setup or rebuild, or its Retry, writes the model from the record.
      if (a.state !== 'RUNNING' && a.state !== 'STOPPED') return nothingToTell();
      let provider: RuntimeProvider;
      try { provider = providerFor(a.hostId); } catch { return nothingToTell(); } // its machine is not known here any more
      const model = effectiveModel(a, p);
      // On its runtime already (the restart came after the write, before the ask went).
      if (a.appliedProfileId === a.aiProfileId && a.appliedModel === model) return nothingToTell();
      // A machine that does not answer (a runner asleep): still asked, for the next start. Not said every start.
      if (provider.reachable && !(await provider.reachable().catch(() => false))) return false;
      // Nor a container the record says is running that is not up (the whole machine restarted,
      // and Docker has not started it again): waited for a little, then still asked (afterRestart.ts).
      if (a.state === 'RUNNING' && !(await containerUp(provider, a.runtimeRef!, deps.upWait))) return false;
      // Held back until the image that can run it is on (classChanges.ts), or one
      // its runtime would refuse: never put on here. Its rebuild brings it.
      const refused = store.agentHold(agentId, 'model-waits-image') === model ? 'it waits for the image that can run it' : await subscriptionRuntimeProblem(a, p, model);
      if (refused) {
        // Still this ask, and nothing written since its look above (the waits for a flight, the machine, the container).
        const ours = store.agentHold(agentId, 'model-apply') === value && stillTheirs();
        nothingToTell();
        trace(agentId)('model.after_restart', { model, how: 'refused', why: refused.slice(0, 200) });
        if (ours) deps.owedRefused?.(agentId, value, 'refused');
        return false;
      }
      const how = await applyModelToRuntime(agentId);
      // Put off: something held the agent. Its caller waits for it to be free, outside the six, and asks again.
      if (how === 'none' && mayWait && store.agentHold(agentId, 'model-apply') === value) return true;
      trace(agentId)('model.after_restart', { model, how });
      // Refused (its ask went with the answer: one cut off is still asked), and nothing asked since.
      // 'rebuild' too: a source switch waits for a rebuild, so the model is not on its runtime, as the
      // pass judges it live (HB-1444). Told so: its maker judges whose switch waits (one made after
      // the ask is the owner's, and then the model stands).
      if ((how === 'failed' || how === 'gone' || how === 'rebuild') && store.agentHold(agentId, 'model-apply') === undefined && stillTheirs()) deps.owedRefused?.(agentId, value, how);
      return false;
    } catch (err) {
      // The write was cut off (its machine stopped answering): still asked, for the next start.
      try { trace(agentId)('model.after_restart', { how: 'cut off', why: String((err as Error)?.message ?? err).slice(0, 200) }); } catch { /* the log itself failed */ }
      return false;
    }
  };
  const applyModelNow = async (agentId: string, write: { cutOff?: boolean } = {}): Promise<ModelApplied> => {
    const a = store.getAgent(agentId);
    const p = a && store.getAIProfile(a.aiProfileId);
    if (!a || !p || !a.runtimeRef || a.migratedTo) return 'none';
    // A source switch is waiting for a rebuild: the container still runs the OLD
    // source's auth/config, so don't touch it and — crucially — don't
    // recordApplied, which would stamp the new source as applied and hide the
    // rebuild the agent still needs. The model lands with that rebuild.
    if (a.appliedProfileId && a.appliedProfileId !== a.aiProfileId) return 'rebuild';
    // Mid-move, mid-restore, mid-rebuild (or one waiting its turn): stored
    // only. Editing the volume then raced the operation's own config, and
    // recordApplied consumed the build's memory-search decision and retired
    // its old key before that build was accepted (concurrency review,
    // 2026-10-09). The operation writes the model from the store; one that
    // already had written it leaves the change for the next rebuild.
    if (a.state !== 'RUNNING' && a.state !== 'STOPPED') return 'none';
    // On 2026.9+ the picker offers only the allowlist, and `models set` to a
    // model off it succeeds without adding it: the agent then ran a model its
    // own picker did not show (HB-0666). So the list goes first, as the build
    // writes it. Read before the busy check, so nothing waits between that
    // check and the write.
    const version = await runtimeVersionOf(a);
    if (isBusy(agentId) || !!inFlight(agentId)) {
      trace(agentId)('model.apply_deferred', { why: 'busy' });
      return 'none';
    }
    const ref = prefixedModelRef(a, p);
    const provider = providerFor(a.hostId);
    const list = hasModelPolicy(version) ? batchConfigCommands(switchableModelsFor(a, p, version))[0] : undefined;
    let res;
    if (a.state === 'RUNNING') {
      res = list ? await provider.exec(a.runtimeRef, list.argv) : undefined;
      if (!res || res.code === 0) res = await provider.exec(a.runtimeRef, ['models', 'set', ref]);
    } else {
      res = await provider.execShellOnVolume(a.runtimeRef, `${list ? `${seedInvocation(list)} >/dev/null && ` : ''}openclaw models set '${ref.replace(/'/g, '')}' >/dev/null`, { image: a.image ?? undefined });
    }
    // Not "try again, or Rebuild": a rebuild makes a fresh, empty volume, the
    // agent healthy with no memory that saying so is there to prevent (HB-0373).
    if (res.volumeMissing) { trace(agentId)('model.volume_gone', { model: ref }); return 'gone'; }
    if (res.code !== 0) {
      // Not run, or no answer: the runtime did not refuse it, and may not have it.
      if (res.unreachable || res.timedOut || res.signalled) write.cutOff = true;
      trace(agentId)('model.live_set_failed', { model: ref, stderr: (res.stderr || res.stdout).slice(0, 200) });
      return 'failed';
    }
    // What was applied is what was read before the call. A source switch (or
    // another model) saved while `models set` ran is not on the runtime:
    // stamping the record as it is now hid the rebuild the switch needs (#87).
    const now = store.getAgent(agentId);
    const nowProfile = now && store.getAIProfile(now.aiProfileId);
    if (now && nowProfile && now.aiProfileId === a.aiProfileId && effectiveModel(now, nowProfile) === effectiveModel(a, p)) recordApplied(store, agentId);
    else if (now) store.setAgentApplied(agentId, a.aiProfileId, effectiveModel(a, p));
    return a.state === 'RUNNING' ? 'live' : 'staged';
  };
  /**
   * The OpenClaw an agent's runtime runs: its container's label, else its
   * image's. Unknown when neither answers, which counts as old.
   */
  const runtimeVersionOf = async (a: Agent): Promise<string | undefined> => {
    const prov = providerFor(a.hostId);
    const running = a.runtimeRef ? (await prov.info(a.runtimeRef).catch(() => undefined))?.openclawVersion : undefined;
    return running ?? (await prov.currentImageInfo(a.image ?? undefined).catch(() => undefined))?.openclawVersion;
  };
  /**
   * A source's model list changed: each of its agents gets the new list now,
   * as a rebuild would write it (HB-0668), in its model queue, so it runs
   * after any model change already waiting. Only where the runtime runs the
   * model the source now gives the agent: one whose model moves, or whose
   * source switch waits, is owed a rebuild (pendingModel says so) and gets
   * the list with it. Mid-operation (busy), the operation writes the list.
   */
  const applyModelListNow = async (agentId: string): Promise<'live' | 'staged' | 'none' | 'failed'> => {
    const a = store.getAgent(agentId);
    const p = a && store.getAIProfile(a.aiProfileId);
    if (!a || !p || !a.runtimeRef || a.migratedTo || (a.state !== 'RUNNING' && a.state !== 'STOPPED')) return 'none';
    if (a.appliedProfileId !== a.aiProfileId || a.appliedModel !== effectiveModel(a, p)) return 'none';
    const version = await runtimeVersionOf(a);
    if (isBusy(agentId) || !!inFlight(agentId)) return 'none';
    const list = batchConfigCommands(switchableModelsFor(a, p, version))[0];
    if (!list) return 'none';
    const provider = providerFor(a.hostId);
    const res = a.state === 'RUNNING'
      ? await provider.exec(a.runtimeRef, list.argv)
      : await provider.execShellOnVolume(a.runtimeRef, `${seedInvocation(list)} >/dev/null`, { image: a.image ?? undefined });
    if (res.code !== 0) { trace(agentId)('model.list_set_failed', { stderr: (res.stderr || res.stdout).slice(0, 200) }); return 'failed'; }
    trace(agentId)('model.list_set', { models: new Set([effectiveModel(a, p), ...(p.models ?? [])]).size, allowlist: hasModelPolicy(version) });
    return a.state === 'RUNNING' ? 'live' : 'staged';
  };
  /** Every agent on a source, one after another, so a long list does not start a crowd of one-shots. Never rejects. */
  const pushModelList = async (profileId: string): Promise<void> => {
    for (const a of store.listAllActiveAgents().filter((x) => x.aiProfileId === profileId)) {
      await modelApplies.run(a.id, () => applyModelListNow(a.id)).catch((err) => trace(a.id)('model.list_set_failed', { error: String((err as Error)?.message ?? err).slice(0, 200) }));
    }
  };

  /**
   * The checks every image pin makes before it is stored (PATCH image, a
   * class's image): no way back across the 2026.8 line. Moving onto 2026.8+
   * migrates the volume (state database, roster, auth store) and 2026.7
   * cannot read it; the way back is the export taken before the move (28th
   * audit). Deliberately NOT checked against `docker images`: the point of a
   * pin is often an image that is about to exist (a candidate being built),
   * and a wrong name fails the next rebuild with a clear error and Retry.
   * sameImage: the tag IS the image already running (the default under
   * another name, the candidate just promoted), so it needs no rebuild —
   * every pin-and-rebuild path asks this rather than comparing tag names
   * (Chris, 2026-09-24).
   * `unanswered`: the container or the image gave no OpenClaw version (its
   * machine did not answer, or the image is not there yet): passed, as
   * before, but not an answer to keep (a class edit's next try asks again,
   * HB-0642).
   */
  const imagePinCheck = async (agent: Agent, image: string | null): Promise<{ problem?: string; sameImage?: boolean; unanswered?: true }> => {
    if (!agent.runtimeRef) return {};
    try {
      const prov = providerFor(agent.hostId);
      const [running, target] = await Promise.all([prov.info(agent.runtimeRef), prov.currentImageInfo(image ?? undefined)]);
      const sameImage = !!running.imageId && !!target.imageId && running.imageId === target.imageId;
      const unanswered = !running.openclawVersion || !target.openclawVersion ? { unanswered: true as const } : {};
      if (needsPortHeal(running.openclawVersion) && target.openclawVersion && !needsPortHeal(target.openclawVersion)) {
        return { sameImage, problem: `This agent's data was migrated for OpenClaw ${running.openclawVersion}; ${image ?? 'the fleet default'} runs ${target.openclawVersion}, which cannot read it. To go back, restore the copy downloaded before the move.` };
      }
      return { sameImage, ...unanswered };
    } catch { return { unanswered: true }; /* no image info: the rebuild will say */ }
  };

  /**
   * A model Anthropic refuses for the Claude Code version this agent's
   * OpenClaw presents on a subscription (modelOptions.ts): every message would
   * fail with an opaque HTTP 400 (2026-10-07). The OpenClaw that counts is the
   * one the model will run on: the running container's, or, when the change
   * lands with a rebuild, the image it is rebuilt on (`rebuildOn`, null = the
   * fleet default). One check for every way a model is chosen: a class gave
   * its model past it (audit #069).
   */
  const subscriptionRuntimeProblem = async (
    agent: Agent, profile: AIProfile, model: string | null | undefined, rebuildOn?: string | null,
  ): Promise<string | undefined> => (await subscriptionRuntime(agent, profile, model, rebuildOn)).problem;
  /** subscriptionRuntimeProblem, and whether the runtime it asked gave no version (`unanswered`: passed, as an unknown version is not refused). */
  const subscriptionRuntime = async (
    agent: Agent, profile: AIProfile, model: string | null | undefined, rebuildOn?: string | null,
  ): Promise<{ problem?: string; unanswered?: true }> => {
    if (!model || profile.kind !== 'subscription' || !SUBSCRIPTION_MIN_OPENCLAW[model]) return {};
    const prov = providerFor(agent.hostId);
    const info = rebuildOn !== undefined
      ? await prov.currentImageInfo(rebuildOn ?? undefined).catch(() => undefined)
      : agent.runtimeRef ? await prov.info(agent.runtimeRef).catch(() => undefined) : undefined;
    const problem = subscriptionModelProblem(model, info?.openclawVersion);
    return { ...(problem ? { problem } : {}), ...(info?.openclawVersion ? {} : { unanswered: true as const }) };
  };

  /**
   * The one check of what an agent will run once a change is stored (HB-0603
   * A): its source, its model and the OpenClaw that model runs on, taken
   * together. Every path that changes one of them asks it: the model route
   * (a pin set or cleared), PATCH (source, model, image), a class (assigned
   * or edited), the bulk switch and the manager's card (model-check). Each
   * used to check only the part it changed, so a cleared pin (HB-0555), a
   * class with only a source (HB-0556) and an image pin alone (HB-0459) could
   * put a subscription agent on a model its runtime refuses.
   * - `pin` given: the pin the change sets, null meaning the source's default.
   * - Not given, the agent's own pin rides along. A source switch drops one
   *   its new source does not offer or its runtime cannot use there, and the
   *   source's default stands in (`dropPin`, HB-0425); any other change that
   *   leaves it unable to run is refused.
   * - `rebuildOn`: the change lands with a rebuild (a source switch, a new
   *   image), on this image (null = the fleet default); left out, the
   *   container it runs now.
   * `problem`: what it would run cannot run there, so the change is refused.
   * `unanswered`: a runtime it asked gave no version (which passes), so
   * the verdict is not an answer to keep (a class edit's next try asks
   * again, HB-0642).
   */
  const finalModelCheck = async (
    a: Agent, target: AIProfile, next: { pin?: string | null; switching?: boolean; rebuildOn?: string | null },
  ): Promise<{ dropPin?: boolean; problem?: string; unanswered?: true }> => {
    let unanswered = false;
    const problemOf = async (model: string | null | undefined): Promise<string | undefined> => {
      const r = await subscriptionRuntime(a, target, model, next.rebuildOn);
      if (r.unanswered) unanswered = true;
      return r.problem;
    };
    const said = (r: { dropPin?: boolean; problem?: string }) => (unanswered ? { ...r, unanswered: true as const } : r);
    if (next.pin !== undefined || !next.switching) {
      const runs = next.pin !== undefined ? next.pin ?? target.model : effectiveModel(a, target);
      const problem = await problemOf(runs);
      if (!problem) return said({});
      // No pin: the source's default is what it would run, and said so
      // (HB-0555). A pin its source no longer offers is passed over the same
      // way, and named: the agent does have a model of its own.
      const own = next.pin !== undefined ? next.pin : a.model;
      if (own && own === runs) return said({ problem });
      return said({ problem: own
        ? `Its model ${own} is no longer on its source's menu, so it would run the source's default, and ${problem}`
        : `Without a model of its own it would run its source's default, and ${problem}` });
    }
    const pin = a.model && !modelOverrideProblem(target, a.model) ? a.model : undefined;
    if (pin && !(await problemOf(pin))) return said({});
    const problem = await problemOf(target.model);
    return said({ ...(pin ? { dropPin: true } : {}), ...(problem ? { problem } : {}) });
  };
  /**
   * A source switch lands with a rebuild, on the agent's own image (`image`:
   * the one being set with it): finalModelCheck, a pin it cannot use dropped.
   */
  const sourceSwitchRuntime = (a: Agent, target: AIProfile, image: string | null = a.image ?? null): Promise<{ dropPin?: boolean; problem?: string }> =>
    finalModelCheck(a, target, { switching: true, rebuildOn: image });
  /**
   * Why this agent may not be put on `model` now (null: back to its source's
   * default): the source's menu, then the runtime it runs. The model route
   * refuses with it, and the manager's card asks it first (model-check), so
   * a card is never filed for a change Confirm would refuse (HB-0597).
   */
  const modelChoiceProblem = async (agent: Agent, profile: AIProfile, model: string | null): Promise<{ status: 400 | 409; error: string } | undefined> => {
    const menu = modelOverrideProblem(profile, model);
    if (menu) return { status: 400, error: menu };
    const r = await finalModelCheck(agent, profile, { pin: model });
    return r.problem ? { status: 409, error: r.problem } : undefined;
  };

  return { applyModelToRuntime, askToApply, applyOwed, stop: () => { stopped = true; waits.abort(); }, pushModelList, imagePinCheck, subscriptionRuntimeProblem, finalModelCheck, sourceSwitchRuntime, modelChoiceProblem };
}
