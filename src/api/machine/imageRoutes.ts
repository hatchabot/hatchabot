import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { derivedNameProblem } from '../../domain/derivedImageName.js';
import { imageRepository } from '../../domain/imageRepository.js';
import type { Agent } from '../../domain/types.js';
import { baseProblem, buildLogPath, checkTag, deriveTag, derivedBuildProblem, dockerfileProblem, readLogTail, removeBuildLogs, removeDerivedImage } from '../../orchestrator/machines/derivedImage.js';
import { needsSharedEmbedder } from '../../orchestrator/machines/buildFailure.js';
import { baseBuildEnv, baseBuildTag, blockedMessage, cleanPackages, movesFleetDefault, promoteRefusal, someNames, strandedFollowers, type MakeDefault } from '../../orchestrator/machines/runtimeImages.js';
import { probeImageCapabilities } from '../../orchestrator/machines/runtimeCaps.js';
import { ProviderError } from '../../providers/provider.js';
import { ownerIdOf } from '../principal.js';
import { IMAGE_TAG_RE, MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from '../routeContext.js';

/** POST /v1/runtime/images/promote (HB-0814): the tag to make the fleet default. */
const PromoteImage = z.object({ tag: z.string().nullish() });

/** POST /v1/runtime/build (HB-0814): an OpenClaw version, candidate or default, extra packages, and the memory search engine (each checked below in its own words). */
const BuildBase = z.object({
  version: z.string().nullish(),
  candidate: z.boolean().nullish(),
  packages: z.unknown().optional(),
  engine: z.unknown().optional(),
});

/** POST /v1/images/:name/rebuild (HB-0814): another base to build on. */
const RebuildImage = z.object({ base: z.string().optional() });

/**
 * Runtime images: the routes (HB-0808).
 *
 * Settings → Advanced → Runtime images and Derived images: every tag on this
 * machine's daemon and who uses it, its build steps, deleting and promoting
 * one, building the base image for an OpenClaw version, the derived images
 * (built, rebuilt, deleted, their logs); and what the image can do and which
 * OpenClaw it runs beside npm's. Everything that changes an image is the
 * machine owner's (MACHINE_OWNER_ONLY).
 *
 * Each route checks who is asking, reads its request and words the answer;
 * the rules and their state are the machines service's (`ctx.machines.images`,
 * src/orchestrator/machines/runtimeImages.ts).
 */
export function registerImageRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, store, trace, providerFor, ownsLocalHost, memorySearch } = ctx;
  const { defaultBase: DEFAULT_BASE, runtimeRepo: RUNTIME_REPO, dataDir: buildDataDir } = ctx.machines.images;
  const { isBuilding, kickImageBuild, readImagesInUse, defaultRefusal, derivedBase, imageBlockers, baseBuildNow, startBaseBuild, distTags } = ctx.machines.images;

  /** Fleet runtime images: every tag on the local daemon, who is pinned where, what :latest points at. */
  app.get('/v1/runtime/images', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
    let tags: { tag: string; imageId: string; createdAt?: string; size?: string; openclawVersion?: string }[] = [];
    const inUsePending = readImagesInUse(localHost);
    try { if (localHost) tags = await providerFor(localHost.id).listImageTags(); } catch { /* daemon hiccup: empty list, not a 500 */ }
    const inUse = await inUsePending;
    const latestRow = tags.find((t) => t.tag === DEFAULT_BASE);
    const latestId = latestRow?.imageId;
    // Human answer to "what does :latest point to?": the version tags sharing its image id.
    const resolvesTo = tags.filter((t) => t.tag !== DEFAULT_BASE && t.imageId === latestId && !t.tag.includes(':derived-')).map((t) => t.tag);
    const derived = new Map(store.listDerivedImages().map((d) => [d.tag, d]));
    const me = ownerIdOf(req);
    const active = store.listAllActiveAgents().filter((a) => a.state !== 'ARCHIVED' && (!localHost || a.hostId === localHost.id)); // local daemon only
    const agentRow = (a: Agent) => ({ id: a.id, name: a.name, state: a.state, mine: a.ownerId === me, classId: a.classId ?? null, runner: localHost && a.hostId !== localHost.id ? store.getHost(a.hostId)?.name ?? 'a runner' : null });
    const everyAgent = store.listAllActiveAgents();
    const known = new Set(tags.map((t) => t.tag));
    // Pins to tags that don't exist (yet) still show, so a typo or an unbuilt candidate is visible.
    for (const a of active) if (a.image && !known.has(a.image)) { known.add(a.image); tags.push({ tag: a.image, imageId: '' }); }
    const relation = (t: { imageId: string; createdAt?: string; tag: string }) =>
      !t.imageId ? 'missing' : t.imageId === latestId ? 'same' : t.tag.includes(':derived-') ? 'derived'
        : latestRow?.createdAt && t.createdAt ? (t.createdAt > latestRow.createdAt ? 'newer' : 'older') : 'other';
    const baseBuild = baseBuildNow();
    return {
      default: DEFAULT_BASE,
      // Why Promote is off (HATCHABOT_IMAGE pins the default), or null: the page says it before anyone confirms one (HB-1256).
      promoteRefused: promoteRefusal(DEFAULT_BASE),
      latestImageId: latestId,
      containersChecked: !!inUse,
      defaultInfo: latestRow ? { resolvesTo, openclawVersion: latestRow.openclawVersion, size: latestRow.size, createdAt: latestRow.createdAt } : null,
      building: { base: baseBuild.running ? { version: baseBuild.version, candidate: baseBuild.candidate, startedAt: baseBuild.startedAt } : null },
      unpinned: active.filter((a) => !a.image).map(agentRow),
      tags: tags
        .sort((x, y) => (x.tag === DEFAULT_BASE ? -1 : y.tag === DEFAULT_BASE ? 1 : 0) || (y.createdAt ?? '').localeCompare(x.createdAt ?? '') || x.tag.localeCompare(y.tag))
        .map((t) => ({
          ...t,
          isDefault: t.tag === DEFAULT_BASE,
          isLatest: !!latestId && t.imageId === latestId,
          exists: !!t.imageId,
          relation: relation(t),
          derived: derived.get(t.tag) ? { name: derived.get(t.tag)!.name, status: derived.get(t.tag)!.status, base: derived.get(t.tag)!.base, summary: derived.get(t.tag)!.dockerfile.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join(' ; ').slice(0, 160) } : null,
          pinned: everyAgent.filter((a) => a.image === t.tag).map(agentRow),
          classes: store.listAllAgentClasses().filter((c) => c.image === t.tag).map((c) => ({ id: c.id, name: c.name, mine: c.ownerId === me })),
          blockers: imageBlockers(t.tag, me, localHost, inUse),
        })),
    };
  });

  /** What's baked into an image: the build steps, newest first. */
  app.get<{ Params: { tag: string } }>('/v1/runtime/images/:tag/history', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const tag = req.params.tag; // Fastify already URL-decodes params
    if (!IMAGE_TAG_RE.test(tag) || !tag.startsWith(`${RUNTIME_REPO}:`)) return reply.code(400).send({ error: `Only ${RUNTIME_REPO}:* tags are managed here.` });
    const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
    if (!localHost) return reply.code(400).send({ error: 'No local host.' });
    return { tag, steps: await providerFor(localHost.id).imageHistory(tag) };
  });

  /** Remove a version/candidate tag. The default is refused, and so is anything imageBlockers lists; Docker refuses tags containers still use. */
  app.delete<{ Params: { tag: string } }>('/v1/runtime/images/:tag', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const tag = req.params.tag;
    if (!IMAGE_TAG_RE.test(tag) || !tag.startsWith(`${RUNTIME_REPO}:`)) return reply.code(400).send({ error: `Only ${RUNTIME_REPO}:* tags are managed here.` });
    if (tag === DEFAULT_BASE) {
      // Under a pin of HATCHABOT_IMAGE Promote is off: the setting names the default (HB-1256).
      return reply.code(400).send({ error: promoteRefusal(DEFAULT_BASE)
        ? 'That is the fleet default, as HATCHABOT_IMAGE pins it: set HATCHABOT_IMAGE in .env to another image and restart Hatchabot first.'
        : 'That is the fleet default — promote another image first.' });
    }
    // A derived image is deleted from its own row, which also forgets its
    // Dockerfile. But an image whose row is gone has no row to delete it from —
    // that was a dead end: the Derived images tab showed nothing and this route
    // refused (seen live 2026-09-19). A leftover like that is deletable here.
    if (tag.includes(':derived-')) {
      const derivedName = tag.split(':derived-')[1] ?? '';
      if (store.getDerivedImage(derivedName)) {
        return reply.code(400).send({
          error: `"${derivedName}" is a derived image: delete it under Settings → Derived images, which also forgets its Dockerfile.`,
        });
      }
      // falls through: a leftover image with no row of its own
    }
    const me = ownerIdOf(req);
    const localHost = store.listHosts(me).find((h) => h.kind === 'local');
    const inUse = await readImagesInUse(localHost);
    const blockers = imageBlockers(tag, me, localHost, inUse);
    if (blockers.length) return reply.code(409).send({ error: blockedMessage(tag, blockers) });
    if (!localHost) return reply.code(400).send({ error: 'No local host.' });
    // The name a stopped build of it left (checkTag) is not counted as
    // another of the image's tags, so it goes first, or the image lives on
    // under it in no list; one that is not there is gone (HB-1288 review).
    const check = checkTag(tag);
    if (!inUse || inUse.tags.some((t) => t.tag === check)) {
      try { await providerFor(localHost.id).removeImageTag(check); }
      catch (err) {
        if (!/No such image|reference does not exist/i.test(String((err as Error).message))) {
          return reply.code(409).send({ error: err instanceof ProviderError ? err.userMessage : String((err as Error).message) });
        }
      }
    }
    try { await providerFor(localHost.id).removeImageTag(tag); }
    catch (err) {
      // Docker's refusal names no one: a look now can, when the first could not or the container is new.
      const now = imageBlockers(tag, me, localHost, await readImagesInUse(localHost));
      if (now.length) return reply.code(409).send({ error: blockedMessage(tag, now) });
      return reply.code(409).send({ error: err instanceof ProviderError ? err.userMessage : String((err as Error).message) });
    }
    return { removed: tag };
  });

  /** Promote a built tag to the fleet default (:latest). Agents without a pin follow it on their next rebuild. */
  app.post('/v1/runtime/images/promote', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    // Any tag that is not text was refused in these words already.
    const body = PromoteImage.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'That image tag is not valid.' });
    const tag = String(body.data.tag ?? '').trim();
    if (!IMAGE_TAG_RE.test(tag)) return reply.code(400).send({ error: 'That image tag is not valid.' });
    if (tag === DEFAULT_BASE) return reply.code(400).send({ error: 'That is already the fleet default.' });
    if (tag.includes(':derived-')) return reply.code(400).send({ error: 'A derived image is pinned per agent or per class, not promoted — every agent would inherit its packages.' });
    // HATCHABOT_IMAGE naming a version tag or a digest is the owner's pin:
    // retagged, it named another image under every agent on it (HB-1256).
    const pinned = promoteRefusal(DEFAULT_BASE);
    if (pinned) return reply.code(409).send({ error: pinned });
    const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
    if (!localHost) return reply.code(400).send({ error: 'No local host.' });
    const provider = providerFor(localHost.id);
    const tags = await provider.listImageTags();
    if (!tags.some((t) => t.tag === tag)) return reply.code(404).send({ error: `${tag} is not built on this machine.` });
    // Promote retags the LOCAL daemon only; agents on runners keep their runner's :latest.
    const followers = store.listAllActiveAgents().filter((a) => !a.image && a.hostId === localHost.id && a.state !== 'ARCHIVED');
    // The checks PATCH image makes, for everyone who follows the default
    // (night review, 2026-09-28): no way back across the 2026.8 line (a
    // migrated volume cannot be read by 2026.7), and no engine-free image
    // while the shared memory service is off (no follower could be built).
    const target = await provider.currentImageInfo(tag).catch(() => ({} as { openclawVersion?: string; embedEngine?: string }));
    const embedder = memorySearch.local;
    if (target.embedEngine === 'none' && !embedder.enabled && !embedder.external) {
      return reply.code(409).send({ error: `${tag} has no memory search engine of its own and the shared service is off, so no agent could be built on it. Turn the service on first (Settings → Hosts).` });
    }
    // Only a target BELOW 2026.8 can strand anyone (the same check as PATCH
    // image), archived followers too (strandedFollowers). Everyone who runs
    // the tag that moves: one pinned to it as well as the unpinned (HB-1187).
    const stuck = await strandedFollowers(store, localHost.id, provider, target.openclawVersion, { tag: DEFAULT_BASE, defaultBase: DEFAULT_BASE });
    if (stuck.length) {
      return reply.code(409).send({ error: `${tag} runs OpenClaw ${target.openclawVersion}, which cannot read the data of agents already on 2026.8 or newer (${someNames(stuck)}). Pin those agents to their current image first, or keep the newer default.` });
    }
    await provider.tagImage(tag, DEFAULT_BASE);
    return { promoted: tag, now: DEFAULT_BASE, followers: followers.map((a) => ({ id: a.id, name: a.name, mine: a.ownerId === ownerIdOf(req) })) };
  });

  /**
   * Why a base build onto `tag` (in `repo`) is refused, or null. A build onto
   * a tag replaces what its pinners run (the Hatchabot agent pins its own); a
   * failed one removed that tag (night review, 2026-09-28). Not a candidate,
   * the build moves the repository's :latest as it ends, so it is held to
   * Promote's check of everyone who runs that: built older than agents
   * already migrated past it, it took :latest from under them (HB-1063).
   * The app's build asks it, and the CLI's (GET /v1/runtime/build/check):
   * the CLI saw only the pins its own listing showed (HB-1428 review).
   */
  const buildRefusal = async (repo: string, tag: string | undefined, outVersion: string | undefined, candidate: boolean, ownerId: string): Promise<string | null> => {
    if (tag) {
      const pinnedBy = [...store.listAllActiveAgents().filter((a) => a.image === tag).map((a) => a.name), ...store.listAllAgentClasses().filter((c) => c.image === tag).map((c) => `class ${c.name}`)];
      if (pinnedBy.length) return `${tag} is pinned by ${pinnedBy.slice(0, 5).join(', ')}${pinnedBy.length > 5 ? ` and ${pinnedBy.length - 5} more` : ''}; rebuilding it would change what they run. Unpin them first, or build another version.`;
    }
    if (!candidate) {
      const latest = `${repo}:latest`;
      const localHost = store.listHosts(ownerId).find((h) => h.kind === 'local');
      const stuck = localHost ? await strandedFollowers(store, localHost.id, providerFor(localHost.id), outVersion, { tag: latest, defaultBase: DEFAULT_BASE }) : [];
      // With HATCHABOT_IMAGE pinned, the build moves `latest`, not the default: said so (HB-1256).
      if (stuck.length) {
        return movesFleetDefault(latest, DEFAULT_BASE)
          ? `Made the default, OpenClaw ${outVersion} cannot read the data of agents already on 2026.8 or newer (${someNames(stuck)}). Pin those agents to their current image first, or build it as a candidate.`
          : `This build moves ${latest}, not the fleet default (${DEFAULT_BASE}), and OpenClaw ${outVersion} cannot read the data of the agents pinned to ${latest} that are already on 2026.8 or newer (${someNames(stuck)}). Pin those agents to a version tag first, or build it as a candidate.`;
      }
    }
    return null;
  };

  /**
   * What POST /v1/runtime/build would say of a build onto `tag`, for one made
   * outside the app (hatchabot upgrade-image runs the build script itself):
   * `refused` is why not, null when nothing stops it. Changes nothing.
   * `built=1`: asked once the build of `tag` is done, before it moves its
   * repository's `latest`, what the app's build asks then (defaultRefusal):
   * an engine-free image with the shared memory service off, agents it would
   * strand; not the pins, as its tag already names the new image (HB-1450
   * review). Its answer says `built: true`: a service from before it reads no
   * `built` and answers the check above, which the CLI then does not take.
   */
  app.get<{ Querystring: { tag?: string; version?: string; candidate?: string; built?: string } }>('/v1/runtime/build/check', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const tag = String(req.query.tag ?? '').trim();
    if (!IMAGE_TAG_RE.test(tag)) return reply.code(400).send({ error: 'That image tag is not valid.' });
    const version = req.query.version?.trim() || undefined;
    if (version && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) return reply.code(400).send({ error: 'That version is not valid.' });
    if (req.query.built === '1') {
      if (req.query.candidate === '1') return reply.code(400).send({ error: 'A candidate moves no default: there is nothing to ask once it is built.' });
      const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
      if (!localHost) return { refused: null, built: true };
      return { refused: (await defaultRefusal({ hostId: localHost.id, tag, latest: `${imageRepository(tag)}:latest`, version: version ?? '' })) ?? null, built: true };
    }
    return { refused: await buildRefusal(imageRepository(tag), tag, version, req.query.candidate === '1', ownerIdOf(req)) };
  });

  /** Build the base runtime image for an OpenClaw version; candidate = don't touch :latest. */
  app.post('/v1/runtime/build', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (baseBuildNow().running) return reply.code(409).send({ error: 'A base image build is already running.' });
    const parsed = BuildBase.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const b = parsed.data;
    const version = b.version?.trim() || undefined;
    if (version && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) return reply.code(400).send({ error: 'That version is not valid.' });
    // Said plainly: ":latest is set by Promote" was untrue under a pinned HATCHABOT_IMAGE, where a default build
    // moves :latest and Promote is off, and of any build that is not a candidate (HB-1454).
    if (version && (version === 'latest' || version.startsWith('derived-'))) return reply.code(400).send({ error: 'Name the OpenClaw version to build, such as 2026.9.8: "latest" and "derived-" names are image tags, not versions.' });
    // Engine-free: the image carries no memory search engine, its agents use
    // the shared service (docs/embedder-and-openclaw-port-design.md, step 4).
    // Only with that service on: an image nobody can run is no candidate.
    if (b.engine !== undefined && b.engine !== 'baked' && b.engine !== 'none') return reply.code(400).send({ error: "engine must be 'baked' or 'none'" });
    // No version given builds the Dockerfile's, and is judged by it: it was
    // judged as one that bakes, so a 2026.8+ build with the service off was
    // started (HB-1185). Neither known, the build itself is the judge.
    const dockerfileVersion = (() => { try { return /^ARG OPENCLAW_VERSION=(\S+)/m.exec(readFileSync('docker/Dockerfile.runtime', 'utf8'))?.[1]; } catch { return undefined; } })();
    const outVersion = version ?? dockerfileVersion;
    const lacksEngine = needsSharedEmbedder(outVersion) === true;
    const engine = b.engine === 'none' || lacksEngine ? 'none' as const : undefined;
    const embedder = memorySearch.local;
    if (engine && !embedder.enabled && !embedder.external) {
      return reply.code(400).send({ error: (lacksEngine ? `OpenClaw ${outVersion} has no memory search engine of its own to bake, so its agents need` : 'An image without its own memory search engine needs') + ' the shared memory search service: start it first (Settings → Hosts).' });
    }
    const candidate = b.candidate !== false;
    const packages = cleanPackages(b.packages);
    if (!packages.ok) return reply.code(400).send({ error: packages.error });
    // Extras are a candidate's business: the fleet's own image stays the
    // standard list, so nobody promotes a surprise into every agent.
    if (packages.value && !candidate) {
      return reply.code(400).send({ error: promoteRefusal(DEFAULT_BASE)
        ? `An image with extra packages is built as a candidate; try it on one agent. Promote is off while HATCHABOT_IMAGE pins the fleet default to ${DEFAULT_BASE}: to make it the default, set HATCHABOT_IMAGE in .env to its tag and restart Hatchabot.`
        : 'An image with extra packages is built as a candidate; try it on one agent, then promote it.' });
    }
    // The tag the build will write, as the script names it (baseBuildTag):
    // extras get <version>-plus-…, an engine-free build of a version that could
    // bake gets -lite, and no version means the Dockerfile's own. Every tag the
    // build can write, not the plain version tag only (HB-1074). Not a
    // candidate, it moves the fleet's repository's :latest (baseBuildEnv's
    // repo, HB-1352), not one HATCHABOT_IMAGE_REPO names where the service
    // runs, as the script does, never a HATCHABOT_IMAGE pinned to another
    // tag: asked now (buildRefusal), and again as it ends (makeDefault, HB-1187).
    const outTag = baseBuildTag(baseBuildEnv({ version, packages: packages.value, engine, candidate }), dockerfileVersion);
    const refused = await buildRefusal(RUNTIME_REPO, outTag ? `${RUNTIME_REPO}:${outTag}` : undefined, outVersion, candidate, ownerIdOf(req));
    if (refused) return reply.code(409).send({ error: refused });
    let makeDefault: MakeDefault | undefined;
    if (!candidate) {
      const repo = RUNTIME_REPO;
      const latest = `${repo}:latest`;
      const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
      // Asked while that was read: one build at a time still.
      if (baseBuildNow().running) return reply.code(409).send({ error: 'A base image build is already running.' });
      // Its tag and OpenClaw unknown, there is nothing to judge it by
      // (strandedFollowers): the script makes it the default itself.
      if (localHost && outTag && outVersion) makeDefault = { hostId: localHost.id, tag: `${repo}:${outTag}`, latest, version: outVersion };
    }
    startBaseBuild({ version, candidate, packages: packages.value, engine, forOwner: ownerIdOf(req), makeDefault });
    return reply.code(202).send({ building: true, version, candidate, packages: packages.value, engine: engine ?? 'baked' });
  });

  app.get('/v1/runtime/build', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    let log = '';
    try { log = await readLogTail(buildLogPath('_base', buildDataDir), 16_000); } catch { /* no build yet */ }
    return { ...baseBuildNow(), log };
  });

  // ---- Derived runtime images (host-owner only) ---------------------------
  // A derived image is `FROM hatchabot-runtime:<base>` + the owner's Dockerfile
  // lines, for system packages a volume install can't provide. Building runs a
  // Dockerfile on this box — a privilege the local-host owner already has, and
  // one a co-tenant must never get, so EVERY route here is ownsLocalHost-gated.
  app.get('/v1/images', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    // Annotate each with how many agents pin it, so the UI can gate delete.
    const images = store.listDerivedImages().map((img) => ({
      ...img,
      pinnedBy: store.agentsPinnedToImage(img.tag).length,
    }));
    return { base: DEFAULT_BASE, images };
  });

  app.post(
    '/v1/images',
    async (req, reply) => {
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(40),
          // The owner's Dockerfile lines, appended verbatim after the FROM.
          // The size a Download can carry (its recipe is capped at 8000), or the
          // agent could never be moved or imported (night review).
          dockerfile: z.string().min(1).max(8000),
          // Defaults to the fleet base; must be a tag of the fleet's runtime repository.
          base: z.string().trim().min(1).max(160).optional(),
          // Replace an image of that name, said out loud (HB-0814: a yes or no).
          replace: z.boolean().nullish(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const { name, dockerfile } = parsed.data;
      const dfProblem = dockerfileProblem(dockerfile);
      if (dfProblem) return reply.code(400).send({ error: dfProblem });
      const nameErr = derivedNameProblem(name);
      if (nameErr) return reply.code(400).send({ error: nameErr });
      // None named: the fleet's default, or, pinned by digest, a tag here of that image, said (HB-1353).
      const fallback = parsed.data.base === undefined ? await derivedBase(store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local')) : undefined;
      if (fallback && 'problem' in fallback) return reply.code(400).send({ error: fallback.problem });
      const base = parsed.data.base ?? fallback!.base;
      // The fleet's own repository, as Promote and the base build use it (HB-0882).
      const baseErr = baseProblem(base, RUNTIME_REPO);
      if (baseErr) return reply.code(400).send({ error: baseErr });
      if (isBuilding(name) || store.getDerivedImage(name)?.status === 'BUILDING') {
        return reply.code(409).send({ error: 'That image is already building.' });
      }
      // Creating is not editing: a name that exists was silently replaced,
      // changing what its pinned agents get at their next rebuild (night review).
      // Replacing one is said out loud (`replace: true`; the CLI's `image
      // derive <name>` does), never done by a create that hit an old name.
      if (store.getDerivedImage(name) && parsed.data.replace !== true) {
        return reply.code(409).send({ error: `An image called ${name} already exists. Send replace to change its lines (its agents get them at their next rebuild), or pick another name.` });
      }

      // A replaced image keeps its base packages: judged with the lines as the
      // build will judge them, before the record is marked building.
      const buildErr = derivedBuildProblem(dockerfile, store.getDerivedImage(name)?.basePackages);
      if (buildErr) return reply.code(400).send({ error: buildErr });
      // A replaced image keeps the tag its agents pin; a new one is named in the fleet's repository.
      const tag = store.getDerivedImage(name)?.tag ?? deriveTag(name, RUNTIME_REPO);
      store.upsertDerivedImage({ name, tag, base, dockerfile, createdBy: ownerIdOf(req) });
      kickImageBuild(name);
      return reply.code(202).send({ building: true, tag, base, ...(fallback && 'said' in fallback && fallback.said ? { said: fallback.said } : {}) });
    },
  );

  app.post<{ Params: { name: string } }>(
    '/v1/images/:name/rebuild',
    async (req, reply) => {
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
      const rec = store.getDerivedImage(req.params.name);
      if (!rec) return reply.code(404).send({ error: 'Not found' });
      if (isBuilding(rec.name) || rec.status === 'BUILDING') {
        return reply.code(409).send({ error: 'That image is already building.' });
      }
      // Rebuild against the same base by default; allow moving it onto a newer
      // base (e.g. after a fleet promote) without retyping the Dockerfile.
      const body = RebuildImage.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues.some((i) => i.path[0] === 'base') ? 'base: a string.' : zodMessage(body.error) });
      const base = body.data.base?.trim() || rec.base;
      const baseErr = baseProblem(base, RUNTIME_REPO);
      if (baseErr) return reply.code(400).send({ error: baseErr });
      // The record's lines held to today's rules before anything is written:
      // lines saved before a rule (a COPY --from, HB-1473) are refused, and
      // the record, its base and its status stay as they were. Marked
      // building first, a refused build marked a working image FAILED, with
      // no log of why (review of HB-1473).
      const buildErr = derivedBuildProblem(rec.dockerfile, rec.basePackages);
      if (buildErr) return reply.code(400).send({ error: buildErr });
      store.upsertDerivedImage({
        name: rec.name, tag: rec.tag, base, dockerfile: rec.dockerfile, createdBy: rec.createdBy,
      });
      kickImageBuild(rec.name);
      return reply.code(202).send({ building: true });
    },
  );

  app.delete<{ Params: { name: string } }>('/v1/images/:name', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const rec = store.getDerivedImage(req.params.name);
    if (!rec) return reply.code(404).send({ error: 'Not found' });
    if (isBuilding(rec.name)) {
      return reply.code(409).send({ error: 'Cannot delete while it is building.' });
    }
    // Refuse while anything needs it: a pinned agent's next rebuild would fail
    // with a cryptic "no such image", a class would pin its next member to a
    // missing image (night review), and Docker refuses while a container holds it.
    const me = ownerIdOf(req);
    const localHost = store.listHosts(me).find((h) => h.kind === 'local');
    const blockers = imageBlockers(rec.tag, me, localHost, await readImagesInUse(localHost));
    if (blockers.length) return reply.code(409).send({ error: blockedMessage(rec.tag, blockers) });
    // Take the image away FIRST, and only forget the row if that worked.
    // `docker rmi` resolves {ok:false} rather than throwing, and this ignored
    // it: a failed removal (a stopped container still referencing the image is
    // the usual cause) dropped the row and left a 2GB image with nothing left
    // to delete it from — the dead end reported on 2026-09-19.
    const removed = await (deps.removeImage ?? removeDerivedImage)(rec.tag);
    if (!removed.ok) {
      trace()('derived.remove_failed', { name: rec.name, error: String(removed.error ?? '').slice(0, 300) });
      return reply.code(409).send({
        error: `Docker would not remove ${rec.tag}: ${String(removed.error ?? 'no reason given').slice(0, 300)}`,
      });
    }
    store.deleteDerivedImage(rec.name);
    // Its build logs go with it: they were kept for ever (HB-1190).
    await removeBuildLogs(rec.name, buildDataDir).catch(() => {});
    return { deleted: true };
  });

  // Tail the build log so the CLI/web can show progress and diagnose a failure.
  app.get<{ Params: { name: string } }>('/v1/images/:name/log', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const rec = store.getDerivedImage(req.params.name);
    if (!rec) return reply.code(404).send({ error: 'Not found' });
    // Its end only, read from there: a build log can be large (HB-0884).
    let log = '';
    try { log = await readLogTail(buildLogPath(rec.name, buildDataDir), 20_000); } catch { /* no log yet */ }
    return { status: rec.status, error: rec.error, log };
  });

  // ---- runtime image / OpenClaw version status ----------------------------
  // What OpenClaw version the shared runtime image is on, vs the latest stable
  // on npm. The image is fleet-wide (every agent rebuilds onto :latest); the
  // actual rebuild is a deliberate host op (`hatchabot upgrade-image`), so this
  // is read-only — it tells you *whether* to upgrade, not a button that does it.
  // What the runtime image can do — probed from the image itself (cached per
  // tag), so the Settings list can't drift from reality. Host-owner only:
  // it spins a one-shot container on first ask.
  app.get('/v1/runtime/capabilities', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    try {
      return await probeImageCapabilities(process.env.HATCHABOT_IMAGE ?? 'hatchabot-runtime:latest');
    } catch (err) {
      return reply.code(502).send({
        error: `Couldn't probe the runtime image: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      });
    }
  });

  app.get('/v1/runtime', async (req) => {
    const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
    let imageVersion: string | undefined;
    if (localHost) {
      try {
        imageVersion = (await providerFor(localHost.id).currentImageInfo()).openclawVersion;
      } catch {
        /* image not built yet / docker hiccup — report unknown, don't fail */
      }
    }
    // npm changes rarely and Settings may poll; cached for an hour (distTags).
    const { latest, extendedStable } = await distTags();
    const embedder = memorySearch.local;
    return {
      imageVersion,
      npmLatest: latest,
      npmExtendedStable: extendedStable,
      upgradeAvailable: !!(imageVersion && latest && imageVersion !== latest),
      /** 2026.8+ images carry no memory search engine: buildable only with the shared service on. Say so rather than invite a build that must fail. */
      upgradeNeedsSharedEmbedder: needsSharedEmbedder(latest) === true,
      // Yes or no, never the address: anyone signed in reads this, and an external server's address
      // may carry credentials (it went out as this value, HB-0854).
      upgradeBuildable: needsSharedEmbedder(latest) !== true || embedder.enabled || !!embedder.external,
    };
  });
}
