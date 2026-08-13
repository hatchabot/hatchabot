import { randomUUID } from 'node:crypto';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { approvePairing, listPairingRequests } from './claim.js';

/**
 * Revoke = flip status + drop the member from the bot's allowlist immediately
 * (§12.3 step 5). OpenClaw keeps pairing approvals in
 * credentials/telegram-<account>-allowFrom.json on the agent's volume, and its
 * CLI has approve/list but no verb to un-approve — so the removal is a small
 * file surgery.
 *
 * This file surgery is the ONLY act that actually revokes. Verified against
 * OpenClaw 2026.6.11 source: under dmPolicy=pairing the runtime admits the
 * UNION of config allowFrom and this credentials file, the file survives
 * rebuilds (it lives on the volume), and it is re-read per message (mtime
 * cache) — so "rebuild to enforce it" was never true, and no gateway restart
 * is needed for the edit to take effect. The surgery runs in a one-shot
 * container against the volume so it works on a stopped agent too.
 */
export interface RevokeDeps {
  store: Store;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export class RevokeError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'RevokeError';
  }
}

export class AdmitError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'AdmitError';
  }
}

export interface AdmitOptions {
  agentId: string;
  runtimeRef: string;
  accountId: string;
  /** OpenClaw pairing code of the pending request being admitted. */
  code: string;
  agentName: string;
  sharedMemory: boolean;
}

export interface AdmitResult {
  userId: string;
  displayName: string;
  channelUserId: string;
  alreadyMember: boolean;
}

/**
 * The Telegram-native invite path (§12.3 without the web page): the invitee
 * simply messages the bot from anywhere — no tailnet needed — and the owner's
 * "Let them in" tap turns the pending pairing request into a real membership.
 * The §12.6 shared-memory disclosure, which the web join page would have
 * shown before joining, is delivered as the bot's first message instead.
 */
export async function admitMember(deps: RevokeDeps, opts: AdmitOptions): Promise<AdmitResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});

  const requests = await listPairingRequests(provider, opts.runtimeRef, opts.accountId);
  const req = requests.find((r) => r.code === opts.code);
  if (!req) throw new AdmitError('That request is no longer pending. Ask them to message again.');

  if (!(await approvePairing(provider, opts.runtimeRef, opts.accountId, opts.code))) {
    throw new AdmitError("Couldn't approve the request — try again.");
  }

  // Re-approval for someone already admitted (e.g. after a rebuild reset the
  // runtime's pairing state) must not mint a second membership.
  const existing = store.getActiveMembershipByChannelUser(opts.agentId, req.id);
  if (existing) {
    return {
      userId: existing.userId,
      displayName: existing.displayName ?? existing.userId,
      channelUserId: req.id,
      alreadyMember: true,
    };
  }

  const displayName =
    ([req.meta?.firstName, req.meta?.lastName].filter(Boolean).join(' ') ||
      req.meta?.username ||
      `Member ${req.id}`).slice(0, 64);
  const userId = `member-${randomUUID()}`;
  store.insertMembership({
    id: randomUUID(),
    agentId: opts.agentId,
    userId,
    role: 'user',
    displayName,
    channelUserId: req.id,
    status: 'active',
    joinedAt: new Date().toISOString(),
  });
  log('member.admitted', { agentId: opts.agentId, userId, channelUserId: req.id, displayName });

  // Welcome + disclosure. Best-effort: the membership is already real, and
  // they'll see the agent respond to their held message either way.
  const disclosure = opts.sharedMemory
    ? ' Heads up: this is a shared agent — things you tell it may be remembered and shared with the other people who use it.'
    : '';
  const welcome = `You're in! You're now a member of ${opts.agentName}.${disclosure} Say hi whenever you're ready.`;
  const sent = await provider
    .exec(opts.runtimeRef, [
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      opts.accountId,
      '--target',
      req.id,
      '-m',
      welcome,
    ])
    .catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
  if (sent.code !== 0) {
    log('member.welcome_failed', { agentId: opts.agentId, userId, stderr: sent.stderr });
  }

  return { userId, displayName, channelUserId: req.id, alreadyMember: false };
}

