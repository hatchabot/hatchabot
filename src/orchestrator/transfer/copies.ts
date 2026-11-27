import { randomUUID } from 'node:crypto';
import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { markBusy, whileBusy } from '../lifecycle/busy.js';
import { claimFirstContact } from '../members/claim.js';
import { modelOverrideProblem } from '../lifecycle/modelRuntime.js';
import { generateDeployKey } from '../apps/gitSource.js';
import { moveIdFrom, receiveMove } from './migrate.js';
import { beginOperation, rethrowIfCrash, type OpHandle } from '../lifecycle/operations.js';
import type { ProvisionDeps } from '../lifecycle/provision.js';
import { exportTemplate, importTemplate, LEGACY_TEMPLATE_FORMAT, readCloneMemory, readTemplate, TEMPLATE_FORMAT } from './template.js';
import { exportAgent, importAgent, ownersModel, peekFormat, TemplateTaskRefused, TransferError } from './transfer.js';

/**
 * A file's pinned image that this machine lacks is built only on the say-so
 * of whoever owns the machine it lands on: building runs the recipe's lines
 * here as root (the same privilege as making a derived image).
 */
export const imageChoice = (q: string | undefined, host: { ownerId: string }, ownerId: string) => ({
  image: q === 'build' || q === 'drop' ? (q as 'build' | 'drop') : undefined,
  mayBuild: host.ownerId === ownerId,
});

/**
 * Copies of an agent (HB-0808 step 12):
 * the whole agent as a file (a Download: its bot token, members and memory,
 * a credential) and back (restore, import of a full copy), a shareable
 * template (its instructions and tasks, without its bot, members or
 * conversations) and back (import of a template), a faithful copy on this
 * installation (clone) and a child of a master (derive).
 *
 * Its state: none. A Download holds the busy flag while it reads the volume;
 * an import of a full copy is a long operation on disk (operations.ts),
 * undone at the start when a restart cut it off (`resumeImport`); a clone
 * holds the busy flag of both agents while the copy's private settings are
 * copied.
 *
 * Nothing here knows about HTTP: a route checks who is asking and what they
 * sent, asks this, and words the answer. Refusals are thrown (TransferError
 * and its kinds, SourceGoneError, ImportCleanupPending), as transfer.ts and
 * template.ts throw them; a busy agent's is AgentBusyError (lifecycle/busy.ts).
 */
export interface Copies {
  /** The whole agent as a file, under its busy flag for the whole read (exportAgent). */
  download(agent: Agent): Promise<{ filename: string; data: Buffer; dropped: string[] }>;
  /** Its template, with what it mentions (`personal`) and the files changed outside the editor (`edited`). */
  template(agent: Agent, includeMemory: boolean): ReturnType<typeof exportTemplate>;
  /** What a template would mention, without making it. */
  scan(agent: Agent, includeMemory: boolean): Promise<{ personal: Awaited<ReturnType<typeof exportTemplate>>['personal']; edited: string[] }>;
  /** A move from another Hatchabot names itself (its header's id): recorded now, before the import awaits anything (receiveMove). */
  receiveMove(moveHeader: unknown, ownerId: string): ReturnType<typeof receiveMove>;
  /** Is this file a template (else a full copy)? Read off the event loop where it must be read whole (peekFormat). */
  isTemplate(data: Buffer): Promise<boolean>;
  /** Restore a full copy as the same agent, on `host` (importAgent): its bot, members and memory. */
  importCopy(host: { id: string; ownerId: string }, data: Buffer, o: { ownerId: string; aiProfileId?: string; image?: string; onOperation: (id: string) => void }): Promise<Agent>;
  /** A template stood up as a fresh agent the importer owns, with its setup answers' credentials and repo bindings. */
  importTemplateFile(host: { id: string }, data: Buffer, o: { ownerId: string; aiProfileId?: string; name?: string; values?: Record<string, string>; onRow?: () => void }): Promise<{ agent: Agent; needs: unknown }>;
  /**
   * Filled env-target setup fields become real agent env vars, and repo
   * fields their bindings, before the agent is set up. On a failure the fresh
   * agent is rolled back whole (TransferError); after a restart part way,
   * the boot's resume rolls it back (an import operation; `shareId`: the
   * share accepted for it, put back in the inbox then; `childOf`: the name
   * of the master it is a child of, named in what the owner is told).
   */
  materializeImportEffects(agent: Agent, envValues: Array<{ name: string; value: string }>, dataSourceValues: Array<{ key: string; sshUrl: string; repoName: string }>, o?: { shareId?: string; childOf?: string }): Promise<void>;
  /**
   * A faithful copy on this installation, with a fresh identity, set up in
   * the background. `current`: the source as its owner sees it now (judged
   * after each wait); `ask`: what was asked (read once its template is made,
   * where the request was read). `onRow`, here and on the other copies that
   * make an agent: told in the turn its row is made (the agent cap's place
   * for the request goes then: HB-1121).
   */
  clone(agent: Agent, o: { owner: string; current: () => Agent | undefined; ask: () => { name?: string | null; telegram?: unknown } | null | undefined; onRow?: () => void }): Promise<{
    clone: Agent; notCopied: string[]; envNotCopied: string[];
    /** Its owner's model, which the copy's AI source does not offer: the copy runs on that source's default. */
    modelNotCopied?: string;
    carried: Awaited<ReturnType<typeof readCloneMemory>>;
  }>;
  /** A child of a master: its template (no memory) with the child's own setup values, lineage recorded, set up in the background. */
  derive(agent: Agent, o: { ownerId: string; name: string; values?: Record<string, string>; onRow?: () => void }): Promise<Agent>;
}

