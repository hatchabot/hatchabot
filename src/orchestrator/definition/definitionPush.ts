import type { Agent } from '../../domain/types.js';
import { DATA_SOURCES_HEADING, GOOGLE_ACCOUNTS_HEADING, readSection, removeSectionEverywhere, replaceSection } from '../../openclaw/workspace.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { semaphore } from '../../util/queues.js';
import { AgentBusyError, whileBusy } from '../lifecycle/busy.js';
import { refused, said, type Answer } from '../consult/answers.js';
import { workspacePath } from '../files/coreFiles.js';
import { CORE_FILES_WAIT_MS } from '../files/coreFileTurns.js';
import { operationRefusal } from '../lifecycle/operations.js';
import { autoSnapshot, CoreFileTooBigError, MAX_FILE_BYTES, readCoreFile, SnapshotError, writeFileInAgent } from '../files/snapshots.js';
import { applyParamValues, pushedParameters, renderedTooBig, renderPersona, resolveParamValues } from '../transfer/template.js';
import { TransferError } from '../transfer/transfer.js';

/** One child's line in a push's answer. */
export type Pushed = { id: string; name: string; ok: boolean; error?: string };

/**
 * Master → children definition push (HB-0808 step 15, part C): every
 * running child's SOUL.md and AGENTS.md rendered again from the master's
 * current definition (its raw template layer, or its live files), keeping
 * each child's own setup values, its Data sources and its Google accounts.
 * Each child in its core-files turn and under its busy flag, snapshot
 * first, four at a time to one shared deadline. No state of its own.
 */
export interface DefinitionPush {
  /**
   * Push a running master's definition to its children of `ownerId` (the
   * route found the master running and not busy). `owned` is the agent of
   * that id as the caller may see it now: the master and each child are
   * checked again through it after every wait.
   */
  push(master: Agent, ownerId: string, owned: (id: string) => Agent | undefined): Promise<Answer<{ pushed: number; results: Pushed[] }>>;
}

export interface DefinitionPushDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The agent's core-files turn (the files service's). */
  withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>, waitMs?: number) => Promise<T>;
  /** The agent as it is now, running, or the turn is refused in these words (the files service's). */
  freshRunning: (agentId: string, notRunning: (a: Agent) => string) => Agent & { runtimeRef: string };
  /** Its managed AGENTS.md sections brought up to date, under its busy flag; never rejects (routes.ts's `syncDocsHeld`). */
  syncDocsHeld: (a: Agent) => Promise<void>;
}