export async function revokeMember(
  deps: RevokeDeps,
  agentId: string,
  userId: string,
): Promise<void> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});

  const member = store.getMembership(agentId, userId);
  if (!member) throw new RevokeError('No such member.');
  if (member.role === 'owner') throw new RevokeError("The owner can't be removed.");
  // 'revoked' now means fully revoked INCLUDING the scrub — the status is
  // flipped only after the scrub succeeds, so this early-return is safe and a
  // failed revoke (still 'active') genuinely re-runs when retried.
  if (member.status === 'revoked') return;

  // No Telegram identity → flip the row and we're done; nothing admits them.
  if (!member.channelUserId) {
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }

  const agent = store.getAgent(agentId);
  const channel = store.getChannelForAgent(agentId);
  if (!agent?.runtimeRef || !channel) {
    // No runtime to scrub (mid-provision, no channel). Flip the row so the
    // NEXT rebuild's config drops them; there is no live allowlist yet.
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }

  // Telegram user ids are numeric; anything else never reaches a shell string.
  if (!/^\d{1,32}$/.test(member.channelUserId)) {
    throw new RevokeError(
      'That member has an unexpected chat id, so the bot allowlist was not touched and they ' +
        'may still be able to chat. Delete the agent to be certain.',
    );
  }

  // Scrub BEFORE flipping the DB row, so a failure is retryable (the row stays
  // 'active' and "remove them again" actually re-runs this). The runtime
  // admits the UNION of two on-volume files (verified against OpenClaw
  // 2026.6.11), and both survive rebuilds, so BOTH must be scrubbed:
  //   - credentials/telegram-<acct>-allowFrom.json  (where pairing approvals land)
  //   - openclaw.json channels.telegram.accounts.<acct>.allowFrom  (what rebuild seeds)
  // Scrubbing only the credentials file left a member baked into config at the
  // last rebuild still admitted — the exact hole "Revoke for real" missed.
  const acct = channel.accountId.toLowerCase();
  const id = member.channelUserId;
  const script = `node -e '
    const fs = require("fs");
    const drop = (arr) => (Array.isArray(arr) ? arr.filter((x) => String(x) !== ${JSON.stringify(id)}) : arr);
    const writeAtomic = (f, obj) => {
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, f);   // atomic: the gateway re-reads per message
    };
    const cred = "/home/node/.openclaw/credentials/telegram-" + ${JSON.stringify(acct)} + "-allowFrom.json";
    if (fs.existsSync(cred)) {
      const d = JSON.parse(fs.readFileSync(cred, "utf8"));
      d.allowFrom = drop(d.allowFrom || []);
      writeAtomic(cred, d);
    }
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const acc = cfg.channels && cfg.channels.telegram && cfg.channels.telegram.accounts
        && cfg.channels.telegram.accounts[${JSON.stringify(channel.accountId)}];
      if (acc && Array.isArray(acc.allowFrom)) {
        acc.allowFrom = drop(acc.allowFrom);
        writeAtomic(cfgPath, cfg);
      }
    }'`;
  const res = await provider.execShellOnVolume(agent.runtimeRef, script);
  if (res.code !== 0) {
    // The row is still 'active' (we haven't flipped it), so "remove them
    // again" genuinely retries the scrub. A rebuild would NOT help — both
    // files live on the volume and a rebuild re-seeds config from members.
    throw new RevokeError(
      'Updating the bot allowlist failed, so they are still a member and may still be able to ' +
        'chat. Remove them again to retry.',
    );
  }

  store.revokeMembership(agentId, userId);
  log('member.revoked', { agentId, userId });
  log('member.allowlist_scrubbed', { agentId, userId, channelUserId: member.channelUserId });
}
