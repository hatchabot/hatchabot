import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ChannelProvisioner } from '../../channels/channel.js';
import type { Agent, DataSource } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { isBusy, whileBusy } from '../lifecycle/busy.js';
import { folderMountNameProblem, MAX_DATA_SOURCES, MAX_MOUNT_NAME, RESERVED_GIT_MOUNT_NAMES } from './dataSourceLimits.js';
import { generateDeployKey, isPublicGitUrl, normalizeGitUrl, probeGitSource, PUBLIC_REPO_READ_ONLY } from './gitSource.js';
import { hostPathTargetProblem, scrubRemovedDataSources, sharePathProblem, syncDataSourceDocs, syncGitDataSources } from '../lifecycle/provision.js';

/**
 * An agent's data sources (HB-0808;
 * docs/data-sources.md): git repos cloned onto its own volume, and folders of
 * this machine's disk mounted into it, listed under "## Data sources" in its
 * AGENTS.md. Cloning, scrubbing and the AGENTS.md section are
 * src/orchestrator/lifecycle/provision.ts and gitSource.ts; the limits are
 * dataSourceLimits.ts. This is the rules the API put round them: adding one,
 * the Test button, removing one.
 *
 * Its state, both locks (docs/architecture.md, "In-memory state,
 * sorted"):
 *  - `addingSources`: the names being added this moment, per agent, held from
 *    the clash check to the row (a private repo's key is saved in between);
 *  - `dataSourceChecks`: one Test of a repo at a time.
 * No timer.
 *
 * Nothing here knows about HTTP: a route checks the agent and reads its
 * request, asks this, and words the answer. A refusal is a `SourceRefusal`:
 * its words, or (`machine-owner`, `gone`) the route's own.
 */
export interface DataSources {
  /**
   * Add a folder (a mount of this machine's disk: the machine's owner only,
   * asked through `ownsMachine` where the check falls) or a git repo (a
   * public one cloned now when the agent is up; a private one with a new
   * deploy key, cloned at the next rebuild). Undefined when added.
   */
  add(agent: Agent, body: NewDataSource, ownsMachine: () => boolean): Promise<SourceRefusal | undefined>;
  /** The Test button: does this source work from here, now? Nothing is changed by a check. */
  check(agent: Agent, src: DataSource): Promise<SourceCheck | SourceRefusal>;
  /**
   * Remove one. A repo goes from the agent completely: its deploy key's
   * private half, and on the volume the key and the clone (retried at the
   * next start, wake or rebuild when it cannot be done now). What the answer
   * adds to the agent: the repo and the key removed, and whether the volume
   * was scrubbed.
   */
  remove(agent: Agent, src: DataSource): Promise<SourceRemoved | SourceRefusal>;
}

/** POST /v1/agents/:id/data-sources's body, as its schema read it. */
export interface NewDataSource {
  kind: 'folder' | 'git';
  access: 'ro' | 'rw';
  path?: string | undefined;
  repoUrl?: string | undefined;
  /** Adopted agents: bind at the original host path, not /data/<name>. */
  atHostPath?: boolean | undefined;
  /** git: a public repo, cloned over https with no credentials (read-only, no deploy key). */
  public?: boolean | undefined;
}

/**
 * Why not, in the words to answer with: `invalid` (the request cannot be
 * done as asked), `conflict` (not now, or not beside what is there),
 * `failed` (this machine could not); `machine-owner` and `gone` are worded
 * by the route (MACHINE_OWNER_ONLY, AGENT_GONE).
 */
export type SourceRefusal =
  | { refused: 'invalid' | 'conflict' | 'failed'; error: string }
  | { refused: 'machine-owner' }
  | { refused: 'gone' };

/** The Test button's answer (a repo's is probeGitSource's, gitSource.ts). */
export interface SourceCheck { ok: boolean; reason?: string; refs?: number; message: string }

export interface SourceRemoved {
  removedRepo?: { repo: string | undefined; scrubbed: boolean };
  removedKey?: { repo: string | undefined; scrubbed: boolean };
}

/** What the data sources need from the process they run in. Functions only, so a test hands them fakes. */
export interface DataSourcesDeps {
  store: Store;
  /** The deploy keys' private halves. */
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** Telegram's provisioner: the sync's provision deps carry it. */
  channel: ChannelProvisioner;
  /** The agent's AGENTS.md turn (files/coreFileTurns.ts): one write of its sections at a time. */
  withAgentsMdTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  /** Bring a RUNNING agent's managed AGENTS.md sections up to date, held busy (routes.ts). Never rejects. */
  syncDocsHeld: (a: Agent, provider: RuntimeProvider) => Promise<void>;
}

