import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { Store, SecondFactorRow } from '../store/store.js';
import { internalPrincipal } from './principal.js';
import { isPublic, publicClientAddress } from './trust.js';
import { verifyPassword } from './accountsAuth.js';
import type { PublicAccessApi } from './publicAccess.js';
import { backupCodeHash, base32Encode, newBackupCode, newTotpSecret, normalizeBackupCode, otpauthUri, totpVerify } from './totp.js';
import { b64u, verifyAssertion, verifyRegistration, WebAuthnError, type StoredPublicKey } from './webauthn.js';

/**
 * Second factors: passkeys, an authenticator app, one-time backup codes
 * (docs/public-access.md, safeguard b).
 *
 * Who must have one: every account with owner rights, before public access
 * can be turned on. Who may: anyone. Where it is asked for: at the public
 * address, at sign-in and again for sensitive actions (publicAccess.ts). At
 * the private address sign-in is unchanged.
 *
 * In identity mode Google is the first factor, and the owner still needs one
 * of these: a Google session open on a borrowed laptop, or a phished Google
 * password, must not be enough to reach the machine's settings from the
 * internet.
 *
 * Changing your factors needs proof beyond the session. At the private
 * address: your current password (a local account). At the public address:
 * the second factor given in the last few minutes (the gate's step-up) when
 * you have one; your current password when you are adding your first.
 */

const BACKUP_CODES = 10;
const CHALLENGE_TTL_MS = 5 * 60_000;

function seal(secret: Buffer, plain: Buffer): string {
  const key = createHmac('sha256', secret).update('second-factor-seal').digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return [iv, ct, c.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}
function unseal(secret: Buffer, sealed: string): Buffer | undefined {
  try {
    const [iv, ct, tag] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
    const key = createHmac('sha256', secret).update('second-factor-seal').digest();
    const d = createDecipheriv('aes-256-gcm', key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(ct!), d.final()]);
  } catch {
    return undefined;
  }
}

export interface SecondFactorDeps { store: Store; secret: Buffer; api: PublicAccessApi }

