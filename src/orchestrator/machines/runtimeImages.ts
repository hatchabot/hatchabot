import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Agent, Host } from '../../domain/types.js';
import { needsPortHeal } from '../../openclaw/configWriter.js';
import { fetchOpenclawDistTags, type OpenclawDistTags } from '../../openclaw/npmVersion.js';
import { quoteOutput } from '../../ops/notify.js';
import type { ImagesInUse, RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { buildDerivedImage, buildLogPath, checkTag, openBuildLog, readLogTail } from './derivedImage.js';
import { buildFailureReason, needsSharedEmbedder } from './buildFailure.js';
import { APT_PACKAGE_NAME } from './imageRecipe.js';
import { imageRepository } from '../../domain/imageRepository.js';

/** One thing that stops a runtime image tag being deleted (imageBlockers). */
export type ImageBlocker = { kind: 'pin' | 'class' | 'derived' | 'container'; name: string; label: string; fix: string; mine: boolean; agentId?: string };

/** The base image build: one at a time, on this machine. */
export type BaseBuild = { running: boolean; version?: string; candidate: boolean; startedAt?: string; ok?: boolean; error?: string };

/** A default base build's end (startBaseBuild): the tag it writes, the `latest` it moves, its OpenClaw, on which machine. */
export type MakeDefault = { hostId: string; tag: string; latest: string; version: string };

/** What a base build is asked for (the script's settings). */
export type BaseBuildOpts = { version?: string; candidate: boolean; logPath: string; packages?: string; engine?: 'none' };

/**
 * Runtime images on this machine (HB-0808): the base image built for an
 * OpenClaw version, the derived images (the base plus the owner's
 * Dockerfile lines), and what stops a tag being deleted. Every route that
 * reaches this is the machine owner's: a build runs a script or a
 * Dockerfile on this box.
 *
 * Its state, sorted (HB-0809):
 *  - `buildingImages`: the derived images building in this process (a lock;
 *    the store's BUILDING status is the signal across requests, and a build
 *    a restart cut off is marked failed as this is built);
 *  - the base build (`baseBuild`, a plain variable), the npm dist-tags read
 *    within the hour (`distTagsCache`) and the read under way that every
 *    viewer meanwhile shares (`distTagsRead`), and the base build under way
 *    (`baseHalt`: its ceiling timer and its process group), which `stop()`
 *    ends;
 *  - the derived builds under way (`derivedHalts`: each one's stop), which
 *    `stop()` ends too.
 *
 * Nothing here knows about HTTP: a route checks who is asking, asks this,
 * and words the answer.
 */
export interface RuntimeImages {
  /** The fleet's default image (HATCHABOT_IMAGE, or hatchabot-runtime:latest), its repository, and where build logs are kept. */
  readonly defaultBase: string;
  readonly runtimeRepo: string;
  readonly dataDir: string;
  /** Is a derived image of this name building in this process? */
  isBuilding(name: string): boolean;
  /** Build a derived image from its row, in the background; its owner is told how it ended. Nothing when one is building. */
  kickImageBuild(name: string): void;
  /** Docker's view of which images are held, or null when it cannot be asked. */
  readImagesInUse(localHost: Host | undefined): Promise<ImagesInUse | null>;
  /** Everything that stops a tag being deleted, each with how to clear it. */
  imageBlockers(tag: string, me: string, localHost: Host | undefined, inUse: ImagesInUse | null): ImageBlocker[];
  /** The base build: running, or how the last one ended. */
  baseBuildNow(): BaseBuild;
  /**
   * Start a base build in the background (the caller has checked none runs); `forOwner` is told how it ended.
   * `makeDefault`, for a build that is not a candidate: the tag it writes, the `latest` it moves (the
   * script's), and the OpenClaw it runs, on this machine (`hostId`). It is moved as the build ends only
   * if no agent that runs `latest` would be stranded then, and Promote's other check holds (HB-1187).
   */
  startBaseBuild(o: { version?: string; candidate: boolean; packages?: string; engine?: 'none'; forOwner: string; makeDefault?: MakeDefault }): void;
  /** OpenClaw's npm dist-tags, read at most once an hour. */
  distTags(): Promise<OpenclawDistTags>;
  /** At shutdown: end the base build and the derived builds under way, the base build's ceiling timer and everything they started. */
  stop(): void;
}

/** What the images need from the process they run in. Functions only, so a test hands them fakes. */
export interface RuntimeImagesDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** The fleet's default image, as registerRoutes read it. */
  defaultBase: string;
  /** Where build logs are kept: beside the database. */
  dataDir: string;
  /** Tell an owner something on their Hatchabot agent's chat (ops/notify.ts). */
  notify: (ownerId: string, body: string) => Promise<void>;
  /** The log. */
  log: { info: (detail: Record<string, unknown>, msg: string) => void; error: (detail: Record<string, unknown>, msg: string) => void };
  /**
   * Whether this machine's shared memory search service is on, or an external
   * one is set: an engine-free image is made the default only then, as
   * Promote holds it. Unset, it is not asked.
   */
  sharedMemorySearchOn?: () => boolean;
  /** Test seams: the derived build, the base build and the npm read. */
  buildImage?: typeof buildDerivedImage;
  buildBase?: (opts: BaseBuildOpts) => Promise<{ ok: boolean; error?: string }>;
  openclawDistTags?: () => Promise<OpenclawDistTags>;
}

