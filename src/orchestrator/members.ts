import { randomUUID } from 'node:crypto';
import type { ChannelKind } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { ACCOUNT_SHAPE, ID_SHAPE } from './channelIds.js';
import { approvePairing, listPairingRequests, PAIRING_DB, PAIRING_DB_JS, pairingStorePath } from './claim.js';
import { CHANNEL_ACCOUNT } from '../openclaw/configWriter.js';

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
  /** Which channel the request came in on. Telegram when absent. */
  kind?: ChannelKind;
  agentName: string;
  sharedMemory: boolean;
  /**
   * "That's me — link & approve": the approving OWNER states the requester is
   * themself. Binds the owner seat, records the Telegram id on their ACCOUNT
   * (so every future agent admits them at creation), and absorbs any duplicate
   * member rows carrying the same id. Without it, a fresh account's first
   * self-approval minted the owner a second time as a member named from their
   * Telegram profile, and the account-level link never formed.
   */
  asSelf?: boolean;
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
  const kind = opts.kind ?? 'telegram';
  if (kind !== 'telegram') return admitOtherChannel(deps, { ...opts, kind });
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});

  const requests = await listPairingRequests(provider, opts.runtimeRef, opts.accountId);
  const req = requests.find((r) => r.code === opts.code);
  if (!req) throw new AdmitError('That request is no longer pending. Ask them to message again.');

  if (!(await approvePairing(provider, opts.runtimeRef, opts.accountId, opts.code))) {
    throw new AdmitError("Couldn't approve the request — try again.");
  }

  // The owner talking to their OWN agent should claim the owner seat, not
  // become a "member" of it. On an agent whose owner seat was never bound to
  // Telegram (typically one created before pair-once), the owner's first
  // message lands here as a pending request; without this it would mint a
  // member row named from their Telegram profile — the same person listed
  // twice. If this telegram id is the owner's own (known from any of their
  // agents), bind the owner seat instead.
  const agent = store.getAgent(opts.agentId);
  if (agent && (opts.asSelf || store.knownChannelUserId(agent.ownerId) === req.id)) {
    store.bindMembershipChannelUser(opts.agentId, agent.ownerId, req.id);
    if (opts.asSelf) {
      // The explicit link: account-level, so it survives deleting every agent
      // and seeds the owner seat of everything created from now on. Absorb any
      // duplicate member rows this identity minted before the link existed.
      store.setAccountTelegram(agent.ownerId, req.id);
      const absorbed = store.absorbOwnerTelegram(agent.ownerId, req.id);
      log('member.telegram_linked', { agentId: opts.agentId, channelUserId: req.id, absorbed });
    } else {
      log('member.owner_self_claim', { agentId: opts.agentId, channelUserId: req.id });
    }
    return {
      userId: agent.ownerId,
      displayName: 'You', // the owner seat is rendered as "You", never a name
      channelUserId: req.id,
      alreadyMember: true,
    };
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

/**
 * admitMember for Slack and Discord. Same shape as Telegram's, with the
 * identity kept in member_identities. There is no account-level link for
 * these yet, so the owner is recognised only by "That's me".
 */
async function admitOtherChannel(deps: RevokeDeps, opts: AdmitOptions & { kind: Exclude<ChannelKind, 'telegram'> }): Promise<AdmitResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const { kind } = opts;

  const requests = await listPairingRequests(provider, opts.runtimeRef, opts.accountId, kind);
  const req = requests.find((r) => r.code === opts.code);
  if (!req) throw new AdmitError('That request is no longer pending. Ask them to message again.');
  if (!(await approvePairing(provider, opts.runtimeRef, opts.accountId, opts.code, kind))) {
    throw new AdmitError("Couldn't approve the request — try again.");
  }

  const agent = store.getAgent(opts.agentId);
  if (agent && opts.asSelf) {
    if (!store.bindMemberIdentity(opts.agentId, agent.ownerId, kind, req.id)) {
      throw new AdmitError('You are already linked to a different account on this channel.');
    }
    log('member.owner_self_claim', { agentId: opts.agentId, kind, channelUserId: req.id });
    return { userId: agent.ownerId, displayName: 'You', channelUserId: req.id, alreadyMember: true };
  }

  const existing = store.getMemberByIdentity(opts.agentId, kind, req.id);
  if (existing) {
    const m = store.listMemberships(opts.agentId).find((x) => x.userId === existing.userId);
    return { userId: existing.userId, displayName: m?.displayName ?? existing.userId, channelUserId: req.id, alreadyMember: true };
  }

  const displayName =
    ([req.meta?.firstName, req.meta?.lastName].filter(Boolean).join(' ') ||
      req.meta?.username ||
      `Member ${req.id}`).slice(0, 64);
  const userId = `member-${randomUUID()}`;
  store.insertMembership({
    id: randomUUID(), agentId: opts.agentId, userId, role: 'user', displayName,
    status: 'active', joinedAt: new Date().toISOString(),
  });
  store.bindMemberIdentity(opts.agentId, userId, kind, req.id);
  log('member.admitted', { agentId: opts.agentId, userId, kind, channelUserId: req.id, displayName });

  const disclosure = opts.sharedMemory
    ? ' Heads up: this is a shared agent — things you tell it may be remembered and shared with the other people who use it.'
    : '';
  const sent = await provider
    .exec(opts.runtimeRef, [
      'message', 'send', '--channel', kind, '--account', opts.accountId, '--target', `user:${req.id}`,
      '-m', `You're in! You're now a member of ${opts.agentName}.${disclosure} Say hi whenever you're ready.`,
    ])
    .catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
  if (sent.code !== 0) log('member.welcome_failed', { agentId: opts.agentId, userId, kind, stderr: sent.stderr });
  return { userId, displayName, channelUserId: req.id, alreadyMember: false };
}

