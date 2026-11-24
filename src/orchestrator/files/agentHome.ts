import { isUtf8 } from 'node:buffer';
import type { Agent } from '../../domain/types.js';
import type { ExecResult, RuntimeProvider } from '../../providers/provider.js';
import { VOLUME_GONE } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { duShell, listShell, parseListing, putArgv, statShell } from './agentFiles.js';
import { AgentBusyError, whileBusy } from '../lifecycle/busy.js';
import { operationRefusal } from '../lifecycle/operations.js';
import { autoSnapshot, MAX_FILE_BYTES } from './snapshots.js';
import { EDITABLE_FILES, type FileRefusal } from './coreFiles.js';
import { TurnRefused, type CoreFileTurns } from './coreFileTurns.js';

/** What a download streams from: the machine's stream of the agent's volume. */
export type StreamFrom = NonNullable<RuntimeProvider['streamFromVolume']>;

/**
 * The agent's files: browse, download and upload (HB-0808 step 13, part of
 * the agent files service, files.ts). The owner only; the route checks who
 * asks and cleans the path (`cleanRelPath`), and it is resolved again inside
 * the one-shot (src/orchestrator/files/agentFiles.ts). Browsing and downloading are
 * read-only one-shots on the volume: they work stopped or archived. An upload
 * takes the core-files turn and the busy flag. Nothing here knows HTTP: a
 * refusal is a result with its status and words; the download's headers and
 * stream are the route's (src/api/fileRoutes.ts).
 */
export interface AgentHome {
  /** A one-shot's failure in the words the Files tab shows. */
  failure(res: ExecResult): FileRefusal;
  /** A folder's entries. */
  list(agent: Agent, rel: string): Promise<{ ok: true; body: { path: string; entries: ReturnType<typeof parseListing> } } | FileRefusal>;
  /**
   * What a download is checked for before a byte streams: a machine that
   * streams, and the file (or folder) there, of the kind asked for and not too big.
   */
  readable(agent: Agent, rel: string, kind: 'file' | 'archive'): Promise<{ ok: true; streamFrom: StreamFrom; size: number } | FileRefusal>;
  /**
   * Write one file into a folder of the agent's home, in its files turn and
   * under the busy flag. The route checked the name, where it goes, the body
   * and `busyNow`.
   */
  upload(agent: Agent, rel: string, name: string, body: Buffer, opts: { overwrite: boolean; owned: (id: string) => Agent | undefined }):
    Promise<{ ok: true; body: { ok: true; path: string; name: string; size: number } } | FileRefusal>;
}

export interface AgentHomeDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Is an archive of this agent under way? */
  isArchiving: (agentId: string) => boolean;
  turns: CoreFileTurns;
  /** The largest file (or folder as .tar.gz) that moves through the Files tab, either way (HATCHABOT_FILE_MAX_MB). */
  fileMaxBytes: number;
}

