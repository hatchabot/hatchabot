import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultMemoryCap, formatMemoryCap, memberMemoryMax, MEMORY_CAP_CEILING_BYTES } from '../../domain/memoryCap.js';
import { passwordProblem, usernameProblem } from './accountsAuth.js';
import { ownerIdOf, principalOf } from '../principal.js';
import { MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from '../routeContext.js';
import { addressBucket, isPublic, publicClientAddress } from '../trust.js';
import { forwardedOnAppPort } from '../proxyListener.js';

/** POST /v1/auth/family-accounts: the owner's own username and password. `null` is as good as leaving one out. */
const FamilySwitchBody = z.object({ username: z.string().nullish(), password: z.string().nullish() }).nullish();
/** POST /v1/cli-tokens: a label of up to 64 characters, and the `rehost` scope or none. */
const NewCliToken = z.object({ label: z.string().max(64).optional(), scope: z.literal('rehost').optional() }).nullish();

/**
 * Accounts: the routes (HB-0808 step 15 part B). Not the sign-in itself,
 * which is src/api/signIn/auth.ts and src/api/signIn/accountsAuth.ts (`registerAccountRoutes`:
 * the sign-in forms, the first account, a reset link's claim, the recovery
 * code), registered there.
 *
 * Switching one shared password to an account per person
 * (/v1/auth/family-accounts), "Forgot password?" by Telegram
 * (/v1/local-accounts/recover, before sign-in and at the public address
 * too), the command-line tokens (/v1/cli-tokens), the people on one's agents
 * (/v1/users), the accounts a share can be addressed to (/v1/accounts) and
 * the caller's own (/v1/account).
 *
 * Each route checks who is asking where it did, reads its body where it
 * first did, and words the answer; the rules are the accounts service's
 * (`ctx.accounts`, src/orchestrator/accounts/accounts.ts). No hook.
 */
export function registerAccountsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, store, ownsLocalHost } = ctx;
  const { family, recovery, cliTokens, people } = ctx.accounts;

  // ---- one shared password → an account per person (familyAccounts.ts) -----
  app.post('/v1/auth/family-accounts', async (req, reply) => {
    const done = await family.switchOn({ ownsMachine: () => ownsLocalHost(req) }, () => {
      // Read where the body always was: after the mode, owner and one-at-a-time checks.
      const body = FamilySwitchBody.safeParse(req.body);
      if (!body.success) return { problem: zodMessage(body.error) };
      const username = (body.data?.username ?? '').trim();
      const password = body.data?.password ?? '';
      const problem = usernameProblem(username) ?? passwordProblem(password);
      return problem ? { problem } : { username, password };
    });
    if (!done.ok && done.why === 'machine-owner') return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (!done.ok) return reply.code(done.status).send({ error: done.error });
    return done.answer;
  });

  // ---- "Forgot password?" by Telegram (telegramRecovery.ts) ----------------
  // The answer is the same whatever happened, in about the same time.
  (app as unknown as { _resetRecoveryLimits?: () => void })._resetRecoveryLimits = () => recovery.resetLimits();
  app.post<{ Body: { username?: string } }>('/v1/local-accounts/recover', async (req, reply) => {
    const mode = deps.authMode ?? 'password';
    if (mode === 'password') return reply.code(404).send({ error: 'Not found' });
    const same = { ok: true };
    const started = Date.now();
    const settle = async () => {
      // Roughly constant time: a path that sends a message must not answer
      // measurably later than one that found nothing.
      const left = 900 - (Date.now() - started);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      return same;
    };
    // Anything at all is read as a username (String), so no body is ever refused: a refusal would say something.
    const username = String(req.body?.username ?? '').trim();
    await recovery.ask(username, { fromPublic: isPublic(req), address: () => addressBucket(publicClientAddress(req)) });
    return settle();
  });

  // ---- CLI tokens (cliTokens.ts) -------------------------------------------
  // How a non-browser client authenticates. Minted from an already-signed-in
  // session, so it works the same whether the owner uses Google, email, or
  // the shared password.

  app.get('/v1/cli-tokens', async (req) => cliTokens.list(ownerIdOf(req)));

  app.post('/v1/cli-tokens', async (req, reply) => {
    const body = NewCliToken.safeParse(req.body);
    if (!body.success) {
      const at = body.error.issues[0]?.path[0];
      if (at === 'label') return reply.code(400).send({ error: 'label: a string of up to 64 characters.' });
      // scope 'rehost': for another Hatchabot server that will move agents
      // here — it can do that, and nothing else with the token.
      if (at === 'scope') return reply.code(400).send({ error: "scope must be 'rehost' or absent" });
      return reply.code(400).send({ error: zodMessage(body.error) });
    }
    const label = body.data?.label ?? 'CLI';
    const { id, token } = cliTokens.mint(ownerIdOf(req), label, body.data?.scope);
    // Shown once — only the hash is kept.
    return reply.code(201).send({ id, token });
  });

  app.delete<{ Params: { id: string } }>('/v1/cli-tokens/:id', async (req, reply) => {
    if (!cliTokens.revoke(ownerIdOf(req), req.params.id)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return { revoked: true };
  });

  // ---- the people on one's agents (people.ts) ------------------------------
  app.get<{ Querystring: { all?: string } }>('/v1/users', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    // --all (host owner only): every user's agents, for the machine-wide view.
    const wantAll = req.query.all === '1';
    if (wantAll && !ownsLocalHost(req)) {
      return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    }
    return people.roster(ownerId, wantAll);
  });

  // ---- accounts a share can be addressed to, and the caller's own ----------
  app.get('/v1/accounts', async (req) => people.addressees(ownerIdOf(req), () => ownsLocalHost(req)));

  /** The caller's own account: email + linked Telegram identity. */
  app.get('/v1/account', async (req) => {
    const me = principalOf(req);
    return {
      ownerId: me.ownerId,
      email: me.email,
      /** Set by "That's me — link & approve" on a pairing card. */
      telegramUserId: store.accountTelegram(me.ownerId),
      /** "That's me" on a Discord card: the identity every new Discord bot admits from its first build. */
      discordUserId: store.identityOfUserAnywhere(me.ownerId, 'discord'),
      /** True for the account that owns this machine (admin actions in the UI). */
      hostOwner: ownsLocalHost(req),
      /** This person's own choices (Settings): see OwnerPrefs. */
      prefs: store.ownerPrefs(me.ownerId),
      /** Memory caps: the fleet default and the most a member may give one agent (the owner is unbound). */
      memoryCapDefault: defaultMemoryCap(),
      memoryCapMax: ownsLocalHost(req) ? formatMemoryCap(MEMORY_CAP_CEILING_BYTES) : memberMemoryMax(),
      /**
       * The machine's OS, for the machine's owner only: what the setup guide
       * can offer depends on it. "Use this machine's Claude login" only works
       * where the agents' containers can use the host's own login — Linux —
       * and on a Mac it silently makes a source that cannot work.
       */
      ...(ownsLocalHost(req) ? { hostOs: process.platform } : {}),
      /** A reverse proxy on this machine still pointed at the app's own port (proxyListener.ts): the owner's Alerts say so. */
      ...(ownsLocalHost(req) && forwardedOnAppPort() ? { proxyOnAppPort: forwardedOnAppPort() } : {}),
    };
  });
}