/** What the copies need from the process they run in. Functions only, so a test hands them fakes. */
export interface CopiesDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Telegram's provisioner (a full copy brings its bot). */
  channel: CompositeTelegramProvisioner;
  /** The memory search service as a build needs it (routes.ts's, read when an import runs). */
  embedder: () => ProvisionDeps['embedder'];
  /** Checks an imported file's bot token with Telegram (the app sets it; tests leave it unset). */
  verifyImportedToken?: (token: string) => Promise<string>;
  /** Set up a new agent in the background (the setup and rebuild queue). */
  kickProvision: (agentId: string, opts?: { webOnlyIfNoBot?: boolean }) => void;
  /** The agent settings service forgets a copy rolled back (its class and model records). */
  forgetAgent: (agentId: string) => void;
  /** The journal's error line. */
  logError: (detail: Record<string, unknown>, msg: string) => void;
  /** An agent's core-files turn (the agent files service's, files.ts): the one its definition's writes take. */
  withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
}

export function createCopies(deps: CopiesDeps): Copies {
  const { store, secrets, providerFor, trace, kickProvision, forgetAgent } = deps;

  /**
   * Its template, read in its core-files turn, where a change to its
   * definition (setup values, a pushed definition, a restore) writes SOUL.md,
   * AGENTS.md and their raw layer: read beside one, a copy took the old
   * SOUL.md with the new AGENTS.md, a pair that never existed (HB-0964).
   * A turn that does not come in time rejects with the turn's AgentBusyError,
   * which the routes answer 409, as every other busy refusal (HB-1166).
   */
  const exportInTurn = (agent: Agent, d: Parameters<typeof exportTemplate>[0], includeMemory: boolean): ReturnType<typeof exportTemplate> =>
    deps.withCoreFilesTurn(agent.id, () => exportTemplate(d, agent.id, { includeMemory }));

  /** An imported agent with nobody in the owner's seat on its bot: claim the importer's first message (HB-0076). */
  const watchImportedOwner = (agent: Agent, o: { accountId: string; excludeIds: string[] }): void => {
    if (!agent.runtimeRef) return;
    void claimFirstContact(
      { store, provider: providerFor(agent.hostId), providerFor, log: trace(agent.id) },
      { agentId: agent.id, runtimeRef: agent.runtimeRef, accountId: o.accountId, forUserId: agent.ownerId, timeoutMs: 30 * 60_000, excludeIds: o.excludeIds },
    ).catch((err) => deps.logError({ err, agentId: agent.id }, 'owner claim after import failed'));
  };

  /**
   * Phase 2b: filled env-target setup fields become real agent env vars —
   * secret in the SecretStore, name in agent_env — BEFORE provisioning, so
   * the container first boots with them. importTemplate is sync and
   * secret-free by design; this async step is the route layer's half. On
   * failure the fresh agent is rolled back whole, matching import semantics.
   */
  const materializeImportEffects = async (
    agent: Agent,
    envValues: Array<{ name: string; value: string }>,
    dataSourceValues: Array<{ key: string; sshUrl: string; repoName: string }>,
    o: { shareId?: string; childOf?: string } = {},
  ): Promise<void> => {
    // ONE rollback list across both kinds: env secrets written before a repo
    // binding fails must be deleted too — scrubAgentResidue removes rows, not
    // secrets, so two separate helpers orphaned the env credentials in the
    // SecretStore forever (10th audit).
    const created: string[] = [];
    let phase = 'setup credentials';
    // The draft is in the roster while its answers are stored: held busy, as a
    // clone's is, or a Delete meanwhile tore it down and the write still under
    // way put its credential back on the tombstone (HB-0926). Taken before the
    // first wait, in the turn the record was made in.
    const release = markBusy(agent.id, 'template-answers');
    // The answers live in this request alone until stored: a restart part way
    // left the draft with some of its credentials, the boot's reconcile marked
    // it FAILED, and Retry built it without the rest (HB-0927). An import's
    // operation on disk meanwhile: reconcile leaves the draft alone, and the
    // boot's resume (resumeImport) undoes it whole.
    let op: OpHandle | undefined;
    try {
      if (envValues.length || dataSourceValues.length) {
        op = beginOperation(store, 'import', agent.id, {
          slug: agent.slug, hostId: agent.hostId, template: true,
          ...(o.shareId ? { shareId: o.shareId } : {}), ...(o.childOf !== undefined ? { childOf: o.childOf } : {}),
        },
          { hostId: agent.hostId, requestedBy: agent.ownerId });
      }
      for (const v of envValues) {
        const id = randomUUID();
        const ref = `agent-env/${id}`;
        await secrets.put(ref, v.value);
        created.push(ref);
        store.insertAgentEnv({ id, agentId: agent.id, name: v.name, secretRef: ref, createdAt: new Date().toISOString() });
      }
      phase = 'repo binding';
      for (const d of dataSourceValues) {
        const id = randomUUID();
        const key = generateDeployKey(`hatchabot-${agent.slug}-${d.repoName}-deploy`);
        const secretRef = `data-source/${id}`;
        await secrets.put(secretRef, key.privateKey);
        created.push(secretRef);
        store.insertDataSource({
          id, agentId: agent.id, kind: 'git', access: 'ro', mountName: d.repoName,
          repoUrl: d.sshUrl, secretRef, pubKey: key.publicKey, createdAt: new Date().toISOString(),
        });
      }
      op?.done('Its setup answers were stored; setting it up.');
    } catch (err) {
      rethrowIfCrash(err);
      for (const ref of created) await secrets.delete(ref).catch(() => {});
      try {
        store.scrubAgentResidue(agent.id);
        forgetAgent(agent.id);
        store.setAgentState(agent.id, 'DELETING');
        store.setAgentState(agent.id, 'DELETED');
      } catch { /* rollback is best-effort; the import error below is what the user sees */ }
      const e = new TransferError(`Couldn't store the ${phase}: ${String((err as Error).message ?? err).slice(0, 200)}`);
      try { op?.rolledBack(e.userMessage); } catch { /* the error below is what the user sees */ }
      throw e;
    } finally {
      release();
    }
  };

  /**
   * The template a copy is made through, read as a template file is, but a
   * task of its refused says so as a copy of `agent` ("Can't copy …"), not as
   * a file ("That template can't be used …", HB-1018).
   */
  const readCopyOf = (agent: Agent, data: Buffer) => readTemplate(data).catch((err: unknown) => {
    throw err instanceof TemplateTaskRefused ? err.copyOf(agent.name) : err;
  });

  return {
    // HOLD the busy flag for the whole export, not just check it: exportAgent
    // quiesces then tars the volume (minutes on a large agent), and without
    // the flag a concurrent Start passed its guards and booted the container
    // to write the volume mid-`tar`, silently tearing the archive.
    //
    // It stops a running agent for the copy and starts it again when the
    // copy fails. A restart in the copy left it stopped with no file: kept
    // from before the stop, the next start starts it again (HB-1479).
    download: (agent) => whileBusy(agent.id, 'download', async () => {
      const kept = store.getAgent(agent.id)?.state === 'RUNNING' ? randomUUID() : undefined;
      if (kept) store.setAgentHold(agent.id, 'download-stop', kept);
      try {
        return await exportAgent(
          { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel,
            log: trace(agent.id) },
          agent.id,
        );
      } finally {
        if (kept) store.clearAgentHold(agent.id, 'download-stop', kept);
      }
    }),

    template: (agent, includeMemory) => exportInTurn(agent, { store, provider: providerFor(agent.hostId), log: trace(agent.id) }, includeMemory),

    scan: async (agent, includeMemory) => {
      const { personal, edited } = await exportInTurn(agent, { store, provider: providerFor(agent.hostId) }, includeMemory);
      return { personal, edited };
    },

    receiveMove: (moveHeader, ownerId) => receiveMove(store, moveIdFrom(moveHeader), ownerId),

    isTemplate: async (data) => [TEMPLATE_FORMAT, LEGACY_TEMPLATE_FORMAT].includes(await peekFormat(data) as string),

    importCopy: (host, body, o) => importAgent(
      // No id yet — trace() picks it up from the orchestrator's log detail.
      { store, secrets, provider: providerFor(host.id), channel: deps.channel, log: trace(), embedder: deps.embedder() },
      body,
      { ownerId: o.ownerId, aiProfileId: o.aiProfileId, hostId: host.id, ...imageChoice(o.image, host, o.ownerId), verifyToken: deps.verifyImportedToken,
        onOperation: o.onOperation, watchOwner: watchImportedOwner },
    ),

    importTemplateFile: async (host, body, o) => {
      // Read off the event loop, then made in one turn (HB-1162).
      const manifest = await readTemplate(body);
      const { agent, needs, envValues, dataSourceValues } = importTemplate(
        { store, provider: providerFor(host.id), log: trace() },
        manifest,
        { ownerId: o.ownerId, aiProfileId: o.aiProfileId, hostId: host.id, name: o.name, values: o.values },
      );
      o.onRow?.();
      await materializeImportEffects(agent, envValues, dataSourceValues);
      return { agent, needs };
    },

    materializeImportEffects,

    clone: async (agent, { owner, current, ask, onRow }) => {
      const deps = { store, provider: providerFor(agent.hostId), log: trace() };
      const assertCloneSourceCurrent = () => {
        const now = current();
        if (!now || now.state !== 'RUNNING' || now.runtimeRef !== agent.runtimeRef || now.hostId !== agent.hostId
            || now.slug !== agent.slug || providerFor(now.hostId) !== deps.provider) {
          throw new TransferError('The source agent changed while copying. Refresh and try again.');
        }
      };
      const release = markBusy(agent.id, 'clone-source');
      try {
        const { data } = await exportInTurn(agent, deps, true);
        // Read off the event loop, then made in one turn (HB-1162).
        const manifest = await readCopyOf(agent, data);
        assertCloneSourceCurrent();
        const asked = ask();
        const name = asked?.name?.trim() || `${agent.name} (copy)`;
        // Faithful copy: reuse the source's own filled values; lenient so a
        // required env/datasource field (whose materialized record lives on
        // the source, not in values) can't make cloning impossible.
        // The same AI source and machine as the original, where the cloner may
        // use them: left out, the copy went to the default source (another key
        // or plan to bill) and the local machine (review, 2026-10-22).
        const source = store.getAIProfile(agent.aiProfileId);
        const aiProfileId = source && (source.ownerId === owner || source.shared) ? source.id : undefined;
        const hostId = store.listHosts(owner).some((h) => h.id === agent.hostId) ? agent.hostId : undefined;
        const { agent: clone } = importTemplate(deps, manifest, {
          ownerId: owner, name, values: agent.paramValues ?? {}, lenient: true, aiProfileId, hostId,
        });
        onRow?.();
        // Everything from here to the build is undone together on a failure:
        // a failed secret copy used to leave the half-made clone (holding its
        // name, so a retry was refused) and the secrets copied so far (#165).
        const created: string[] = [];
        let notCopied: string[];
        // A variable whose value could not be read is named, not dropped in
        // silence: the copy would build without the key its app needs and
        // nobody told (review, 2026-10-22).
        const envNotCopied: string[] = [];
        let modelNotCopied: string | undefined;
        let carried: Awaited<ReturnType<typeof readCloneMemory>>;
        // The draft appears in the roster while its private settings copy.
        // A concurrent lifecycle action must not provision it half-filled.
        const releaseClone = markBusy(clone.id, 'clone-draft');
        // Its settings live in this request alone until copied: a restart part
        // way left the copy with some of its variables, the boot's reconcile
        // marked it FAILED, and Retry built it without the rest (HB-1164). An
        // import's operation on disk meanwhile, begun in the turn the record
        // was made in: the boot's resume (resumeImport) undoes it whole.
        let op: OpHandle | undefined;
        try {
          op = beginOperation(store, 'import', clone.id, { slug: clone.slug, hostId: clone.hostId, template: true, cloneOf: agent.name },
            { hostId: clone.hostId, requestedBy: owner });
          store.setAgentParent(clone.id, agent.id); // lineage: a clone is a child
          // Its model too, where the copy's source offers it (the rule a full
          // copy's import keeps): left out, a clone of an agent pinned to a
          // smaller model ran on its source's default, at another cost (HB-1082).
          // Its owner's choice, not the cheaper one a budget moved it to; one
          // that cannot come is named in the answer (HB-1165).
          const own = ownersModel(store, agent);
          if (own) {
            const on = store.getAIProfile(clone.aiProfileId);
            if (on && !modelOverrideProblem(on, own)) store.setAgentModel(clone.id, own);
            else {
              modelNotCopied = own;
              trace(clone.id)('agent.clone_model_skipped', { sourceAgentId: agent.id, model: own });
            }
          }
          // A faithful copy carries its environment variables too (new secret
          // refs, same values), before its first build reads them. Data
          // sources (deploy keys, clones) are not copied: they are named in the
          // answer so the owner is told, not left with tools that fail (night review).
          for (const e of store.listAgentEnv(agent.id)) {
            const value = await secrets.get(e.secretRef).catch(() => undefined);
            assertCloneSourceCurrent();
            if (value === undefined) { envNotCopied.push(e.name); continue; }
            const id = randomUUID();
            const secretRef = `agent-env/${id}`;
            created.push(secretRef);
            await secrets.put(secretRef, value);
            assertCloneSourceCurrent();
            store.insertAgentEnv({ id, agentId: clone.id, name: e.name, secretRef, createdAt: new Date().toISOString() });
          }
          notCopied = store.listDataSources(agent.id).map((d) => d.mountName);
          // Its daily notes (memory/) and USER.md too: most of what an agent
          // saves lives there, not in MEMORY.md (2026-09-30). Seeded like the
          // rest, before the first build; what could not come is named.
          carried = await readCloneMemory(deps.provider, agent.runtimeRef!, agent.slug);
          assertCloneSourceCurrent();
          if (Object.keys(carried.files).length) store.setAgentSeed(clone.id, carried.files);
          // `telegram: false`: web-only, as create — no pool bot taken (2026-10-08).
          if (asked?.telegram === false) store.setAgentWebOnly(clone.id, true);
          op.done('Its settings were copied; setting it up.');
        } catch (err) {
          rethrowIfCrash(err);
          for (const ref of created) await secrets.delete(ref).catch(() => {});
          try {
            store.scrubAgentResidue(clone.id);
            forgetAgent(clone.id);
            store.setAgentState(clone.id, 'DELETING');
            store.setAgentState(clone.id, 'DELETED');
          } catch { /* best-effort; the error below is what the user sees */ }
          trace(clone.id)('agent.clone_failed', { sourceAgentId: agent.id, error: String((err as Error).message ?? err).slice(0, 200) });
          const e = new TransferError(`Couldn't copy ${agent.name}'s settings to the clone: ${String((err as Error).message ?? err).slice(0, 200)}. Nothing was kept; try again.`);
          try { op?.rolledBack(e.userMessage); } catch { /* the error below is what the user sees */ }
          throw e;
        } finally {
          releaseClone();
        }
        if (envNotCopied.length) trace(clone.id)('agent.clone_env_skipped', { sourceAgentId: agent.id, names: envNotCopied.join(', ') });
        kickProvision(clone.id, { webOnlyIfNoBot: true });
        return { clone, notCopied, envNotCopied, ...(modelNotCopied ? { modelNotCopied } : {}), carried };
      } finally {
        release();
      }
    },

    derive: async (agent, { ownerId, name, values, onRow }) => {
      const deps2 = { store, provider: providerFor(agent.hostId), log: trace() };
      const { data } = await exportInTurn(agent, deps2, false);
      // Read off the event loop, then made in one turn (HB-1162).
      const { agent: child, envValues, dataSourceValues } = importTemplate(deps2, await readCopyOf(agent, data), {
        ownerId, name, values,
      });
      onRow?.();
      await materializeImportEffects(child, envValues, dataSourceValues, { childOf: agent.name });
      store.setAgentParent(child.id, agent.id);
      trace(child.id)('agent.derived', { parentAgentId: agent.id, parentName: agent.name });
      kickProvision(child.id, { webOnlyIfNoBot: true });
      return child;
    },
  };
}
