import type { PeerFetch } from '../util/peerAddress.js';
import { hostOf, publicConfig } from './safeguards.js';
import { hostGit } from '../orchestrator/apps/apps.js';
import { filesMb, type ChannelKindForFiles } from '../domain/filesLimit.js';
import { claudePlanAllowed } from '../config/claudePlan.js';
export { claudePlanAllowed };
import { existsSync } from 'node:fs';
import { parkDiscordBot } from '../orchestrator/channels/discordPool.js';
import { defaultDbPath } from '../envCompat.js';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import compress from '@fastify/compress';
import { peersCsv, Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeInfo, RuntimeProvider } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';
import { resolveProvider } from '../providers/resolveProvider.js';
import type { CompositeTelegramProvisioner } from '../channels/composite.js';
import type { ChannelConnector, ConnectorKind } from '../channels/connector.js';
import { ensureOpsServer } from '../ops/opsServer.js';
import { hashPassword, newRecoveryCode, normalizeRecoveryCode } from './signIn/accountsAuth.js';
import { loopbackIsRemote } from './signIn/auth.js';
import { proxyListenerState, proxyPort } from './proxyListener.js';
import { readSessionCookie } from './signIn/sessionCookie.js';
import { formatMemoryCap } from '../domain/memoryCap.js';
import { agentMemoryLimits, COMPRESSED_SWAP_FIX, defaultSwapAllowance } from '../domain/swap.js';
import { APP_VERSION } from '../domain/appVersion.js';
import { pageScripts, registerJoinPage, registerPageFiles, registerPageRoutes } from './machine/pageRoutes.js';
import {
  effectiveModel,
  forgetEmbedDecision,
  buildRuntimeSpec,
  type ProvisionDeps,
  renderRefusalOf,
  runOwedRebuildHook,
  syncDataSourceDocs,
  scrubRemovedDataSources,
  SEARCH_KEY_REF,
} from '../orchestrator/lifecycle/provision.js';
import { AgentBusyError, freedWithin, isBusy, OWED_BUSY_WAIT_MS, OWED_BUSY_WAITS, whileBusy } from '../orchestrator/lifecycle/busy.js';
import { retryPendingSchedulesWhenUp, waitsForItsOwner } from '../orchestrator/lifecycle/provision.js';
import { containerUp, sleepUnref, UP_TRIES, upEveryMs, type UpWait } from '../orchestrator/lifecycle/afterRestart.js';
import { listCrons } from '../orchestrator/schedules/crons.js';
import { TASK_NOTES_PER_HOUR } from '../orchestrator/schedules/taskNotes.js';
import { stashOldPendingSecrets } from '../orchestrator/apps/appPending.js';
import { MACHINE } from '../orchestrator/usage/budgets.js';
import { syncContextCap } from '../orchestrator/memory/compaction.js';
import type { OpenclawDistTags } from '../openclaw/npmVersion.js';
import { completeWithProfile, pickMgmtProfile, runMgmtCompletion } from './ops/mgmtLlm.js';
import { opsDriftOf } from '../ops/opsDrift.js';
import { recordChanges, snapshotModels, type ChangeMeta } from '../orchestrator/usage/modelLedger.js';
import type { PendingConfirm } from '../mgmt/pendingStore.js';
import { createOpsPush } from '../ops/push.js';
import { OPS_AGENT_SEARCHES } from '../orchestrator/settings/searchUsage.js';
import type { IconCompleter } from '../orchestrator/homeScreen/agentIcons.js';
import { interruptedConfirmsNote, registerMgmtChat, type InterruptedConfirm } from './ops/mgmtChat.js';
import { registerReachRoutes } from './machine/reachRoutes.js';
import { registerInspectRoutes } from './agents/inspectRoutes.js';
import { registerClassRoutes } from './agents/classRoutes.js';
import { registerModelRoutes } from './agents/modelRoutes.js';
import { registerAiSourceRoutes } from './usage/aiSourceRoutes.js';
import { registerChannelRoutes } from './chat/channelRoutes.js';
import { registerBackupRoutes } from './data/backupRoutes.js';
import { registerAppRoutes } from './data/appRoutes.js';
import { registerMachineRoutes } from './machine/machineRoutes.js';
import { registerImageRoutes } from './machine/imageRoutes.js';
import { registerUsageRoutes } from './usage/usageRoutes.js';
import { registerGoogleRoutes } from './data/googleRoutes.js';
import { registerHealthRoutes } from './machine/healthRoutes.js';
import { registerOpsAgentRoutes } from './ops/opsAgentRoutes.js';
import { registerProblemReportRoutes } from './ops/problemReportRoutes.js';
import { registerTransferRoutes } from './data/transferRoutes.js';
import { registerAdoptRoutes } from './data/adoptRoutes.js';
import { createTransfers } from '../orchestrator/transfer/transfers.js';
import { registerSkillRoutes } from './data/skillRoutes.js';
import { registerVoiceRoutes } from './console/voiceRoutes.js';
import { registerFileRoutes } from './data/fileRoutes.js';
import { registerEmbedderRoutes } from './machine/embedderRoutes.js';
import { registerConversationRoutes } from './chat/conversationRoutes.js';
import { createConversations } from '../orchestrator/conversation/conversations.js';
import { registerConsultRoutes } from './chat/consultRoutes.js';
import { createConsults } from '../orchestrator/consult/consults.js';
import { registerMemoryRoutes } from './chat/memoryRoutes.js';
import { createAgentMemory } from '../orchestrator/memory/agentMemory.js';
import { registerDefinitionRoutes } from './agents/definitionRoutes.js';
import { createAgentDefinition } from '../orchestrator/definition/agentDefinition.js';
import { registerAgentSecretRoutes } from './agents/agentSecretRoutes.js';
import { createAgentSecrets } from '../orchestrator/agentSecrets/agentSecrets.js';
import { registerHomeScreenRoutes } from './agents/homeScreenRoutes.js';
import { createHomeScreen } from '../orchestrator/homeScreen/homeScreen.js';
import { registerModelChangeRoutes } from './usage/modelChangeRoutes.js';
import { createModelChanges } from '../orchestrator/usage/modelChanges.js';
import { createMemorySearch } from '../orchestrator/memorySearch/memorySearch.js';
import { createFiles } from '../orchestrator/files/files.js';
import { createSkills } from '../orchestrator/skills/skills.js';
import { createAgentVoice } from '../orchestrator/voice/agentVoice.js';
import { registerMachineSettingsRoutes } from './machine/machineSettingsRoutes.js';
import { registerTailscaleRoutes } from './machine/tailscaleRoutes.js';
import { registerConfigRoutes } from './machine/configRoutes.js';
import { registerAccountsRoutes } from './signIn/accountsRoutes.js';
import { createReach } from '../orchestrator/reach/reach.js';
import { signinLinkAudience } from './signIn/signinLink.js';
import { createAccounts } from '../orchestrator/accounts/accounts.js';
import { createMachineSettings } from '../orchestrator/settings/machineSettings.js';
import { createAgentSettings } from '../orchestrator/lifecycle/agentSettings.js';
import { createAgentLifecycle } from '../orchestrator/lifecycle/agentLifecycle.js';
import { createAgentEdits } from '../orchestrator/lifecycle/agentEdits.js';
import { registerLifecycleRoutes } from './agents/lifecycleRoutes.js';
import { createAiSources } from '../orchestrator/sources/aiSources.js';
import { createWarmLocalModels } from '../orchestrator/sources/warmModels.js';
import { createChannels } from '../orchestrator/channels/channels.js';
import { createBackups } from '../orchestrator/backups/backups.js';
import { createAppsAndSources } from '../orchestrator/apps/appsAndSources.js';
import { createConsoles } from '../orchestrator/console/consoles.js';
import { createMembersAndInvites } from '../orchestrator/members/membersAndInvites.js';
import { resumeFirstContacts } from '../orchestrator/members/claim.js';
import { inChannelConfigTurn } from '../orchestrator/members/members.js';
import { registerBrowserRoutes } from './console/browserRoutes.js';
import { consoleSessionWatch, registerConsoleRoutes } from './console/consoleRoutes.js';
import { createMachines } from '../orchestrator/machines/machines.js';
import { registerMemberRoutes } from './chat/memberRoutes.js';
import { createUsageAndBudgets } from '../orchestrator/usage/usageAndBudgets.js';
import { createSchedules } from '../orchestrator/schedules/schedules.js';
import { registerScheduleRoutes } from './data/scheduleRoutes.js';
import { createConnectionsAndAccess } from '../orchestrator/google/connectionsAndAccess.js';
import { createProblemReports } from '../orchestrator/diagnostics/problemReports.js';
import { createHealthChecks } from '../orchestrator/health/healthChecks.js';
import { createHatchabotAgent } from '../orchestrator/ops/hatchabotAgent.js';
import { sixAtATimeWhenReady } from '../util/queues.js';
import { HOST_GOING, IMAGE_TAG_RE, IMPORT_HEAD_MAX_BYTES, IMPORT_WITH_VALUES, NO_COMPRESS, OPS_ALONE, type RouteContext } from './routeContext.js';
import { forgetDmPolicy } from '../orchestrator/channels/dmPolicyMemo.js';
import { GOOGLE_SERVICES, syncConnections } from '../orchestrator/google/googleConnections.js';
import { verifyAgentAccess } from '../orchestrator/google/accessOverview.js';
import { ownerChatRoutes, tellOwner } from '../channels/notify.js';

/** The largest file (or folder as .tar.gz) that moves through an agent's Files tab, either way. */
const FILE_MAX_BYTES = Math.max(1, Number(process.env.HATCHABOT_FILE_MAX_MB ?? 512)) * 1024 * 1024;
import type { EmbedderService } from '../embedder/embedder.js';
import { hibernateSweep, wakeAgent, wakeSweep, type HibernateDeps } from '../orchestrator/lifecycle/hibernate.js';
import { clearStaleRuntimePinsWhenUp } from '../orchestrator/sources/runtimePins.js';
import { rebuildPolicy } from '../domain/rebuildPolicy.js';
import { holdDeleteEnds, KIND_LABEL, operationRefusal, operationsOverFor, publicOperation, STARTS_IT_AT_ITS_END } from '../orchestrator/lifecycle/operations.js';
import { recoverOperation, startOperationRetryLoop, startResumeOperations, type ResumeContext, type ResumingOperations } from '../orchestrator/lifecycle/operationsResume.js';
import type { buildDerivedImage, removeDerivedImage } from '../orchestrator/machines/derivedImage.js';
import type { Agent, AIProfile, Host } from '../domain/types.js';
import { ownerIdOf } from './principal.js';
import { registerWebChatRoutes, webChatBusy } from './chat/webChat.js';
import type { IdentityVerifier } from './signIn/identity.js';



export interface ApiDeps {
  /** Stands in for the network when search is checked (tests). */
  searchFetch?: typeof fetch;
  /** Stands in for Telegram when a note is pushed to the owner's phone (tests). */
  pushFetch?: typeof fetch;
  store: Store;
  secrets: SecretStore;
  /** Keyed by Host.provider — 'mock', 'local-docker', later 'gce'. */
  providers: Map<string, RuntimeProvider>;
  /** `hatchabot doctor --json` lines for a problem report; tests pass their own (the real one spawns the CLI). */
  reportDoctor?: () => Promise<Array<{ level: string; text: string; fix?: string }> | undefined>;
  /** Git for reading app sources on the host (orchestrator/apps/apps.ts); tests inject one. */
  appGit?: import('../orchestrator/apps/apps.js').Git;
  /** Runner providers by host (resolveProvider's cache), shared with the health sweep; a fresh one when absent. */
  remoteProviders?: Map<string, RuntimeProvider>;
  channel: CompositeTelegramProvisioner;
  /** Absolute path to the single-page app. */
  webIndexPath?: string;
  /** Absolute path to the invitee join page. */
  webJoinPath?: string;
  /** The version stamped into the page and its ETag; APP_VERSION unless a test sets it. */
  appVersion?: string;
  /**
   * Canonical origin others should use to reach this control plane, e.g.
   * http://my-host.example.ts.net:8080. Invite links are built from it,
   * so a link minted while the owner browses localhost still works from the
   * invitee's phone.
   */
  publicUrl?: string;
  /** Test seam for the Google OAuth round-trip (token exchange, userinfo, revoke). */
  oauthFetch?: typeof fetch;
  /** Test seam for calls to another Hatchabot server (pinnedPeerFetch by default). */
  peerFetch?: PeerFetch;
  /**
   * Checks an imported file's bot token with Telegram (its username comes
   * back). Set by the app; the harnesses leave it unset and import fixtures
   * with made-up tokens.
   */
  verifyImportedToken?: (token: string) => Promise<string>;
  /** Drives the login screen the unauthenticated page renders. */
  authMode?: 'password' | 'accounts' | 'identity';
  /** Set in identity mode: lets the join flow bind a membership to an account. */
  verifier?: IdentityVerifier;
  /** Override the OpenClaw npm dist-tags lookup (tests). Defaults to the real
   *  registry fetch; the endpoint caches the result. */
  openclawDistTags?: () => Promise<OpenclawDistTags>;
  /** Override the derived-image builder (tests). Defaults to the real
   *  `docker build`; tests inject a stub so no docker runs. */
  buildImage?: typeof buildDerivedImage;
  /** Test seam: what actually takes the image off the daemon. */
  removeImage?: typeof removeDerivedImage;
  /** Override the base-image build (tests). Default spawns scripts/build-runtime-image.sh. */
  buildBase?: (opts: { version?: string; candidate: boolean; logPath: string; packages?: string; engine?: 'none' }) => Promise<{ ok: boolean; error?: string }>;
  /** Override the mgmt-LLM proxy's Anthropic call (tests). */
  mgmtLlmComplete?: typeof completeWithProfile;
  /** Override the mgmt-LLM CLI path (tests — the real one spawns `claude`). */
  mgmtCliComplete?: Parameters<typeof runMgmtCompletion>[0]['cliComplete'];
  /** Tests: allow a management agent on a provider with no network isolation. */
  allowUnjailedOps?: boolean;
  /** Slack and Discord connectors (tests inject fakes that never touch the network). */
  connectors?: Partial<Record<ConnectorKind, ChannelConnector>>;
}


