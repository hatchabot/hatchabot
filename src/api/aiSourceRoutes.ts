import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { claudePlanAllowed, CLAUDE_PLAN_HOSTED } from '../config/claudePlan.js';
import { snapshotModels } from '../orchestrator/usage/modelLedger.js';
import { claudeAuthDir } from '../orchestrator/lifecycle/provision.js';
import { checkLocalServer, CURATED_ANTHROPIC_MODELS, isPrivateModelUrl, limitsSaid, usesSource, type KeptLine } from '../orchestrator/sources/aiSources.js';
import { usableForMgmt } from './mgmtLlm.js';
import { ownerIdOf } from './principal.js';
import { MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from './routeContext.js';

/** POST /v1/ai-profiles, a local model server. */
const LocalProfile = z.object({
  kind: z.literal('local'),
  name: z.string().min(1),
  model: z.string().min(1),
  models: z.array(z.string().min(1)).max(16).optional(),
  /** As the AGENT sees it — containers can't reach the host's loopback. */
  /**
   * Must be a private address: "nothing leaves this machine" has to be
   * enforced, not just documented. z.string().url() alone accepts
   * https://evil.com and file:// — both silently break the promise.
   */
  baseUrl: z
    .string()
    .url()
    .refine(isPrivateModelUrl, 'Must be an http:// address on this machine or a private network')
    .default('http://172.17.0.1:11434/v1'),
});

/** POST /v1/ai-profiles: a local model server, an API key, or a Claude subscription. */
const CreateAIProfile = z.union([
  LocalProfile,
  z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api_key'),
    name: z.string().min(1),
    vendor: z.enum(['anthropic', 'google', 'openai']),
    model: z.string().min(1),
    models: z.array(z.string().min(1)).max(16).optional(),
    apiKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal('subscription'),
    name: z.string().min(1),
    vendor: z.literal('anthropic'),
    model: z.string().min(1),
    models: z.array(z.string().min(1)).max(16).optional(),
    /** From `claude setup-token` — the subscription path for hosts where the
     *  login lives in the macOS Keychain instead of ~/.claude. */
    oauthToken: z.string().min(1).optional(),
  }),
  ]),
]);

/**
 * POST /v1/ai-profiles/:id/migrate-agents (HB-0814): the source to move to,
 * and the same choices adopt-agents takes (each a boolean, or left out).
 */
const MigrateAgents = z.object({
  toProfileId: z.string().optional(),
  rebuild: z.boolean().optional(),
  checkpoint: z.boolean().optional(),
  recoverAfter: z.boolean().optional(),
});

/**
 * AI sources: the routes (HB-0808).
 *
 * Each route reads its request and words the answer. The rules a bulk switch,
 * a default model's apply and a source's model list follow are the AI
 * sources service's (`ctx.sources`, src/orchestrator/sources/aiSources.ts);
 * the holds on a source a switch goes to are the agent settings service's
 * (`ctx.settings.sourceHolds`), which a class change takes too.
 *
 * GET and POST /v1/ai-profiles/usage stay with source usage in routes.ts:
 * they read its sampler.
 */
