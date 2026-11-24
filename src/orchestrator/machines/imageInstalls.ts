import type { Host } from '../../domain/types.js';
import { parseByteSize, type RuntimeProvider } from '../../providers/provider.js';
import { publishedRuntimeImage } from '../../providers/releaseManifest.js';
import type { Store } from '../../store/store.js';
import { beginOperation, currentBootId } from '../lifecycle/operations.js';
import { installRuntimeImage } from './runnerSetup.js';
import { someNames, strandedFollowers } from './runtimeImages.js';

/** One copy of this machine's runtime image onto a runner, as GET and POST /v1/hosts/:id/install-image answer it. */
export type ImageCopy = {
  startedAt: string; bytes: number; total?: number; done: boolean; ok?: boolean; error?: string; finishedAt?: string; pulled?: string;
  /** Installed, but the published image a runner on another CPU pulled is not built as this machine's is: how (HB-1189). */
  differs?: string;
};

/**
 * Install image on a runner (HB-0808).
 * Copy this box's runtime image onto a runner (docker save | docker -H load).
 * Slow — minutes for a multi-GB image — so the UI treats it as a long job.
 *
 * Its state, sorted (HB-0809):
 *  - `imageCopies`: the copy under way or last made per runner (a cache: the
 *    bytes copied so far). The copy is an operation on disk, so a restart in
 *    the middle reads "interrupted: Install again". No timer.
 *
 * Nothing here knows about HTTP: a route checks who is asking (the machine's
 * owner), asks this, and words the answer.
 */
export interface ImageInstalls {
  /** How the copy to this runner stands: the one in memory, else how its last record ended, else idle. */
  status(hostId: string): Record<string, unknown>;
  /** Start a copy to this runner, or the one under way: one per runner. `finished` never rejects. */
  start(host: Host, dockerHost: string, requestedBy: string): { job: ImageCopy; finished: Promise<ImageCopy> };
  /** A copy to this runner is under way in this process: its removal waits for it (HB-1025). */
  underWay(hostId: string): boolean;
}

/** What the copies need from the process they run in. Functions only, so a test hands them fakes. */
export interface ImageInstallsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
}

/** The words for an install that went ahead on a published image not built as this machine's is (HB-1189). */
export const installedDiffers = (how: string): string =>
  `It is not built quite as this machine's image is: ${how}. Only extra packages can be built again on a runner of another CPU; agents there run it as it is.`;