/**
 * Tell everyone in the agent's chat something — one DM per active member with
 * a bound Telegram identity (bots have no broadcast). Best-effort throughout:
 * an announcement must never fail the operation it documents. Used for bot
 * renames, so the chat itself records "this bot is now called X" instead of
 * the label silently changing under people.
 */
export async function announceToMembers(
  deps: RevokeDeps,
  opts: { agentId: string; runtimeRef: string; accountId: string; text: string },
): Promise<number> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const targets = store
    .listMemberships(opts.agentId)
    .filter((m) => m.status === 'active' && m.channelUserId);
  let sent = 0;
  for (const m of targets) {
    const res = await provider
      .exec(opts.runtimeRef, [
        'message', 'send', '--channel', 'telegram',
        '--account', opts.accountId, '--target', m.channelUserId!, '-m', opts.text,
      ])
      .catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
    if (res.code === 0) sent++;
  }
  log('members.announced', { agentId: opts.agentId, sent, of: targets.length });
  return sent;
}

export interface DenyOptions {
  agentId: string;
  runtimeRef: string;
  /** OpenClaw pairing code of the pending request being turned away. */
  code: string;
  /** Which channel the request came in on. Telegram when absent. */
  kind?: ChannelKind;
}

/**
 * Turn a pending pairing request away. OpenClaw's CLI has approve/list but NO
 * deny verb (verified against 2026.7.1), so — exactly like revokeMember's
 * allowlist scrub — this is a small atomic surgery on the pairing store that
 * lives on the agent's volume (credentials/telegram-pairing.json), run in a
 * one-shot container so it works on a stopped agent too.
 *
 * This drops the pending REQUEST; it is not a ban. If they message the bot
 * again OpenClaw records a fresh request — which is the honest behaviour for a
 * "not now", and callers word it that way.
 */
export async function denyPairing(
  deps: RevokeDeps,
  opts: DenyOptions,
): Promise<{ denied: boolean }> {
  const { provider } = deps;
  const log = deps.log ?? (() => {});
  // Defence in depth: the code is embedded via JSON.stringify below, but never
  // let anything but a plain pairing code near the script in the first place.
  if (!/^[A-Za-z0-9]{4,16}$/.test(opts.code)) {
    throw new AdmitError('That pairing code looks wrong.');
  }
  const script = `node -e '
    const fs = require("fs");
    const f = ${JSON.stringify(pairingStorePath(opts.kind ?? 'telegram'))};
    if (!fs.existsSync(f)) {
      // 2026.9: the request is a row in the state database.
      if (!fs.existsSync(${JSON.stringify(PAIRING_DB)})) { console.log("0"); process.exit(0); }
      ${PAIRING_DB_JS.open(false)}
      const r = db.prepare("delete from channel_pairing_requests where channel_key = ? and code = ?").run(${JSON.stringify(opts.kind ?? 'telegram')}, ${JSON.stringify(opts.code)});
      console.log(String(r.changes)); process.exit(0);
    }
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    const before = Array.isArray(d.requests) ? d.requests.length : 0;
    d.requests = (Array.isArray(d.requests) ? d.requests : [])
      .filter((r) => String(r && r.code) !== ${JSON.stringify(opts.code)});
    if (d.requests.length !== before) {
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); // credentials stay 0600
      fs.renameSync(tmp, f);                                             // atomic swap
    }
    console.log(String(before - d.requests.length));'`;
  const res = await provider.execShellOnVolume(opts.runtimeRef, script);
  if (res.code !== 0) {
    throw new AdmitError('Turning that request away failed — try again in a moment.');
  }
  const denied = Number(res.stdout.trim()) > 0;
  log('pairing.denied', { agentId: opts.agentId, code: opts.code, denied });
  return { denied };
}