export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<RoutesHandle> {
  const { store, secrets } = deps;
  // Bot tokens held for setup (telegramManual.ts) are read from the store
  // once, now, for every agent, as the store read on each look did (one
  // pasted on attach is held for a running agent until that request's
  // provision); after that only memory is asked, and every look waits for
  // this read.
  deps.channel?.loadHeld?.(store.listAllActiveAgents().map((a) => a.id));

  // Compress what the app fetches: the page was 778 KB per load and the
  // /v1/agents poll 91 KB every 8 s, a quarter and an eighth of that gzipped —
  // it matters on a phone over the tailnet (review, 2026-09-29). Registered
  // first so every route below gets it. Text, JSON, JS, SVG and what mime-db
  // calls compressible — which includes octet-stream, so every download and
  // stream opts out by name (NO_COMPRESS): archives are already compressed and
  // files are streamed with a length the client checks. So does the console
  // proxy, which rewrites its page and passes the gateway's own encoding
  // through. Websocket upgrades never reach Fastify's reply at all. Request bodies are left alone (no decompression): an
  // upload is taken as sent. Brotli at quality 4, the plugin's default, since
  // 11 costs a second on the page.
  await app.register(compress, {
    threshold: 1024,
    encodings: ['br', 'gzip'],
    customTypes: /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|^(?:application|text)\/javascript(?:;|$)|^image\/svg\+xml(?:;|$)/,
    globalDecompression: false,
  });

  // Browser hardening on every response. No other site may frame the app (the
  // session cookie is SameSite=Strict, so a framed copy would be signed out
  // anyway — this makes it certain); nothing is content-sniffed; and a page
  // whose address carries a code (/join/…, a reset link) never sends that
  // address to another site as a Referer. Set only when a route hasn't: the
  // console proxy sets its own framing rule.
  // A Recommended item's button (recommendations.ts) calls the same route its
  // card would; each one that went through is a line on the agent's timeline.
  // As the answer is sent, not once it has reached the page (onResponse): a
  // page that hung up first, the change made all the same, left no line
  // (HB-1405 review, as HB-0630 and HB-1405 found for the holds and the
  // open consoles).
  app.addHook('onSend', async (req, reply, payload) => {
    const rec = req.headers['x-hatchabot-recommendation'];
    if (typeof rec !== 'string' || !rec || reply.statusCode >= 400 || req.method === 'GET') return payload;
    try {
      const route = req.routeOptions?.url ?? '';
      const params = (req.params ?? {}) as { id?: string };
      const agentId = route.startsWith('/v1/agents/:id') ? params.id
        : route === '/v1/proposals/:id/:verb' ? store.getMgmtProposal<PendingConfirm>(String(params.id ?? ''))?.resolved?.agentId
        : undefined;
      trace(agentId || 'admin')('recommendation.acted', { item: rec.slice(0, 200), route: `${req.method} ${route}`, ...(agentId ? { agentId } : {}) });
    } catch (err) { app.log.warn({ err }, 'recommendation.trace_failed'); } // the answer stands: its line is only a line
    return payload;
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'SAMEORIGIN');
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  /**
   * Orchestrators already report what they do; this sends it to the log AND
   * to the agent's timeline, so the app can answer "what happened to this
   * agent?" instead of only "what state is it in now?".
   */
  const trace =
    (agentId?: string) =>
    (event: string, detail: Record<string, unknown>): void => {
      app.log.info(detail, event);
      const id = agentId ?? (typeof detail.agentId === 'string' ? detail.agentId : undefined);
      if (id) {
        try {
          store.recordEvent(id, event, detail);
        } catch {
          /* a timeline write must never break the operation it describes */
        }
      }
    };

  // Agent archives arrive as raw bytes (import). The ceiling is what an
  // import can accept at all (transfer.ts's MAX_STATE_BYTES, base64-inflated)
  // — a bigger body only ever sat in memory to be refused (26th audit).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: Math.max(272 * 1024 * 1024, FILE_MAX_BYTES) }, // imports, and Files uploads up to their own cap
    (_req, body, done) => done(null, body),
  );
  // An import with a template's setup answers (HB-0093): one line of JSON
  // (`{"values":{…}}`), a newline, then the .hatchabot file's bytes. Only the
  // import route takes it; the answers in the address passed Node's 16 KB limit.
  app.addContentTypeParser(
    IMPORT_WITH_VALUES,
    { parseAs: 'buffer', bodyLimit: 272 * 1024 * 1024 + IMPORT_HEAD_MAX_BYTES },
    (req, body, done) => {
      if (req.routeOptions?.url === '/v1/agents/import') return done(null, body);
      done(Object.assign(new Error(`Unsupported Media Type: ${IMPORT_WITH_VALUES}`), { statusCode: 415 }), undefined);
    },
  );
  // Any other body type reaches ONLY the console proxy, as bytes: the Control UI
  // sends attachments as multipart, which Fastify refused with 415 before the
  // proxy saw it (audit, 2026-10-23). Every other route keeps its 415.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: Math.max(64 * 1024 * 1024, FILE_MAX_BYTES) },
    (req, body, done) => {
      if ((req.routeOptions?.url ?? '').startsWith('/v1/agents/:id/ui/')) return done(null, body);
      done(Object.assign(new Error(`Unsupported Media Type: ${String(req.headers['content-type'] ?? '')}`), { statusCode: 415 }), undefined);
    },
  );

  /**
   * Resolve an agent by id AND check it belongs to the caller. Every by-id
   * route goes through this — without it, ownerId scoping exists only on the
   * list endpoints and provides no isolation the moment a second owner exists
   * (docs/identity.md phase 1).
   */
  const ownedAgent = (req: FastifyRequest, id: string): Agent | undefined => {
    const agent = store.getAgent(id);
    if (!agent || agent.ownerId !== ownerIdOf(req)) return undefined;
    return agent;
  };
  /**
   * Deleted or being deleted: nothing more is stored for it. A credential
   * saved then sat on the tombstone, past the delete's scrub (HB-0322). Asked
   * again after any wait, since the delete may land during it.
   */
  const agentGone = (id: string): boolean => {
    const state = store.getAgent(id)?.state;
    return !state || state === 'DELETED' || state === 'DELETING';
  };

  /**
   * Phase 4 (docs/identity.md): an agent a member may *see* — theirs by
   * ownership or by active membership. Read-only surfaces use this; anything
   * that changes the agent's life (lifecycle, files, members, export, delete)
   * stays on ownedAgent so a `user` member can't touch it.
   */
  const visibleAgent = (req: FastifyRequest, id: string): Agent | undefined => {
    const agent = store.getAgent(id);
    if (!agent) return undefined;
    return store.accessRole(agent.id, ownerIdOf(req)) ? agent : undefined;
  };

  /**
   * The only shape an Agent leaves this process in. gatewayToken is a
   * credential for full agent control (served on demand by /gateway), so
   * stripping it belongs here rather than in each route's spread — four
   * mutation routes previously leaked it by returning the raw row.
   */
  /**
   * An agent's swap as the app shows it: the allowance it should have
   * (`swapAllowanceEffective`, "off" or a size), what its container runs with
   * (`swapInEffect`), how much of it is in swap now (`swapBytes`), and — when
   * an allowance is set but the host does not compress swap — why it is
   * withheld and the fix.
   */
  const swapViewOf = async (a: Agent, running?: import('../providers/provider.js').RuntimeInfo): Promise<Record<string, unknown>> => {
    const lim = agentMemoryLimits(store, a);
    const out: Record<string, unknown> = { swapAllowanceEffective: lim.swap ?? 'off', swapAllowanceDefault: defaultSwapAllowance() };
    if (running?.swapBytes !== undefined) out.swapBytes = running.swapBytes;
    if (running?.memorySwapLimitBytes !== undefined && running.memoryLimitBytes) {
      const extra = running.memorySwapLimitBytes - running.memoryLimitBytes;
      out.swapInEffect = running.memorySwapLimitBytes < 0 ? 'unlimited' : extra > 0 ? formatMemoryCap(extra) : 'off';
    }
    if (lim.swap) {
      const host = await providerFor(a.hostId).compressedSwap?.().catch(() => undefined);
      if (host && !host.compressed) Object.assign(out, { swapWithheld: host.why, swapFix: COMPRESSED_SWAP_FIX });
    }
    return out;
  };
  /** Being archived right now: the agent lifecycle service's marker (`lifecycle.records`, built below; read when asked). */
  const isArchiving = (agentId: string): boolean => lifecycle.records.isArchiving(agentId);
  /**
   * Its peers are not the ones its last rebuild installed (the call-agent
   * tool): its card's "peers changed", and Start's judgement
   * (rebuildOwedAtStart), which keeps no mark that nothing would clear once
   * the peers went back to what it has (HB-0465). The agent list and the bulk
   * Connect ask the same of all an owner's agents at once
   * (store.agentsWithPeersPending, in the same peersCsv form).
   */
  const peersNotInstalled = (agentId: string): boolean =>
    peersCsv(store.listAgentPeers(agentId)) !== store.appliedPeersCsv(agentId);
  const publicAgent = (agent: Agent, extra: Record<string, unknown> = {}) => {
    const desired = store.getAIProfile(agent.aiProfileId);
    // What this agent WILL run: its own override if any, else the profile
    // default (local ignores the override — effectiveModel handles that).
    const desiredModel = desired ? effectiveModel(agent, desired) : undefined;
    const switched =
      (agent.appliedProfileId && agent.appliedProfileId !== agent.aiProfileId) ||
      (!!agent.appliedModel && !!desiredModel && agent.appliedModel !== desiredModel);
    return {
      ...agent,
      gatewayToken: undefined,
      // Keep its logins (HB-0680): whether it does. Its profile's id and the
      // sites are the owner's, from GET /v1/agents/:id/browser.
      browserLogins: undefined,
      browserSites: undefined,
      // Saved/applied library choices are read only through the owner-scoped
      // skills route, not the roster and detail views shared with members.
      curatedSkills: undefined,
      appliedCuratedSkills: undefined,
      keepsLogins: agent.browser && agent.browserLogins ? true : undefined,
      // An answered bot-token step is setup's to take up, not the owner's:
      // shown as setting up, so no app or CLI reads it as asked again.
      pendingAction: agent.pendingAction?.received ? undefined : agent.pendingAction,
      // The raw template layer is bulky file text — the app only needs to know
      // the values are editable; the PUT /params route re-reads the real thing.
      paramFiles: undefined,
      hasParamFiles: !!agent.paramFiles,
      hasGateway: !!(agent.gatewayPort && agent.gatewayToken),
      /** What the runtime is actually running right now. */
      model: agent.appliedModel ?? desiredModel,
      /** What it WILL run after a rebuild, when that differs from now. */
      pendingModel: switched ? desiredModel : undefined,
      /**
       * That model waits for a rebuild it is owed (a source switch, one due
       * at its next start, or the image its class's model needs:
       * modelWaitingForImage), rather than for a runtime that refused it:
       * the class list counts only the latter as "still on an old model".
       */
      rebuildWaits: switched ? !!(agent.appliedProfileId && agent.appliedProfileId !== agent.aiProfileId) || !!agent.rebuildOnStart || (!!desiredModel && settings.classes.modelWaitingForImage(agent.id) === desiredModel) : undefined,
      /** True when the granted peer set differs from what was installed at the
       *  last rebuild — the call-agent tool is (re)installed on rebuild, so this
       *  agent needs one before it can consult its current peers. */
      peersPending: peersNotInstalled(agent.id),
      /** The agent's class name (for display/filter), resolved from classId. */
      className: agent.classId ? store.getAgentClass(agent.classId)?.name : undefined,
      /** The models this agent could switch to (its profile's menu), so the
       *  app can offer a per-agent picker without another round-trip. */
      profileModels: desired && desired.vendor !== 'local'
        ? [desired.model, ...(desired.models ?? [])].filter((m, i, a) => a.indexOf(m) === i)
        : [],
      profileDefaultModel: desired?.model,
      /** The raw per-agent override (undefined = follows the default), so the
       *  picker can show which choice is currently in effect. */
      modelOverride: agent.model,
      /** Everything this agent can access, unified: legacy read-only folders
       *  plus richer DataSources. One list so the app can show "what data does
       *  this agent have" at a glance. */
      dataSources: dataSourcesFor(agent),
      dataSummary: dataSummaryFor(agent),
      /** Per-agent environment variables — names only; the secret values are
       *  write-only and never leave the SecretStore. */
      envVars: store.listAgentEnv(agent.id).map((e) => ({ id: e.id, name: e.name, createdAt: e.createdAt })),
      /** Mid-operation (move, backup, export, adopt…): the state alone reads
       *  as a lie — a move shows STOPPED for a minute — so the app can show
       *  "working" instead of leaving the owner to think nothing is happening. */
      busy: isBusy(agent.id),
      /** Its long operation that is not over (operations.ts): running, interrupted
       *  by a restart, or held for the owner's choice — with the choices. */
      operation: publicOperation(store.activeOperationFor(agent.id)),
      /** Being archived right now (saving its conversation, then stopping): the step and since when. */
      archiving: lifecycle.records.archivingNow(agent.id),
      /** Asleep (hibernate.ts): stopped by the idle rule; a message, its console or an ask wakes it. */
      hibernatedAt: agent.hibernatedAt,
      /** A copy was downloaded while it stood stopped: deleting it does not park its bot (web: del). */
      exportedAt: agent.exportedAt,
      /** A change is waiting for its next start, which is a rebuild (HB-0411). */
      rebuildOnStart: agent.rebuildOnStart,
      hibernate: agent.hibernate,
      /** The management agent's tool lockdown was loosened: key suspended. */
      opsDrift: agent.ops ? opsDriftOf(agent.id) : undefined,
      ...extra,
      // A member of someone else's agent gets what it can DO, never where the
      // owner's files live, their env var names, or its gateway port (26th audit).
      ...((extra.role !== undefined && extra.role !== 'owner') || extra.foreign === true
        // A legacy folder's id IS its path: renamed for them too (night review).
        ? { dataSources: dataSourcesFor(agent).map((d) => ({ ...d, hostPath: undefined, ...(d.legacy ? { id: `legacy:${d.mountName}` } : {}) })), envVars: [], gatewayPort: undefined, sharedPaths: undefined,
          // Why a stopped one did not start names the owner's machines (Store.markNotStarted).
          stateReason: agent.state === 'FAILED' ? agent.stateReason : undefined,
          // Members see that it is busy with something, never what or the owner's choices.
          operation: ((o) => o && { kind: o.kind, kindLabel: o.kindLabel, status: o.status })(publicOperation(store.activeOperationFor(agent.id), { recovery: false })) }
        : {}),
    };
  };

  /** Legacy shared_paths + data_sources, as one uniform list for the app. */
  const dataSourcesFor = (agent: Agent) => [
    ...(agent.sharedPaths ?? []).map((p) => ({
      id: `legacy:${p}`,
      kind: 'folder' as const,
      access: 'ro' as const,
      mountName: basename(p),
      hostPath: p,
      legacy: true,
    })),
    ...store.listDataSources(agent.id).map((d) => ({
      id: d.id,
      kind: d.kind,
      access: d.access,
      mountName: d.mountName,
      hostPath: d.hostPath,
      mountAtHostPath: d.mountAtHostPath,
      repoUrl: d.repoUrl,
      // Public half of the deploy key — safe to show, and the owner needs it to
      // grant the repo access (as a read, or write for rw, deploy key).
      pubKey: d.pubKey,
      /** Why the last clone failed, so the card can say which repo is stuck
       *  instead of the owner digging through the audit log. */
      syncError: d.syncError,
      legacy: false,
    })),
  ];

  /** One-line "reads 2 folders · 1 writable folder" for the card. */
  const dataSummaryFor = (agent: Agent): string | undefined => {
    const all = dataSourcesFor(agent);
    if (!all.length) return undefined;
    const ro = all.filter((d) => d.kind === 'folder' && d.access === 'ro').length;
    const rw = all.filter((d) => d.kind === 'folder' && d.access === 'rw').length;
    const git = all.filter((d) => d.kind === 'git').length;
    const parts: string[] = [];
    if (ro) parts.push(`reads ${ro} folder${ro > 1 ? 's' : ''}`);
    if (rw) parts.push(`${rw} writable folder${rw > 1 ? 's' : ''}`);
    if (git) parts.push(`${git} git repo${git > 1 ? 's' : ''}`);
    return parts.join(' · ');
  };

  /**
   * A moved agent's bot now belongs to another server. Starting, rebuilding
   * or retrying this copy would put two runtimes on one token and they would
   * fight over every message — so refuse until the owner explicitly says the
   * move was undone.
   */
  const movedAway = (agent: Agent, reply: any): boolean => {
    if (!agent.migratedTo) return false;
    reply.code(409).send({
      error:
        `"${agent.name}" was moved to ${agent.migratedTo}. Starting this copy would make two ` +
        `agents poll the same Telegram bot and messages would go to whichever answers first. ` +
        `If the move was undone, clear it first (Edit → "Runs here again").`,
    });
    return true;
  };

  /**
   * A lifecycle request against an agent mid-migrate/adopt/import. Those
   * operations hold the busy flag precisely because, from the outside, the
   * agent looks like an ordinary stopped one — and acting on that look is how
   * a mid-migration Start ends with two runtimes polling one bot token.
   */
  /**
   * A long operation on disk (operations.ts) — running, interrupted by a
   * restart, or held for the owner's choice — refuses with its own line.
   * Also what a change only a new container picks up asks first: such an
   * operation stops the agent for its own reasons and decides what runs next.
   * Undone, it starts the old container, and that may still hold a bot given
   * back meanwhile; a change saved under it would be promised for a next start
   * it never gets (rebuildOrOwe).
   */
  const operationRefuses = (agent: Agent, reply: any): boolean => {
    const onDisk = operationRefusal(store, agent.id);
    if (!onDisk) return false;
    reply.code(409).send({ error: onDisk, operation: store.activeOperationFor(agent.id)?.id });
    return true;
  };
  const busyNow = (agent: Agent, reply: any, opts: { deleting?: boolean } = {}): boolean => {
    // A Delete goes through an adopt held on a torn copy: it removes the files
    // the hold waits to put right, and records.remove ends the hold (HB-0980).
    if (!(opts.deleting && holdDeleteEnds(store, agent.id)) && operationRefuses(agent, reply)) return true;
    // An archive's checkpoint turn runs before the busy flag is taken: a
    // Rebuild or a move started under it would be cut off by the stop.
    if (!isBusy(agent.id) && !isArchiving(agent.id)) return false;
    reply.code(409).send({ error: 'Another operation is already running on this agent.' });
    return true;
  };

  /**
   * May this caller name arbitrary HOST paths (inspect / adopt / sharedPaths /
   * fromWorkspace)? Only the account that owns the local host — i.e. the
   * person who set the machine up. Those routes mount or read host
   * directories at uid 1000; the `sharePathProblem` blocklist protects a few
   * well-known secrets but is owner-blind, so on a shared box a second
   * account could otherwise mount another user's home and read it through
   * their own agent. Refuse rather than widen the blocklist.
   */
  const ownsLocalHost = (req: FastifyRequest): boolean => {
    const ownerId = ownerIdOf(req);
    const local = store.listHosts(ownerId).find((h) => h.kind === 'local');
    return !!local && local.ownerId === ownerId;
  };
  /** Password accounts sign in here: accounts mode, or Google sign-in with them added (docs/identity.md). */
  const localAccountsOn = (): boolean =>
    deps.authMode === 'accounts' || (deps.authMode === 'identity' && process.env.HATCHABOT_LOCAL_ACCOUNTS === '1');
  /**
   * Agent caps, checked by EVERY path that creates or revives a live agent
   * (create, import, restore from file, clone, derive, accept a shared
   * template, un-archive). ARCHIVED agents don't count — they hold no bot,
   * container or port. Unset caps = no limit.
   */
  // Agents being made right now hold a place each (capacity.ts).
  // One request at a time for a key (an agent's un-archive, an owner's
  // manager setup): a double-click ran both, and each made its own (night review).
  // Held until the request's handler answers, however long its work takes
  // (HB-0630): its answer is the end of its work, whether or not its caller
  // is still there to read it. Let go at onSend, which comes with every
  // answer: onResponse never comes for a caller that hung up (the answer is
  // never finished), so holds let go there lasted ten more minutes after
  // the work, and a lapse at ten minutes let a second request in while a
  // slow first one (a big import, a clone's export) still worked.
  const onceHeld = new Map<string, string>(); // key → request
  const holdOnce = (req: FastifyRequest, key: string): boolean => {
    const holder = onceHeld.get(key);
    if (holder !== undefined && holder !== req.id) return false;
    onceHeld.set(key, req.id);
    return true;
  };
  // The agent caps' places (`capHeld`, `capHolds`) are the agent lifecycle
  // service's (`lifecycle.capacity`, built below; read when a request runs).
  const releaseHolds = (reqId: string): void => {
    for (const [k, id] of onceHeld) if (id === reqId) onceHeld.delete(k);
    lifecycle.capacity.release(reqId);
  };
  app.addHook('onSend', async (req, _reply, payload) => { releaseHolds(req.id); return payload; });
  const capProblem = (req: FastifyRequest): string | undefined =>
    lifecycle.capacity.claim(req.id, ownerIdOf(req), () => ownsLocalHost(req));
  // Its row counts itself from the turn it is made (HB-1121).
  const capRowMade = (req: FastifyRequest): void => { lifecycle.capacity.release(req.id); };


  // Remote runner providers (Cluster mode) are built per host from its stored
  // Docker endpoint and kept for the process — this cache is that store.
  const remoteProviderCache = deps.remoteProviders ?? new Map<string, RuntimeProvider>();
  /** Runners whose removal is under way: no agent is created, imported or moved onto one (HB-0275). */
  const removingHosts = new Set<string>();
  const providerFor = (hostId: string): RuntimeProvider => {
    const host = store.getHost(hostId);
    if (!host) throw new Error(`No such host: ${hostId}`);
    return resolveProvider(host, deps.providers, remoteProviderCache, {
      image: process.env.HATCHABOT_IMAGE,
      prefix: process.env.HATCHABOT_PREFIX,
    });
  };

  // The agent-to-agent guards' limits (the consult service's, below) and an
  // owner's ask's time limit (the memory service's, and web chat's).
  const envNum = (name: string, dflt: number): number => {
    const n = Number(process.env[name]); return Number.isFinite(n) && process.env[name] !== '' && process.env[name] !== undefined ? n : dflt;
  };
  /** Web chat turns in flight, `${agentId} ${userId}` (api/chat/webChat.ts): one per person at a time. */
  const webChatInFlight = new Set<string>();
  const A2A_MAX_CONCURRENT = Math.max(1, envNum('HATCHABOT_A2A_MAX_CONCURRENT', 8));
  const A2A_PER_HOUR = Math.max(1, envNum('HATCHABOT_A2A_PER_HOUR', 60));
  const A2A_TIMEOUT_MS = Math.max(10_000, envNum('HATCHABOT_A2A_TIMEOUT_MS', 120_000));
  /** An owner's `ask` can be real work (research, a report): longer than a
   *  consult, and under the 300 s a client's fetch waits for response headers. */
  const ASK_TIMEOUT_MS = Math.max(10_000, envNum('HATCHABOT_ASK_TIMEOUT_MS', 280_000));
  // ---- the agent lifecycle (HB-0808 step 11) -------------------------------
  // The setup and rebuild queue, the machine's own rebuilds, Start, Stop,
  // sleep and wake, and the owner's choice for a held operation: the agent
  // lifecycle service (orchestrator/lifecycle/agentLifecycle.ts) owns the
  // queue (`inflight`, the rebuild slots) and the sweep's timer. Built before
  // the other services, which are told of the queue as functions. Its routes
  // are in lifecycleRoutes.ts; the routes still here reach it through these
  // names, and the context hands the queue's on.
  const lifecycle = createAgentLifecycle({
    store, secrets, providerFor, trace,
    channel: deps.channel,
    // Defined further down (consts in this scope); read only when a setup, a
    // rebuild, a start, a sweep or a request runs.
    embedder: () => embedderForProvision,
    runPendingApp: (agentId) => apps.installed.runPendingApp(agentId),
    priorChatIdsOf: (username) => channels.bots.priorChatIdsOf(username),
    browsersNow: (agentId) => consoles.browsers.browsersNow(agentId),
    logError: (detail, msg) => { app.log.error(detail, msg); },
    peersNotInstalled,
    inLimitsTurn: (agentId, fn) => settings.limits.inLimitsTurn(agentId, fn),
    applyCurrentLimits: (agentId) => settings.limits.applyCurrentLimits(agentId),
    tellMemoryBudget: (agentId) => settings.limits.tellMemoryBudget(agentId),
    clearPinsWhenUp: (a) => clearPinsWhenUp(a),
    disownPauseOnStop: (agentId) => usage.budgets.disownPauseOnStop(agentId),
    hibernateDeps: () => hibernateDeps,
    switchPendingFor: (a) => switchPendingFor(a),
    activityEvidence: (a) => activityEvidence(a),
    recoverOperation: (opId, action) => recoverOperation(opsCtx, opId, action),
    // Create, archive, unarchive and delete (agentRecords.ts).
    hostGoing: (hostId) => (removingHosts.has(hostId) ? HOST_GOING : undefined),
    connectorFor: (kind) => channels.bots.connectorFor(kind),
    dmChannelPeople: (agent, kind, secretRef, text) => channels.bots.dmChannelPeople(agent, kind, secretRef, text),
    parkArchivedChannels: (agent) => parkArchivedChannels(agent),
    forgetSettings: (agentId) => settings.forgetAgent(agentId),
    // Defined further down (a const in this scope); called only by a delete or an archive.
    forgetConversations: (agentId) => conversations.forgetAgent(agentId),
    // The agent list (agentList.ts).
    publicAgent: (agent, extra) => publicAgent(agent, extra),
    noteSelfRestart: (a, running) => noteSelfRestart(a, running),
    swapViewOf: (a, running) => swapViewOf(a, running),
    defaultAliasesFor: (hostId) => defaultAliasesFor(hostId),
    lastActiveFor: (a) => lastActiveFor(a),
    unreadFor: (a, ownerId) => unreadFor(a, ownerId),
    botDisplayNameFor: (agentId, secretRef) => channels.bots.botDisplayNameFor(agentId, secretRef),
    warmLocalModels: (baseUrl) => warmLocalModels(baseUrl),
    peakSinceClear: (a, kernelPeak, current) => machines.resources.peakSinceClear(a, kernelPeak, current),
    capHitsSince: (a, raw, startedAt) => machines.resources.capHitsSince(a, raw, startedAt),
    machineBudgetView: (now) => usage.budgets.machineBudgetView(now),
    warn: (detail, msg) => { app.log.warn(detail, msg); },
    // Off in tests, as before.
    sweepEveryMs: !process.env.VITEST && process.env.NODE_ENV !== 'test' ? Number(process.env.HATCHABOT_REBUILD_SWEEP_MS) || 5 * 60_000 : 0,
  });
  const { kickProvision, provisionWhenFree, kickRebuild, oweRebuild, rebuildOrOwe, inFlight, isInFlight } = lifecycle.queue;
  const { rebuildNeedOf } = lifecycle.rebuilds;

  // ---- an agent's files and its core-files turn (HB-0808 step 13) ----------
  // The agent files service (orchestrator/files/files.ts) owns the agent's
  // core-files turn, the one queue its AGENTS.md writers share too
  // (`agentsMdTurns`): built here, before the services that take it. Every
  // caller reaches the same queue through these names (the settings, apps
  // and backups services, the held syncs, setup values, a pushed definition,
  // a merged proposal, and the skill files and uploads through the service).
  const files = createFiles({
    store, providerFor, trace, agentGone,
    // The agent lifecycle service's marker (above; read when an upload's turn comes).
    isArchiving: (agentId) => isArchiving(agentId),
    fileMaxBytes: FILE_MAX_BYTES,
  });
  const { withAgentsMdTurn, withCoreFilesTurn, freshRunning } = files.turns;

  /**
   * The model-change ledger (modelLedger.ts): who made a change and how. A
   * card confirmed in "Alerts" executes with the header naming it (set by
   * the confirmer, mgmtChat.ts); the card itself, read here and owner-scoped,
   * says whether the owner's chat, their management agent or Hatchabot's
   * quality guard prepared it, and why. Otherwise the owner did it: in the
   * app (a session cookie) or through the API (a bearer token: the CLI, a
   * script), with an optional `why` in the body: of any type, kept only when
   * it is text (HB-0814), and a body that is not an object is without one.
   */
  const LedgerWhy = z.object({ why: z.unknown().optional() });
  const ledgerMeta = (req: FastifyRequest, source: string): ChangeMeta => {
    const pid = req.headers['x-hatchabot-proposal'];
    if (typeof pid === 'string' && pid) {
      const rec = store.getMgmtProposal<PendingConfirm>(pid);
      if (rec && rec.ownerId === ownerIdOf(req)) {
        return {
          by: rec.source === 'agent' ? 'agent' : rec.source === 'guard' ? 'hatchabot' : 'owner',
          via: rec.source === 'guard' ? 'guard' : 'proposal', source, proposalId: pid,
          why: rec.note ?? (rec.source === 'guard' ? `Quality guard: switch back (${rec.summary.split('\n').find((l) => l.startsWith('Worse:'))?.slice(7).replace(/\.$/, '') ?? 'worse after the switch'})` : undefined),
        };
      }
    }
    const auth = req.headers.authorization;
    const why = LedgerWhy.safeParse(req.body).data?.why;
    // A click on a Recommended item (recommendations.ts): the owner's own
    // change, through the same route, marked so the ledger says where from.
    const rec = req.headers['x-hatchabot-recommendation'];
    if (typeof rec === 'string' && rec) return { by: 'owner', via: 'recommendation', source, why: typeof why === 'string' && why.trim() ? why : `From Recommended (${rec.slice(0, 120)})` };
    return { by: 'owner', via: typeof auth === 'string' && /^bearer\s/i.test(auth) ? 'api' : 'app', source, ...(typeof why === 'string' && why.trim() ? { why } : {}) };
  };
  /** Record each agent whose model moved since `before` (snapshotModels). Never fails the change it follows. */
  const recordLedger = (req: FastifyRequest, source: string, before: Map<string, string | undefined>): void => {
    try {
      for (const row of recordChanges(store, before, ledgerMeta(req, source))) {
        trace(row.agentId)('model.changed', { from: row.from ?? null, to: row.to, by: row.by, via: row.via, source: row.source });
        // A context cap follows the model: written for the new one at once on a running agent.
        const a = store.getContextCap(row.agentId) ? store.getAgent(row.agentId) : undefined;
        if (a?.state === 'RUNNING' && a.runtimeRef) void syncContextCap({ store, provider: providerFor(a.hostId), log: (e, d) => trace(a.id)(e, d) }, a, a.runtimeRef).catch(() => undefined);
      }
    } catch (err) { app.log.warn({ err: String(err) }, 'model.ledger_failed'); }
  };
  /** Snapshot these agents' models, run the change, and record each agent whose model moved. */
  const ledgered = async <T>(req: FastifyRequest, source: string, agentIds: Iterable<string>, change: () => T | Promise<T>): Promise<T> => {
    const before = snapshotModels(store, agentIds);
    const out = await change();
    recordLedger(req, source, before);
    return out;
  };

  // ---- classes, models and limits (HB-0807) ---------------------------------
  // What each agent runs on, and how a change of it reaches the agent: the
  // agent settings service (orchestrator/lifecycle/agentSettings.ts) owns the
  // queues, the holds and the turns. Its routes are in classRoutes.ts and
  // modelRoutes.ts; the routes still here reach it through these names.
  const settings = createAgentSettings({
    store, providerFor, trace, agentGone, withAgentsMdTurn,
    warn: (detail, event) => { app.log.warn(detail, event); },
    inFlight,
    // A budget's switch to a cheaper model the boot's write could not put on
    // (HB-1404): the usage service, built further down; called only at resume.
    owedRefused: (id, ask, how) => usage.budgets.cheaperRefused(id, ask, how),
  });
  const { applyModelToRuntime, imagePinCheck, subscriptionRuntimeProblem, finalModelCheck } = settings.models;
  const { inLimitsTurn, applyCurrentLimits, tellMemoryBudget, setMemoryCap, setSwapAllowance } = settings.limits;
  const { detachClassIfDrifted } = settings.classes;
  const { withSourceHold } = settings.sourceHolds;

  // ---- AI sources (HB-0808) -------------------------------------------------
  // Agents moved onto a source in bulk, a default model applied to the agents
  // on one, and what a source can switch between: the AI sources service
  // (orchestrator/sources/aiSources.ts). Its routes are in aiSourceRoutes.ts.
  const sources = createAiSources({
    store, providerFor, agentGone, kickRebuild, oweRebuild,
    // A recovery chained after a switch's rebuild takes its slot in
    // `recovering`, the memory service's (built further down; called only by
    // a request): one Set for Recover context and the switch.
    recoverAfterRebuild: (id) => memory.history.afterRebuild(id),
    secretOf: (ref) => secrets.get(ref),
    models: settings.models,
    detachClassIfDrifted, withSourceHold,
  });

  // ---- channels and pairing (HB-0808) ----------------------------------------
  // Telegram, Discord and Slack: an agent's bots, and the people knocking on
  // them. The channels service (orchestrator/channels/channels.ts) owns the
  // bot-name and knock caches and the timers (the bot names owed, the pairing
  // sweep). Its routes are in channelRoutes.ts; the routes still here reach
  // it through these names.
  const offInTests = !!process.env.VITEST || process.env.NODE_ENV === 'test';
  const channels = createChannels({
    store, secrets, providerFor, trace,
    channel: deps.channel,
    connectors: deps.connectors,
    // A rebuild owed on the record of an agent stopped for a bot handover (chatBots.ts owedAfterHandover,
    // HB-0830). Not said on its timeline: the handover's own lines say what happened.
    oweRebuild: (agentId) => { oweRebuild(agentId, () => {}); },
    nameRetryMs: offInTests ? 0 : 10 * 60_000,
    ...(deps.oauthFetch ? { telegramFetch: deps.oauthFetch } : {}),
    // Told on the owner's phone (opsPush, below): only the sweep pushes, and it starts a minute after this.
    opsPush: { waiting: (ownerId, headline, detail, opts) => opsPush.waiting(ownerId, headline, detail, opts) },
    knockCacheMs: process.env.VITEST ? 0 : Number(process.env.HATCHABOT_KNOCK_CACHE_MS ?? 30_000),
    sweepEveryMs: offInTests ? 0 : Number(process.env.HATCHABOT_PAIRING_SWEEP_MS ?? 5 * 60_000),
  });
  const { connectorFor, renameChannelBot, dmChannelPeople, forgetBotName, priorChatIdsOf } = channels.bots;

  // ---- backups, snapshots and restores (HB-0808) ----------------------------
  // An agent's snapshots, the backup sets and a restore from one, recovery
  // readiness and the restore drills: the backups service
  // (orchestrator/backups/backups.ts) owns the drill schedule's timer. Its
  // routes are in backupRoutes.ts.
  const backups = createBackups({
    store, secrets, providerFor, trace, agentGone, withCoreFilesTurn,
    channel: deps.channel,
    // Defined further down (consts in this scope); read only when a restore runs.
    embedder: () => embedderForProvision,
    afterStart: (agentId) => startHooksFor(agentId),
    inFlight: isInFlight,
    isArchiving,
    warn: (detail, event) => { app.log.warn(detail, event); },
    drillSweepEveryMs: offInTests ? 0 : 15 * 60_000,
  });

  // ---- apps in agents and data sources (HB-0808) ---------------------------
  // The apps installed in agents (and the install that waits for a new
  // agent's setup), and their git repos and folders: the apps and data
  // sources service (orchestrator/apps/appsAndSources.ts) owns their locks.
  // Its routes are in appRoutes.ts. Setup that finishes (kickProvision) and
  // the boot resume run a waiting install; the boot resume settles an app
  // operation with `appDeps`.
  const apps = createAppsAndSources({
    store, secrets, providerFor, trace, agentGone, withAgentsMdTurn,
    channel: deps.channel,
    appGit: deps.appGit ?? hostGit,
    appCacheDir: join(dirname(process.env.HATCHABOT_DB ?? defaultDbPath()), 'app-sources'),
    warn: (detail, event) => { app.log.warn(detail, event); },
    // Defined further down (a const in this scope); called only when a repo is removed.
    syncDocsHeld: (a, provider) => syncDocsHeld(a, provider),
  });
  const { runPendingApp, appDeps } = apps.installed;

  // ---- the console and the browser panel (HB-0808) --------------------------
  // Who may reach which agent's OpenClaw console and what ends it, each
  // agent's own browser, and "Sign in to a site": the service
  // (orchestrator/console/consoles.ts) owns the console handshakes and
  // sockets, the open panels and the three sweeps. Its routes are in
  // consoleRoutes.ts and browserRoutes.ts; the routes still here reach it
  // through these names (members and web chat bring a gateway in step; a
  // start, wake or rebuild sweeps the agent's browser).
  const consoles = createConsoles({
    store, providerFor, trace,
    // Defined further down (a const in this scope); called only when a console wakes a sleeping agent.
    ensureAwake: (agent, why) => ensureAwake(agent, why),
    // Read at each call: tests and the sign-in set these on the app after this runs.
    cookieSignIn: () => !!app.principalFromCookieHeader,
    signedInAs: (cookie, https) => app.principalFromCookieHeader?.(cookie, https),
    publicGate: () => app.publicAccess,
    sessionOf: (cookie, https) => readSessionCookie(cookie, https)?.value,
    warn: (detail, event) => { app.log.warn(detail, event); },
    browserSweepEveryMs: offInTests ? 0 : Number(process.env.HATCHABOT_BROWSER_SWEEP_MS) || 60_000,
  });
  const { consoleAccess } = consoles.gateway;
  const { browsersNow } = consoles.browsers;
  const { watchConsoleSession, watchConsoleHttp } = consoleSessionWatch(app, consoles.gateway);

  // ---- machines, runners and images (HB-0808) ------------------------------
  // This machine and its runners, Install image, live CPU and memory, and the
  // runtime images: the machines service (orchestrator/machines/machines.ts)
  // owns the image copies, the stats cache, the builds' state and the base
  // build's ceiling. Its routes are in machineRoutes.ts and imageRoutes.ts.
  // An agent's page reads its peak and cap hits from it.
  // The fleet's default runtime image (the embedding service runs it too).
  const DEFAULT_BASE = process.env.HATCHABOT_IMAGE ?? 'hatchabot-runtime:latest';
  // Build logs live beside the database, not in the checkout (prod checkouts have no data/).
  const buildDataDir = dirname(resolve(process.env.HATCHABOT_DB ?? defaultDbPath()));
  const machines = createMachines({
    store, providerFor, trace,
    // Defined further down (consts in this scope); called only by a request.
    disownPauseOnStop: (agentId) => disownPauseOnStop(agentId),
    beginRemoval: (hostId) => { if (removingHosts.has(hostId)) return false; removingHosts.add(hostId); return true; },
    endRemoval: (hostId) => { removingHosts.delete(hostId); },
    embedderOf: (hostId) => memorySearch.madeFor(hostId) ?? embedderFor(hostId),
    forgetEmbedder: (hostId) => { memorySearch.forget(hostId); },
    // Each one's console tunnels end with it: they held a connection to the removed runner until Hatchabot stopped (HB-1030).
    forgetProviders: (hostId) => {
      for (const [k, p] of [...remoteProviderCache]) if (k.startsWith(`${hostId}:`)) { p.dispose?.(); remoteProviderCache.delete(k); }
    },
    defaultBase: DEFAULT_BASE,
    dataDir: buildDataDir,
    notify: (ownerId, body) => opsNotifier.notify(ownerId, body),
    log: { info: (detail, msg) => { app.log.info(detail, msg); }, error: (detail, msg) => { app.log.error(detail, msg); } },
    buildImage: deps.buildImage,
    buildBase: deps.buildBase,
    openclawDistTags: deps.openclawDistTags,
    // Defined further down; asked only as a default base build ends.
    sharedMemorySearchOn: () => memorySearch.local.enabled || !!memorySearch.local.external,
  });

  // ---- members, invites and web chat (HB-0808) -----------------------------
  // Who may use an agent besides its owner, and how they come to: invites and
  // joining by one, the members, sharing for web chat. The service
  // (orchestrator/members/membersAndInvites.ts) has no state and no timer; it
  // keeps the gateway's list of people in step (consoleAccess, above) and
  // shuts the door through the channels service. Its routes are in
  // memberRoutes.ts.
  const members = createMembersAndInvites({
    store, secrets, providerFor, trace,
    authMode: () => deps.authMode,
    localAccountsOn,
    consoleAccess,
    restDoor: async (agent) => { await channels.knocks.restDoor(agent); },
    forgetKnocks: (agentId) => channels.knocks.forgetKnocks(agentId),
    // Told on the owner's phone (opsPush, defined further down: called only once an invitee's window has lapsed).
    opsPush: { waiting: (ownerId, headline, detail) => opsPush.waiting(ownerId, headline, detail) },
    // A join to a sleeping agent wakes it (ensureAwake, defined further down: called only after a join).
    wake: (agent, why) => ensureAwake(agent, why),
    telegramFetch: (url, init) => (deps.oauthFetch ?? fetch)(url, init),
    logError: (detail, msg) => { app.log.error(detail, msg); },
  });

  // ---- usage, costs and budgets (HB-0808) ----------------------------------
  // The usage pass and what follows it (the model-change guard, the token
  // steward, the spike warnings, the budget pass), a paused agent's replies,
  // the cost badges and Recommended: the usage and budgets service
  // (orchestrator/usage/usageAndBudgets.ts) owns the passes, the cost cache
  // and the three timers. Its routes are in usageRoutes.ts. A Stop by a
  // person (and a runner's removal, above) disowns a budget's pause through it,
  // and the agent list shows the machine's budget on the manager's tile.
  const usage = createUsageAndBudgets({
    store, secrets, providerFor, trace,
    // Defined further down (consts in this scope); called only by a pass or a request.
    tell: (ownerId, agent, text) => tellUsageSpike(ownerId, agent, text),
    chatReaches: (ownerId, agentId) => ownerChatRoutes(ownerChat, ownerId, agentId).length > 0,
    push: (ownerId, headline, detail) => void opsPush.waiting(ownerId, headline, detail),
    startStopped: (agent) => lifecycle.power.startStopped(agent),
    secretOf: (ref) => secrets.get(ref),
    inFlight: isInFlight,
    applyModelToRuntime, subscriptionRuntimeProblem,
    log: { info: (detail, msg) => { app.log.info(detail, msg); }, warn: (detail, msg) => { app.log.warn(detail, msg); } },
    warn: (detail, msg) => { app.log.warn(detail, msg); },
    // Off in tests, as before; HATCHABOT_USAGE_SAMPLE_MS=0 turns the pass off.
    sampleEveryMs: process.env.VITEST ? 0 : Number(process.env.HATCHABOT_USAGE_SAMPLE_MS ?? 600_000),
    pausedReplyEveryMs: process.env.VITEST ? 0 : 60_000,
  });
  const { disownPauseOnStop } = usage.budgets;

  // ---- scheduled tasks (HB-0808) --------------------------------------------
  // An agent's tasks, the passes that point them where their results go and
  // tell the owner of a finished run they asked about, and the permission to
  // run event-triggered tasks: the schedules service
  // (orchestrator/schedules/schedules.ts) owns the quick pass's memory, the
  // permission's queue and the passes' three timers. Its routes are in
  // scheduleRoutes.ts; PATCH /v1/agents/:id writes the permission through it.
  const schedules = createSchedules({
    store, providerFor, trace, agentGone, oweRebuild,
    // Defined further down (consts in this scope); called only by a request or a pass.
    noteReach: (ownerId) => ownerNoteReach(ownerId),
    taskNotePush: { waiting: (ownerId, headline, detail, opts) => taskNotePush.waiting(ownerId, headline, detail, opts) },
    appUrl: () => appUrlFor(),
    applyFilesCap: (a, kind) => applyFilesCap(a, kind),
    // The moves, import and export service's, below (a const in this scope); called only by a pass.
    finishDeferredAdopts: () => transfers.adopts.finishDeferredAdopts(),
    warn: (detail, msg) => { app.log.warn(detail, msg); },
    sweepsOn: !offInTests,
  });
  const { applyCronTriggers } = schedules.triggers;

  // ---- Google connections and what each agent can reach (HB-0808) ----------
  // The installation's OAuth client and the consent round-trip, the vault and
  // which agent holds which account, a new client secret delivered (and the
  // pass every ten minutes for what is still owed), and Verify now: the
  // Google connections and access service
  // (orchestrator/google/connectionsAndAccess.ts) owns the consent states,
  // the deletes under way, the secret's back-offs, the verifications under
  // way and the pass's timer. Its routes are in googleRoutes.ts. A start or
  // wake syncs an agent's accounts and looks at what it can reach through
  // `connSyncDeps`.
  const google = createConnectionsAndAccess({
    store, secrets, providerFor, trace,
    oauthFetch: deps.oauthFetch ?? fetch,
    // Defined further down (a const in this scope); called only after an attach, a detach or a first import.
    syncDocsHeld: (agent, provider) => syncDocsHeld(agent, provider),
    warn: (detail, msg) => { app.log.warn(detail, msg); },
    // Off in tests, as before.
    sweepEveryMs: !process.env.VITEST && process.env.NODE_ENV !== 'test' ? 10 * 60_000 : 0,
    // The owner's own chat (`ownerChat`, defined further down; read when a pass gives up on a revoke).
    tellOwner: (ownerId, text) => tellOwner(ownerChat, ownerId, '', text),
  });
  const { connSyncDeps } = google;

  // ---- the Hatchabot agent (HB-0808) ----------------------------------------
  // The account's management agent: made once, a turn in its own
  // conversation and the notes posted there, asking it which agents to add,
  // who may use its door, the operator's profile pushed into the running
  // agents, and the check of its tool lockdown every ten minutes: the
  // Hatchabot agent service (orchestrator/ops/hatchabotAgent.ts) owns the
  // doormen's addresses, the profile pushes' chain and the check's timer. Its
  // routes are in opsAgentRoutes.ts; the door (registerMgmtChat), a build's
  // end, a confirmed card and an adopt reach it through these names.
  const hatchabotAgent = createHatchabotAgent({
    store, providerFor, trace,
    // Defined further down (consts in this scope); called only by a turn, a request or a push.
    forgetSessions: (agentId) => { conversations.forget(agentId); },
    openDoor: () => ensureOpsServer(),
    unjailedOk: () => process.env.NODE_ENV === 'test' || !!deps.allowUnjailedOps,
    defaultBase: DEFAULT_BASE,
    imageTagOk: (tag) => IMAGE_TAG_RE.test(tag),
    kickProvision: (agentId) => kickProvision(agentId),
    syncDocsHeld: (a) => syncDocsHeld(a),
    log: { info: (detail, msg) => { app.log.info(detail, msg); }, warn: (detail, msg) => { app.log.warn(detail, msg); } },
    // Not under NODE_ENV=test, as before.
    driftEveryMs: process.env.NODE_ENV !== 'test' ? Number(process.env.HATCHABOT_OPS_DRIFT_MS) || 10 * 60_000 : 0,
  });
  const { notifier: opsNotifier, peerOk: opsPeerOk } = hatchabotAgent;

  // ---- Report a problem (HB-0808, docs/field-reports.md) --------------------
  // The facts a report carries, what a public report must not carry, the
  // drafts, the known problems and the installed source: the Report a
  // problem service (orchestrator/diagnostics/problemReports.ts). No state
  // and no timer. Its routes are in problemReportRoutes.ts.
  const problemReports = createProblemReports({
    store, secrets, providerFor,
    appDir: resolve(import.meta.dirname, '..', '..'),
    version: `v${String(deps.appVersion ?? APP_VERSION).replace(/^v/, '')}`,
    reportDoctor: deps.reportDoctor,
    addressHosts: () => {
      const hosts: string[] = [];
      for (const u of [deps.publicUrl, publicConfig().url]) { const h = hostOf(u); if (h) hosts.push(h); }
      return hosts;
    },
  });

  // ---- health, logs and events (HB-0808) -------------------------------------
  // An agent's live health, its event trail and Activity, the security
  // posture, the limits check and each agent's storage: the health service
  // (orchestrator/health/healthChecks.ts) owns what the limits check has
  // said and its two timers. Its routes are in healthRoutes.ts; a start or
  // wake checks that agent's limits through `limitsCheck`.
  const health = createHealthChecks({
    store, providerFor, trace, inLimitsTurn,
    inFlight: isInFlight,
    limitsCheckFile: process.env.VITEST ? undefined : join(dirname(resolve(process.env.HATCHABOT_DB ?? defaultDbPath())), 'limits-check.json'),
    warn: (detail, msg) => { app.log.warn(detail, msg); },
    // Off in tests, as before: the first check 45 s after the start, then every ten minutes.
    limitsTimers: offInTests ? undefined : {
      bootMs: Number(process.env.HATCHABOT_SWAP_BOOT_MS) || 45_000,
      everyMs: Number(process.env.HATCHABOT_SWAP_PROBE_MS) || 10 * 60_000,
    },
  });
  const { limitsCheck } = health;

  // ---- moves, import and export (HB-0808 step 12) ---------------------------
  // An agent moved to another machine or another Hatchabot, the whole agent
  // as a file and back, a template and back, clone and derive, sharing in
  // the app, and what was made outside Hatchabot brought in: the moves,
  // import and export service (orchestrator/transfer/transfers.ts) owns the
  // deferred adopts' memory; no timer. Its routes are in transferRoutes.ts
  // and adoptRoutes.ts; the schedules' quick pass gives the deferred adopts
  // their turn.
  const transfers = createTransfers({
    store, secrets, providerFor, trace, agentGone, kickProvision,
    channel: deps.channel,
    // Defined further down (a const in this scope); read when a move or an import runs.
    embedder: () => embedderForProvision,
    isInFlight,
    peerFetch: deps.peerFetch,
    verifyImportedToken: deps.verifyImportedToken,
    forgetAgent: (agentId) => settings.forgetAgent(agentId),
    notify: (ownerId, body) => opsNotifier.notify(ownerId, body),
    logError: (detail, msg) => { app.log.error(detail, msg); },
    withCoreFilesTurn,
  });

  // ---- keys, web search and the machine's defaults (HB-0808 step 15) --------
  // The fleet's Gemini and Brave keys, which search the fleet uses (the one
  // search watch and its ten-minute tick) and Defaults for this machine: the
  // machine settings service (orchestrator/settings/machineSettings.ts). Its
  // routes are in machineSettingsRoutes.ts; the manager's own search
  // (registerMgmtChat's opsWeb, below) reads the watch.
  const machineSettings = createMachineSettings({
    store, secrets, providerFor, trace, isBusy, inLimitsTurn,
    notify: (headline, detail) => {
      const owner = store.listAllLocalHostOwners()[0];
      if (owner) void opsPush.waiting(owner, headline, detail, { note: true });
    },
    info: (event, detail) => app.log.info(detail, event),
    warn: (detail, msg) => app.log.warn(detail, msg),
    ...(deps.searchFetch ? { searchFetch: deps.searchFetch } : {}),
    ...(Number(process.env.HATCHABOT_SEARCH_CHECK_MS) > 0 ? { checkEveryMs: Number(process.env.HATCHABOT_SEARCH_CHECK_MS) } : {}),
    // Not under VITEST, as before (NODE_ENV=test alone keeps it).
    tickEveryMs: process.env.VITEST ? 0 : 10 * 60_000,
    recheckOn: () => !process.env.VITEST,
    // Defined further down (consts in this scope); read when a default is set.
    syncDocsHeld: (a) => syncDocsHeld(a),
    applyFilesCap: (a, kind) => applyFilesCap(a, kind),
    embedder: () => embedder,
  });
  const { watch: searchWatch } = machineSettings.search;

  // ---- long changes in the background (operations.ts, phase 3) -------------
  // A move, a move to another Hatchabot, an import of a full copy, a restore
  // from a backup or a snapshot answer 202 { operation } as soon as they are
  // validated and their operation has begun; the work goes on here, and the
  // page and the CLI follow GET /v1/operations/:id. `?wait=1` keeps the old
  // answer (sent when it is over) for older CLIs and scripts: nothing new
  // uses it.
  const waitAsked = (req: FastifyRequest): boolean =>
    ['1', 'true', 'yes'].includes(String((req.query as { wait?: unknown } | undefined)?.wait ?? ''));
  /** The 202: the operation as the page shows it, and its agent when there is one. */
  const accepted = (reply: FastifyReply, opId: string) => {
    const op = store.getOperation(opId);
    const agent = op?.agentId ? store.getAgent(op.agentId) : undefined;
    return reply.code(202).send({ operation: publicOperation(op), ...(agent ? { agent: publicAgent(agent) } : {}) });
  };
  /** What a background operation threw: its outcome is on its row; the journal gets the rest. */
  const backgroundError = (err: unknown, opId: string) => {
    app.log.warn({ op: opId, err: String(err instanceof Error ? err.message : err).slice(0, 300) }, 'operation.background_ended');
  };

  // ---- curated skills and browser voice (HB-0808 step 13) ------------------
  // The skills service (orchestrator/skills/skills.ts) owns the practice
  // cooldown and the coalesced status reads; a skill file changed or
  // practised takes the agent's core-files turn (`files`, above). The voice
  // service (orchestrator/voice/agentVoice.ts) has no state. Their routes are
  // in skillRoutes.ts and voiceRoutes.ts.
  const skills = createSkills({ store, providerFor, trace, agentGone, isArchiving, oweRebuild, withCoreFilesTurn });
  const voice = createAgentVoice({ store, providerFor, trace, agentGone, isArchiving });
  const conversations = createConversations({ store, providerFor });
  const { readSessions, newestActivity, lastActiveFor, activityEvidence, unreadFor } = conversations;
  const memorySearch = createMemorySearch({
    store, secrets, providerFor, trace, dataDir: buildDataDir, defaultBase: DEFAULT_BASE,
    // Defined further down (consts in this scope); called only by a request or a timer.
    switchPendingFor: (a) => switchPendingFor(a),
    isInFlight, lastActiveFor: (a) => lastActiveFor(a), kickRebuild,
    warn: (detail, msg) => app.log.warn(detail, msg),
  });
  const { local: embedder, serviceFor: embedderFor, forProvision: embedderForProvision } = memorySearch;
  // ---- the agent-to-agent consult, and an agent's memory (HB-0808 step 13) --
  // The consult service (orchestrator/consult/consults.ts) owns the one turn
  // per agent (`a2aInFlight`: a consult, an ask, a checkpoint, a
  // distillation; the idle sweep reads it), the caller holds, the per-owner
  // count and the call token mints. The memory service
  // (orchestrator/memory/agentMemory.ts) takes that turn, and owns
  // `recovering` (Recover context's slots, which the AI sources service
  // reserves too).
  const consults = createConsults({
    store, secrets, providerFor, trace, agentGone,
    warn: (detail, msg) => app.log.warn(detail, msg),
    // Defined further down (a const in this scope); called only by a request.
    ensureAwake: (agent, why) => ensureAwake(agent, why),
    forgetSessions: (id) => conversations.forget(id),
    unreadFor,
    maxConcurrent: A2A_MAX_CONCURRENT, perHour: A2A_PER_HOUR, timeoutMs: A2A_TIMEOUT_MS,
    // Defined just below (a const in this scope); called only by a turn.
    alsoAnswering: (id) => memory.history.answering(id),
  });
  const memory = createAgentMemory({
    store, secrets, providerFor, trace,
    turns: consults.turns,
    // Defined further down (consts in this scope); called only by a request.
    ensureAwake: (agent, why) => ensureAwake(agent, why),
    tell: (ownerId, agent, text) => tellUsageSpike(ownerId, agent, text),
    forgetSessions: (id) => conversations.forget(id),
    inFlight,
    withCoreFilesTurn, freshRunning,
    askTimeoutMs: ASK_TIMEOUT_MS,
  });
  // ---- an agent's definition and its secrets (HB-0808 step 15, part C) -----
  // The definition service (orchestrator/definition/agentDefinition.ts):
  // setup values and a master's push, in each agent's core-files turn. The
  // agent secrets service (orchestrator/agentSecrets/agentSecrets.ts): its
  // environment values and its parked setup's bot token. Neither has state.
  const definition = createAgentDefinition({
    store, providerFor, trace, withCoreFilesTurn, freshRunning,
    // Defined further down (a const in this scope); called only by a request.
    syncDocsHeld: (a) => syncDocsHeld(a),
  });
  const agentSecrets = createAgentSecrets({ store, secrets, trace, agentGone, channel: deps.channel, provisionWhenFree, ...(deps.oauthFetch ? { telegramFetch: deps.oauthFetch } : {}) });
  // ---- the home screen and the model steward's reads (HB-0808 step 15, part C) --
  // The home screen service (orchestrator/homeScreen/homeScreen.ts): the
  // order and groups, icons (with their two locks) and planned agents. Its
  // icons ask the owner's management AI through this completer (mgmtLlm.ts
  // is the API layer's).
  // Pick home-screen icons (ui v2) for the caller's agents that have none —
  // or, with `redo`, for the named ones. One call to the owner's management
  // AI covers the batch; without one (or if it fails) a keyword table picks.
  // Either way the result is validated to one emoji and a palette colour.
  const iconCompleter = (ownerId: string, maxTokens: number): IconCompleter | undefined => {
    const profile = pickMgmtProfile(store, ownerId);
    return profile
      ? async (system, user) => {
          const r = await runMgmtCompletion(
            { secrets, apiComplete: deps.mgmtLlmComplete, cliComplete: deps.mgmtCliComplete },
            profile,
            { system, tools: [], messages: [{ role: 'user', content: user }], maxTokens },
          );
          const text = (r.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n');
          return { text, stopReason: r.stopReason };
        }
      : undefined;
  };
  const homeScreen = createHomeScreen({ store, lastActiveFor, completer: iconCompleter });
  // The model changes service (orchestrator/usage/modelChanges.ts): the
  // model options and the model-change ledger, and the ledger's start-up.
  const modelChanges = createModelChanges({
    store,
    log: { info: (detail, msg) => app.log.info(detail, msg), warn: (detail, msg) => app.log.warn(detail, msg) },
  });

  // ---- how the app is reached, and accounts (HB-0808 step 15 part B) --------
  // The app's addresses (the one shown, the one links are made for, and the
  // tailnet probe's two timers), Tailscale's setup and the app's config: the
  // reach service (orchestrator/reach/reach.ts). Switching to accounts,
  // "Forgot password?" by Telegram (its throttles), the CLI tokens and the
  // people roster: the accounts service (orchestrator/accounts/accounts.ts).
  // Their routes are in tailscaleRoutes.ts, configRoutes.ts, accountsRoutes.ts
  // and pageRoutes.ts.
  const reach = createReach({
    publicUrl: () => deps.publicUrl,
    port: () => Number(process.env.PORT) || 8080,
    proxyPort: () => proxyPort(),
    proxyListener: () => proxyListenerState(),
    envPath: () => join(process.cwd(), '.env'),
    signinLinkAudience: () => signinLinkAudience(),
    publicStatus: () => app.publicAccess?.status(),
    refreshOn: !process.env.VITEST && process.env.NODE_ENV !== 'test',
    trace,
    warn: (detail, msg) => app.log.warn(detail, msg),
    authMode: () => deps.authMode,
    countLocalAccounts: () => store.countLocalAccounts(),
    localAccountsOn,
    loopbackIsRemote,
    rebuildsAtOnce: () => lifecycle.queue.atOnce(),
  });
  // Every feature that makes a link reads these two (one copy, the service's; on the context too).
  const { appUrl: appUrlFor, linkUrl: linkUrlFor } = reach.address;
  const accounts = createAccounts({
    store, secrets, providerFor, trace,
    warn: (detail, msg) => app.log.warn(detail, msg),
    authMode: () => deps.authMode,
    envPath: () => join(process.cwd(), '.env'),
    hashPassword: (password) => hashPassword(password),
    newRecoveryCode, normalizeRecoveryCode,
    supervised: () => !!(process.env.INVOCATION_ID || process.env.XPC_SERVICE_NAME),
    restartOn: () => !process.env.VITEST,
    exit: () => process.exit(0),
    hasOwnerRights: (accountId) => app.publicAccess?.hasOwnerRights(accountId) ?? false,
    appUrlFor, linkUrlFor,
    connectorFor,
    telegramFetch: () => deps.oauthFetch ?? fetch,
  });

  // An agent's own settings changed (PATCH /v1/agents/:id; HB-0825): its
  // checks, its holds and its one transaction, and what follows from it.
  // No state, no timer.
  const agentEdits = createAgentEdits({
    store, secrets, imagePinCheck, finalModelCheck,
    searchServiceOn: () => !!(embedder.enabled || embedder.external),
    trace, providerFor, channel: deps.channel, agentGone,
    ...(deps.oauthFetch ? { telegramFetch: deps.oauthFetch } : {}),
    withSourceHold, inLimitsTurn, applyCurrentLimits, setMemoryCap, setSwapAllowance, tellMemoryBudget, detachClassIfDrifted,
    oweRebuild, rebuildOrOwe, applyCronTriggers,
    // A const further down (read at each call).
    applyFilesCap: (a) => applyFilesCap(a),
    forgetBotName, connectorFor, renameChannelBot,
    view: (a, extra) => publicAgent(a, extra),
  });

  // ---- what handlers share (routeContext.ts) --------------------------------
  // Built once, from the functions above, and handed to each feature file
  // (registerXRoutes(app, ctx)). A feature's own Maps, Sets and timers are not
  // in it: they move with the feature, into its service (HB-0807, HB-0808).
  const ctx: RouteContext = {
    deps, store, secrets,
    trace, providerFor,
    ownedAgent, visibleAgent, ownsLocalHost, agentGone, capProblem, capRowMade, publicAgent,
    movedAway, operationRefuses, busyNow, holdOnce,
    isArchiving,
    kickProvision, provisionWhenFree, kickRebuild, oweRebuild, rebuildOrOwe,
    recordLedger, ledgered,
    waitAsked, accepted, backgroundError,
    watchConsoleSession, watchConsoleHttp,
    // The agent list's (`slowHostUntil`, agentList.ts).
    hostKnownAway: (hostId) => lifecycle.list.hostKnownAway(hostId),
    hostBeingRemoved: (hostId) => removingHosts.has(hostId),
    // The reach service's (above); localAccountsOn is above too.
    appUrlFor, linkUrlFor,
    localAccountsOn,
    // Defined further down (a const in this scope); read by the usage and schedule routes.
    runningAgent: (req, id, reply, action) => runningAgent(req, id, reply, action),
    ledgerMeta,
    lifecycle, settings, sources, channels, backups, apps, consoles, machines, members, usage, schedules, google, hatchabotAgent, problemReports, health, transfers,
    files, skills, voice, machineSettings, memorySearch, conversations, consults, memory, definition, agentSecrets,
    homeScreen, modelChanges, reach, accounts, agentEdits,
  };

  // ---- app ----------------------------------------------------------------

  // The page and its scripts (src/api/machine/pageRoutes.ts, HB-0811); the join page's scripts come from there too.
  const pageScriptsOf = deps.webIndexPath ?? deps.webJoinPath;
  const scripts = pageScriptsOf ? pageScripts(dirname(pageScriptsOf)) : undefined;
  if (scripts) registerPageRoutes(app, { webIndexPath: deps.webIndexPath, version: deps.appVersion ?? APP_VERSION }, scripts);

  // The page's other files: the PWA shell, the privacy policy and terms, the icons and the app's QR code (pageRoutes.ts).
  registerPageFiles(app, { webIndexPath: deps.webIndexPath, appUrl: appUrlFor });

  // ---- Tailscale and accounts (HB-0808 step 15 part B) ---------------------
  // The app's addresses are the reach service's (`reach`, above:
  // orchestrator/reach/), its Tailscale routes in tailscaleRoutes.ts. Switching
  // to accounts, "Forgot password?" by Telegram, the CLI tokens, the people
  // roster and the account menu are the accounts service's (`accounts`:
  // orchestrator/accounts/), their routes in accountsRoutes.ts.
  registerTailscaleRoutes(app, ctx);
  registerAccountsRoutes(app, ctx);

  // "Reach it from anywhere": the public-access switch, the security record and notices (reachRoutes.ts).
  registerReachRoutes(app, { store, secrets, ownsLocalHost, appUrlFor, trace: (e, d) => trace()(e, d), fetchImpl: deps.oauthFetch });

  // ---- health, logs and events (HB-0808): healthRoutes.ts -------------------
  // /healthz, an agent's health, logs and event trail, Activity and the
  // security posture (the health service, ctx.health).
  registerHealthRoutes(app, ctx);

  // What the sign-in screen and the page read before anyone has signed in, masked at the public address (configRoutes.ts; the reach service's `config`).
  registerConfigRoutes(app, ctx);

  // ---- profiles & hosts ----------------------------------------------------

  /**
   * Bring a RUNNING agent's managed AGENTS.md sections up to date (its memory
   * budget, data sources, operator, peers), held busy like every other change
   * to its files: the sync reads AGENTS.md, works out its sections, then
   * writes the whole file, and a save made meanwhile was written over without
   * a snapshot (audit #096, HB-0230). A save now waits for it ("another
   * operation"). One refused because the agent is busy waits for it to be
   * free and tries again, a few times (OWED_BUSY_WAITS), in the background:
   * the boot's own work for an agent took its flag from the rest, and what
   * it refused was left for the next restart (HB-0834 review). Best-effort;
   * never rejects.
   * Owed in the store from the call until it has run (`agent_holds`,
   * 'docs-sync', HB-0834): the change that asked for it is stored, and a
   * restart before the sync ran left the file on the old text until the
   * agent's next rebuild. Let go only once the sections are on the file
   * (`syncDocsFor`); one refused (busy) or that failed (its container not
   * up, its write refused) stays owed, for the next sync of that agent that
   * runs or the next process, which syncs each agent still owed one
   * (`resumeOperations`).
   */
  /** Shutdown has begun (`stop`): the boot's waits for a container, and the docs syncs' waits for a busy agent, end. */
  const routesStop = new AbortController();
  /** The boot's wait for a container the record says is running, as the settings service's (afterRestart.ts). */
  const bootUpWait: UpWait = { tries: UP_TRIES, everyMs: upEveryMs(), sleep: sleepUnref, stopped: () => routesStop.signal.aborted };
  const syncDocsHeld = (a: Agent, provider = providerFor(a.hostId)): Promise<void> => {
    const ask = randomUUID();
    try { store.setAgentHold(a.id, 'docs-sync', ask); } catch { /* the database is closing: the sync is tried as before */ }
    return syncDocsFor(a, provider, ask);
  };
  /**
   * The sync for one ask, its hold let go (only if it is still that ask) once
   * the sections are on the file. Was: let go however the sync ended, and a
   * refused or failed one was lost (HB-0834 review). Never rejects.
   */
  const syncDocsFor = (a: Agent, provider: RuntimeProvider, ask: string, waits = OWED_BUSY_WAITS): Promise<void> =>
    whileBusy(a.id, 'docs-sync', () => syncDataSourceDocs({ store, secrets, provider, channel: deps.channel, log: trace(a.id) }, a.id, a.runtimeRef!, trace(a.id), { turn: (write) => withAgentsMdTurn(a.id, write) }))
      .then((current) => { if (current) store.clearAgentHold(a.id, 'docs-sync', ask); })
      .catch((err: unknown) => {
        // The sync failed, or the database is closing: still owed. Busy: its turn is waited for.
        if (err instanceof AgentBusyError && waits > 0) void docsWhenFree(a, provider, ask, waits - 1).catch(() => undefined);
      });
  /** A docs sync refused because its agent was busy, run once it is free, for the same ask, if that is still owed. */
  const docsWhenFree = async (a: Agent, provider: RuntimeProvider, ask: string, waits: number): Promise<void> => {
    if (!(await freedWithin(a.id, OWED_BUSY_WAIT_MS, routesStop.signal))) return; // still owed, for the next start
    if (store.agentHold(a.id, 'docs-sync') !== ask) return; // synced since, or asked again: that ask's sync serves it
    const now = store.getAgent(a.id);
    // Stopped, rebuilt or moved meanwhile: still owed, for its next start (a rebuild's setup writes the sections).
    if (now?.state !== 'RUNNING' || now.runtimeRef !== a.runtimeRef || now.migratedTo) return;
    await syncDocsFor(now, provider, ask, waits);
  };

  // ---- planned agents: with the home screen's routes (homeScreenRoutes.ts) --

  // ---- agent classes (model/source tiers): classRoutes.ts ------------------
  registerClassRoutes(app, ctx);

  // ---- AI-source usage, costs and budgets (HB-0808) -------------------------
  // The usage pass every ten minutes and what follows it (the model-change
  // guard, the token steward, the spike warnings, the budget pass), the cost
  // badges, budgets and Recommended: the usage and budgets service (`usage`,
  // above) owns the passes, the cost cache and the timers. Its routes are in
  // usageRoutes.ts. The owner's chat stays here: a compaction tells it too.
  /** The owner's own chat, on any app: from their Hatchabot agent's bot, else from the busy agent's own (channels/notify.ts). */
  const ownerChat = {
    store, secrets,
    ...(deps.pushFetch ? { fetchImpl: deps.pushFetch } : {}),
    dmFor: (kind: 'discord' | 'slack') => {
      const conn = connectorFor(kind);
      return conn?.dm ? (secret: string, userId: string, text: string) => conn.dm!(secret, userId, text) : undefined;
    },
  };
  /** A budget's, a spike's or a loop's message to its owner. */
  const tellUsageSpike = (ownerId: string, agent: Agent, text: string) => tellOwner(ownerChat, ownerId, agent.id, text);
  // The model-change ledger at start-up (the model changes service's): seeded
  // once from the set_model cards confirmed before it existed, and changes
  // older than about 13 months forgotten. Then its two reads' routes
  // (modelChangeRoutes.ts).
  modelChanges.atStart();
  registerModelChangeRoutes(app, ctx);
  registerUsageRoutes(app, ctx);

  // ---- machines and runners (HB-0808) -------------------------------------
  // This machine and its runners (list, Check, the runner key, Install image,
  // add, Drain, Remove) and Status → Resources (machineRoutes.ts; the rules
  // and their state are the machines service's, ctx.machines).
  registerMachineRoutes(app, ctx);

  // ---- the memory search service (HB-0808 step 13) ------------------------
  // The embedding service (src/embedder): one engine per machine for every
  // agent's semantic memory search. The fleet's engine choice, a machine's
  // service and the guests' keys: the routes are in embedderRoutes.ts, the
  // services and their timers the memory search service's (`memorySearch`,
  // built above the context).
  (app as unknown as { embedder?: EmbedderService }).embedder = embedder;
  (app as unknown as { embedderFor?: typeof embedderFor }).embedderFor = embedderFor;
  /** What provisioning needs of the service: it up, and a key for the agent. (Exposed on app for tests.) */
  (app as unknown as { embedderForProvision?: typeof embedderForProvision }).embedderForProvision = embedderForProvision;
  registerEmbedderRoutes(app, ctx);
  // At boot, the service's start and then its health loop (off under test).
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') memorySearch.startTimers();
  // ---- curated skills and browser voice (HB-0808 step 13) ------------------
  // The library, an instruction file previewed and changed, practice and the
  // running agent's inventory; Talk's readiness and its setup: the routes are
  // in skillRoutes.ts and voiceRoutes.ts, the rules the skills service's
  // (`skills`, with the practice cooldown and the coalesced status reads) and
  // the voice service's (`voice`), built above the context.
  registerSkillRoutes(app, ctx);
  registerVoiceRoutes(app, ctx);

  // ---- each agent's own browser and "Sign in to a site" (HB-0808) -----------
  // Its state, the sign-in panel and Keep its logins: the routes are in
  // browserRoutes.ts; the sweep and the open panels are the service's
  // (`consoles`, above the context).
  registerBrowserRoutes(app, ctx);

  // A started or woken agent may carry sessions pinned to a runtime its config
  // no longer names (runtimePins.ts): once its gateway answers, clear them.
  // Settles once all it started has (the boot's pass takes six agents at a
  // time by it); never rejects. Its callers at a start do not wait for it.
  const clearPinsWhenUp = (a: Agent): Promise<void> => {
    if (!a.runtimeRef) return Promise.resolve();
    const jobs: Array<Promise<unknown>> = [];
    if (a.browser) jobs.push(browsersNow(a.id)); // started or woken: its browser joins its new network
    forgetDmPolicy(a.id); // started or woken: the door is asserted afresh at the next rest
    // Its memory and swap limits as the kernel holds them, now that it has a fresh cgroup (limitsCheck).
    jobs.push(limitsCheck({ agentIds: [a.id] }).catch(() => {}));
    jobs.push(clearStaleRuntimePinsWhenUp(providerFor(a.hostId), a.runtimeRef, a.slug, (e, d) => trace(a.id)(e, d)).catch(() => {}));
    // Web chat given or taken while it was down: its gateway's list of people
    // follows now, before anyone opens the console (2026-09-30).
    jobs.push(consoleAccess.syncWhenUp(a.id).catch(() => {}));
    // Template tasks still waiting to be added: tried again once it answers (HB-0231).
    if (store.getPendingSchedules(a.id).length) {
      jobs.push(retryPendingSchedulesWhenUp({ store, provider: providerFor(a.hostId), stop: routesStop.signal }, a.id, trace(a.id)).catch(() => {}));
    }
    // Google accounts attached or detached while it was stopped or asleep take
    // effect now, not at its next rebuild: a detached account used to stay
    // usable after Start (night review, 2026-09-28). Only for owners who have any.
    // Then what it can reach is looked at afresh (access overview): its
    // last-verified times move on every start and wake, not only on Verify now.
    const ref = a.runtimeRef;
    // Moved while stopped: the tools its rebuild hook puts back outside its
    // home are not in this new container yet (audit #087).
    if (a.rebuildHookDue) {
      jobs.push(runOwedRebuildHook({ store, secrets, provider: providerFor(a.hostId), channel: deps.channel }, a.id, ref, trace(a.id)).catch(() => {}));
    }
    // A removed repo source whose deploy key could not be scrubbed yet: again now.
    if (store.dataSourceRemovals(a.id).length) {
      jobs.push(scrubRemovedDataSources({ store, secrets, provider: providerFor(a.hostId) }, a.id, ref, true, trace(a.id)).catch(() => {}));
    }
    const verifyLater = () => verifyAgentAccess(connSyncDeps(a.hostId), a.id, ref).then(() => undefined, () => undefined);
    if (store.listConnections(a.ownerId).length || store.connectionRemovals(a.id).length) {
      jobs.push(syncConnections(connSyncDeps(a.hostId), a.id, ref).catch((err: unknown) => trace(a.id)('connection.sync_failed', { error: String(err).slice(0, 200) }))
        .then(() => syncDocsHeld({ ...a, runtimeRef: ref }, providerFor(a.hostId))) // names the accounts it now holds (HB-0394)
        .then(verifyLater)
        .catch(() => {})); // verifyLater throws when the host was removed during the sync (HB-0374)
    } else jobs.push(verifyLater());
    return Promise.allSettled(jobs).then(() => undefined);
  };
  /**
   * What of clearPinsWhenUp a start owes this agent on its record, not only
   * in this process: a Google account detached or a repo source removed
   * whose scrub is still to come, its rebuild hook, template tasks still to
   * add (the boot's pass for a start a restart cut off, HB-0833).
   */
  const owedAfterStart = (a: Agent): boolean =>
    !!a.rebuildHookDue || store.connectionRemovals(a.id).length > 0 || store.dataSourceRemovals(a.id).length > 0
    // Not a task parked as a clash with another of its name, or one the agent
    // refused: each waits for its owner, and is not owed at every boot (HB-0833 review, HB-1409).
    || store.getPendingSchedules(a.id).some((s) => !waitsForItsOwner(s.why));
  /** What follows a start the boot owes an agent, once its own operations are over (resumeOperations). Never rejects. */
  const afterItsOperation = async (was: Agent): Promise<void> => {
    if (!(await operationsOverFor(store, was.id, routesStop.signal))) return;
    const now = store.getAgent(was.id);
    if (!now || now.state !== 'RUNNING' || now.runtimeRef !== was.runtimeRef || now.migratedTo || isInFlight(now.id) || !owedAfterStart(now)) return;
    await clearPinsWhenUp(now);
  };
  /** The same, for an agent something other than Start brought up (a restore), by id. */
  const startHooksFor = (agentId: string): void => {
    const a = store.getAgent(agentId);
    if (a) clearPinsWhenUp(a);
  };
  // Hibernation: the idle sweep and the Telegram wake poll (hibernate.ts).
  const hibernateDeps: HibernateDeps = {
    store, secrets, providerFor,
    // Up again: its budget too, as Start does (a cap changed while it slept).
    afterWake: (a) => { clearPinsWhenUp(a); void tellMemoryBudget(a.id).catch(() => undefined); },
    // Its limits in their turn, as Start puts them on (HB-0881).
    inLimitsTurn, applyCurrentLimits: (agentId) => applyCurrentLimits(agentId),
    // A change was made while it slept. Refused at render time (a source with no
    // key, say) it stays down: it is a stopped agent then, with the reason on its
    // trail, or every message would ask for the same refused rebuild again.
    rebuildOnWake: (a, why) => {
      if (!kickRebuild(a.id)) return;
      trace(a.id)('rebuild.on_wake', { why });
      void inFlight(a.id)?.then(() => {
        const now = store.getAgent(a.id);
        const refused = now?.state === 'STOPPED' && now.hibernatedAt ? renderRefusalOf(a.id) : undefined;
        if (!refused) return;
        store.setHibernated(a.id, null);
        trace(a.id)('hibernate.wake_abandoned', { error: refused, attempts: 1 });
      }).catch(() => {});
    },
    // Read fresh, and a read that fails says so: the list's lastActiveFor
    // answers "nothing" then, and an agent mid-conversation slept (#99).
    // readSessions is the conversations service's (built further down; called only at sweep time).
    lastActiveFor: async (a) => {
      const sessions = await readSessions(a);
      if (!sessions) throw new Error('its conversations could not be read');
      return newestActivity(sessions);
    },
    ownCrons: async (a) => (await listCrons(providerFor(a.hostId), a.runtimeRef!, a.slug)).map((c) => ({ enabled: c.enabled, system: c.system })),
    // Busy is the flag AND a turn in flight: an ask or a consult is not on the
    // flag, and the idle sweep stopped a container mid-answer (30th audit).
    // A rebuild waiting for its turn counts too: put to sleep meanwhile, its
    // rebuild was skipped and the change it carried lost (regression review).
    // And a long operation on disk (operations.ts): a held move must not be woken by a message.
    // And a Recover context slot: its turn runs in the background while its
    // process does (the turn in flight counts it then), and one reserved
    // for after a switch's rebuild (HB-0887). `settle` looks at that process
    // first, so a turn that has ended does not refuse a sleep by hand.
    isBusy: (id) => isBusy(id) || consults.turns.inFlight(id) || memory.history.recovering(id) || isInFlight(id) || webChatBusy(webChatInFlight, id) || !!store.activeOperationFor(id),
    settle: (id) => memory.history.settle(id),
    // Only when the machine rebuilds on its own: under "manual" it would never sleep.
    requiredRebuildDue: async (a) => rebuildPolicy() !== 'manual' && (await rebuildNeedOf(a))?.need?.level === 'required',
    log: (id) => (event, detail) => trace(id)(event, detail ?? {}),
    fetchImpl: deps.oauthFetch,
  };
  /** Wake a sleeping agent and wait for its gateway (a message, a console, an ask). */
  const ensureAwake = async (agent: Agent, why: string): Promise<Agent> => {
    if (!agent.hibernatedAt || agent.state !== 'STOPPED') return agent;
    // Moved away or busy: not ours to start (two gateways on one bot token; a
    // start under a move). The caller's "not running" answer stands.
    if (agent.migratedTo || hibernateDeps.isBusy(agent.id)) return agent;
    const woken = await wakeAgent(hibernateDeps, agent, why);
    // A 2026.9 gateway takes 20–60 s to answer on a loaded box: the first console
    // open after a sleep timed out at 45 s (one agent, 2026-09-26).
    const waitMs = Number(process.env.HATCHABOT_WAKE_TIMEOUT_MS ?? 120_000);
    // This wake is the rebuild it was owed: done when that is, within the same wait.
    const rebuilding = woken.state !== 'RUNNING' ? inFlight(agent.id) : undefined;
    if (rebuilding) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([rebuilding, new Promise<void>((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
      return store.getAgent(agent.id) ?? woken;
    }
    if (woken.state !== 'RUNNING') return woken;
    const provider = providerFor(woken.hostId);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const st = await provider.status(woken.runtimeRef!).catch(() => undefined);
      if (st?.phase === 'running' && st.healthy) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return store.getAgent(woken.id) ?? woken;
  };
  (app as unknown as { hibernateDeps?: HibernateDeps; ensureAwake?: typeof ensureAwake }).hibernateDeps = hibernateDeps;
  (app as unknown as { ensureAwake?: typeof ensureAwake }).ensureAwake = ensureAwake;
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    setInterval(() => { void hibernateSweep(hibernateDeps).catch((err) => app.log.warn({ err: String(err) }, 'hibernate sweep failed')); },
      Number(process.env.HATCHABOT_HIBERNATE_SWEEP_MS) || 5 * 60_000).unref();
    setInterval(() => { void wakeSweep(hibernateDeps).catch((err) => app.log.warn({ err: String(err) }, 'wake sweep failed')); },
      // Every 20 s: a getUpdates per sleeper is one cheap call, and the reply to
      // the first message after a sleep is the poll plus the gateway's start.
      Number(process.env.HATCHABOT_WAKE_POLL_MS) || 20_000).unref();
    // Once per boot, the running fleet on this machine: sessions pinned to a
    // runtime the config no longer names (the agents that switched from a
    // machine login to a setup token kept asking for the CLI; runtimePins.ts).
    // Each agent is waited for (a host reboot brings 45 gateways up slowly),
    // three at a time, and a failure is on its trail rather than swallowed.
    setTimeout(() => {
      void (async () => {
        const local = store.localHostId();
        const queue = store.listAllActiveAgents().filter((a) => a.state === 'RUNNING' && !!a.runtimeRef && a.hostId === local);
        const worker = async () => {
          for (let a = queue.shift(); a; a = queue.shift()) {
            const cleared = await clearStaleRuntimePinsWhenUp(providerFor(a.hostId), a.runtimeRef!, a.slug, (e, d) => trace(a.id)(e, d));
            if (cleared.length) app.log.warn({ agent: a.slug, sessions: cleared }, 'stale runtime pins cleared');
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      })().catch((err) => app.log.warn({ err: String(err) }, 'runtime.pin_sweep_failed')); // HB-0374
    }, Number(process.env.HATCHABOT_PINS_BOOT_MS) || 60_000).unref();
  }
  // ---- runtime images (HB-0808) ------------------------------------------
  // The base image, derived images, deleting and promoting a tag, and which
  // OpenClaw the image runs (imageRoutes.ts; the rules and the builds' state
  // are the machines service's, ctx.machines.images).
  registerImageRoutes(app, ctx);

  /**
   * Which local models are resident right now, per model server, kept 15
   * seconds; one question at a time per server (src/orchestrator/sources/warmModels.ts).
   */
  const warmLocalModels = createWarmLocalModels();

  // Telegram, Discord and Slack (src/api/chat/channelRoutes.ts, HB-0808): an agent's bots, the spare pools, the bot census, the account's chat identities, and pairing.
  registerChannelRoutes(app, ctx);

  // Keys, web search and the machine's defaults (src/api/machine/machineSettingsRoutes.ts, HB-0808 step 15): the fleet's Gemini and Brave keys, which search the fleet uses and an agent's search test, Defaults for this machine.
  registerMachineSettingsRoutes(app, ctx);

  // AI sources (src/api/usage/aiSourceRoutes.ts, HB-0808): each source, the agents moved onto one, its default model and its model list.
  registerAiSourceRoutes(app, ctx);

  // ---- management bot ------------------------------------------------------
  // The mgmt bot is a separate process the control plane otherwise can't see.
  // It phones home here (authenticated by its own cli-token, so the row is
  // owner-scoped) and the web UI reads the result to show a live presence card
  // instead of guessing from cli-token last-used timestamps.






  // Phase C: the web management chat pane — same broker, web transport.
  /**
   * "Something is waiting" on the owner's phone, through their management
   * agent's own Telegram bot — the one thing the retired management bot did
   * that the app could not. One way only: confirming stays in the app.
   */
  const opsPushDeps: Parameters<typeof createOpsPush>[0] = {
    botToken: async (ownerId) => {
      const ops = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
      const row = ops && store.getChannelForAgent(ops.id, 'telegram');
      return row ? await secrets.get(row.secretRef).catch(() => undefined) : undefined;
    },
    chatId: (ownerId) => {
      const ops = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
      // The owner's OWN Telegram on that agent: never a member's.
      return ops
        ? store.listMemberships(ops.id).find((m) => m.role === 'owner' && m.status === 'active')?.channelUserId
        : undefined;
    },
    appUrl: () => appUrlFor(),
    // Discord: the manager's bot DMs the owner's linked Discord identity, from here.
    sendDiscord: async (ownerId, text, beforeSend) => {
      const ops = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
      const row = ops && store.getChannelForAgent(ops.id, 'discord');
      const me = ops && store.memberIdentities(ops.id, ownerId).discord;
      const conn = connectorFor('discord');
      if (!row || !me || !conn?.dm) return false;
      const secret = await secrets.get(row.secretRef).catch(() => undefined);
      return secret && (!beforeSend || beforeSend()) ? conn.dm(secret, me, text) : false;
    },
    discordLinked: (ownerId) => {
      const ops = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
      return !!(ops && store.getChannelForAgent(ops.id, 'discord') && store.memberIdentities(ops.id, ownerId).discord && connectorFor('discord')?.dm);
    },
    ...(deps.pushFetch ? { fetchImpl: deps.pushFetch } : {}),
    log: (event, detail) => app.log.info(detail, event),
  };
  const opsPush = createOpsPush(opsPushDeps);
  /** A task's run, told on the owner's phone (HB-0537): the same bot, a budget of its own, so a busy morning of reports never uses up the alerts' hour. */
  const taskNotePush = createOpsPush({ ...opsPushDeps, perHour: TASK_NOTES_PER_HOUR });
  /** Whether such a note has a way to the owner: their Hatchabot agent's Telegram bot with them linked on it, or its Discord. */
  const ownerNoteReach = (ownerId: string): boolean => {
    const ops = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
    if (!ops) return false;
    if (store.getChannelForAgent(ops.id, 'telegram') && opsPushDeps.chatId(ownerId)) return true;
    return opsPushDeps.discordLinked?.(ownerId) === true;
  };

  registerMgmtChat(app, {
    store, secrets, opsPeerOk, machineOwner: ownsLocalHost,
    notifyOps: (ownerId, body) => void opsNotifier.notify(ownerId, body),
    pushOps: (ownerId, headline, detail) => void opsPush.waiting(ownerId, headline, detail),
    opsWeb: {
      braveKey: async () => (searchWatch.state().active === 'brave' ? secrets.get(SEARCH_KEY_REF).catch(() => undefined) : undefined),
      onBraveFailed: () => searchWatch.nudge(),
      onSearched: (provider) => store.addSearch(OPS_AGENT_SEARCHES, provider, new Date().toISOString()),
    },
  });

  // ---- agents ---------------------------------------------------------------

  // ---- an agent's conversations (HB-0808 step 13, HB-0826) ---------------
  // Its sessions file read and cached, "last active", the unread mark, and
  // the home screen's Recent list: the routes (/v1/recent, POST
  // /v1/agents/:id/seen) are in conversationRoutes.ts, the reads and their
  // caches the conversations service's (`conversations`, built above the context).
  registerConversationRoutes(app, ctx);

  // ---- rebuild policy: which agents need a rebuild, and which the machine
  // does on its own (rebuildPolicy.ts) ---------------------------------------

  /** Every tag on a host that IS the fleet default's image (`:latest` under another name), cached like the image info. */
  const aliasCache = new Map<string, { at: number; value: Promise<Set<string>> }>();
  const defaultAliasesFor = (hostId: string): Promise<Set<string>> => {
    const hit = aliasCache.get(hostId);
    if (hit && Date.now() - hit.at < 10_000) return hit.value;
    const value = providerFor(hostId).listImageTags().then((tags) => {
      const latest = tags.find((t) => t.tag === DEFAULT_BASE)?.imageId;
      return new Set(latest ? tags.filter((t) => t.imageId === latest).map((t) => t.tag) : []);
    }).catch(() => new Set<string>());
    aliasCache.set(hostId, { at: Date.now(), value });
    return value;
  };
  /** The owner switched its memory search engine and the rebuild is still owed. */
  const switchPendingFor = (a: Agent): boolean =>
    a.hostId === store.localHostId() && !a.ops && (a.embedMode ?? 'baked') !== (a.appliedEmbedMode ?? 'baked')
    // Wanting the shared service while it is off: a rebuild falls back to the
    // agent's own engine again, so it is never "done" — the quiet-hours sweep
    // rebuilt such an agent every five minutes (night review, 2026-09-28).
    && !((a.embedMode ?? 'baked') === 'shared' && !embedder.enabled && !embedder.external);
  /**
   * A container whose process quit on its own and was started again by
   * Docker's restart policy (RestartCount went up; a rebuild makes a new
   * container, so it starts from 0) gets a line in its Setup log, with the
   * exit code — the only trace of an event nothing else records. A trading
   * agent, 2026-09-24: the gateway quit with code 0 a second
   * after a message, at a 2 GiB cap it had hit hundreds of times; the
   * container log had nothing, and neither did Hatchabot. Counts seen since
   * this process started; a restart while Hatchabot was down is not noticed.
   */
  const restartsSeen = new Map<string, number>();
  const noteSelfRestart = (a: Agent, running: RuntimeInfo) => {
    const n = running.restartCount;
    if (n === undefined) return;
    const prev = restartsSeen.get(a.id);
    restartsSeen.set(a.id, n);
    if (prev === undefined || n <= prev) return;
    trace(a.id)('runtime.self_restarted', { count: n, exitCode: running.lastExitCode, startedAt: running.startedAt });
  };
  /**
   * An agent's file ceiling on each of its apps, set live (OpenClaw hot-reloads
   * it; a stopped agent's volume is edited). In the agent's limits turn, and
   * read as it is once that comes: a fleet default's pass, holding an agent
   * read before its wait for the agents ahead, wrote the default over a
   * ceiling of its own saved meanwhile (HB-0917). Each write in the agent's
   * turn at its chat apps' section of openclaw.json too: the CLI writes the
   * whole file back, and landing in the middle of a member's removal it put
   * the removed person back on the agent's allowFrom (HB-1554). Where it
   * runs, and how, read once its turn comes: stopped, rebuilt or moved while
   * it waited, it wrote to the container it ran on before. `skipped`: it had
   * nothing to write to (being set up, rebuilt, moved or deleted, then or in
   * its turn), which says nothing of its machine: a fleet default's pass read
   * a skip as a runner it could not reach, and passed the runner's other
   * agents by (HB-1554 review).
   */
  const applyFilesCap = (agent: Agent, only?: ChannelKindForFiles): Promise<{ applied: number; gone: boolean; skipped?: true }> => inLimitsTurn(agent.id, async () => {
    const a = store.getAgent(agent.id);
    if (!a?.runtimeRef || (a.state !== 'RUNNING' && a.state !== 'STOPPED')) return { applied: 0, gone: false, skipped: true };
    const provider = providerFor(a.hostId);
    let n = 0, gone = false, moved = false, failed = false;
    for (const kind of new Set(store.listChannelsForAgent(a.id).map((c) => c.kind))) {
      if (kind !== 'telegram' && kind !== 'discord' && kind !== 'slack') continue;
      if (only && kind !== only) continue;
      const mb = String(filesMb(kind, a.filesMaxMb));
      const res = await inChannelConfigTurn(store, a.id, async () => {
        const now = store.getAgent(a.id);
        if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED') || now.hostId !== a.hostId) return 'moved' as const;
        return now.state === 'RUNNING'
          ? provider.exec(now.runtimeRef, ['config', 'set', `channels.${kind}.mediaMaxMb`, mb])
          : provider.execShellOnVolume(now.runtimeRef, `openclaw config set channels.${kind}.mediaMaxMb ${mb} >/dev/null`, { image: now.image ?? undefined });
      }).catch(() => undefined);
      // Being set up, rebuilt, moved or deleted meanwhile: the build writes the ceiling from the setting.
      if (res === 'moved') { moved = true; continue; }
      if (res?.code === 0) n++;
      else {
        failed = true;
        // Its one agent's loss, not a machine that is asleep (HB-0373).
        gone ||= res?.volumeMissing === true;
        trace(a.id)('files.cap_failed', { kind, error: String(res?.stderr ?? 'no answer').slice(0, 200) });
      }
    }
    return { applied: n, gone, ...(moved && !n && !failed ? { skipped: true as const } : {}) };
  });

  // ---- the agent lifecycle's routes (HB-0808 step 11) ----------------------
  // The rebuild policy and how many rebuild at once (machine settings, read as
  // they are set: by the machine owner, HB-0061; a member's page has
  // rebuildConcurrency in /v1/config), the long operations and the owner's
  // choice for a held one, and Rebuild, Retry setup, Stop, Start, sleep and
  // wake: the routes are in lifecycleRoutes.ts, the rules the agent lifecycle
  // service's (`lifecycle`, above the context). Last there, PATCH
  // /v1/agents/:id, an agent's own settings: its rules are the agent edits
  // service's (`agentEdits`, above the context; HB-0825).
  registerLifecycleRoutes(app, ctx);

  // ---- an agent's files (HB-0808 step 13) ---------------------------------
  // Its core files (Personality and Knowledge) read and saved, and its home
  // browsed, downloaded and uploaded to: the routes are in fileRoutes.ts, the
  // rules and the core-files turn the agent files service's (`files`, built
  // above with the turn). The upload's raw body comes through the
  // `application/octet-stream` parser registered above.
  registerFileRoutes(app, ctx);

  // ---- an agent's definition (HB-0808 step 15, part C) ---------------------
  // Its setup values applied to its files (PUT …/params) and a master's
  // definition pushed to its children (POST …/push-definition): the routes
  // are in definitionRoutes.ts, the rules the definition service's
  // (`definition`, above the context).
  registerDefinitionRoutes(app, ctx);

  // ---- snapshots (core-file history): in backupRoutes.ts (HB-0808) ---------

  // ---- an agent's secrets (HB-0808 step 15, part C) ------------------------
  // Its debug gateway's credential, its environment values and the bot token
  // its parked setup waits for: the routes are in agentSecretRoutes.ts, the
  // rules the agent secrets service's (`agentSecrets`, above the context).
  registerAgentSecretRoutes(app, ctx);

  // ---- the OpenClaw console (HB-0808) ---------------------------------------
  // The proxy (HTTP and its WebSocket upgrade) and the console's own routes are
  // in consoleRoutes.ts; who may reach which console, the handshakes and open
  // sockets and their sweep are the console's gate (`consoles`, above the context).
  registerConsoleRoutes(app, ctx);

  // ---- apps in agents and data sources (HB-0808) ---------------------------
  // The routes are in appRoutes.ts; the rules and their locks are the apps and
  // data sources service (`apps`, above the context).
  registerAppRoutes(app, ctx);

  // ---- the home screen (HB-0808 step 15, part C) ----------------------------
  // An agent moved, a section sorted, a group renamed or moved, icons picked
  // and ideas for one, and the agents planned for later: the routes are in
  // homeScreenRoutes.ts, the rules the home screen service's (`homeScreen`,
  // above the context, with its icon locks).
  registerHomeScreenRoutes(app, ctx);

  // ---- Scheduled tasks (OpenClaw crons, HB-0808) -------------------------
  // The list, a new task, an edit or a switch, run now, its runs, delete, and
  // the template tasks still waiting: scheduleRoutes.ts, over the schedules
  // service (orchestrator/schedules/). It adds no hook. The gateway must be
  // up, so every route needs RUNNING; the routes still here use this too.
  const runningAgent = (
    req: FastifyRequest,
    id: string,
    reply: any,
    action = 'manage its scheduled tasks',
  ): Agent | undefined => {
    const agent = ownedAgent(req, id);
    if (!agent) {
      reply.code(404).send({ error: 'Not found' });
      return undefined;
    }
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) {
      reply.code(409).send({ error: agent.hibernatedAt ? `It is asleep — wake it to ${action}.` : `Start the agent to ${action}.` });
      return undefined;
    }
    return agent;
  };

  registerScheduleRoutes(app, ctx);

  // Per-agent token usage, read from its OpenClaw session store. Accurate usage,
  // not a cost figure — the app renders billing context from the AI profile.

  // ---- an agent's memory and the turns in its conversation (HB-0808) --------
  // Checkpoint, the chat history and Recover context, compact and the context
  // cap, an owner's ask, a child's distillation and its review: the routes are
  // in memoryRoutes.ts, the rules the memory service's
  // (orchestrator/memory/agentMemory.ts).
  registerMemoryRoutes(app, ctx);

  // ---- live model change (no rebuild): modelRoutes.ts ---------------------
  registerModelRoutes(app, ctx);

  // ---- agent-to-agent consult (HB-0808) -------------------------------------
  // Owner sets which agents an agent may consult; the caller agent holds a
  // call token and hits POST /message, which runs a turn on the peer and
  // returns its reply. Same-owner only, grant-gated, depth-limited: the
  // routes are in consultRoutes.ts, the rules the consult service's
  // (orchestrator/consult/consults.ts).
  registerConsultRoutes(app, ctx);

  // The model steward's two reads (/v1/model-options, /v1/model-changes):
  // modelChangeRoutes.ts, registered with the ledger's start-up, below the
  // usage routes' (the model changes service's, `modelChanges`).


  // ---- Report a problem (HB-0808, docs/field-reports.md): problemReportRoutes.ts
  // The facts a report carries, a private draft per person, and the installed
  // source read-only (the Report a problem service, ctx.problemReports).
  // Nothing here sends anything: the person opens the GitHub issue
  // themselves from the draft.
  registerProblemReportRoutes(app, ctx);


  // Chat on the web for the people the owner trusts with it (2026-09-29).
  registerWebChatRoutes(app, {
    store, providerFor, ensureAwake, isBusy,
    trace: (id) => trace(id),
    inFlight: webChatInFlight,
    timeoutMs: ASK_TIMEOUT_MS,
    afterTurn: (id) => conversations.forget(id),
  });

  // ---- the Hatchabot agent (HB-0808): opsAgentRoutes.ts ---------------------
  // The account's management agent, asking it which agents to add, and the
  // operator's profile (the Hatchabot agent service, ctx.hatchabotAgent).
  registerOpsAgentRoutes(app, ctx);

  // ---- Google connections and what each agent can reach: googleRoutes.ts ----
  // The accounts an agent's gog holds, Test Gmail and Disconnect, the OAuth
  // client, the consent round-trip, the vault, attach and detach, the access
  // overview and Verify now (the Google connections and access service).
  registerGoogleRoutes(app, ctx);

  // ---- read-only inspection (archived / stopped agents): inspectRoutes.ts ----
  registerInspectRoutes(app, ctx);

  // ---- backups, snapshots and restores (HB-0808) ----------------------------
  // Snapshots, the backup sets, recovery readiness and the restore drills
  // (backupRoutes.ts; the rules are the backups service's, ctx.backups).
  registerBackupRoutes(app, ctx);

  // ---- adopting an existing OpenClaw agent (HB-0808 step 12): adoptRoutes.ts ----
  // The OpenClaw agents on this machine, their bots quieted, a workspace's
  // folders and preview, and a workspace copied into an agent (the moves,
  // import and export service's adopts, ctx.transfers.adopts).
  registerAdoptRoutes(app, ctx);

  // ---- moves, import and export (HB-0808 step 12): transferRoutes.ts --------
  // Move-host and rehost, the other servers (/v1/peers), the preflight and
  // /v1/moves/:id another server asks, the whole agent as a file and back,
  // a template and its scan, sending one to an inbox and the inbox, clone,
  // derive and import (the moves, import and export service, ctx.transfers).
  registerTransferRoutes(app, ctx);

  /**
   * An archive's Discord and Slack bots, like Telegram's: the bot is parked
   * (kept for this agent, so a restore takes it back unless somebody used it
   * meanwhile) and the people on it are told. Slack's tokens are the owner's
   * app: left as is. Part of the archive's finish (archive.ts), so the finish
   * after a restart does it too (audit #093); a row already parked is gone.
   */
  const parkArchivedChannels = async (agent: Agent): Promise<void> => {
    for (const kind of ['discord', 'slack'] as const) {
      const dc = store.getChannelForAgent(agent.id, kind);
      if (!dc) continue;
      const told = await dmChannelPeople(agent, kind, dc.secretRef, `📥 ${agent.name} has been archived by its owner. This bot does not answer for it while it is archived.`);
      try { await parkDiscordBot({ store, secrets }, agent.ownerId, dc, { archivedFor: agent.id }); }
      catch (err) { trace(agent.id)('channel.park_failed', { kind, error: String(err).slice(0, 200) }); await secrets.delete(dc.secretRef).catch(() => {}); }
      store.deleteChannelForAgent(agent.id, kind);
      trace(agent.id)('channel.detached', { kind, accountId: dc.accountId, parked: true, told, archived: true });
    }
  };

  // ---- operations (orchestrator/lifecycle/operations.ts) -----------------------------
  // Long changes recorded on disk as they go. A restart in the middle is
  // settled by resumeOperations (index.ts, at boot); one the machine cannot
  // settle by itself is held, and its owner chooses here.
  const opsCtx: ResumeContext = {
    store, secrets, channel: deps.channel, embedder: embedderForProvision, peerFetch: deps.peerFetch,
    providerForHost: (hostId) => { try { return providerFor(hostId); } catch { return undefined; } },
    logFor: (agentId) => trace(agentId ?? undefined),
    // A rebuild queued before the restart takes its place in the queue again.
    requeueRebuild: (op) => {
      const p = op.params as { checkpoint?: boolean; was?: Partial<Agent>; recoverOn?: string };
      const kicked = kickRebuild(op.agentId!, { checkpoint: p.checkpoint === true, ...(p.recoverOn ? { recoverOn: p.recoverOn } : {}), resume: { opId: op.id, was: (p.was ?? {}) as Agent } });
      // The recovery a source switch chained after it (HB-0832): chained again, while the agent is
      // on the source it was asked for (switched again since, that switch says what follows).
      if (kicked && p.recoverOn && store.getAgent(op.agentId!)?.aiProfileId === p.recoverOn) memory.history.afterRebuild(op.agentId!);
      return kicked;
    },
    // The same for a rebuild the pass finishes itself (HB-1445).
    recoverAfterRebuild: (agentId, done) => memory.history.afterRebuild(agentId, done),
    appDeps: (agentId) => { const a = store.getAgent(agentId); return a?.runtimeRef ? appDeps(a) : undefined; },
    tellOwner: (ownerId, agentId, text) => tellOwner(ownerChat, ownerId, agentId, text),
    afterStart: startHooksFor,
    // An adopt's starts are the Start button's (HB-0980 review): the owner's own
    // choice as the owner asked, one a restart left as the machine's own.
    startStopped: (agentId, opts) => {
      const a = store.getAgent(agentId);
      return a ? lifecycle.power.startStopped(a, opts) : Promise.resolve({ ok: false, error: 'Not found' });
    },
    isInFlight,
    parkOtherChannels: parkArchivedChannels,
  };



  // ---- members, invites and web chat (HB-0808) -----------------------------
  // Invites and joining by one, the members, the people known from another
  // agent and sharing for web chat: the routes are in memberRoutes.ts, the
  // rules the members service's (orchestrator/members/membersAndInvites.ts).
  registerMemberRoutes(app, ctx);

  // The join page an invite link opens: a page, served with the page's scripts (pageRoutes.ts).
  registerJoinPage(app, { webJoinPath: deps.webJoinPath }, scripts);

  return {
    /**
     * At boot, before anything is served: waiting app installs from before
     * v2.160.0 move their secret values out of the row. Their manifest is read
     * where it is on this machine (the folder, or the git address's mirror),
     * never fetched; a row whose manifest can't be read is retried next boot.
     */
    stashOldPendingSecrets: async () => {
      const name = '2026-10-11-app-pending-secrets';
      if (store.storeMigrationDone(name)) return;
      const r = await stashOldPendingSecrets(store, secrets, (source, ref) => apps.installed.manifestHere(source, ref));
      if (r.moved.length) app.log.warn({ agents: r.moved }, 'moved waiting app secrets into the secret store');
      if (r.unknown.length) app.log.warn({ agents: r.unknown }, 'waiting app installs whose manifest could not be read: their values stay in the row until it goes in');
      else store.recordStoreMigration(name);
    },
    /** At boot, after the first reconcile: settle what the last process left running. */
    resumeOperations: async () => {
      // What the last process had still to put on a container for an agent's
      // class, model or memory limits (HB-0809, settings.resume): once that
      // agent's own operations are settled (a rebuild put back in the queue
      // writes the model itself), not every agent's (HB-0839), beside the
      // rest of this pass, and whether or not settling them failed. It never
      // rejects.
      let settingsResumed: Promise<void> | undefined;
      let pass: ResumingOperations | undefined;
      // A budget's pause an earlier process stopped its agent for and never
      // recorded: recorded first, so a start an operation still owes the
      // agent is the pause's, not run below (HB-0835 review). The first
      // budget pass comes too late for that.
      try { usage.budgets.recordCutOffPauses(); } catch (err) { app.log.error({ err: String(err) }, 'cut-off budget pauses could not be recorded'); }
      // A join to an agent that was not running waits for its next start,
      // wake or rebuild: watched again, as the last process did, whatever
      // settling the operations below comes to (HB-0992).
      try { members.invites.resumePendingJoins(); } catch (err) { app.log.error({ err: String(err) }, 'pending joins could not be taken up'); }
      // Every other watch for a first message the last process had under way
      // (a new agent's owner, an import's, a Telegram attached, a reopened
      // door): watched again for the time it had left, with the ids it never
      // claims (HB-0838). It lived only in memory over its stored window.
      try {
        resumeFirstContacts({ store, providerFor, trace, logError: (obj, msg) => app.log.error(obj, msg) });
      } catch (err) { app.log.error({ err: String(err) }, 'first-contact watches could not be taken up'); }
      // A start cut off by the restart (HB-0833): Start records RUNNING, then
      // what follows a start runs in the background (clearPinsWhenUp), and
      // reconcile marks a container it finds running as RUNNING without it.
      // What of that is owed is on the record (a Google account or a repo
      // source removed while it was stopped, its rebuild hook, tasks still to
      // add): each agent running at this start with any of it has what
      // follows a start run now, once its own operations are settled, as its
      // next start would. Not every agent: it is several calls each.
      const runningAtBoot = store.listAllActiveAgents().filter((a) => a.state === 'RUNNING' && !!a.runtimeRef && !a.migratedTo && owedAfterStart(a));
      // A sync of an agent's managed AGENTS.md sections asked for and not run
      // when the process ended (HB-0834: an operator profile's push to every
      // running agent, a peer or an account changed): run now, once its own
      // operations are settled. One not running now gets its sections from
      // its next setup or rebuild, as one stopped at the change does.
      const docsOwed = store.agentHolds('docs-sync');
      try { pass = startResumeOperations(opsCtx); } finally { settingsResumed = settings.resume(pass?.settledFor); }
      // A door to open once its agent is free ("Anyone can knock" turned on
      // while a change held it), whose wait the restart cut off: opened once
      // the agent's own operations are settled and its container is up (HB-1264).
      try { channels.knocks.resumeKnockDoors(pass?.settledFor, bootUpWait); } catch (err) { app.log.error({ err: String(err) }, 'doors to open could not be taken up'); }
      // Six agents at a time, each once its own operations are settled.
      const afterStartOwed = sixAtATimeWhenReady(runningAtBoot, (was) => pass!.settledFor(was.id), async (was) => {
        const now = store.getAgent(was.id);
        // Stopped, moved or gone since, or rebuilt (its new container's setup ran them), or one in flight that will.
        if (!now || now.state !== 'RUNNING' || now.runtimeRef !== was.runtimeRef || now.migratedTo || isInFlight(now.id) || !owedAfterStart(now)) return;
        // An operation of its own not over (held for its owner's choice, or
        // waiting its turn): one whose end starts it does what follows then,
        // as Start does; any other (a snapshot restore) never would, so it is
        // done once that operation is over, in the background, if the agent
        // still runs this container and still owes it (HB-0833 review).
        const active = store.activeOperationFor(now.id);
        if (active) {
          if (!STARTS_IT_AT_ITS_END.has(active.kind)) void afterItsOperation(now).catch(() => undefined);
          return;
        }
        await clearPinsWhenUp(now);
      }).catch((err: unknown) => { app.log.error({ err: String(err) }, 'what follows a start could not be taken up'); });
      const docsSynced = sixAtATimeWhenReady(docsOwed, (owed) => pass!.settledFor(owed.agentId), async ({ agentId, value }) => {
        if (store.agentHold(agentId, 'docs-sync') !== value) return; // synced by this process since, or asked again
        const a = store.getAgent(agentId);
        if (!a || a.state !== 'RUNNING' || !a.runtimeRef || a.migratedTo) { store.clearAgentHold(agentId, 'docs-sync', value); return; }
        const provider = providerFor(a.hostId);
        // A container the record says is running that is not up yet (the whole
        // machine restarted, and Docker has not started it again): waited for a
        // little, as its model and limits are, then still owed (afterRestart.ts).
        if (!(await containerUp(provider, a.runtimeRef, bootUpWait))) return;
        // For the ask it is owed, so one this process made since (whose own sync serves it) is not let go here.
        await syncDocsFor(a, provider, value);
      }).catch((err: unknown) => { app.log.error({ err: String(err) }, 'owed AGENTS.md syncs could not be taken up'); });
      await pass.all;
      // A bot-token step answered before the restart: its setup runs now,
      // with the token held on disk (telegramManual.ts).
      for (const a of store.listAllActiveAgents()) {
        if (a.state !== 'PROVISIONING' || !a.pendingAction?.received) continue;
        // A token answer whose token was never held (the restart came in the
        // middle of the paste): the owner is asked again.
        const held = a.webOnly || !deps.channel.waitingFor || await deps.channel.waitingFor(a.id).catch(() => false);
        if (!held) { store.setAgentPendingAction(a.id, { type: 'bot_token', instructions: a.pendingAction.instructions }); continue; }
        provisionWhenFree(a.id);
      }
      // An app waiting for its agent's setup (a new agent "from a repo") went
      // in only when that setup finished in this process: one whose setup
      // ended before a restart (or was settled by it) goes in now.
      for (const id of store.listAppPendingAgents()) {
        if (store.getAgent(id)?.state === 'RUNNING') await runPendingApp(id).catch(() => {});
      }
      await settingsResumed;
      await afterStartOwed;
      await docsSynced;
    },
    /**
     * At boot (HB-1053): each owner with confirmed changes this restart cut
     * off (markInterruptedConfirms) is told through their management agent,
     * one note in its own conversation once its container is up, as the
     * settings' waits are (afterRestart.ts). A courtesy: a manager not
     * running, not up in time or busy is told nothing, and the cards say it
     * all. Never rejects.
     */
    tellInterruptedConfirms: async (cards: InterruptedConfirm[]) => {
      const owners = cards.map((c) => c.ownerId).filter((o, i, all) => all.indexOf(o) === i);
      await Promise.all(owners.map(async (ownerId) => {
        try {
          const ops = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
          if (!ops || ops.state !== 'RUNNING' || !ops.runtimeRef) return;
          if (!(await containerUp(providerFor(ops.hostId), ops.runtimeRef, bootUpWait))) return;
          await opsNotifier.notify(ownerId, interruptedConfirmsNote(cards.filter((c) => c.ownerId === ownerId)));
        } catch (err) { app.log.warn({ ownerId, err: String(err) }, 'mgmt.interrupted_note_failed'); }
      }));
    },
    /** Ask again, every 10 minutes, the questions a held operation is waiting on. */
    startOperationRetryLoop: (intervalMs?: number) => startOperationRetryLoop(opsCtx, intervalMs),
    clientSecretSweep: google.delivery.clientSecretSweep,
    /**
     * At shutdown: the services' timers end (HB-0807; each feature's service
     * joins as it moves, HB-0808). Each on its own: one that throws (a build
     * stopped as the process ends) kept every one after it from stopping.
     * The memory service first: it is the one that writes to the store as it
     * stops, putting back a merge the shutdown cuts off (HB-1171).
     */
    stop: () => {
      const stops: Array<[string, () => void]> = [
        ['memory', () => memory.stop()], ['routes', () => routesStop.abort()], ['lifecycle', () => lifecycle.stop()],
        ['settings', () => settings.stop()], ['channels', () => channels.stop()], ['backups', () => backups.stop()],
        ['consoles', () => consoles.stop()], ['machines', () => machines.stop()], ['usage', () => usage.stop()],
        ['schedules', () => schedules.stop()], ['google', () => google.stop()], ['hatchabotAgent', () => hatchabotAgent.stop()],
        ['health', () => health.stop()], ['skills', () => skills.stop()], ['files', () => files.stop()],
        ['memorySearch', () => memorySearch.stop()], ['machineSettings', () => machineSettings.stop()], ['reach', () => reach.stop()],
        ['accounts', () => accounts.stop()],
      ];
      for (const [service, stopIt] of stops) {
        try { stopIt(); } catch (err) { app.log.error({ service, err: String((err as Error)?.message ?? err) }, 'shutdown: a service did not stop'); }
      }
    },
  };
}

/** What registerRoutes hands back to index.ts. */
export interface RoutesHandle {
  stashOldPendingSecrets(): Promise<void>;
  resumeOperations(): Promise<void>;
  /** At boot: tell each owner's management agent of their confirmed changes the restart cut off (HB-1053). Never rejects. */
  tellInterruptedConfirms(cards: InterruptedConfirm[]): Promise<void>;
  startOperationRetryLoop(intervalMs?: number): NodeJS.Timeout;
  /** The pass for a new Google client secret still owed (HB-0463): run every 10 minutes here, and by tests. */
  clientSecretSweep(): Promise<{ pushing: number; waiting: number } | undefined>;
  /** Stop the services registerRoutes built (their timers and waits): called once, at shutdown. */
  stop(): void;
}