/** The refusal when a tag is still needed: each blocker and how to clear it. */
export const blockedMessage = (tag: string, blockers: ImageBlocker[]) =>
  `${tag} is still in use. ${blockers.map((b) => `${b.name} (${b.label}): ${b.fix}`).join(' ')}`;

/**
 * The environment the base build script runs with: this process's, and what
 * the build asks for. `repo` is the repository it writes to (the script's
 * HATCHABOT_IMAGE_REPO): the app names the fleet's, RUNTIME_REPO, so one set
 * where the service runs cannot send a build where the image list, its
 * guards and the agents do not look (HB-1352).
 */
export const baseBuildEnv = (opts: { version?: string; packages?: string; engine?: 'none'; candidate: boolean; repo?: string }): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(opts.repo ? { HATCHABOT_IMAGE_REPO: opts.repo } : {}),
  ...(opts.version ? { OPENCLAW_VERSION: opts.version } : {}),
  ...(opts.packages ? { EXTRA_PACKAGES: opts.packages } : {}),
  ...(opts.engine === 'none' ? { EMBED_ENGINE: 'none' } : {}),
  NO_LATEST: opts.candidate ? '1' : '',
});

/** POSIX `cksum` of a text (CRC-32, polynomial 0x04C11DB7, its length folded in): the checksum the build script names tags with. */
export function posixCksum(text: string): number {
  let crc = 0;
  const step = (byte: number) => {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  };
  const bytes = Buffer.from(text, 'utf8');
  for (const b of bytes) step(b);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return ~crc >>> 0;
}

/**
 * The tag (after the repository's colon) the base build script writes, named
 * as scripts/build-runtime-image.sh names it, from the environment it runs
 * with (baseBuildEnv): the OpenClaw version; with extra packages
 * `<version>-plus-<names>` (forty characters of them, then a checksum of the
 * whole list when longer, or when a name holds a `-` or a `+`, which is
 * written `p`, HB-1346); engine-free for a version that could bake one,
 * `<version>-lite`, and with packages `<version>-lite-plus-<names>` (the
 * build with its engine and the one without wrote one tag, HB-1120);
 * IMAGE_TAG when given; and another Node, plugin pins or
 * plugins for the release's own OpenClaw (`defaultVersion`, the Dockerfile's)
 * add `-custom-<checksum>`. Only the plain version tag was guarded against
 * replacing what its pinners run, and an extras or -lite rebuild replaced
 * theirs (HB-1074). test/scriptsBuildRuntimeImage.test.ts holds this to the
 * script's own dry run.
 */