/**
 * Add a channel identity to an agent's LIVE allowlist, without a pairing
 * request — the mirror of the scrub in revokeMember, and the reason someone
 * you already know never has to do the pairing dance twice.
 *
 * Both on-volume files the runtime unions are written (verified against
 * OpenClaw 2026.6.11): the credentials allowFrom where approvals land, and the
 * config the next rebuild seeds from. The gateway re-reads per message, so it
 * takes effect immediately — no rebuild.
 */
export async function grantChannelAccess(
  deps: RevokeDeps,
  opts: { agentId: string; runtimeRef: string; kind: ChannelKind; accountId: string; channelUserId: string },
): Promise<void> {
  const log = deps.log ?? (() => {});
  if (!ID_SHAPE[opts.kind].test(opts.channelUserId) || !/^[A-Za-z0-9_]{1,64}$/.test(opts.accountId)) {
    throw new AdmitError('That chat id has an unexpected shape, so the allowlist was not touched.');
  }
  const target = {
    channel: opts.kind,
    acct: opts.accountId,
    id: opts.channelUserId,
    cred: `/home/node/.openclaw/credentials/${opts.kind}-${opts.accountId.toLowerCase()}-allowFrom.json`,
  };
  const script = `node -e '
    const fs = require("fs");
    const writeAtomic = (f, obj) => {
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, f);   // atomic: the gateway re-reads per message
    };
    const t = ${JSON.stringify(target)};
    const add = (arr) => {
      const a = Array.isArray(arr) ? arr.slice() : [];
      if (!a.some((x) => String(x) === t.id)) a.push(t.id);
      return a;
    };
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)}) && !fs.existsSync(t.cred)) {
      // 2026.9: approvals are rows in the state database, not a file.
      ${PAIRING_DB_JS.open(false)}
      const next = db.prepare("select coalesce(max(sort_order), -1) + 1 as n from channel_pairing_allow_entries where channel_key = ? and lower(account_id) = lower(?)").get(t.channel, t.acct).n;
      db.prepare("insert or ignore into channel_pairing_allow_entries (channel_key, account_id, entry, sort_order, updated_at) values (?, ?, ?, ?, ?)").run(t.channel, t.acct, t.id, next, Date.now());
    } else {
      const d = fs.existsSync(t.cred) ? JSON.parse(fs.readFileSync(t.cred, "utf8")) : {};
      d.allowFrom = add(d.allowFrom);
      writeAtomic(t.cred, d);
    }
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const acc = cfg.channels && cfg.channels[t.channel] && cfg.channels[t.channel].accounts
        && cfg.channels[t.channel].accounts[t.acct];
      if (acc) { acc.allowFrom = add(acc.allowFrom); writeAtomic(cfgPath, cfg); }
    }'`;
  const res = await deps.provider.execShellOnVolume(opts.runtimeRef, script);
  if (res.code !== 0) {
    throw new AdmitError('Adding them to the bot allowlist failed — try again in a moment.');
  }
  log('member.allowlist_granted', { agentId: opts.agentId, kind: opts.kind });
}

/**
 * Forget everyone a channel had admitted, on the volume, when the channel is
 * removed from the agent. The rebuild rewrites the CONFIG allowlist from
 * memberships, but OpenClaw also unions in its own approval store (the
 * 2026.9 allow rows, the 2026.7 credentials file), and that outlived a
 * detach: the next bot attached under the same account key (`hatchabot` for
 * every Discord and Slack bot) admitted the people the owner had dropped,
 * with no membership to show for it (2026-09-25). Best effort by contract:
 * the caller logs a failure; the rebuild that follows still writes the
 * config from scratch.
 */
