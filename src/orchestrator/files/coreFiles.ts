import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { AgentBusyError, whileBusy } from '../lifecycle/busy.js';
import { autoSnapshot, CORE_FILES, CoreFileTooBigError, MAX_FILE_BYTES, readCoreFile, SnapshotError, writeFileInAgent } from './snapshots.js';
import { TurnRefused, type CoreFileTurns } from './coreFileTurns.js';

// Workspace file editing — the "full OpenClaw interface" promise (§9.3):
// the persona and memory are the user's files, editable from the app.
// Same triple the snapshot system protects — one source of truth.
export const EDITABLE_FILES = new Set<string>(CORE_FILES);
export const workspacePath = (slug: string, name: string) =>
  `/home/node/.openclaw/agents/${slug}/agent/${name}`;

/** Why not, with the status the route answers and its words. */
export type FileRefusal = { ok: false; status: number; error: string };

/**
 * An agent's core files (SOUL.md, AGENTS.md, MEMORY.md) read and saved from
 * the app's Personality and Knowledge panes (HB-0808 step 13, part of the
 * agent files service, files.ts). Who may ask, the file's name, the body and
 * the agent's state are the route's checks (src/api/data/fileRoutes.ts); a save
 * then takes the agent's core-files turn and the busy flag, snapshots first,
 * and keeps the template layer in step. Nothing here knows HTTP: a refusal
 * is a result with its status and words.
 */
export interface CoreFiles {
  /** The file as it is, read under the snapshot's cap; one that is not there is editable as empty. */
  read(agent: Agent, name: string): Promise<{ ok: true; body: { name: string; content: string; missing?: true } } | FileRefusal>;
  /** Save it: the files turn, then the busy flag, a snapshot first. Throws what it does not word. */
  save(agent: Agent, name: string, content: string): Promise<{ ok: true; body: { saved: true } } | FileRefusal>;
}

export interface CoreFilesDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  turns: CoreFileTurns;
}

export function createCoreFiles(deps: CoreFilesDeps): CoreFiles {
  const { store, providerFor, trace, turns } = deps;
  const { withCoreFilesTurn, freshRunning } = turns;
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  const read: CoreFiles['read'] = async (agent, name) => {
    // The snapshot read: the same cap (an unbounded cat of a corrupt
    // multi-MB file would balloon responses, audit 2026-09-04 #3), counted
    // in bytes (a multibyte-heavy file just over the cap arrived truncated
    // mid-character and was saved back truncated, 10th audit), and it tells
    // a failed read from an empty file. `head … || true` answered a runner
    // asleep or a daemon down with 200 and '', the editor showed an empty
    // file ready to save, and a Save wrote nothing over the real one
    // (review 2026-10-23). A failed read is a 502 now, and nothing loads.
    let content: string | undefined;
    try {
      content = await readCoreFile(providerFor(agent.hostId), agent.runtimeRef!, agent.slug, name);
    } catch (err) {
      if (err instanceof CoreFileTooBigError) {
        return { ok: false, status: 413, error: `${name} is over ${MAX_FILE_BYTES / 1024}KB — edit it in chat instead.` };
      }
      if (err instanceof SnapshotError) return { ok: false, status: 502, error: `${err.userMessage} Nothing was loaded.` };
      return { ok: false, status: 502, error: `Couldn't read ${name} — is the agent's machine awake? Nothing was loaded.` };
    }
    // A file that is not there is editable as empty: saving creates it.
    // Said apart from one that is there and empty.
    return content === undefined
      ? { ok: true, body: { name, content: '', missing: true } }
      : { ok: true, body: { name, content } };
  };

  const save: CoreFiles['save'] = async (agent, name, content) => {
    // base64 through the shell so arbitrary content can't break quoting.
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    try {
      // The files turn first, then the busy flag, as Apply values takes
      // them: a snapshot by hand reading the files meanwhile kept the old
      // file with the layer this save stores, or the reverse (HB-0566).
      const res = await withCoreFilesTurn(agent.id, () => whileBusy(agent.id, 'file-save', async () => {
        const fresh = freshRunning(agent.id, () => 'Start the agent to edit its files.');
        // Version the files BEFORE overwriting — a bad save must be recoverable.
        await autoSnapshot(snapshotDeps(fresh), agent.id, 'pre-edit');
        const r = await writeFileInAgent(providerFor(fresh.hostId), fresh.runtimeRef, workspacePath(fresh.slug, name), b64);
        // Keep the template layer in step with a direct edit: the layer is
        // what "Apply values" re-renders from, and a frozen import-time copy
        // silently REVERTED any approved rewrite on the next value change
        // (audit 2026-09-03). The edited content becomes the layer — any
        // {{placeholders}} it still contains keep rendering; prose it
        // hard-coded stays as written.
        // Its one key, the rest as it is now: written back whole as read
        // before the write, a persona changed meanwhile went back (HB-0567).
        // Before the turn ends, so a snapshot after it has the pair.
        if (r.code === 0 && store.getAgent(agent.id)?.paramFiles && (name === 'SOUL.md' || name === 'AGENTS.md')) {
          store.setAgentParamFile(agent.id, name === 'SOUL.md' ? 'soul' : 'agents', content);
        }
        return r;
      }));
      if (res.code !== 0) return { ok: false, status: 500, error: 'Write failed' };
      return { ok: true, body: { saved: true } };
    } catch (err) {
      if (err instanceof TurnRefused) return { ok: false, status: err.status, error: err.message };
      if (err instanceof AgentBusyError) return { ok: false, status: 409, error: err.userMessage };
      throw err;
    }
  };

  return { read, save };
}