export function baseBuildTag(env: NodeJS.ProcessEnv, defaultVersion: string | undefined): string | undefined {
  const version = env.OPENCLAW_VERSION || defaultVersion;
  if (!version) return undefined;
  const given = env.IMAGE_TAG || '';
  let tag = given || version;
  const extras = env.EXTRA_PACKAGES || '';
  let plus = '';
  if (extras && tag === version) {
    // A + is no character of a tag (g++): written p, as the script does.
    const names = extras.split(' ').join('-').replace(/\+/g, 'p');
    plus = `-plus-${names.slice(0, 40)}`;
    // A name with a character other than a-z, 0-9 and . (a - or a +):
    // "python3-pip" and "python3 pip" named one tag, and the second build
    // replaced the first's (HB-1346).
    if (names.length > 40 || /[^a-z0-9. ]/.test(extras)) plus = `${plus}-${posixCksum(extras)}`;
    tag = `${version}${plus}`;
  }
  const rule = needsSharedEmbedder(version) ? 'none' : 'baked';
  if ((env.EMBED_ENGINE || rule) === 'none' && rule === 'baked' && tag === `${version}${plus}`) tag = `${version}-lite${plus}`;
  const custom = ['LLAMA_CPP_PROVIDER_VERSION', 'NODE_IMAGE', 'CHANNEL_PLUGIN_VERSION', 'BAKED_PLUGINS', 'PLUGIN_INSTALL']
    .filter((v) => env[v]).map((v) => `${v}=${env[v]} `).join('');
  if (custom && !given && version === defaultVersion) tag = `${tag}-custom-${posixCksum(custom)}`;
  return tag;
}

/**
 * The agents a machine's default would strand as an image of OpenClaw
 * `version`. Only a version BELOW 2026.8 can: it cannot read a volume already
 * migrated to 2026.8+. Upward is the normal path, and a 2026.7 volume is
 * healed on its rebuild (this was inverted, and refused promoting 2026.9.8
 * over agents still on 2026.7, 2026-10-07). Everyone on that machine who
 * follows the default is asked what they run: no pin, archived ones too,
 * as they keep their stopped container and volume and a restore runs them
 * on the default (2026-10-10). Promote's check (night review, 2026-09-28),
 * made wherever a machine's default changes: Promote, a base build made the
 * default (HB-1063), Install image on a runner (HB-1061). An unknown version
 * strands no one: there is nothing to judge it by.
 *
 * `onto`: the tag that moves, when it is not the default the unpinned agents
 * run. Those who run it are asked: pinned to it, or unpinned while the
 * default (`defaultBase`, HATCHABOT_IMAGE) is it. A pin of HATCHABOT_IMAGE to
 * a version tag left the agents pinned to that tag unasked (HB-1187).
 */
export async function strandedFollowers(store: Store, hostId: string, provider: RuntimeProvider, version: string | undefined, onto?: { tag: string; defaultBase: string }): Promise<string[]> {
  if (!version || needsPortHeal(version)) return [];
  const runsIt = (a: Agent) => (onto ? withTag(a.image || onto.defaultBase) === withTag(onto.tag) : !a.image);
  const stuck: string[] = [];
  for (const a of store.listAllActiveAgents()) {
    if (!runsIt(a) || a.hostId !== hostId || !a.runtimeRef) continue;
    const running = await provider.info(a.runtimeRef).catch(() => ({} as { openclawVersion?: string }));
    if (running.openclawVersion && needsPortHeal(running.openclawVersion)) stuck.push(a.name);
  }
  return stuck;
}

/** An image named with no tag or digest is its :latest, as docker reads it. */
export const withTag = (ref: string): string => (/@|:[^:/]*$/.test(ref) ? ref : `${ref}:latest`);