export async function scrubChannelAllowlist(
  deps: RevokeDeps,
  opts: { agentId: string; runtimeRef: string; kind: ChannelKind; accountId: string },
): Promise<boolean> {
  const log = deps.log ?? (() => {});
  if (!ACCOUNT_SHAPE.test(opts.accountId)) return false;
  const t = { channel: opts.kind, acct: opts.accountId, cred: `/home/node/.openclaw/credentials/${opts.kind}-${opts.accountId.toLowerCase()}-allowFrom.json` };
  const script = `node -e '
    const fs = require("fs");
    const t = ${JSON.stringify(t)};
    let n = 0;
    if (fs.existsSync(t.cred)) { fs.unlinkSync(t.cred); n++; }
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) {
      ${PAIRING_DB_JS.open(false)}
      n += db.prepare("delete from channel_pairing_allow_entries where channel_key = ? and lower(account_id) = lower(?)").run(t.channel, t.acct).changes;
      n += db.prepare("delete from channel_pairing_requests where channel_key = ? and lower(account_id) = lower(?)").run(t.channel, t.acct).changes;
    }
    console.log(String(n));'`;
  const res = await deps.provider.execShellOnVolume(opts.runtimeRef, script);
  if (res.code !== 0) {
    log('channel.allowlist_scrub_failed', { agentId: opts.agentId, kind: opts.kind });
    return false;
  }
  log('channel.allowlist_scrubbed', { agentId: opts.agentId, kind: opts.kind, removed: Number(res.stdout.trim()) || 0 });
  return true;
}

/**
 * Flip an agent's DM policy on its volume, live.
 *
 * `allowlist` is the resting state: OpenClaw drops a DM from anyone not on
 * the list without a word. `pairing` answers a stranger with "access not
 * configured" and a pairing code — useful for exactly as long as we are
 * waiting for somebody specific, and a standing invitation to poke the rest
 * of the time. The gateway reads the config per message, so this takes effect
 * immediately; the next rebuild reseeds the same value from provision.
 */
