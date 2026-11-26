import { z } from 'zod';
import type { Agent } from '../../domain/types.js';
import { DATA_SOURCES_HEADING, GOOGLE_ACCOUNTS_HEADING, INSTALL_HEADING, OPERATOR_HEADING, PEERS_HEADING, readSection, removeInstallSections, removeSectionEverywhere, replaceSection, SCHEDULED_RESULTS_HEADING, unsureSections, withInstallSection } from '../../openclaw/workspace.js';
import { OPS_MANAGED_HEADINGS, OPS_RENAMED_HEADINGS } from '../../ops/opsAgent.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { AgentBusyError, whileBusy } from '../lifecycle/busy.js';
import { refused, said, type Answer } from '../consult/answers.js';
import { workspacePath } from '../files/coreFiles.js';
import { TurnRefused } from '../files/coreFileTurns.js';
import { autoSnapshot, CoreFileTooBigError, MAX_FILE_BYTES, readCoreFile, SnapshotError, writeFileInAgent } from '../files/snapshots.js';
import { applyParamValues, renderedTooBig, renderPersona, resolveParamValues } from '../transfer/template.js';
import { TransferError } from '../transfer/transfer.js';

/** The AGENTS.md sections Hatchabot keeps (provision.ts, syncDataSourceDocs), but its install section. */
const KEPT_SECTIONS = [DATA_SOURCES_HEADING, '## Memory policy', '## Memory budget', OPERATOR_HEADING, GOOGLE_ACCOUNTS_HEADING, SCHEDULED_RESULTS_HEADING, PEERS_HEADING];

/**
 * AGENTS.md rendered from the layer, with the sections Hatchabot keeps as the
 * live file has them now. The layer holds them as they were when it was made
 * (a master's own file on its first edit): rendered over the file, it put
 * back the accounts, folders and peers taken away since and dropped the ones
 * added, until the next rebuild (HB-0959). A section the live file does not
 * have goes; one either text's code fences leave unsure is refused, naming it,
 * as a pushed definition is.
 */
function withLiveSections(rendered: string, live: string, ops: boolean): string {
  const headings = [...KEPT_SECTIONS, ...(ops ? [...OPS_MANAGED_HEADINGS, ...Object.keys(OPS_RENAMED_HEADINGS)] : [])];
  const unsure = [...unsureSections(live, [...headings, INSTALL_HEADING]), ...unsureSections(rendered, [...headings, INSTALL_HEADING])][0];
  if (unsure) throw new TransferError(`AGENTS.md has a code fence that doesn't close above "${unsure.replace(/^#+ /, '')}"; fix it, then apply the values again.`);
  let out = rendered;
  for (const heading of headings) {
    const now = readSection(live, heading).text;
    out = now ? replaceSection(out, heading, now) : removeSectionEverywhere(out, heading);
  }
  return readSection(live, INSTALL_HEADING).text ? withInstallSection(out) : removeInstallSections(out);
}

/** What PUT /v1/agents/:id/params sends: the values to apply, or a reset to the defaults. */
export interface SetupValuesAsk { values?: unknown; reset?: unknown }
/** The answer once the values are in the files. */
export interface SetupValuesApplied { applied: true; values: Record<string, string>; warning?: string }

/**
 * An agent's setup values, edited (or reset) in place (HB-0808 step 15,
 * part C): the agent keeps its raw placeholder-bearing layer (paramFiles,
 * from its import, or seeded from a master's own files on its first edit)
 * and SOUL.md, AGENTS.md and its description are rendered again from it
 * with the new values, in the agent's core-files turn and under its busy
 * flag, snapshot first. No state of its own.
 */
export interface SetupValues {
  /**
   * The checks made before the busy flag, in their order: the fields it
   * declares, running, what was sent. Refused, or the change to run once the
   * route has found the agent free (`busyNow`).
   */
  prepare(agent: Agent, body: SetupValuesAsk): Answer<() => Promise<Answer<SetupValuesApplied>>>;
}