/**
 * The repository a base build run by hand writes to, as the build script
 * names it (REPO): HATCHABOT_IMAGE_REPO, else HATCHABOT_IMAGE's (the CLI's
 * upgrade-image). The app's own builds write to the fleet's (RUNTIME_REPO,
 * baseBuildEnv's `repo`, HB-1352). A default build moves
 * its :latest, never HATCHABOT_IMAGE itself when that names another tag or a
 * digest: that is the owner's pin, which nothing moves (upgrade.sh, HB-1187).
 */
export const baseBuildRepo = (defaultBase: string, env: NodeJS.ProcessEnv = process.env): string => env.HATCHABOT_IMAGE_REPO || imageRepository(defaultBase);

/** Names for a refusal: five at most, and how many more. */
export const someNames = (names: string[]) => `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`;

/**
 * apt names only, and few of them: this text becomes an `apt-get install`.
 * The name rule a recipe is held to (APT_PACKAGE_NAME): a "-" at the end is
 * apt's remove operator, and "curl-" built an image without curl that no
 * recipe could make again (HB-0972).
 */
export const cleanPackages = (raw: unknown): { ok: true; value?: string } | { ok: false; error: string } => {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return { ok: true };
  if (list.length > 8) return { ok: false, error: 'Eight extra packages at most — a base image is shared by every agent.' };
  const bad = list.find((p) => p.length > 64 || !APT_PACKAGE_NAME.test(p));
  if (bad) return { ok: false, error: `"${bad.slice(0, 40)}" is not a package name${/-$/.test(bad) ? ' (a "-" at the end tells apt to remove it)' : ''}.` };
  return { ok: true, value: list.join(' ') };
};