export async function setDmPolicy(
  deps: RevokeDeps,
  opts: {
    agentId: string; runtimeRef: string; kind: ChannelKind; accountId: string;
    policy: 'allowlist' | 'pairing';
    /**
     * Who the config itself must admit. A fresh agent is written with NO
     * allowFrom key at all (configWriter only writes one when there is
     * somebody to write), and approving a pairing request adds the id to
     * OpenClaw's own credentials store — not to the config. Flipping the
     * policy alone therefore switched the door to "admit the empty list",
     * and the owner's messages were dropped in silence (a Mac, 2026-09-21).
     */
    allowFrom?: string[];
  },
): Promise<boolean> {
  const log = deps.log ?? (() => {});
  if (!/^[A-Za-z0-9_]{1,64}$/.test(opts.accountId)) return false;
  const admit = (opts.allowFrom ?? []).filter((id) => ID_SHAPE[opts.kind].test(id));
  const target = { channel: opts.kind, acct: opts.accountId, policy: opts.policy, admit };
  const script = `node -e '
    const fs = require("fs");
    const t = ${JSON.stringify(target)};
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (!fs.existsSync(cfgPath)) { console.log("no-config"); process.exit(0); }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const acc = cfg.channels && cfg.channels[t.channel] && cfg.channels[t.channel].accounts
      && cfg.channels[t.channel].accounts[t.acct];
    if (!acc) { console.log("no-account"); process.exit(0); }
    const have = Array.isArray(acc.allowFrom) ? acc.allowFrom.map(String) : [];
    const missing = t.admit.filter((id) => !have.includes(String(id)));
    if (acc.dmPolicy === t.policy && !missing.length) { console.log("unchanged"); process.exit(0); }
    acc.dmPolicy = t.policy;
    // The config must carry the list it is about to enforce: an allowlist with
    // nobody in it admits nobody, including the owner.
    if (t.admit.length) acc.allowFrom = [...have, ...missing];
    const tmp = cfgPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, cfgPath);   // atomic: the gateway re-reads per message
    console.log("set");'`;
  const res = await deps.provider.execShellOnVolume(opts.runtimeRef, script);
  const out = res.stdout.trim();
  // A sweep re-asserts the policy every few minutes; "unchanged" is not news
  // (it filled Genetic Algorithm Trading's Setup log, 2026-09-24).
  if (!(res.code === 0 && out === 'unchanged')) log('channel.dm_policy', { agentId: opts.agentId, policy: opts.policy, result: res.code === 0 ? out : `failed:${res.code}` });
  return res.code === 0 && (out === 'set' || out === 'unchanged');
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

  // Every channel they are known on: Telegram (on the membership row) plus
  // Slack and Discord (member_identities). None → flip the row; nothing admits them.
  const ids = store.memberIdentities(agentId, userId);
  if (!Object.keys(ids).length) {
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) {
    // No runtime to scrub (mid-provision). Flip the row so the NEXT rebuild's
    // config drops them; there is no live allowlist yet.
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }

  // Scrub BEFORE flipping the DB row, so a failure is retryable (the row stays
  // 'active' and "remove them again" actually re-runs this). The runtime
  // admits the UNION of two on-volume files (verified against OpenClaw
  // 2026.6.11), and both survive rebuilds, so BOTH must be scrubbed, on every
  // channel the member is known on:
  //   - credentials/<channel>-<acct>-allowFrom.json  (where pairing approvals land)
  //   - openclaw.json channels.<channel>.accounts.<acct>.allowFrom  (what rebuild seeds)
  // Scrubbing only the credentials file left a member baked into config at the
  // last rebuild still admitted — the exact hole "Revoke for real" missed.
  // The credentials FILENAME is lowercased (OpenClaw's on-disk convention);
  // the config KEY keeps the case configWriter seeded.
  const targets: Array<{ channel: string; acct: string; id: string; cred: string }> = [];
  for (const kind of Object.keys(ids) as ChannelKind[]) {
    const id = ids[kind]!;
    const channel = store.getChannelForAgent(agentId, kind);
    if (!channel) continue; // that channel is gone; its config was rewritten without them
    const acct = kind === 'telegram' ? channel.accountId : CHANNEL_ACCOUNT;
    // Identities and account names only ever reach the script if they are the
    // plain shapes the platforms issue.
    if (!ID_SHAPE[kind].test(id) || !/^[A-Za-z0-9_]{1,64}$/.test(acct)) {
      throw new RevokeError(
        'That member has an unexpected chat id, so the bot allowlist was not touched and they ' +
          'may still be able to chat. Delete the agent to be certain.',
      );
    }
    targets.push({ channel: kind, acct, id, cred: `/home/node/.openclaw/credentials/${kind}-${acct.toLowerCase()}-allowFrom.json` });
  }
  if (!targets.length) {
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }
  const script = `node -e '
    const fs = require("fs");
    const writeAtomic = (f, obj) => {
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, f);   // atomic: the gateway re-reads per message
    };
    const targets = ${JSON.stringify(targets)};
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : null;
    let cfgChanged = false;
    // 2026.9: approvals are rows in the state database — scrub them there too,
    // or a removed member stays admitted by the store the gateway unions in.
    let db = null;
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) { const { DatabaseSync } = require("node:sqlite"); db = new DatabaseSync(${JSON.stringify(PAIRING_DB)}); db.exec("PRAGMA busy_timeout=5000"); }
    for (const t of targets) {
      const drop = (arr) => (Array.isArray(arr) ? arr.filter((x) => String(x) !== t.id) : arr);
      if (fs.existsSync(t.cred)) {
        const d = JSON.parse(fs.readFileSync(t.cred, "utf8"));
        d.allowFrom = drop(d.allowFrom || []);
        writeAtomic(t.cred, d);
      }
      if (db) db.prepare("delete from channel_pairing_allow_entries where channel_key = ? and lower(account_id) = lower(?) and entry = ?").run(t.channel, t.acct, t.id);
      const acc = cfg && cfg.channels && cfg.channels[t.channel] && cfg.channels[t.channel].accounts
        && cfg.channels[t.channel].accounts[t.acct];
      if (acc && Array.isArray(acc.allowFrom)) { acc.allowFrom = drop(acc.allowFrom); cfgChanged = true; }
    }
    if (cfgChanged) writeAtomic(cfgPath, cfg);'`;
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
  log('member.allowlist_scrubbed', { agentId, userId, channels: targets.map((t) => t.channel) });
}