export function registerSecondFactorRoutes(app: FastifyInstance, deps: SecondFactorDeps): void {
  const { store, secret, api } = deps;
  const challenges = new Map<string, { challenge: string; exp: number }>();
  const issue = (key: string): string => {
    const challenge = randomBytes(32).toString('base64url');
    challenges.set(key, { challenge, exp: Date.now() + CHALLENGE_TTL_MS });
    if (challenges.size > 2000) for (const [k, v] of challenges) if (Date.now() > v.exp) challenges.delete(k);
    return challenge;
  };
  /** One use: taken out whether or not what follows succeeds. */
  const take = (key: string): string | undefined => {
    const c = challenges.get(key);
    challenges.delete(key);
    return c && Date.now() <= c.exp ? c.challenge : undefined;
  };

  /** The signed-in person, never the management agent's in-process reads. */
  const me = (req: FastifyRequest, reply: FastifyReply): string | undefined => {
    if (internalPrincipal(req)) { void reply.code(403).send({ error: 'Only the person themselves manages their second factor.' }); return undefined; }
    const id = req.principal?.ownerId;
    if (!id || req.principal?.via === 'header') { void reply.code(401).send({ error: 'auth required' }); return undefined; }
    return id;
  };
  /** A factor added or removed goes on the security record, with where it was done: the owner can see a factor they did not add. */
  const recordChange = (req: FastifyRequest, kind: 'second_factor.added' | 'second_factor.removed', ownerId: string, what: string): void => {
    try { store.recordSecurity(kind, ownerId, { method: what, ...(isPublic(req) ? { from: publicClientAddress(req), at: 'the public address' } : { at: 'the private address' }) }); } catch { /* the record must not break the change */ }
  };
  const nameOf = (ownerId: string): string => store.localAccount(ownerId)?.username ?? store.emailForOwner(ownerId) ?? 'you';
  const real = (ownerId: string): SecondFactorRow[] => store.listSecondFactors(ownerId).filter((f) => f.kind !== 'backup');
  const backupLeft = (ownerId: string): number => store.listSecondFactors(ownerId, { kind: 'backup' }).length;

  /** Proof beyond the session before factors change (see the header). Answers the refusal itself. */
  const proveManage = async (req: FastifyRequest, reply: FastifyReply, ownerId: string, current: unknown): Promise<boolean> => {
    const local = store.localAccount(ownerId);
    // At the public address someone who has a factor has just given it (the gate's step-up).
    // (One the gate counts HERE: a passkey made for another address was never asked for.)
    if (isPublic(req) && api.secondFactorNeed(ownerId) === 'yes') return true;
    if (!local) return true; // a Google account: Google is its password
    // A place in the count while the password is checked: a burst cannot outrun the limit (auth.ts reserve).
    const release = api.throttle.reserve ? api.throttle.reserve(req, local.username) : api.throttle.throttled(req, local.username) ? undefined : () => {};
    if (!release) { void reply.code(429).send({ error: 'Too many failed attempts — try again later.' }); return false; }
    const right = typeof current === 'string' && !!current && local.pwHash !== ''
      && await verifyPassword(current, local.pwHash, local.pwSalt).catch((err: unknown) => { release(); throw err; });
    if (!right) api.throttle.noteFailure(req, local.username);
    release();
    if (!right) {
      void reply.code(401).send({ error: 'Current password is wrong.', needsPassword: true });
      return false;
    }
    return true;
  };

  const newBackupCodes = (ownerId: string): string[] => {
    store.deleteSecondFactors(ownerId, 'backup');
    const codes: string[] = [];
    for (let i = 0; i < BACKUP_CODES; i++) {
      const code = newBackupCode();
      codes.push(code);
      store.insertSecondFactor({ id: `sf-${randomUUID()}`, ownerId, kind: 'backup', data: backupCodeHash(secret, ownerId, code) });
    }
    return codes;
  };

  const requestHost = (req: FastifyRequest): string | undefined => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    try { if (origin) return new URL(origin).hostname.toLowerCase(); } catch { /* fall through */ }
    const fwd = req.headers['x-forwarded-host'];
    const host = (Array.isArray(fwd) ? fwd[0] : fwd) ?? req.headers.host;
    return host?.split(',')[0]?.trim().toLowerCase().replace(/:\d+$/, '');
  };

  app.get('/v1/second-factor', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const rpId = api.rpId();
    const factors = real(ownerId);
    return {
      factors: factors.map((f) => ({
        id: f.id, kind: f.kind, label: f.label, createdAt: f.createdAt, lastUsedAt: f.lastUsedAt,
        // A passkey belongs to the address it was made at.
        ...(f.kind === 'passkey' ? { madeFor: f.rpId, worksAtPublicAddress: !!rpId && f.rpId === rpId } : {}),
      })),
      backupCodes: backupLeft(ownerId),
      need: api.secondFactorNeed(ownerId),
      ownerRights: api.hasOwnerRights(ownerId),
      methods: [...new Set(factors.map((f) => f.kind)), ...(backupLeft(ownerId) && factors.length ? ['backup'] : [])],
      publicAddress: isPublic(req),
      localAccount: !!store.localAccount(ownerId),
      passkeyAddress: rpId ? `https://${rpId}` : null,
      passkeyHere: !!rpId && requestHost(req) === rpId,
    };
  });

  /** A challenge for signing in with a passkey. */
  app.post('/v1/second-factor/challenge', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const rpId = api.rpId();
    const keys = real(ownerId).filter((f) => f.kind === 'passkey' && f.rpId === rpId);
    if (!rpId || !keys.length) return reply.code(409).send({ error: 'You have no passkey for this address. Use your authenticator app or a backup code.' });
    return {
      challenge: issue(`get:${ownerId}`), rpId, timeout: 120_000, userVerification: 'preferred',
      allowCredentials: keys.map((k) => ({ type: 'public-key', id: k.credentialId })),
    };
  });

  /**
   * Give the second factor: an authenticator code, a backup code, or a
   * passkey's answer to the challenge. Counted per person and per address
   * like a password; a backup code is spent by the request that uses it.
   */
  app.post<{ Body: { code?: string; passkey?: { id?: string; clientDataJSON?: string; authenticatorData?: string; signature?: string } } }>('/v1/second-factor/verify', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const bucket = `2fa:${ownerId}`;
    if (api.throttle.throttled(req, bucket, '2fa')) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    const body = req.body ?? {};
    let method: 'passkey' | 'totp' | 'backup' | undefined;
    if (body.passkey) {
      const challenge = take(`get:${ownerId}`);
      const row = typeof body.passkey.id === 'string' ? store.secondFactorByCredential(body.passkey.id) : undefined;
      const rpId = api.rpId();
      if (challenge && row && row.ownerId === ownerId && row.kind === 'passkey' && rpId && row.rpId === rpId) {
        try {
          const key = JSON.parse(row.data) as StoredPublicKey;
          const r = verifyAssertion(
            { clientDataJSON: String(body.passkey.clientDataJSON ?? ''), authenticatorData: String(body.passkey.authenticatorData ?? ''), signature: String(body.passkey.signature ?? '') },
            { publicKey: key, signCount: row.signCount },
            { challenge, origins: api.origins(), rpId },
          );
          store.touchPasskey(row.id, r.signCount);
          method = 'passkey';
        } catch (err) {
          if (!(err instanceof WebAuthnError)) throw err;
          app.log.warn({ ownerId, why: err.message }, 'second_factor.passkey_refused');
        }
      }
    } else if (typeof body.code === 'string' && body.code.trim()) {
      const typed = body.code.trim();
      if (/^\d{6}$/.test(typed.replace(/\s/g, ''))) {
        for (const row of real(ownerId).filter((f) => f.kind === 'totp')) {
          const key = unseal(secret, row.data);
          const step = key ? totpVerify(key, typed, { lastStep: row.lastStep }) : undefined;
          // The step is claimed in the database: the same code cannot pass twice, even at once.
          if (step !== undefined && store.advanceTotpStep(row.id, step)) { method = 'totp'; break; }
        }
      } else if (normalizeBackupCode(typed).length === 12 && real(ownerId).length > 0) {
        if (store.spendBackupCode(ownerId, backupCodeHash(secret, ownerId, typed))) method = 'backup';
      }
    }
    if (!method) {
      api.throttle.noteFailure(req, bucket, '2fa');
      await new Promise((r) => setTimeout(r, 300));
      return reply.code(401).send({ error: body.passkey ? 'That passkey did not verify. Try again, or use a code.' : 'That code is not right.' });
    }
    api.secondFactorPassed(req, reply);
    if (isPublic(req)) {
      try { store.recordSecurity('public.second_factor', ownerId, { method, from: publicClientAddress(req) }); } catch { /* the record must not break sign-in */ }
    }
    if (method === 'backup') app.log.warn({ ownerId, left: backupLeft(ownerId) }, 'second_factor.backup_code_used');
    return { ok: true, method, backupCodes: backupLeft(ownerId) };
  });

  /** Start adding an authenticator app: a new secret, shown once as a QR code; it counts only once a code from it is confirmed. */
  app.post<{ Body: { current?: string } }>('/v1/second-factor/totp', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    if (!(await proveManage(req, reply, ownerId, req.body?.current))) return reply;
    store.deleteSecondFactors(ownerId, 'totp', { unconfirmedOnly: true });
    const key = newTotpSecret();
    const id = `sf-${randomUUID()}`;
    store.insertSecondFactor({ id, ownerId, kind: 'totp', label: 'Authenticator app', data: seal(secret, key), confirmed: false });
    const uri = otpauthUri(key, nameOf(ownerId));
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.header('cache-control', 'no-store').send({ id, secret: base32Encode(key), uri, qr });
  });

  app.post<{ Body: { id?: string; code?: string } }>('/v1/second-factor/totp/confirm', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const bucket = `2fa:${ownerId}`;
    if (api.throttle.throttled(req, bucket, '2fa')) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    const row = store.listSecondFactors(ownerId, { kind: 'totp', unconfirmed: true }).find((f) => f.id === req.body?.id && !f.confirmedAt);
    const key = row ? unseal(secret, row.data) : undefined;
    const step = key ? totpVerify(key, String(req.body?.code ?? '')) : undefined;
    if (!row || step === undefined) {
      api.throttle.noteFailure(req, bucket, '2fa');
      return reply.code(401).send({ error: 'That code is not right. Check the app shows this Hatchabot, and try the next code.' });
    }
    const first = real(ownerId).length === 0;
    // One authenticator app at a time: the new one replaces the old.
    for (const old of real(ownerId).filter((f) => f.kind === 'totp')) store.deleteSecondFactor(ownerId, old.id);
    store.confirmSecondFactor(row.id);
    store.advanceTotpStep(row.id, step);
    app.log.warn({ ownerId }, 'second_factor.totp_added');
    recordChange(req, 'second_factor.added', ownerId, 'totp');
    api.secondFactorPassed(req, reply);
    void api.evaluate().catch(() => {});
    return { ok: true, ...(first || backupLeft(ownerId) === 0 ? { backupCodes: newBackupCodes(ownerId) } : {}) };
  });

  /** Options for navigator.credentials.create(). */
  app.post<{ Body: { current?: string } }>('/v1/second-factor/passkey/options', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const rpId = api.rpId();
    if (!rpId) return reply.code(409).send({ error: 'A passkey needs this Hatchabot\'s https address, and it has none yet (the setup guide\'s "Turn on HTTPS" step). An authenticator app works without one.' });
    if (requestHost(req) !== rpId) {
      return reply.code(409).send({ error: `A passkey is tied to the address it is made at. Open Hatchabot at https://${rpId} and add it there, or use an authenticator app.` });
    }
    if (!(await proveManage(req, reply, ownerId, req.body?.current))) return reply;
    const name = nameOf(ownerId);
    return {
      challenge: issue(`create:${ownerId}`),
      rp: { id: rpId, name: 'Hatchabot' },
      user: { id: createHash('sha256').update(`passkey-user:${ownerId}`).digest().subarray(0, 16).toString('base64url'), name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      excludeCredentials: real(ownerId).filter((f) => f.kind === 'passkey').map((k) => ({ type: 'public-key', id: k.credentialId })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none',
      timeout: 120_000,
    };
  });

  app.post<{ Body: { label?: string; clientDataJSON?: string; attestationObject?: string } }>('/v1/second-factor/passkey', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const challenge = take(`create:${ownerId}`);
    const rpId = api.rpId();
    if (!challenge || !rpId) return reply.code(409).send({ error: 'That took too long. Start adding the passkey again.' });
    try {
      const cred = verifyRegistration(
        { clientDataJSON: String(req.body?.clientDataJSON ?? ''), attestationObject: String(req.body?.attestationObject ?? '') },
        { challenge, origins: api.origins(), rpId },
      );
      if (store.secondFactorByCredential(cred.credentialId)) return reply.code(409).send({ error: 'That passkey is already added.' });
      const first = real(ownerId).length === 0;
      const label = String(req.body?.label ?? '').trim().slice(0, 60) || 'Passkey';
      store.insertSecondFactor({ id: `sf-${randomUUID()}`, ownerId, kind: 'passkey', label, credentialId: cred.credentialId, rpId, data: JSON.stringify(cred.publicKey), signCount: cred.signCount });
      app.log.warn({ ownerId, rpId, backedUp: cred.backedUp }, 'second_factor.passkey_added');
      recordChange(req, 'second_factor.added', ownerId, 'passkey');
      api.secondFactorPassed(req, reply);
      void api.evaluate().catch(() => {});
      return { ok: true, label, ...(first || backupLeft(ownerId) === 0 ? { backupCodes: newBackupCodes(ownerId) } : {}) };
    } catch (err) {
      if (err instanceof WebAuthnError) return reply.code(400).send({ error: `That passkey could not be added: ${err.message}.` });
      throw err;
    }
  });

  /** New backup codes; the old ones stop working. */
  app.post<{ Body: { current?: string } }>('/v1/second-factor/backup-codes', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    if (!real(ownerId).length) return reply.code(409).send({ error: 'Add a passkey or an authenticator app first; backup codes stand in for one.' });
    if (!(await proveManage(req, reply, ownerId, req.body?.current))) return reply;
    return reply.header('cache-control', 'no-store').send({ backupCodes: newBackupCodes(ownerId) });
  });

  app.delete<{ Params: { id: string }; Body: { current?: string } }>('/v1/second-factor/:id', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    const row = real(ownerId).find((f) => f.id === req.params.id);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    // The last factor of someone with owner rights is what public access stands on.
    const host = api.rpId();
    const usableAfter = real(ownerId).filter((f) => f.id !== row.id && (f.kind === 'totp' || !host || f.rpId === host)).length;
    if (api.config().on && api.hasOwnerRights(ownerId) && usableAfter === 0) {
      return reply.code(409).send({ error: 'This is your only second factor, and public access is on. Add another first, or turn public access off (Settings → Reach it from anywhere).' });
    }
    if (!(await proveManage(req, reply, ownerId, (req.body as { current?: string } | null)?.current))) return reply;
    store.deleteSecondFactor(ownerId, row.id);
    if (real(ownerId).length === 0) store.deleteSecondFactors(ownerId, 'backup');
    app.log.warn({ ownerId, kind: row.kind }, 'second_factor.removed');
    recordChange(req, 'second_factor.removed', ownerId, row.kind);
    // What was proved with the old set of factors is void: consoles opened at the public address close.
    app.consoleSockets?.closeFor(ownerId, { publicOnly: true });
    void api.evaluate().catch(() => {});
    return { ok: true };
  });

  /**
   * The machine's owner clears someone's second factors (a lost phone and no
   * backup codes). Private address only (the route table refuses it at the
   * public one). If that person has owner rights and public access is on, it
   * pauses until they enrol again: the safeguard is judged right away.
   */
  app.post<{ Params: { id: string } }>('/v1/second-factor/reset/:id', async (req, reply) => {
    const ownerId = me(req, reply);
    if (!ownerId) return reply;
    if (isPublic(req)) return reply.code(403).send({ error: 'Not at the public address.' });
    if (!api.hasOwnerRights(ownerId)) {
      return reply.code(403).send({ error: 'Only the owner of this machine can reset a second factor.' });
    }
    const target = req.params.id === 'me' ? ownerId : (store.localAccount(req.params.id)?.id ?? store.localAccountByUsername(req.params.id)?.id ?? (req.params.id.startsWith('user-') ? req.params.id : undefined));
    if (!target) return reply.code(404).send({ error: 'Not found' });
    const removed = store.deleteSecondFactors(target);
    try { store.recordSecurity('second_factor.reset', target, { by: ownerId, removed }); } catch { /* best effort */ }
    app.log.warn({ by: ownerId, target, removed }, 'second_factor.reset');
    // A reset is for a lost phone or a suspicion: either way, that person's open public consoles end now.
    app.consoleSockets?.closeFor(target, { publicOnly: true });
    await api.evaluate().catch(() => {});
    return { ok: true, removed, publicAccess: api.status().serving ? 'serving' : api.config().on ? 'paused' : 'off' };
  });
}

/** For tests and the click-through's fixtures: seal a TOTP secret the way the routes do. */
export const _sealForTest = seal;
export { b64u };