export function createDefinitionPush(deps: DefinitionPushDeps): DefinitionPush {
  const { store, providerFor, trace, withCoreFilesTurn, freshRunning, syncDocsHeld } = deps;
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  /**
   * Master → children definition push: re-render every RUNNING child's
   * SOUL/AGENTS from the master's CURRENT files, keeping each child's own
   * setup values. Snapshot-first per child, so any push is reversible; the
   * child's MEMORY.md (its lived history) is never touched.
   */
  const push: DefinitionPush['push'] = async (master, ownerId, owned) => {
    const children = store.listChildren(master.id).filter((c) => c.ownerId === ownerId);
    if (!children.length) return refused(400, 'This agent has no derived children.');
    const assertMasterCurrent = () => {
      const now = owned(master.id);
      if (!now || now.state !== 'RUNNING' || now.runtimeRef !== master.runtimeRef || now.hostId !== master.hostId || now.slug !== master.slug) {
        throw new TransferError('The master changed while preparing its definition. Refresh and try again.');
      }
    };
    /**
     * One file as it is: its text, '' when it is there and empty, undefined
     * when it is not there. A read that failed throws (SnapshotError): `head …
     * || true` read a sleeping runner as '' and the layer dropped the file,
     * so a SOUL.md the owner had cleared on purpose stayed as it was on every
     * child while the push reported success (review 2026-10-23).
     */
    const readCapped = async (agentLike: Agent, nameF: string): Promise<string | undefined> => {
      try {
        return await readCoreFile(providerFor(agentLike.hostId), agentLike.runtimeRef!, agentLike.slug, nameF);
      } catch (err) {
        if (err instanceof CoreFileTooBigError) throw new TransferError(`${nameF} is over ${MAX_FILE_BYTES / 1024}KB — trim it before pushing.`);
        throw err;
      }
    };
    // The master's RAW template layer, when it has one — a master that filled
    // its own setup values (the /params master-seeding flow) has RENDERED
    // live files; pushing those overwrote every child's per-child values with
    // the master's and froze placeholder-free text as each child's layer
    // (10th audit). Live files are only the source when no layer exists.
    // A file read as empty is pushed as empty; only a file that is not there
    // is left out.
    // The two reads hold the master's busy guard, as a file save does: a save
    // between them sent every child the old SOUL.md with the new AGENTS.md
    // (HB-0311).
    let layer: { soul?: string; agents?: string; persona?: string };
    try {
      layer = master.paramFiles ?? await whileBusy(master.id, 'definition-read', async () => {
        const soul = await readCapped(master, 'SOUL.md');
        assertMasterCurrent();
        const agents = await readCapped(master, 'AGENTS.md');
        assertMasterCurrent();
        return { soul, agents, persona: typeof master.persona === 'string' ? master.persona : undefined };
      });
      assertMasterCurrent();
    } catch (err) {
      if (err instanceof AgentBusyError) return refused(409, err.userMessage);
      if (err instanceof TransferError) return refused(400, err.userMessage);
      if (err instanceof SnapshotError) return refused(502, `Couldn't read the master's files: ${err.userMessage}`);
      return refused(502, "Couldn't read the master's files — is its machine awake?");
    }
    if (layer.soul === undefined && layer.agents === undefined) {
      return refused(400, 'The master has neither a SOUL.md nor an AGENTS.md to push.');
    }
    // The children together, four at a time: one after another, a request
    // behind several slow ones waited a turn's whole bound for each. A slot
    // first, then the child's turn, so one waiting for a slot holds nothing
    // of the child's; every turn is waited for until one shared deadline.
    const working = semaphore(4);
    const deadline = Date.now() + CORE_FILES_WAIT_MS;
    const inSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
      await working.acquire();
      try { return await fn(); } finally { working.release(); }
    };
    const settled = await Promise.allSettled(children.map(async (child): Promise<Pushed> => {
      if (child.state !== 'RUNNING' || !child.runtimeRef) {
        return { id: child.id, name: child.name, ok: false, error: `not running (${child.state})` };
      }
      // A child whose long operation is not over (a restore interrupted by a
      // restart, say) has files that are being put right: the transient busy
      // flag below is empty after a restart, and the push wrote under the
      // recovery (review 2026-10-23). Refused in the operation's words, as
      // every other file-writing route does.
      const onDisk = operationRefusal(store, child.id);
      if (onDisk) return { id: child.id, name: child.name, ok: false, error: onDisk };
      try {
        const pushedTo = await inSlot(() => withCoreFilesTurn(child.id, () => whileBusy(child.id, 'definition-push', async () => {
          // The child as it is at its turn, not as read before the wait: its
          // own values applied meanwhile went back to the old ones.
          const fresh = freshRunning(child.id, (a) => `not running (${a.state})`);
          const assertChildCurrent = () => {
            assertMasterCurrent();
            const now = owned(child.id);
            if (!now || now.parentAgentId !== master.id || now.state !== 'RUNNING'
                || now.runtimeRef !== fresh.runtimeRef || now.hostId !== fresh.hostId || now.slug !== fresh.slug) {
              throw new TransferError('The child changed owner, master or runtime while waiting for its definition. Refresh and try again.');
            }
          };
          assertChildCurrent();
          // Same split as the /params route: env creds and datasource repo
          // bindings never live in paramValues, so a required one must not
          // fail the resolve and block the push. Resolved against the MASTER's
          // current declarations, so a field added after derive reaches the
          // child too (leniently — the child fills its value later; until then
          // the {{placeholder}} renders verbatim, same as any unknown key).
          // The fields the child has after this push: the master's, and the
          // placeholders the pushed text still uses (pushedParameters).
          // The child's layer after it: the master's files, and the child's own
          // for a file the master has none of (that file is not written, so the
          // child's layer is still what it renders from; storing only the
          // master's dropped it, and Setup values never changed it again —
          // audit #015).
          const childLayer = {
            soul: layer.soul ?? fresh.paramFiles?.soul,
            agents: layer.agents ?? fresh.paramFiles?.agents,
            persona: layer.persona ?? fresh.paramFiles?.persona,
          };
          const childParams = pushedParameters(master.parameters, childLayer, fresh.parameters);
          const pushedParams = childParams
            .filter((p) => p.target !== 'env' && p.target !== 'datasource')
            .map((p) => ({ ...p, required: false }));
          const values = resolveParamValues(pushedParams, fresh.paramValues ?? {});
          // Rendered before any file is written: one too long fails this child only (HB-0309).
          const persona = typeof layer.persona === 'string' ? renderPersona(layer.persona, values) : undefined;
          // The child's "## Data sources" section is platform-maintained and
          // describes the CHILD's own mounts — a wholesale write of the
          // master's file told every child it had the master's repos until
          // the next rebuild (10th audit). Splice each child's own section
          // back into the pushed content.
          let childAgentsRead = true;
          const childAgentsMd = typeof layer.agents === 'string'
            ? await readCapped(fresh, 'AGENTS.md').catch(() => {
              childAgentsRead = false;
              return undefined;
            })
            : undefined;
          assertChildCurrent();
          const childData = readSection(childAgentsMd ?? '', DATA_SOURCES_HEADING);
          // Its Google accounts too: another agent's addresses must not reach it, nor its own go missing (HB-0394).
          const childGoogle = readSection(childAgentsMd ?? '', GOOGLE_ACCOUNTS_HEADING);
          // One its fences leave unsure is not "none": pushed, it kept the
          // master's Data sources or dropped its own Google accounts. This
          // child is not pushed, and says why (eighth review of HB-0520).
          const unsureHeading = childData.unsure ? DATA_SOURCES_HEADING : childGoogle.unsure ? GOOGLE_ACCOUNTS_HEADING : undefined;
          if (unsureHeading) throw new Error(`its AGENTS.md has a code fence that doesn't close above "${unsureHeading.replace(/^#+ /, '')}"; fix it and push again`);
          const childDataSection = childData.text;
          const childGoogleSection = childGoogle.text;
          // The master's own fences too: a section of the master's they leave
          // unsure is not replaced, and its own Google accounts or Data
          // sources went to the child (HB-0394). Refused, naming the master;
          // a section the push only removes goes in every copy (ninth review).
          const masterAgents = typeof layer.agents === 'string' ? applyParamValues(layer.agents, values) : '';
          const masterUnsure = [childDataSection ? DATA_SOURCES_HEADING : '', childGoogleSection ? GOOGLE_ACCOUNTS_HEADING : '']
            .find((h) => h && readSection(masterAgents, h).unsure);
          if (masterUnsure) throw new Error(`${master.name}'s AGENTS.md has a code fence that doesn't close above "${masterUnsure.replace(/^#+ /, '')}"; fix it there and push again`);
          // Checked before the snapshot: a child not pushed gets none (ninth review).
          await autoSnapshot(snapshotDeps(fresh), child.id, 'pre-params');
          assertChildCurrent();
          // Both files or neither: a SOUL.md written and an AGENTS.md that
          // failed left the child half on the new definition, with the
          // bookkeeping below skipped (review, 2026-10-22). What was written
          // goes back as it was before the push.
          // A file whose read failed, or that was not there, is not written
          // back as nothing: the pre-params snapshot is the way back for it.
          // One that was there and empty goes back empty.
          const written: Array<[string, string | undefined]> = [];
          const write = async (nameF: string, text: string) => {
            assertChildCurrent();
            const result = await writeFileInAgent(providerFor(fresh.hostId), fresh.runtimeRef!, workspacePath(fresh.slug, nameF), Buffer.from(text, 'utf8').toString('base64'));
            assertChildCurrent();
            return result;
          };
          try {
            for (const [nameF, text] of [['SOUL.md', layer.soul], ['AGENTS.md', layer.agents]] as const) {
              if (typeof text !== 'string') continue;
              let rendered = applyParamValues(text, values);
              if (nameF === 'AGENTS.md' && childDataSection) {
                rendered = replaceSection(rendered, DATA_SOURCES_HEADING, childDataSection);
              }
              if (nameF === 'AGENTS.md') {
                rendered = childGoogleSection ? replaceSection(rendered, GOOGLE_ACCOUNTS_HEADING, childGoogleSection) : removeSectionEverywhere(rendered, GOOGLE_ACCOUNTS_HEADING);
              }
              if (Buffer.byteLength(rendered, 'utf8') > MAX_FILE_BYTES) throw renderedTooBig(nameF); // review R16
              let beforeRead = nameF === 'AGENTS.md' ? childAgentsRead : true;
              const before = nameF === 'AGENTS.md' ? childAgentsMd : await readCapped(fresh, nameF).catch(() => {
                beforeRead = false;
                return undefined;
              });
              // A write that threw may have landed before the call was lost
              // (HB-0310), and so may one that answered with a failure (a
              // timeout, the runner out of reach): taken as not landed, it
              // stayed on the new definition while the push said it failed
              // (HB-1194, as HB-1083 for setup values). So the file is read
              // again after any failure, and it goes back with the others
              // unless it reads as it was (both reads worked, missing
              // included) or as anything but the new text (the write
              // replaces the file whole).
              let thrown: { err: unknown } | undefined;
              const r = await write(nameF, rendered).catch((err: unknown) => { thrown = { err }; return undefined; });
              if (!r || r.code !== 0) {
                // Not run at all (the runner did not answer, or the volume is
                // not there): nothing was sent, so nothing landed to put back.
                // Taken as maybe landed, a put-back that could not reach it
                // either said to restore the snapshot though nothing changed.
                if (r?.unreachable || r?.volumeMissing) throw new Error('write failed');
                let nowRead = true;
                const now = await readCapped(fresh, nameF).catch(() => {
                  nowRead = false;
                  return undefined;
                });
                if (!(nowRead && (now !== rendered || (beforeRead && now === before)))) written.push([nameF, before]);
                throw thrown ? thrown.err : new Error('write failed');
              }
              written.push([nameF, before]);
            }
          } catch (err) {
            const back = await Promise.all(written.map(([nameF, before]) => (before !== undefined ? write(nameF, before).then((r) => r.code === 0, () => false) : false)));
            if (back.every(Boolean)) throw err;
            throw new Error(`write failed, and ${written.filter((_, i) => !back[i]).map(([n]) => n).join(', ')} could not be put back: restore the pre-params snapshot`);
          }
          // Recorded before the turn ends, so a snapshot waiting on it takes
          // these files with these values and this layer (HB-0566).
          assertChildCurrent();
          if (persona !== undefined) store.setAgentPersona(child.id, persona);
          // The pushed RAW layer becomes the child's new template layer, so its
          // own Setup-values edits keep working against the CURRENT definition —
          // and the master's current field declarations come along, so the
          // child's values panel can ask for any newly-added field. A key at a
          // time: a file the master has none of stays as the child has it now,
          // not as read before the writes (a description changed meanwhile went back: HB-0567).
          store.setAgentParamState(child.id, values);
          for (const key of ['soul', 'agents', 'persona'] as const) {
            if (typeof layer[key] === 'string') store.setAgentParamFile(child.id, key, layer[key]);
          }
          store.setAgentParameters(child.id, childParams.length ? childParams : null);
          return fresh;
        }), Math.max(0, deadline - Date.now())));
        // Its OWN managed sections back (its peers, data sources, operator,
        // memory rules): the master's came along in the pushed file and stood
        // until the child's next rebuild (2026-09-28). Best-effort, off the reply.
        if (pushedTo.runtimeRef && pushedTo.state === 'RUNNING') void syncDocsHeld(pushedTo);
        trace(child.id)('definition.pushed', { from: master.id });
        return { id: child.id, name: child.name, ok: true };
      } catch (err) {
        // 200: a too-long description's reason (146) and renderedTooBig's were cut mid-word at 120 (HB-0309).
        return { id: child.id, name: child.name, ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
      }
    }));
    const results = settled.map((r, i): Pushed => (r.status === 'fulfilled'
      ? r.value
      : { id: children[i]!.id, name: children[i]!.name, ok: false, error: String((r.reason as Error)?.message ?? r.reason).slice(0, 200) }));
    return said({ pushed: results.filter((r) => r.ok).length, results });
  };

  return { push };
}