export function createRuntimeImages(deps: RuntimeImagesDeps): RuntimeImages {
  const { store, providerFor, notify, log } = deps;
  const DEFAULT_BASE = deps.defaultBase;
  const RUNTIME_REPO = imageRepository(DEFAULT_BASE);
  const buildDataDir = deps.dataDir;

  // In-process guard against two concurrent builds of the same name (the store's
  // BUILDING status is the cross-request signal; this stops a double-submit).
  const buildingImages = new Set<string>();
  // A build this process never finished (a restart mid-build) is FAILED,
  // not BUILDING for ever with Rebuild and Delete greyed out (night review).
  store.failInterruptedImageBuilds();
  let baseBuild: BaseBuild = { running: false, candidate: true };
  /**
   * Stop the base build under way, its ceiling and its whole process group,
   * for stop(). Its own group outlived the service: launchd ends only a
   * job's group, Ctrl-C reaches only the foreground one, and the restarted
   * service, not knowing a build ran, could start another onto the same tag
   * and log (HB-0883).
   */
  let baseHalt: (() => void) | undefined;
  /**
   * Each derived build under way, to stop it for stop(): docker leads a
   * process group of its own, so a service stop no longer ended it, and a
   * Rebuild after the restart ran beside the build left over, onto the same
   * tag (review of HB-1026).
   */
  const derivedHalts = new Set<AbortController>();
  /** Default base build: the same script an operator runs by hand, output to a log file. */
  const buildBaseImage = (opts: BaseBuildOpts): Promise<{ ok: boolean; error?: string }> =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (r: { ok: boolean; error?: string }) => { if (!settled) { settled = true; resolve(r); } };
      // The log is opened before the build starts, and an error on it fails
      // the build. A write stream with no 'error' listener ended the whole
      // process when the log could not be opened: a directory at its name, a
      // full or read-only disk (HB-0878). It is capped, and the one before kept (HB-1190).
      const out = openBuildLog(opts.logPath);
      let child: ReturnType<typeof spawn> | undefined;
      let running = false;
      let logError: string | undefined;
      /** The outcome by the script's exit code, once it has ended. */
      let byExitCode: (() => void) | undefined;
      let timedOut = false;
      let shutDown = false;
      /**
       * Stop the whole build: the script and everything it started. It leads
       * a process group of its own (spawned `detached`), and the group is
       * killed. Killed alone, the script left a hung docker or npm call
       * holding its output open: 'close' never came, and "a build is already
       * running" outlived the time limit (HB-0883).
       */
      const stopAll = () => {
        if (!child) return;
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      out.on('error', (err) => {
        // Ended, and the log failed as it was flushed: the build's outcome is
        // still its exit code.
        if (byExitCode) return byExitCode();
        logError ??= `The build log ${opts.logPath} could not be written: ${err.message}`;
        // Not opened: no build was started. Started: stop it, and give the
        // outcome once it has stopped, so "a build is running" stays true
        // until none is.
        if (!running) return settle({ ok: false, error: logError });
        child?.stdout?.unpipe(out); child?.stderr?.unpipe(out);
        // Unpiped output is paused, and a paused pipe never reads its end:
        // after the script has exited (Node resumes its output once, then),
        // nothing would, and 'close', which gives the outcome, never came.
        // Read it and let it go.
        child?.stdout?.resume(); child?.stderr?.resume();
        stopAll();
      });
      out.once('open', () => {
        if (settled) return;
        let proc: ReturnType<typeof spawn>;
        try {
          proc = child = spawn('bash', ['scripts/build-runtime-image.sh'], {
            env: baseBuildEnv({ ...opts, repo: RUNTIME_REPO }),
            stdio: ['ignore', 'pipe', 'pipe'],
            // A process group of its own, so stopping the build stops all of it (stopAll).
            detached: true,
          });
        } catch (err) {
          // spawn throws some errors (E2BIG, ENOMEM) rather than emitting
          // them; in this listener a throw would end the process.
          out.end();
          return settle({ ok: false, error: (err as Error)?.message ?? String(err) });
        }
        running = true;
        // Before the pipes: a child that could not start (EMFILE) has no
        // output streams, and emits its error.
        let ended = () => { running = false; };
        proc.on('error', (err) => { ended(); out.end(); settle({ ok: false, error: logError ?? err.message }); });
        proc.stdout?.pipe(out, { end: false }); proc.stderr?.pipe(out, { end: false });
        // A ceiling: a hung pull or npm call held "a build is already running"
        // until the service restarted (night review, 2026-09-28).
        const limitMs = Number(process.env.HATCHABOT_BASE_BUILD_TIMEOUT_MS ?? 90 * 60_000);
        const ceiling = setTimeout(() => { timedOut = true; stopAll(); }, limitMs);
        ceiling.unref();
        const halt = () => { clearTimeout(ceiling); shutDown = true; stopAll(); };
        baseHalt = halt;
        ended = () => { running = false; clearTimeout(ceiling); if (baseHalt === halt) baseHalt = undefined; };
        proc.on('close', (code) => {
          ended();
          if (logError) { out.destroy(); return settle({ ok: false, error: logError }); }
          byExitCode = () => {
            if (shutDown) return settle({ ok: false, error: 'The build was stopped as Hatchabot stopped.' });
            if (timedOut) return settle({ ok: false, error: `The build ran past its time limit${limitMs >= 60_000 ? ` of ${Math.round(limitMs / 60_000)} minutes` : ''} and was stopped.` });
            if (code === 0) return settle({ ok: true });
            // The log's end, read from there (HB-0884); no log: the code is all we have.
            void readLogTail(opts.logPath, 200_000).then(
              (log) => settle({ ok: false, error: buildFailureReason(log, code) }),
              () => settle({ ok: false, error: buildFailureReason('', code) }),
            );
          };
          out.end(byExitCode);
        });
      });
    });

  const kickImageBuild = (name: string): void => {
    if (buildingImages.has(name)) return;
    const rec = store.getDerivedImage(name);
    if (!rec) return;
    buildingImages.add(name);
    const halt = new AbortController();
    derivedHalts.add(halt);
    const build = deps.buildImage ?? buildDerivedImage;
    void build({ name, base: rec.base, basePackages: rec.basePackages, dockerfile: rec.dockerfile, tag: rec.tag, dataDir: buildDataDir, signal: halt.signal })
      .then((res) => {
        // Stopped with the service: the database may be closing. The start
        // after marks it failed (failInterruptedImageBuilds), unless its
        // image took its tag before the stop: then it is READY, if the
        // database still takes it.
        if (halt.signal.aborted) {
          if (res.ok) { try { store.setDerivedImageStatus(name, 'READY', null); } catch { /* closing: the start after marks it failed */ } }
          log.info({ name, ok: res.ok }, 'derived image build stopped with the service');
          return;
        }
        store.setDerivedImageStatus(name, res.ok ? 'READY' : 'FAILED', res.ok ? null : res.error);
        log.info({ name, ok: res.ok }, 'derived image build finished');
        // Docker's output is quoted as such; Hatchabot's own reason (the
        // image would run as root, a time limit) is said as the reason.
        notify(rec.createdBy, res.ok
          ? `The derived image "${name}" (${rec.tag}) finished building. It can now be pinned to an agent.`
          : res.fromDocker
            ? `The derived image "${name}" FAILED to build. Its last output: "${quoteOutput(res.error)}"`
            : `The derived image "${name}" FAILED to build: ${quoteOutput(res.error, 400)}`);
      })
      .catch((err) => {
        store.setDerivedImageStatus(name, 'FAILED', String(err?.message ?? err));
        log.error({ err, name }, 'derived image build threw');
        notify(rec.createdBy, `The derived image "${name}" FAILED to build: ${quoteOutput(err, 400)}`);
      })
      .finally(() => { buildingImages.delete(name); derivedHalts.delete(halt); });
  };

  /** Docker's view of which images are held, or null when it cannot be asked. */
  const readImagesInUse = async (localHost: Host | undefined): Promise<ImagesInUse | null> => {
    try { return localHost ? await providerFor(localHost.id).imagesInUse() : null; } catch { return null; }
  };
  /**
   * Everything that stops a tag being deleted, each with how to clear it. The
   * one list behind "Used by" and both deletes, so "nothing" means it deletes.
   * A container counts only on the image's last tag: with another tag on the
   * same image Docker removes the name and the container keeps running.
   */
  const imageBlockers = (tag: string, me: string, localHost: Host | undefined, inUse: ImagesInUse | null): ImageBlocker[] => {
    const agents = store.listAllActiveAgents();
    const others = (mine: boolean) => (mine ? '' : ', another account');
    const pins: ImageBlocker[] = agents.filter((a) => a.image === tag).map((a) => {
      const mine = a.ownerId === me;
      const archived = a.state === 'ARCHIVED';
      const runner = localHost && a.hostId !== localHost.id ? store.getHost(a.hostId)?.name ?? 'a runner' : null;
      const fix = archived
        ? (mine ? 'Restore it and discard its trial, or delete it.' : 'Its owner can restore it and discard the trial, or delete it.')
        : (mine ? 'Discard its trial (✕).' : 'Its owner can move it to another image.');
      return { kind: 'pin', name: a.name, label: `${archived ? 'archived, pinned' : 'pinned'}${runner ? `, on ${runner}` : ''}${others(mine)}`, fix, mine, agentId: a.id };
    });
    const classes: ImageBlocker[] = store.listAllAgentClasses().filter((c) => c.image === tag).map((c) => {
      const mine = c.ownerId === me;
      return { kind: 'class', name: c.name, label: `class${others(mine)}`, fix: mine ? "Change the class's image." : "Its owner can change the class's image.", mine };
    });
    const built: ImageBlocker[] = store.listDerivedImages().filter((d) => d.base === tag).map((d) =>
      ({ kind: 'derived', name: d.name, label: 'derived image built on it', fix: 'Rebuild it on another base, or delete it.', mine: true }));
    const imageId = inUse?.tags.find((t) => t.tag === tag)?.imageId;
    // A name a build of it left (checkTag) is not another tag: Delete removes it too.
    const lastTag = !!imageId && inUse!.tags.filter((t) => t.imageId === imageId && t.tag !== checkTag(tag)).length === 1;
    const held = lastTag ? inUse!.containers.filter((c) => c.imageId === imageId) : [];
    const containerOf = (a: Agent) => (a.runtimeRef ? providerFor(a.hostId).containerName?.(a.runtimeRef) ?? a.runtimeRef : undefined);
    const containers: ImageBlocker[] = held.flatMap((c): ImageBlocker[] => {
      const a = localHost && agents.find((x) => x.hostId === localHost.id && containerOf(x) === c.name);
      if (a && pins.some((p) => p.agentId === a.id)) return []; // clearing the pin clears its container
      if (!a) {
        return [c.state === 'running'
          ? { kind: 'container', name: c.name, label: 'container with no agent, running', fix: 'Check what it is, then stop and remove it with docker.', mine: true }
          : { kind: 'container', name: c.name, label: 'leftover container', fix: `Remove it: docker rm ${c.name}`, mine: true }];
      }
      const mine = a.ownerId === me;
      const archived = a.state === 'ARCHIVED';
      const fix = archived
        ? (mine ? 'Restore and rebuild it, which moves it off this image, or delete it.' : 'Its owner can restore and rebuild it, or delete it.')
        : (mine ? 'Rebuild it, which moves it off this image.' : 'Its owner can rebuild it, which moves it off this image.');
      return [{ kind: 'container', name: a.name, label: `${archived ? 'archived, container on it' : 'container on it'}${others(mine)}`, fix, mine, agentId: a.id }];
    });
    return [...pins, ...classes, ...built, ...containers];
  };

  /**
   * A default build's end: `latest` moved, as the script moved it, with
   * Promote's checks asked again now, not only as it began. An agent that
   * reached 2026.8 or newer during the build (up to 90 minutes) was stranded
   * by the default the script then moved (HB-1187). Why it was not moved, or
   * nothing.
   */
  const madeDefault = async (d: MakeDefault): Promise<string | undefined> => {
    const provider = providerFor(d.hostId);
    const kept = `It is kept as ${d.tag}`;
    const built = await provider.currentImageInfo(d.tag).catch(() => ({} as { embedEngine?: string }));
    if (built.embedEngine === 'none' && deps.sharedMemorySearchOn && !deps.sharedMemorySearchOn()) {
      return `it has no memory search engine of its own and the shared service is off, so no agent could be built on it. ${kept}: turn the service on (Settings → Hosts), then promote it.`;
    }
    const stuck = await strandedFollowers(store, d.hostId, provider, d.version, { tag: d.latest, defaultBase: DEFAULT_BASE });
    if (stuck.length) return `OpenClaw ${d.version} cannot read the data of agents that reached 2026.8 or newer while it built (${someNames(stuck)}). ${kept}: pin those agents to their current image, then promote it.`;
    try { await provider.tagImage(d.tag, d.latest); }
    catch (err) { return `docker could not tag it as ${d.latest} (${String((err as Error)?.message ?? err).slice(0, 200)}). ${kept}.`; }
    return undefined;
  };

  /** The base build, started by POST /v1/runtime/build once its checks pass. */
  const startBaseBuild: RuntimeImages['startBaseBuild'] = ({ version, candidate, packages, engine, forOwner, makeDefault }) => {
    const logPath = buildLogPath('_base', buildDataDir);
    mkdirSync(dirname(logPath), { recursive: true });
    baseBuild = { running: true, version, candidate, startedAt: new Date().toISOString(), ok: undefined, error: undefined };
    const run = deps.buildBase ?? buildBaseImage;
    const what = `base image ${candidate ? 'candidate' : 'default'} for OpenClaw ${version ?? 'the newest version'}` +
      (packages ? ` with ${packages.split(' ').join(', ')}` : '') + (engine ? ' without its own memory search engine' : '');
    // Made the default here, as it ends (madeDefault), not by the script:
    // built as a candidate, which leaves the default alone.
    const promote = !candidate ? makeDefault : undefined;
    void run({ version, candidate: candidate || !!promote, logPath, packages, engine })
      .then(async (r) => {
        const notMade = r.ok && promote ? await madeDefault(promote) : undefined;
        if (notMade) {
          baseBuild = { ...baseBuild, running: false, ok: false, error: `Built, but not made the default: ${notMade}` };
          notify(forOwner, `The ${what} finished building, but was not made the default: ${notMade}`);
          return;
        }
        baseBuild = { ...baseBuild, running: false, ok: r.ok, error: r.error };
        // With HATCHABOT_IMAGE pinned to another tag, the fleet default is that
        // pin, and stays: only what runs `latest` moves.
        const isDefault = promote && withTag(DEFAULT_BASE) === withTag(promote.latest);
        notify(forOwner, r.ok
          ? (promote
            ? (isDefault
              ? `The ${what} finished building and is now the fleet default. Nothing restarts by itself: agents on this machine without a pin move onto it when they are rebuilt; agents on runners keep their runner's image.`
              : `The ${what} finished building and is now ${promote.latest}. The fleet default stays ${DEFAULT_BASE}, as HATCHABOT_IMAGE pins it: only agents pinned to ${promote.latest} move onto it when they are rebuilt.`)
            : `The ${what} finished building. Nothing changes for any agent until it is tried on one and promoted.`)
          : `The ${what} FAILED to build. Its last output: "${quoteOutput(r.error)}"`);
      })
      .catch((err) => {
        baseBuild = { ...baseBuild, running: false, ok: false, error: String(err?.message ?? err) };
        notify(forOwner, `The ${what} FAILED to build. Its last output: "${quoteOutput(err)}"`);
      });
  };

  // ---- runtime image / OpenClaw version status ----------------------------
  // What OpenClaw version the shared runtime image is on, vs the latest stable
  // on npm (GET /v1/runtime). npm changes rarely and Settings may poll; cache for an hour.
  const getDistTags = deps.openclawDistTags ?? (() => fetchOpenclawDistTags());
  let distTagsCache: { at: number; tags: OpenclawDistTags } | undefined;
  // The read under way: every viewer asking meanwhile waits for it. Each
  // asked npm itself while the first read was out, after a start and every
  // hour (HB-0905). Fresh for an hour from its answer; an answer with no
  // `latest` (npm did not answer: fetchOpenclawDistTags gives {} for a
  // timeout or a refusal) for five minutes, so a blip at a start does not
  // hide "upgrade available" for the hour.
  let distTagsRead: Promise<OpenclawDistTags> | undefined;
  const distTags = async (): Promise<OpenclawDistTags> => {
    const keep = distTagsCache?.tags.latest ? 3_600_000 : 5 * 60_000;
    if (distTagsCache && Date.now() - distTagsCache.at <= keep) return distTagsCache.tags;
    distTagsRead ??= (async () => getDistTags())()
      .then((tags) => { distTagsCache = { at: Date.now(), tags }; return tags; })
      .finally(() => { distTagsRead = undefined; });
    return distTagsRead;
  };

  return {
    defaultBase: DEFAULT_BASE,
    runtimeRepo: RUNTIME_REPO,
    dataDir: buildDataDir,
    isBuilding: (name) => buildingImages.has(name),
    kickImageBuild,
    readImagesInUse,
    imageBlockers,
    baseBuildNow: () => baseBuild,
    startBaseBuild,
    distTags,
    stop: () => {
      const halt = baseHalt; baseHalt = undefined; halt?.();
      for (const h of derivedHalts) h.abort();
      derivedHalts.clear();
    },
  };
}