export function registerAiSourceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, secrets, trace, ownsLocalHost, holdOnce, recordLedger, ledgered } = ctx;
  const { pushModelList } = ctx.settings.models;
  const { sourceHeld } = ctx.settings.sourceHolds;
  const { switchAgentToSource, applyDefaultModel, availableModels } = ctx.sources;

  app.get('/v1/ai-profiles', async (req) => {
    // `mine` tells the app which rows the caller may edit/share/delete —
    // a shared profile appears in everyone's list but has one owner.
    // `credential` says WHAT authenticates this source (never the secret
    // itself): the two subscription flavours are indistinguishable in the
    // UI otherwise, and "did I paste a setup-token or is this the machine
    // login?" is a question the owner should not need the database for.
    // Who is on each source — the number that decides whether Delete can work.
    // Other accounts' agents are a COUNT only (never named) and only for the
    // profiles you own; for someone else's shared source you see just yours.
    const active = store.listAllActiveAgents();
    return store.listAIProfiles(ownerIdOf(req)).map(({ secretRef, ownerId, baseUrl, ...safe }) => {
      const mine = ownerId === ownerIdOf(req);
      // What agents will use AND what a container still runs (a switch waiting
      // for its rebuild): the same rule delete applies.
      const on = active.filter((a) => usesSource(a, safe.id));
      const inUse = { mine: on.filter((a) => a.ownerId === ownerIdOf(req)).length, others: mine ? on.filter((a) => a.ownerId !== ownerIdOf(req)).length : undefined };
      return {
        inUse,
        ...safe,
        mine,
        // Don't leak another account's identifier or their internal model-
        // server address just because they shared a profile with the box.
        ownerId: mine ? ownerId : undefined,
        baseUrl: mine ? baseUrl : undefined,
        credential:
          safe.vendor === 'local'
            ? 'none'
            : safe.kind === 'subscription'
              ? secretRef
                ? 'setup-token'
                : 'machine-login'
              : 'api-key',
      };
    });
  });

  app.post('/v1/ai-profiles', async (req, reply) => {
    const parsed = CreateAIProfile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;
    // One at a time per name: a double click on Add made two sources (HB-0062).
    if (!holdOnce(req, `ai-profile-add:${ownerIdOf(req)}:${body.name}`)) return reply.code(409).send({ error: `${body.name} is already being added.` });
    // Hosted: no Claude plan sources of any kind (a setup token, or this
    // machine's login), and a setup token pasted as an "API key" gets the
    // same answer rather than "make it a subscription source".
    if (!claudePlanAllowed() && (body.kind === 'subscription' || (body.kind === 'api_key' && /^sk-ant-oat/i.test(body.apiKey.trim())))) {
      return reply.code(400).send({ error: CLAUDE_PLAN_HOSTED });
    }

    const id = randomUUID();
    let secretRef: string | undefined;

    if (body.kind === 'local') {
      // Only the machine owner: checking the address fetches it from this
      // machine, and any signed-in account could otherwise have it probe
      // every port on the home network and the agents' docker network, the
      // answers telling open from closed (2026-10-09). A model server on the
      // network is the machine's, as runners and images are; the owner
      // shares the source with the household.
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: 'Only the owner of this machine can add a local model server (they can share it with you).' });
      // No credential to store — which makes this the ONE profile kind where
      // the config is the only thing that can be wrong. Check it here, where
      // the error is fixable, instead of letting the agent provision green
      // and then stay silent on Telegram forever.
      const check = await checkLocalServer(body.baseUrl, body.model);
      if (!check.ok) return reply.code(400).send({ error: check.error });
    } else if (body.kind === 'api_key') {
      // A `claude setup-token` (sk-ant-oat…) is an OAuth token, NOT an API key.
      // Stored as ANTHROPIC_API_KEY it fails every call with an auth error the
      // owner only sees as "something went wrong" in Telegram. It belongs in a
      // subscription profile, where it's injected as CLAUDE_CODE_OAUTH_TOKEN.
      if (/^sk-ant-oat/i.test(body.apiKey.trim())) {
        return reply.code(400).send({
          error:
            "That's a Claude setup-token, not an API key — used as an API key it will fail every " +
            'request. Create this source as "Claude subscription" instead and paste the token into ' +
            'its setup-token field. (An API key looks like sk-ant-api…)',
        });
      }
      secretRef = `ai-profile/${id}`;
      await secrets.put(secretRef, body.apiKey);
    } else if (body.oauthToken && !/^sk-ant-oat/i.test(body.oauthToken.trim())) {
      return reply.code(400).send({
        error: /^sk-ant-api/i.test(body.oauthToken.trim())
          ? 'That is an API key, not a setup token — create this source as "API key" instead. (A setup token looks like sk-ant-oat…, from `claude setup-token`.)'
          : 'That does not look like a setup token (they start sk-ant-oat…, from `claude setup-token`).',
      });
    } else if (body.oauthToken) {
      // Subscription via a `claude setup-token` token — for hosts (macOS)
      // where the login lives in the Keychain and can't be file-mounted.
      secretRef = `ai-profile/${id}`;
      await secrets.put(secretRef, body.oauthToken);
    } else {
      // Subscription via the on-disk login: nothing to store — the OAuth
      // credential stays on the host machine and is mounted at boot. That
      // file is the MACHINE OWNER'S Claude login, so on a shared local host
      // only the account that owns the host row may lean on it; anyone else
      // would silently bill their agents to someone else's subscription.
      // They can still paste a setup-token of their own (the branch above).
      // No new machine-login sources (26th audit): the mount is the owner's
      // real ~/.claude, read-write — an agent that is talked into writing a
      // hook into settings.json there runs it as the owner the next time they
      // use Claude Code on the machine. Existing sources keep working, and
      // the Security posture says to move them; a setup token mounts nothing.
      if (!process.env.HATCHABOT_ALLOW_MACHINE_LOGIN) {
        return reply.code(400).send({
          error:
            "A source that mounts this machine's Claude login is no longer offered: an agent could " +
            'change files that run as you. Run `claude setup-token` and paste the token here instead ' +
            '(same subscription, nothing mounted) — or use an API key or a local model.',
        });
      }
      const localHost = store.listHosts(ownerIdOf(req)).find((h) => h.kind === 'local');
      if (localHost && localHost.ownerId !== ownerIdOf(req)) {
        return reply.code(400).send({
          error:
            "This machine's Claude login belongs to the account that set the server up — " +
            'they can share their AI source with everyone here (Settings → AI sources → ' +
            'Shared). Or run `claude setup-token` under your own Claude account and paste ' +
            'that token here — or use an API key or a local model.',
        });
      }
      if (!existsSync(`${claudeAuthDir()}/.credentials.json`)) {
        return reply.code(400).send({
          error:
            'No Claude login file found on this host. On Linux: run `claude` once and log in. ' +
            'On macOS the login lives in the Keychain, so instead run `claude setup-token` ' +
            'and paste the token here. See docs/ai-profiles.md.',
        });
      }
    }

    const isLocal = body.kind === 'local';
    // A fresh Anthropic source (Max subscription, or an Anthropic API key) comes
    // pre-stocked with the current Claude line-up as switchable models, so its
    // agents aren't stuck on the single default the way a source created with an
    // empty `models` list would be. The owner can prune what they don't want,
    // and the auto-clean on next open drops any the runtime doesn't actually
    // serve (see available-models, source:'runtime'). Explicit models win.
    const anthropic = !isLocal && body.vendor === 'anthropic';
    const seededModels =
      body.models && body.models.length
        ? body.models
        : anthropic
          ? [body.model, ...CURATED_ANTHROPIC_MODELS].filter((m, i, a) => m && a.indexOf(m) === i)
          : body.models;
    const profile = {
      id,
      ownerId: ownerIdOf(req),
      name: body.name,
      // A local profile is its own vendor, and always api_key-shaped as far
      // as the rest of the system is concerned (no OAuth, no mount).
      vendor: (isLocal ? 'local' : body.vendor) as 'anthropic' | 'google' | 'openai' | 'local',
      kind: (isLocal ? 'api_key' : body.kind) as 'api_key' | 'subscription',
      model: body.model,
      models: seededModels,
      baseUrl: isLocal ? body.baseUrl : undefined,
      secretRef,
      createdAt: new Date().toISOString(),
    };
    store.insertAIProfile(profile);
    // Never echo the key back.
    const { secretRef: _omit, ...safe } = profile;
    return reply.code(201).send(safe);
  });

  // Update the switchable-model list on a profile. Its agents get the new
  // list at once, where their runtime runs the model the source gives them
  // (pushModelList, HB-0668); one owed a model change or a source switch gets
  // it with the rebuild that change waits for.
  app.patch<{ Params: { id: string }; Body: { models?: string[] } }>(
    '/v1/ai-profiles/:id',
    async (req, reply) => {
      const profile = store.getAIProfile(req.params.id);
      if (!profile || profile.ownerId !== ownerIdOf(req)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const parsed = z
        .object({
          model: z.string().trim().min(1).optional(),
          models: z.array(z.string().min(1)).max(16).optional(),
          /** Owner opt-in: every account on this installation may use this
           *  source for their agents. Shared spend, so explicit only. */
          shared: z.boolean().optional(),
          /** Back the management bot's LLM with this source (single-select;
           *  the control plane proxies the calls — see api/mgmtLlm.ts). */
          mgmtLlm: z.boolean().optional(),
          /** Installation-wide default for NEW agents (single-select):
           *  preselected in the create form, preferred by import fallbacks.
           *  Only reaches other accounts where the profile is Shared. */
          defaultSource: z.boolean().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      // Every refusal before any write: a model saved together with a refused
      // choice was kept although the request answered 400 (#56).
      if (parsed.data.shared && profile.kind === 'subscription' && !profile.secretRef) {
        // A machine-login subscription profile (no stored token) IS the
        // operator's ~/.claude, bind-mounted into an agent's container. Sharing
        // it would mount that directory — OAuth token, transcripts, and
        // hook-executing settings.json — into another account's container.
        // Never shareable; only setup-token / API-key sources are (family-member
        // hardening, docs/family-member-risk-assessment.md).
        return reply.code(400).send({
          error:
            "A machine-login Max source can't be shared — it would expose this machine's ~/.claude to " +
            'other accounts. Run `claude setup-token` and share that source instead, or use an API-key source.',
        });
      }
      if (parsed.data.mgmtLlm && !usableForMgmt(profile)) {
        return reply.code(400).send({
          error: 'Only an Anthropic source can back the management assistant (local model servers cannot).',
        });
      }
      // Installation-wide single flag (one row across the whole DB): only
      // the host owner sets it, or any co-tenant could clear/override the
      // household default and redirect where new agents silently land
      // (audit 2026-09-06). Contrast mgmtLlm/shared, which are
      // legitimately per-owner.
      if (parsed.data.defaultSource !== undefined && !ownsLocalHost(req)) {
        return reply.code(403).send({ error: 'Only the server owner sets the default AI source.' });
      }
      // `models` sent (an empty list included) replaces the list. The body
      // is an object once parsed, and JSON has no undefined, so sent is
      // defined (HB-0814: this read `'models' in` the body, cast).
      const modelsSent = parsed.data.models !== undefined;
      // A new default (or a menu that drops a pin) moves every agent that
      // follows it, any account's: each such change goes in the ledger.
      const followers = (parsed.data.model !== undefined || modelsSent)
        ? snapshotModels(store, store.listAllActiveAgents().filter((a) => a.aiProfileId === profile.id).map((a) => a.id)) : undefined;
      if (parsed.data.model !== undefined) store.setAIProfileModel(profile.id, parsed.data.model);
      if (modelsSent) {
        store.setAIProfileModels(profile.id, parsed.data.models);
      }
      if (followers) recordLedger(req, 'source-default', followers);
      if (parsed.data.shared !== undefined) store.setAIProfileShared(profile.id, parsed.data.shared);
      if (parsed.data.mgmtLlm !== undefined) {
        if (parsed.data.mgmtLlm) store.setAIProfileMgmtLlm(ownerIdOf(req), profile.id);
        else if (profile.mgmtLlm) store.setAIProfileMgmtLlm(ownerIdOf(req), null);
      }
      if (parsed.data.defaultSource !== undefined) {
        if (parsed.data.defaultSource) store.setAIProfileDefault(profile.id);
        else if (profile.defaultSource) store.setAIProfileDefault(null);
      }
      // Editing the model or its switchable list can orphan a per-agent pin.
      // effectiveModel already refuses to run a stale pin; also clear it from
      // stored state so the app doesn't misreport what an agent runs.
      if (parsed.data.model !== undefined || modelsSent) {
        const fresh = store.getAIProfile(profile.id)!;
        // Owner-scoped: on a SHARED profile another account's pin may be
        // perfectly valid for them, and clearing it silently moved their agent
        // onto our new default at its next rebuild.
        store.clearStaleAgentModels(fresh.id, [fresh.model, ...(fresh.models ?? [])], ownerIdOf(req));
      }
      // Off the request: one config write per agent, one agent at a time.
      if (modelsSent) void pushModelList(profile.id).catch(() => undefined);
      const updated = store.getAIProfile(profile.id)!;
      const { secretRef: _s, ...safe } = updated;
      return safe;
    },
  );

  /**
   * HOST-OWNER admin: move EVERY agent on one of your sources — other accounts'
   * included — onto a shared source, so the old source can be deleted. This is
   * how a legacy machine-login Max profile (the ~/.claude mount) is retired when
   * family members' agents still sit on it and they have no source of their own.
   */
  app.post<{ Params: { id: string }; Body: { toProfileId?: string; rebuild?: boolean; checkpoint?: boolean; recoverAfter?: boolean } }>(
    '/v1/ai-profiles/:id/migrate-agents',
    async (req, reply) => {
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
      const from = store.getAIProfile(req.params.id);
      if (!from || from.ownerId !== ownerIdOf(req)) return reply.code(404).send({ error: 'Not found' });
      const parsedBody = MigrateAgents.safeParse(req.body ?? {});
      if (!parsedBody.success) return reply.code(400).send({ error: zodMessage(parsedBody.error) });
      const b = parsedBody.data;
      const target = b.toProfileId ? store.getAIProfile(b.toProfileId) : undefined;
      if (!target || target.id === from.id) return reply.code(400).send({ error: 'Pick a different target source.' });
      // Other accounts' agents may only land on a SHARED source (or their own).
      const onIt = store.listAllActiveAgents().filter((a) => a.aiProfileId === from.id);
      if (!target.shared && onIt.some((a) => a.ownerId !== target.ownerId)) {
        return reply.code(400).send({ error: 'The target must be a shared source — agents from other accounts are on this one.' });
      }
      const tally = { switched: 0, rebuilding: 0, atNextStart: 0, notRecovered: 0, classDetached: 0, skipped: [] as Array<{ name: string; reason: string }> };
      // Recover context is its owner's alone (runningAgent): the caller cannot press it for
      // another account's agent, so those are counted apart, for the answer to say so.
      let notRecoveredOthers = 0;
      const limits: Array<Promise<KeptLine | undefined>> = [];
      await ledgered(req, 'source-switch', onIt.map((a) => a.id), async () => {
        for (const a of onIt) {
          const before = tally.notRecovered;
          await switchAgentToSource(a, target, b, tally, limits);
          if (tally.notRecovered > before && a.ownerId !== ownerIdOf(req)) notRecoveredOthers++;
        }
      });
      Object.assign(tally, await limitsSaid(limits));
      trace('admin')('source.migrated', { from: from.id, to: target.id, ...tally, notRecoveredOthers, skipped: tally.skipped.length });
      return { ...tally, notRecoveredOthers, agents: onIt.length, otherAccounts: new Set(onIt.filter((a) => a.ownerId !== ownerIdOf(req)).map((a) => a.ownerId)).size };
    },
  );

  /**
   * Move a batch of agents ONTO this AI source in one call — the bulk form of
   * the per-agent switch in PATCH /v1/agents/:id. `:id` is the DESTINATION
   * source. Same per-agent rules as that path (setup-token vs runner, stale
   * model pins dropped), applied atomically per agent: an agent that can't
   * legally switch is reported in `skipped`, and the rest still move.
   *
   * This is what the "change every agent's AI source" case needs — e.g. moving
   * the whole fleet off a machine-login Max profile onto a setup-token one to
   * close the ~/.claude mount (docs/pre-production.md #1).
   */
  app.post<{ Params: { id: string }; Body: { apply?: string[]; rebuild?: boolean; checkpoint?: boolean } }>(
    '/v1/ai-profiles/:id/adopt-agents',
    async (req, reply) => {
      const ownerId = ownerIdOf(req);
      const target = store.getAIProfile(req.params.id);
      if (!target || (target.ownerId !== ownerId && !target.shared)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const parsed = z
        .object({
          /** Agent ids to move onto this source. Omitted/empty = ALL of the
           *  caller's agents not already on it. */
          apply: z.array(z.string()).max(500).optional(),
          /** Rebuild each switched agent now (else it shows "rebuild to apply"). */
          rebuild: z.boolean().optional(),
          /** Summarise each agent's live conversation into MEMORY.md before its
           *  rebuild — the source switch resets the thread, this is what
           *  survives it. Only acts on a RUNNING agent being rebuilt now. */
          checkpoint: z.boolean().optional(),
          /** After each rebuild finishes, restore the pre-switch conversation
           *  from the transcript (including the one that was current) and have
           *  the agent save it to memory — on the NEW source. This is the path
           *  when the old source is out of tokens and can't checkpoint. */
          recoverAfter: z.boolean().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });

      const mine = store.listAgents(ownerId);
      const requested = parsed.data.apply?.length
        ? mine.filter((a) => parsed.data.apply!.includes(a.id))
        : mine.filter((a) => a.aiProfileId !== target.id); // "all" = everything not already here

      const tally = { switched: 0, rebuilding: 0, atNextStart: 0, notRecovered: 0, classDetached: 0, skipped: [] as Array<{ name: string; reason: string }> };
      const limits: Array<Promise<KeptLine | undefined>> = [];
      await ledgered(req, 'source-switch', requested.map((a) => a.id), async () => { for (const a of requested) await switchAgentToSource(a, target, parsed.data, tally, limits); });
      return { ...tally, ...(await limitsSaid(limits)) };
    },
  );

  // Only your own agents are touched; a shared source's other users keep theirs.
  // Local sources run one model for the whole GPU, so they can't hold
  // individuals — they use the plain PATCH instead.
  app.post<{ Params: { id: string }; Body: { model?: string; models?: string[]; apply?: string[]; rebuild?: boolean } }>(
    '/v1/ai-profiles/:id/apply-default-model',
    async (req, reply) => {
      const profile = store.getAIProfile(req.params.id);
      if (!profile || profile.ownerId !== ownerIdOf(req)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      if (profile.vendor === 'local') {
        return reply.code(400).send({
          error: 'Local sources run one model for every agent — set the default and rebuild.',
        });
      }
      const parsed = z
        .object({
          model: z.string().trim().min(1),
          /** The owner's "also switchable" extras; the final menu adds held
           *  models on top so their pins stay valid. */
          models: z.array(z.string().min(1)).max(16).optional(),
          /** Agent ids that should switch TO the new default. Everything else
           *  of yours on this source is held on its current model. */
          apply: z.array(z.string()).max(500).optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const out = await applyDefaultModel(profile, ownerIdOf(req), parsed.data, (source, before) => recordLedger(req, source, before));
      // A list longer than a source holds, once the held models are on it: nothing was written (HB-0907).
      if ('refused' in out) return reply.code(400).send({ error: out.error });
      return out;
    },
  );

  /**
   * ▲▼ in ⚙ Settings → AI. The order is what every list of sources shows —
   * the create form, an agent's AI tab, a class — so a local model that is
   * rarely the right answer can be put at the bottom instead of being the
   * first thing offered. You may move a source you own; a neighbour shared by
   * someone else is only ever moved past, never moved.
   */
  app.post<{ Params: { id: string } }>('/v1/ai-profiles/:id/move', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const profile = store.getAIProfile(req.params.id);
    if (!profile || profile.ownerId !== ownerId) return reply.code(404).send({ error: 'Not found' });
    const parsed = z.object({ dir: z.enum(['up', 'down']) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const moved = store.moveAIProfile(ownerId, req.params.id, parsed.data.dir);
    return { moved, profiles: store.listAIProfiles(ownerId).map((p) => p.id) };
  });

  // What models this profile could switch between, for the app's pick-list
  // (the service's availableModels). Own or shared profile only.
  app.get<{ Params: { id: string } }>('/v1/ai-profiles/:id/available-models', async (req, reply) => {
    const profile = store.getAIProfile(req.params.id);
    if (!profile || (profile.ownerId !== ownerIdOf(req) && !profile.shared)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return availableModels(profile, ownerIdOf(req));
  });

  /**
   * Reveal a source's stored credential — the only way to copy a Claude
   * subscription token or an API key to a SECOND installation, since the app
   * stores secrets write-only everywhere else. Owner only here — but this is
   * not the only way out: a source shared with other accounts is materialized
   * into THEIR agents' containers, which their owners can read (Files, export,
   * or just asking the agent). 2026-09-30: the page no longer claims they
   * "never see it". Logged, because a credential leaving the box is exactly
   * the event an audit wants.
   */
  app.get<{ Params: { id: string } }>('/v1/ai-profiles/:id/credential', async (req, reply) => {
    const profile = store.getAIProfile(req.params.id);
    // Not 403: a non-owner has no business learning the source exists.
    if (!profile || profile.ownerId !== ownerIdOf(req)) return reply.code(404).send({ error: 'Not found' });
    if (profile.vendor === 'local') {
      return reply.code(409).send({ error: 'A local model server has no credential to copy — point the other installation at the same URL.' });
    }
    if (!profile.secretRef) {
      return reply.code(409).send({
        error: "This source uses this machine's own Claude login, so there's nothing stored to copy. Run `claude setup-token` on the other machine and add it there as a setup-token source.",
      });
    }
    const credential = await secrets.get(profile.secretRef).catch(() => undefined);
    if (!credential) return reply.code(409).send({ error: 'The stored credential is missing — re-add it on this source.' });
    app.log.warn(
      { profileId: profile.id, ownerId: profile.ownerId, vendor: profile.vendor, kind: profile.kind },
      'ai_source.credential_revealed',
    );
    return {
      kind: profile.kind === 'subscription' ? 'setup-token' : 'api-key',
      vendor: profile.vendor,
      credential,
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/ai-profiles/:id', async (req, reply) => {
    const profile = store.getAIProfile(req.params.id);
    if (!profile || profile.ownerId !== ownerIdOf(req)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // In-use check must span all owners (a shared profile may power another
    // account's agent), but the message must not name THEIR agents to you.
    // "In use" is what an agent WILL use and what its container runs NOW: a
    // switch that has not been applied yet leaves the old source's token in
    // the container until the rebuild (30th audit).
    const using = store.listAllActiveAgents().filter((a) => usesSource(a, profile.id));
    if (using.length > 0) {
      const mine = using.filter((a) => a.ownerId === ownerIdOf(req));
      const others = using.length - mine.length;
      const parts = [
        ...mine.map((a) => a.name),
        ...(others > 0 ? [`${others} agent(s) on other accounts`] : []),
      ];
      return reply.code(400).send({
        error:
          `Still in use by ${parts.join(', ')} — ` +
          `switch ${using.length === 1 ? 'it' : 'them'} to another AI source first, or ` +
          `unshare this one and let those agents keep it until they move.`,
      });
    }
    // An agent being switched to it, its checks still under way (HB-0570):
    // after the in-use check, whose answer says more when both are true.
    if (sourceHeld(profile.id)) return reply.code(409).send({ error: 'An agent is switching to it; try again in a moment.' });
    // Gone in the same tick as the in-use check and the holds, then its key:
    // an agent switched to it while the key was being deleted kept a source
    // that no longer existed (HB-0570). A switch from now on finds no such source.
    store.deleteAIProfile(profile.id);
    if (profile.secretRef) await secrets.delete(profile.secretRef).catch(() => {});
    return { deleted: true };
  });
}