export interface SetupValuesDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The agent's core-files turn (the files service's). */
  withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>, waitMs?: number) => Promise<T>;
  /** The agent as it is now, running, or the turn is refused in these words (the files service's). */
  freshRunning: (agentId: string, notRunning: (a: Agent) => string) => Agent & { runtimeRef: string };
}

export function createSetupValues(deps: SetupValuesDeps): SetupValues {
  const { store, providerFor, trace, withCoreFilesTurn, freshRunning } = deps;
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  /**
   * Edit (or reset) a configured template copy's setup values in place —
   * standing preferences change over time, and a Share→Import round-trip is
   * a terrible way to flip "enable LEAPS". The agent keeps its raw
   * placeholder-bearing layer from import (paramFiles); this re-renders
   * SOUL/AGENTS/persona from it with the new values. A snapshot is taken
   * first, so a re-render over hand-edits is always recoverable.
   */
  const prepare: SetupValues['prepare'] = (agent, body) => {
    const NO_FIELDS = 'This agent declares no setup fields — add them under 📖 Definition → Setup fields first.';
    const NO_FILE_FIELDS = "All of this agent's setup fields are env credentials or repo bindings — change those under ⚙ Settings → Environment / Data.";
    if (!agent.parameters?.length) return refused(400, NO_FIELDS);
    // Env-target fields (Phase 2b) are write-only credentials managed under
    // Settings → Environment, and datasource-target fields materialized as
    // git sources managed under Settings → Data — neither lives in
    // paramValues, and neither may block (as "required") the re-render of
    // the file-target fields.
    const fileFields = (fields: NonNullable<Agent['parameters']>) => fields.filter((p) => p.target !== 'env' && p.target !== 'datasource');
    const editableParams = fileFields(agent.parameters);
    if (!editableParams.length) return refused(400, NO_FILE_FIELDS);
    if (agent.state !== 'RUNNING') {
      return refused(409, 'Start the agent to change its setup values.');
    }
    // An empty body would resolve as {} and silently re-apply every default
    // over the current values — a reset nobody asked for. Require intent.
    if (body.values === undefined && !body.reset) {
      return refused(400, 'Send { values } to apply, or { reset: true } to restore defaults.');
    }
    const vals = z
      .record(z.string().max(64), z.string().max(2000))
      .refine((r) => Object.keys(r).length <= 24)
      .optional()
      .safeParse(body.values);
    if (!vals.success) return refused(400, 'Malformed setup values.');
    let resolved: Record<string, string>;
    try {
      // reset → resolve with nothing supplied: defaults fill in (a required
      // field WITHOUT a default correctly refuses a blanket reset).
      resolved = resolveParamValues(editableParams, body.reset ? {} : (vals.data ?? {}));
    } catch (err) {
      if (err instanceof TransferError) return refused(400, err.userMessage);
      throw err;
    }
    return said(async (): Promise<Answer<SetupValuesApplied>> => {
      // Seed + write both run INSIDE the busy guard: the master-seeding reads
      // become this agent's permanent template layer, and a concurrent file
      // save or restore interleaving with them would freeze a torn layer
      // (audit 2026-09-03).
      class NoPlaceholders extends Error {}
      let warning: string | undefined;
      /**
       * The values and the layer the files now hold, recorded before the turn
       * ends: a snapshot waiting on it took the new files with the old values
       * and layer (HB-0566).
       */
      const recordApplied = (fresh: Agent, layer: NonNullable<Agent['paramFiles']>) => {
        // Persist the freshly seeded layer on a master's first edit, a key at a
        // time; imported copies already have theirs stored. Its description as
        // it is now, not as read at the start: one changed during the writes
        // went back to the old one (HB-0567).
        if (!fresh.paramFiles) {
          store.setAgentParamFile(agent.id, 'soul', layer.soul);
          store.setAgentParamFile(agent.id, 'agents', layer.agents);
          store.setAgentParamFile(agent.id, 'persona', store.getAgent(agent.id)?.persona || undefined);
        }
        const personaLayer = store.getAgent(agent.id)?.paramFiles?.persona;
        // Checked above when it was the one read then. A newer one that these
        // values make too long is left as its owner set it, and said: answered
        // as applied, the description silently kept its old values.
        if (typeof personaLayer === 'string') {
          try { store.setAgentPersona(agent.id, renderPersona(personaLayer, resolved)); }
          catch (err) {
            if (!(err instanceof TransferError) || personaLayer === layer.persona) throw err;
            warning = `The files have the new values, but the description was changed meanwhile and was not filled in with them: ${err.userMessage}`;
          }
        }
        store.setAgentParamState(agent.id, resolved);
      };
      try {
        // The files turn first, the busy flag once it is ours: waiting behind a
        // snapshot does not make the agent busy for everything else.
        const res = await withCoreFilesTurn(agent.id, () => whileBusy(agent.id, 'setup-values', async () => {
          // As it is at its turn, not as read before the wait: a file saved
          // or values applied meanwhile stored the layer it renders from, and
          // the old one written over them undid them.
          const fresh = freshRunning(agent.id, () => 'Start the agent to change its setup values.');
          // Its fields as they are now too: a definition pushed meanwhile may
          // have added one. One the caller never saw keeps the value it has,
          // a reset too: a reset puts back only the fields it showed.
          if (!fresh.parameters?.length) throw new TurnRefused(400, NO_FIELDS);
          const fields = fileFields(fresh.parameters);
          if (!fields.length) throw new TurnRefused(400, NO_FILE_FIELDS);
          const unseen = Object.fromEntries(Object.entries(fresh.paramValues ?? {}).filter(([key]) => !editableParams.some((p) => p.key === key)));
          resolved = resolveParamValues(fields, body.reset ? unseen : { ...unseen, ...(vals.data ?? {}) });
          let paramFiles = fresh.paramFiles;
          const read = (name: string) => readCoreFile(providerFor(fresh.hostId), fresh.runtimeRef!, fresh.slug, name).catch((err: unknown) => {
            if (err instanceof CoreFileTooBigError) throw new TransferError(`${name} is over ${MAX_FILE_BYTES / 1024}KB — trim it before changing its setup values.`);
            throw err;
          });
          let liveAgents: string | undefined;
          if (!paramFiles) {
            // The raw placeholder-bearing layer normally arrives on import.
            // On a MASTER — fields authored here, live files still carrying
            // their {{placeholders}} — seed the layer from the live files on
            // first edit, so the author can fill values directly instead of
            // the Send→Import round-trip this feature exists to kill.
            // A read that failed refuses the edit: `cat … || true` read an
            // unreadable SOUL.md as missing, and the layer stored without it
            // never configured that file again (audit #014).
            const soul = await read('SOUL.md');
            const agentsMd = liveAgents = await read('AGENTS.md');
            paramFiles = {
              soul: soul || undefined,
              agents: agentsMd || undefined,
              persona: fresh.persona || undefined,
            };
            const PH = /\{\{\s*[a-z][a-z0-9_]{0,31}\s*\}\}/;
            if (![paramFiles.soul, paramFiles.agents, paramFiles.persona].some((t) => typeof t === 'string' && PH.test(t))) {
              throw new NoPlaceholders();
            }
          }
          const writes: Array<{ name: string; content: string }> = [];
          // Rendered past the core-file limit: refused before the snapshot and the writes (review R16),
          // SOUL.md before AGENTS.md is read for its live sections.
          const fits = () => { for (const w of writes) if (Buffer.byteLength(w.content, 'utf8') > MAX_FILE_BYTES) throw renderedTooBig(w.name); };
          if (typeof paramFiles.soul === 'string') {
            writes.push({ name: 'SOUL.md', content: applyParamValues(paramFiles.soul, resolved) });
          }
          fits();
          if (typeof paramFiles.agents === 'string') {
            const live = liveAgents ?? await read('AGENTS.md');
            writes.push({ name: 'AGENTS.md', content: withLiveSections(applyParamValues(paramFiles.agents, resolved), live ?? '', !!fresh.ops) });
          }
          fits();
          // The description too: over the limit, the agent's own backup could not be imported (HB-0309).
          if (typeof paramFiles.persona === 'string') renderPersona(paramFiles.persona, resolved);
          await autoSnapshot(snapshotDeps(fresh), agent.id, 'pre-params');
          // All the files or none: a SOUL.md written and an AGENTS.md that
          // failed left the agent half on the new values while its stored
          // values said the old ones (audit #013). What was written goes back
          // as it was, as push-definition does; a file whose read failed, or
          // that was not there, is not written back as nothing: the
          // pre-params snapshot is the way back for it.
          const write = (name: string, text: string) =>
            writeFileInAgent(providerFor(fresh.hostId), fresh.runtimeRef!, workspacePath(fresh.slug, name), Buffer.from(text, 'utf8').toString('base64'));
          const written: Array<[string, string | undefined]> = [];
          for (const w of writes) {
            let beforeRead = true;
            const before = await readCoreFile(providerFor(fresh.hostId), fresh.runtimeRef!, fresh.slug, w.name).catch(() => {
              beforeRead = false;
              return undefined;
            });
            // A write that threw (the runner's daemon gone mid-call) is a
            // failed write too: it skipped the putting back (HB-0310). It may
            // have landed before the call was lost, and so may one that
            // answered with a failure (a timeout, the runner out of reach):
            // taken as not landed, it stayed on the new values while the
            // answer said nothing was changed (HB-1083). So the file is read
            // again after any failure, and it goes back too unless it reads
            // as it was (both reads worked, missing included) or as anything
            // but the new text (the write replaces the file whole).
            const r = await write(w.name, w.content).catch((err: unknown) => (
              { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }));
            if (r.code !== 0) {
              let nowRead = true;
              const now = await readCoreFile(providerFor(fresh.hostId), fresh.runtimeRef!, fresh.slug, w.name).catch(() => {
                nowRead = false;
                return undefined;
              });
              const landed = !(nowRead && (now !== w.content || (beforeRead && now === before)));
              const undo = landed ? [...written, [w.name, before] as [string, string | undefined]] : written;
              const back = await Promise.all(undo.map(([name, was]) => (was !== undefined ? write(name, was).then((x) => x.code === 0, () => false) : false)));
              const lost = undo.filter((_, i) => !back[i]).map(([name]) => name);
              return { ...r, lost };
            }
            written.push([w.name, before]);
          }
          recordApplied(fresh, paramFiles);
          return { code: 0, stdout: '', stderr: '', lost: [] as string[] };
        }));
        if (res.code !== 0) {
          return refused(500,
            res.lost.length
              ? `Write failed, and ${res.lost.join(', ')} could not be put back: restore the pre-params snapshot.`
              : 'Write failed. Nothing was changed.',
          );
        }
      } catch (err) {
        if (err instanceof TurnRefused) return refused(err.status, err.message);
        if (err instanceof AgentBusyError) return refused(409, err.userMessage);
        if (err instanceof TransferError) return refused(400, err.userMessage);
        if (err instanceof SnapshotError) return refused(502, `${err.userMessage} Nothing was changed.`);
        if (err instanceof NoPlaceholders) {
          return refused(400,
            'No {{placeholders}} found in SOUL.md/AGENTS.md/persona — applying values would change nothing. ' +
            'Reference the declared fields as {{key}} in the files first.',
          );
        }
        throw err;
      }
      trace(agent.id)('params.applied', { reset: !!body.reset, keys: Object.keys(resolved).length });
      return said({ applied: true as const, values: resolved, ...(warning ? { warning } : {}) });
    });
  };

  return { prepare };
}