export function createAgentHome(deps: AgentHomeDeps): AgentHome {
  const { store, providerFor, trace, isArchiving, turns, fileMaxBytes: FILE_MAX_BYTES } = deps;
  const { withCoreFilesTurn } = turns;
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });
  const refused = (status: number, error: string): FileRefusal => ({ ok: false, status, error });

  const failure = ({ code, volumeMissing }: ExecResult): FileRefusal =>
    volumeMissing ? refused(404, VOLUME_GONE)
      : code === 2 ? refused(404, 'No such file or folder.')
      : code === 3 ? refused(400, 'That path leads outside the agent.')
      : code === 4 ? refused(400, 'Not that kind of path.')
      : refused(502, "Couldn't read the agent's files.");

  const list: AgentHome['list'] = async (agent, rel) => {
    let res: ExecResult;
    try { res = await providerFor(agent.hostId).execShellOnVolume(agent.runtimeRef!, listShell(rel), { readOnly: true }); }
    catch { return refused(502, "Couldn't read the agent's files."); }
    if (res.code !== 0) return failure(res);
    return { ok: true, body: { path: rel, entries: parseListing(res.stdout) } };
  };

  const readable: AgentHome['readable'] = async (agent, rel, kind) => {
    const provider = providerFor(agent.hostId);
    const streamFrom = provider.streamFromVolume?.bind(provider);
    if (!streamFrom) return refused(501, 'Downloads are not available from this machine.');
    // Size first, so a runaway folder is refused before a byte streams.
    let st: ExecResult;
    try { st = await provider.execShellOnVolume(agent.runtimeRef!, kind === 'file' ? statShell(rel) : duShell(rel), { readOnly: true }); }
    catch { return refused(502, "Couldn't read the agent's files."); }
    if (st.code !== 0) return failure(st);
    const [ftype, fsize] = kind === 'file' ? st.stdout.trim().split('\t') : ['directory', st.stdout.trim()];
    if (kind === 'file' && ftype !== 'regular file' && ftype !== 'regular empty file') return refused(400, 'That is a folder — download it as an archive.');
    const size = Number(fsize) || 0;
    if (size > FILE_MAX_BYTES) return refused(413, `Too big to download here (${Math.round(size / 1048576)} MB; the limit is ${FILE_MAX_BYTES / 1048576} MB — HATCHABOT_FILE_MAX_MB).`);
    return { ok: true, streamFrom, size };
  };

  const upload: AgentHome['upload'] = async (agent, rel, name, body, opts) => {
    let res: ExecResult;
    try {
      // All uploads take the turn: an ordinary-looking folder can be a link
      // into the workspace. The one-shot reports its resolved destination.
      res = await withCoreFilesTurn(agent.id, () => whileBusy(agent.id, async () => {
        const fresh = opts.owned(agent.id);
        if (!fresh?.runtimeRef || fresh.state === 'DELETED') throw new TurnRefused(404, 'Not found');
        if (fresh.state === 'DELETING' || operationRefusal(store, fresh.id) || isArchiving(fresh.id)) throw new TurnRefused(409, 'Another change is under way — wait for it to finish.');
        if (fresh.hostId !== agent.hostId || fresh.runtimeRef !== agent.runtimeRef) throw new TurnRefused(409, 'The agent moved meanwhile; reload its files and try again.');
        const provider = providerFor(fresh.hostId);
        if (!provider.writeToVolume) throw new TurnRefused(501, 'Uploads are not available to this machine.');
        if (EDITABLE_FILES.has(name) && fresh.state === 'RUNNING') await autoSnapshot(snapshotDeps(fresh), fresh.id, 'pre-edit');
        // The text checks are for a core file's name only (they apply where it
        // lands in the workspace: putArgv), and the text one only within the
        // size cap, which is checked first: every upload was decoded and
        // encoded again in full, a 32 MB picture making three times that, to
        // be checked for nothing (HB-1125).
        const tooLarge = body.length > MAX_FILE_BYTES;
        const core = EDITABLE_FILES.has(name) ? { tooLarge, invalidText: !tooLarge && !isUtf8(body) } : undefined;
        const result = await provider.writeToVolume(fresh.runtimeRef, putArgv(rel, name, opts.overwrite, fresh.slug, core), body);
        if (result.code === 0 && result.stdout.trim() === 'hatchabot:core' && store.getAgent(fresh.id)?.paramFiles && (name === 'SOUL.md' || name === 'AGENTS.md')) {
          store.setAgentParamFile(fresh.id, name === 'SOUL.md' ? 'soul' : 'agents', body.toString('utf8'));
        }
        return result;
      }));
    } catch (err) {
      if (err instanceof TurnRefused) return refused(err.status, err.message);
      if (err instanceof AgentBusyError) return refused(409, err.userMessage);
      return refused(502, "Couldn't write into the agent.");
    }
    if (res.code === 5) return refused(409, `${name} is already there — replace it?`);
    if (res.code === 6) return refused(400, "That folder leads into OpenClaw's own state — uploads go in the workspace or outside .openclaw.");
    if (res.code === 7) return refused(413, `Too large — core files cap at ${MAX_FILE_BYTES / 1024}KB.`);
    if (res.code === 8) return refused(400, 'Core files must contain UTF-8 text.');
    if (res.code !== 0) return failure(res);
    return { ok: true, body: { ok: true, path: rel, name, size: body.length } };
  };

  return { failure, list, readable, upload };
}