export function createImageInstalls(deps: ImageInstallsDeps): ImageInstalls {
  const { store, providerFor, trace } = deps;

  // The Retry a copy that failed offers (operations.ts).
  const INSTALL_AGAIN = { actions: [{ action: 'install-again', label: 'Install again' }], recommended: 'install-again' };
  const imageCopies = new Map<string, { job: ImageCopy; finished: Promise<ImageCopy> }>();

  const status: ImageInstalls['status'] = (hostId) => {
    const live = imageCopies.get(hostId)?.job;
    if (live) return live;
    // After a restart the job in memory is gone; its record says how it ended
    // (an interrupted one is "interrupted", not idle: the copy did not finish).
    const op = store.listMachineOperations([hostId], 20).find((o) => o.kind === 'install-image');
    if (!op) return { idle: true };
    const over = !['queued', 'running'].includes(op.status) || op.bootId !== currentBootId();
    return {
      startedAt: op.requestedAt, bytes: 0, done: over, ok: op.status === 'succeeded',
      ...(op.status === 'succeeded' ? {} : { error: op.outcome ?? 'The image copy was interrupted by a restart.' }),
      // How the image installed differs, kept whole in the record (the outcome is cut at 600; HB-1189 review).
      ...(op.status === 'succeeded' && typeof op.params?.differs === 'string' ? { differs: op.params.differs } : {}),
      ...(op.finishedAt ? { finishedAt: op.finishedAt } : {}),
      interrupted: op.status === 'interrupted' || (op.status === 'running' && op.bootId !== currentBootId()) || /interrupted by a restart/.test(op.outcome ?? '') || undefined,
      operation: op.id,
    };
  };

  const start: ImageInstalls['start'] = (host, dockerHost, requestedBy) => {
    let copy = imageCopies.get(host.id);
    if (!copy || copy.job.done) {
      const image = process.env.HATCHABOT_IMAGE ?? 'hatchabot-runtime:latest';
      const local = store.localHostId();
      const job: ImageCopy = { startedAt: new Date().toISOString(), bytes: 0, done: false };
      // The copy is this runner's from here, before anything is awaited: two
      // requests at once (a double click, two tabs) both found none and started
      // two multi-GB copies (audit, 2026-10-22).
      const finished = (async () => {
        // Unread is not "no extra packages" (as for a recipe): a runner on
        // another CPU then pulls nothing, rather than get the stock image.
        let extrasUnread: string | undefined;
        const row = local ? (await providerFor(local).listImageTags().catch(() => { extrasUnread = "this machine's images could not be read"; return []; }))
          .find((t) => t.tag === image) : undefined;
        const total = row?.size;
        job.total = total ? parseByteSize(total) || undefined : undefined;
        // Its extra packages, which a runner on another CPU has built onto the published image (HB-1062).
        const extraPackages = row?.extraPackages ?? [];
        trace()('host.image_copy_started', { host: host.id, image });
        // On disk (operations.ts): a restart in the middle leaves "interrupted —
        // Install again", and the Activity list shows it (GET /v1/events).
        const op = beginOperation(store, 'install-image', null, { image, host: host.name }, { hostId: host.id, requestedBy });
        const version = local ? (await providerFor(local).currentImageInfo().catch(() => undefined))?.openclawVersion ?? row?.openclawVersion : undefined;
        // The image becomes that runner's default: Promote's check, made for
        // the runner's own followers. A copy of an older OpenClaw went in over
        // agents already migrated past it, and their next rebuild could not
        // read their data (HB-1061). Everyone there who runs that name: one
        // pinned to it too, when HATCHABOT_IMAGE names a version tag (HB-1187).
        const stuck = await strandedFollowers(store, host.id, providerFor(host.id), version, { tag: image, defaultBase: image });
        if (stuck.length) {
          const error = `This machine's image runs OpenClaw ${version}, which cannot read the data of ${host.name}'s agents already on 2026.8 or newer (${someNames(stuck)}). Installed as that runner's default, their next rebuild would fail: make this machine's default 2026.8 or newer first (Settings → Advanced → Runtime images), then install it.`;
          Object.assign(job, { done: true, ok: false, error, finishedAt: new Date().toISOString() });
          trace()('host.image_copy_failed', { host: host.id, bytes: 0, error });
          op.fail(error);
          return job;
        }
        // A runner on another CPU pulls the published image of the same OpenClaw
        // instead (installRuntimeImage): the one this release's manifest names,
        // by digest (#47, 2026-10-10); by tag only for a release made before manifests.
        const found = version && /^\d{4}\.\d+\.\d+(?:-\d+)?$/.test(version) ? await publishedRuntimeImage(version) : undefined;
        const published = found && !('problem' in found) ? found : undefined;
        const unpublished = found && 'problem' in found ? found.problem : undefined;
        const r = await installRuntimeImage(dockerHost, { image, total: job.total, published, unpublished, extraPackages, extrasUnread, buildInputs: row?.buildInputs, onProgress: (p) => { job.bytes = p.bytes; } });
        const differs = r.ok && r.differs ? installedDiffers(r.differs) : undefined;
        Object.assign(job, { done: true, ok: r.ok, error: r.ok ? undefined : `Image install failed: ${r.error}`, finishedAt: new Date().toISOString(), ...(r.pulled ? { pulled: r.pulled } : {}), ...(differs ? { differs } : {}) });
        trace()(r.ok ? 'host.image_copied' : 'host.image_copy_failed', { host: host.id, bytes: job.bytes, ...(r.pulled ? { pulled: r.pulled } : {}), ...(r.differs ? { differs: r.differs } : {}), ...(r.ok ? {} : { error: r.error }) });
        if (differs) store.updateOperation(op.id, { params: { ...op.get().params, differs } });
        if (r.ok) op.done(r.pulled ? `${host.name} pulled the published image ${r.pulled}${extraPackages.length ? `, with this machine's extra packages (${extraPackages.join(', ')}) built onto it` : ''}.${differs ? ` ${differs}` : ''}` : `The runtime image was copied to ${host.name} (${(job.bytes / 1e9).toFixed(1)} GB).`);
        else op.fail(job.error ?? 'Image install failed.', INSTALL_AGAIN);
        return job;
      })().catch((e: unknown) => {
        // Never left "under way" for good: the next request starts again.
        Object.assign(job, { done: true, ok: false, error: `Image install failed: ${e instanceof Error ? e.message : String(e)}`, finishedAt: new Date().toISOString() });
        return job;
      });
      copy = { job, finished };
      imageCopies.set(host.id, copy);
    }
    return copy;
  };

  const underWay: ImageInstalls['underWay'] = (hostId) => {
    const copy = imageCopies.get(hostId);
    return !!copy && !copy.job.done;
  };

  return { status, start, underWay };
}