export function createDataSources(deps: DataSourcesDeps): DataSources {
  const { store, secrets, providerFor, trace, agentGone, withAgentsMdTurn, syncDocsHeld } = deps;
  const invalid = (error: string): SourceRefusal => ({ refused: 'invalid', error });
  const conflict = (error: string): SourceRefusal => ({ refused: 'conflict', error });

  // Add a data source. Folders are host mounts (ro/rw), gated to the machine
  // owner + blocklist. Git repos are cloned onto the agent's own volume with a
  // generated deploy key — no host access, so any agent owner may add one; the
  // clone happens on the next rebuild. Both apply on rebuild.
  // Mount names being added right now, per agent: a private repo's key is
  // saved before its row, and two adds of one name (two tabs) both passed
  // the clash check during that wait — two repos then shared one clone and
  // one deploy key path (audit #073).
  const addingSources = new Map<string, Set<string>>();
  const add = async (agent: Agent, body: NewDataSource, ownsMachine: () => boolean): Promise<SourceRefusal | undefined> => {
    const { kind, access } = body;

    // Reject a mount-name clash across legacy folders + every data source,
    // and any being added this moment.
    const adding = addingSources.get(agent.id) ?? new Set<string>();
    const clashes = (name: string) =>
      adding.has(name) || new Set([
        ...(agent.sharedPaths ?? []).map((x) => basename(x.replace(/\/+$/, ''))),
        ...store.listDataSources(agent.id).map((d) => d.mountName),
      ]).has(name);
    // No more than a template or a full copy can carry: the agent's own export
    // must read back (audit #070).
    if (store.listDataSources(agent.id).length + adding.size >= MAX_DATA_SOURCES) {
      return conflict(`"${agent.name}" already has ${MAX_DATA_SOURCES} data sources, the most one agent can hold. Remove one first.`);
    }

    if (kind === 'folder') {
      if (store.activeOperationFor(agent.id)?.kind === 'move-host') {
        return conflict('Its move to another machine is not over. Add folders once that finishes.');
      }
      const p = (body.path ?? '').trim();
      if (!p) return invalid('A folder path is required.');
      if (!ownsMachine()) return { refused: 'machine-owner' };
      // A folder is a bind mount of THIS machine's disk: a runner's docker
      // cannot see it, and the mount was silently skipped there while the
      // agent was told it had the data (audit, 2026-10-23).
      if (store.getHost(agent.hostId)?.kind !== 'local') {
        return invalid(`"${agent.name}" runs on another machine, which cannot see this machine's folders. Move it here first, or give it a git repo instead.`);
      }
      const problem = sharePathProblem(p);
      if (problem) return invalid(problem);
      if (!existsSync(p)) return invalid(`No such folder on this machine: ${p}`);
      // A file was saved as a folder, and its own Check then said it was not one (HB-0361).
      if (statSync(p, { throwIfNoEntry: false })?.isDirectory() === false) return invalid(`${p} is a file, not a folder. Give the folder it is in.`);
      const atHostPath = body.atHostPath === true;
      const targetProblem = atHostPath ? hostPathTargetProblem(p) : undefined;
      if (targetProblem) return invalid(targetProblem);
      // A host-path mount lives at its own path: it clashes only with the same
      // folder. Its name, flattened from the path, is just a label kept unique:
      // /a/b and /a-b both flatten to a-b, and the second was refused as
      // "already shared" (HB-0074). /data mounts key off the basename, which
      // is where they live.
      const bare = (x: string) => x.replace(/\/+$/, '') || '/';
      if (atHostPath && store.listDataSources(agent.id).some((d) => d.kind === 'folder' && d.mountAtHostPath && bare(d.hostPath ?? '') === bare(p))) {
        return conflict(`${p} is already shared with this agent.`);
      }
      let mountName = atHostPath
        ? p.replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-')
        : basename(p.replace(/\/+$/, ''));
      // No longer than a template or a full copy carries (HB-0320): a /data
      // folder lives at its name, so a longer one is refused; a host-path
      // label is only a label, so it is cut short, with room for a "-n".
      if (!atHostPath && mountName.length > MAX_MOUNT_NAME) {
        return invalid(`The folder's name is over ${MAX_MOUNT_NAME} characters, longer than a copy of the agent can carry. Rename it, or share a folder with a shorter name.`);
      }
      if (atHostPath && mountName.length > MAX_MOUNT_NAME) mountName = mountName.slice(0, MAX_MOUNT_NAME - 8);
      const nameProblem = folderMountNameProblem(mountName);
      if (nameProblem) return invalid(nameProblem);
      if (atHostPath) for (let n = 2, base = mountName.slice(0, MAX_MOUNT_NAME - 8); clashes(mountName); n++) mountName = `${base}-${n}`;
      if (clashes(mountName)) {
        return conflict(`Another source already lives at /data/${mountName}. Rename or remove it first.`);
      }
      store.insertDataSource({
        id: randomUUID(), agentId: agent.id, kind: 'folder', access, mountName,
        hostPath: p, mountAtHostPath: atHostPath, createdAt: new Date().toISOString(),
      });
      return undefined;
    }

    // git
    const git = normalizeGitUrl(body.repoUrl ?? '');
    if (!git) {
      return invalid('Not a recognizable git repo. Use git@host:owner/repo.git or https://host/owner/repo.');
    }
    // git repos clone beside OpenClaw's own dirs under ~/.openclaw; a repo whose
    // name matches one of them (or a dotfile) would collide with runtime state.
    if (RESERVED_GIT_MOUNT_NAMES.has(git.repoName) || git.repoName.startsWith('.')) {
      return invalid(`"${git.repoName}" is a reserved name — it would collide with the agent's own files. Use a differently named repo.`);
    }
    if (git.repoName.length > MAX_MOUNT_NAME) {
      return invalid(`The repo's name is over ${MAX_MOUNT_NAME} characters, longer than a copy of the agent can carry.`);
    }
    if (clashes(git.repoName)) {
      return conflict(`Another source is already named "${git.repoName}". Remove it first.`);
    }
    const id = randomUUID();
    if (body.public) {
      // Public repo: nothing to register on the git host, so clone it right away
      // when the agent is up — no rebuild, no key. Read-only by construction.
      if (access !== 'ro') return invalid(PUBLIC_REPO_READ_ONLY);
      store.insertDataSource({
        id, agentId: agent.id, kind: 'git', access: 'ro', mountName: git.repoName,
        repoUrl: git.httpsUrl, createdAt: new Date().toISOString(),
      });
      if (agent.state === 'RUNNING' && agent.runtimeRef && !isBusy(agent.id)) {
        const d = { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel, log: trace(agent.id) };
        // Held busy throughout, like every other change to its files: the docs
        // sync reads AGENTS.md, works out its sections, then writes the whole
        // file, and a save made meanwhile was written over without a snapshot
        // (audit #096). A save now waits for it ("another operation"). Taken
        // in this tick, so nothing can start between the check above and it.
        void whileBusy(agent.id, async () => {
          // This one alone: the others are as they were (HB-1126); a start or rebuild syncs them all.
          await syncGitDataSources(d, agent.id, agent.runtimeRef!, trace(agent.id), { only: id });
          await syncDataSourceDocs(d, agent.id, agent.runtimeRef!, trace(agent.id), { turn: (write) => withAgentsMdTurn(agent.id, write) }); // AGENTS.md "Data sources" learns the path
        }).catch(() => { /* best-effort; the next rebuild retries and the card shows any error */ });
      }
      return undefined;
    }
    let key: { privateKey: string; publicKey: string };
    try {
      key = generateDeployKey(`hatchabot-${agent.slug}-${git.repoName}-deploy`);
    } catch {
      return { refused: 'failed', error: 'Could not generate a deploy key — this server needs `ssh-keygen` (openssh-client).' };
    }
    const secretRef = `data-source/${id}`;
    // The key is saved before its row: a process that stops in between leaves
    // a key nothing names, and the next start deletes it before anything is
    // served (Store.sweepOrphanAgentSecrets, from src/index.ts; HB-0853).
    // The name is held from the clash check to the row, across the key's save.
    adding.add(git.repoName);
    addingSources.set(agent.id, adding);
    try {
      await secrets.put(secretRef, key.privateKey);
      if (agentGone(agent.id)) {
        await secrets.delete(secretRef).catch(() => {});
        return { refused: 'gone' };
      }
      store.insertDataSource({
        id, agentId: agent.id, kind: 'git', access, mountName: git.repoName,
        repoUrl: git.sshUrl, secretRef, pubKey: key.publicKey, createdAt: new Date().toISOString(),
      });
    } finally {
      adding.delete(git.repoName);
      if (!adding.size && addingSources.get(agent.id) === adding) addingSources.delete(agent.id);
    }
    return undefined;
  };

  // The Test button (Settings → Data): does this source work from here, now?
  // A folder: it is there and this service can read it (and write it, if the
  // agent may). A repo: `git ls-remote` from this machine with the source's own
  // deploy key, so a key not yet added to the repo is found before a Rebuild
  // fails to clone. Nothing is changed by a check; one runs per source at a time.
  const dataSourceChecks = new Set<string>();
  const check = async (agent: Agent, src: DataSource): Promise<SourceCheck | SourceRefusal> => {
    if (src.kind === 'folder') {
      const p = src.hostPath ?? '';
      if (!p || !existsSync(p)) return { ok: false, reason: 'missing', message: `No such folder on this machine: ${p}` };
      let st; try { st = statSync(p); } catch { return { ok: false, reason: 'unreadable', message: `${p} cannot be read by the Hatchabot service.` }; }
      if (!st.isDirectory()) return { ok: false, reason: 'not-a-folder', message: `${p} is a file, not a folder.` };
      try { accessSync(p, fsConstants.R_OK | fsConstants.X_OK); } catch { return { ok: false, reason: 'unreadable', message: `${p} is there, but the Hatchabot service cannot read it. Check its permissions.` }; }
      if (src.access === 'rw') {
        try { accessSync(p, fsConstants.W_OK); } catch { return { ok: false, reason: 'not-writable', message: `${p} can be read, but not written by the Hatchabot service, so the agent could not write there either.` }; }
      }
      if (store.getHost(agent.hostId)?.kind !== 'local') {
        return { ok: false, reason: 'remote', message: `The folder is there, but "${agent.name}" runs on another machine, which cannot see this machine's folders: it is not mounted there. Move the agent here, or remove this folder.` };
      }
      const where = src.mountAtHostPath ? p : `/data/${src.mountName}`;
      return { ok: true, message: `The folder is there and ${src.access === 'rw' ? 'readable and writable' : 'readable'}. The agent sees it at ${where} after its next Rebuild.` };
    }
    if (dataSourceChecks.has(src.id)) return conflict('This repo is being checked already.');
    dataSourceChecks.add(src.id);
    try {
      let privateKey: string | undefined;
      if (!isPublicGitUrl(src.repoUrl) && src.secretRef) {
        try { privateKey = await secrets.get(src.secretRef); } catch { privateKey = undefined; }
      }
      const r = await probeGitSource({ repoUrl: src.repoUrl ?? '', privateKey, access: src.access });
      trace(agent.id)('data_source.checked', { id: src.id, kind: 'git', ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
      return { ...r, ...(r.ok ? { message: `${r.message} The agent clones it to ~/.openclaw/${src.mountName} on its next Rebuild.` } : {}) };
    } finally { dataSourceChecks.delete(src.id); }
  };

  const remove = async (agent: Agent, src: DataSource): Promise<SourceRemoved | SourceRefusal> => {
    // A repo goes from the agent completely (HB-0002): the deploy key's
    // private half in the store, and on the volume the key and the clone.
    // What that takes is recorded BEFORE the row goes, so a failed scrub is
    // retried at the next start, wake or rebuild instead of only traced,
    // with the key still usable and nothing left that named it.
    if (src.kind === 'folder' && store.activeOperationFor(agent.id)?.kind === 'move-host') {
      return conflict('Its move to another machine is not over. Remove folders once that finishes.');
    }
    const git = src.kind === 'git';
    const deployKey = git && !!src.secretRef;
    if (git) store.addDataSourceRemoval({ id: src.id, agentId: agent.id, mountName: src.mountName, secretRef: src.secretRef, repoUrl: src.repoUrl });
    store.deleteDataSource(agent.id, src.id);
    const provider = providerFor(agent.hostId);
    const running = agent.state === 'RUNNING';
    const done = git
      ? await scrubRemovedDataSources({ store, secrets, provider }, agent.id, agent.runtimeRef, running, trace(agent.id))
      : true;
    // Its AGENTS.md stops listing the repo now, not at the next rebuild.
    if (git && running && agent.runtimeRef) void syncDocsHeld(agent, provider);
    return {
      ...(git ? { removedRepo: { repo: src.repoUrl, scrubbed: done } } : {}),
      // A copy of the key can outlive anything done here (the git host
      // still trusts it): the page says to delete it there too.
      ...(deployKey ? { removedKey: { repo: src.repoUrl, scrubbed: done } } : {}),
    };
  };

  return { add, check, remove };
}
