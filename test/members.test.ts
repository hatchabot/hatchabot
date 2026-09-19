import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { admitMember, AdmitError, announceToMembers, denyPairing, revokeMember, RevokeError } from '../src/orchestrator/members.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';

async function setup(sharedMemory = true) {
  const db = new Database(':memory:');
  const store = new Store(db);
  const provider = new MockProvider();
  const { runtimeRef } = await provider.provision({
    agentId: 'a1',
    slug: 'a1',
    workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
    env: {},
  });
  store.insertAgent({
    id: 'a1', ownerId: 'u1', name: 'Fam', slug: 'a1', state: 'RUNNING',
    aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory,
    createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
  provider.execResponses.set('sh', {
    code: 0,
    stdout: JSON.stringify({
      requests: [{ id: '555', code: 'CODE1', meta: { username: 'gran', firstName: 'Grandma' } }],
    }),
    stderr: '',
  });
  provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
  const opts = {
    agentId: 'a1', runtimeRef, accountId: 'bot', code: 'CODE1',
    agentName: 'Fam', sharedMemory,
  };
  return { store, provider, opts };
}

describe('admitMember', () => {
  it('approves the request, creates a bound membership, and sends the disclosure', async () => {
    const { store, provider, opts } = await setup(true);
    const res = await admitMember({ store, provider }, opts);

    expect(res).toMatchObject({ displayName: 'Grandma', channelUserId: '555', alreadyMember: false });
    expect(store.listAllowedChannelUserIds('a1')).toEqual(['555']);
    const member = store.getMembership('a1', res.userId);
    expect(member).toMatchObject({ role: 'user', status: 'active', channelUserId: '555' });

    expect(provider.execLog.some((a) => a.join(' ').startsWith('pairing approve telegram CODE1'))).toBe(true);
    const send = provider.execLog.find((a) => a[0] === 'message' && a[1] === 'send');
    expect(send).toBeDefined();
    expect(send!).toContain('555');
    expect(send![send!.length - 1]).toContain('shared agent');
  });

  it('omits the shared-memory disclosure when memory is not shared', async () => {
    const { store, provider, opts } = await setup(false);
    await admitMember({ store, provider }, opts);
    const send = provider.execLog.find((a) => a[0] === 'message' && a[1] === 'send');
    expect(send![send!.length - 1]).not.toContain('shared agent');
  });

  it('does not mint a second membership when the sender is already a member', async () => {
    const { store, provider, opts } = await setup();
    store.insertMembership({
      id: 'm2', agentId: 'a1', userId: 'u2', role: 'user',
      displayName: 'Grandma', channelUserId: '555', status: 'active',
    });
    const res = await admitMember({ store, provider }, opts);
    expect(res).toMatchObject({ userId: 'u2', alreadyMember: true });
    expect(store.listMemberships('a1').filter((m) => m.channelUserId === '555')).toHaveLength(1);
    expect(provider.execLog.some((a) => a[0] === 'message')).toBe(false);
  });

  it('binds the OWNER seat (no member copy) when the owner messages their own agent', async () => {
    // Owner u1's Telegram id 555 is already known from another agent, and this
    // agent's owner seat was never bound (a pre-pair-once agent). Approving the
    // owner's own pairing request must claim the owner seat, not mint a
    // "member" duplicate of the owner.
    const { store, provider, opts } = await setup();
    store.insertAgent({
      id: 'other', ownerId: 'u1', name: 'Other', slug: 'other', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'mo', agentId: 'other', userId: 'u1', role: 'owner', channelUserId: '555', status: 'active' });
    expect(store.knownChannelUserId('u1')).toBe('555');

    const res = await admitMember({ store, provider }, opts);
    expect(res).toMatchObject({ userId: 'u1', alreadyMember: true }); // the owner, not a new member
    // Owner seat on a1 is now bound; no member-* row was created.
    expect(store.getMembership('a1', 'u1')!.channelUserId).toBe('555');
    expect(store.listMemberships('a1')).toHaveLength(1); // owner only
    expect(store.listMemberships('a1').every((m) => m.role === 'owner')).toBe(true);
  });

  it('rejects a code that is no longer pending', async () => {
    const { store, provider, opts } = await setup();
    await expect(admitMember({ store, provider }, { ...opts, code: 'GONE' })).rejects.toBeInstanceOf(
      AdmitError,
    );
    expect(store.listMemberships('a1')).toHaveLength(1); // owner only
  });

  it('still admits when the welcome message fails to send', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('message send', { code: 1, stdout: '', stderr: 'boom' });
    const res = await admitMember({ store, provider }, opts);
    expect(res.alreadyMember).toBe(false);
    expect(store.getMembership('a1', res.userId)?.status).toBe('active');
  });
});

describe('revokeMember', () => {
  async function withMember() {
    const s = await setup();
    s.store.insertChannel({
      id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'MixedCaseBot',
      secretRef: 'chan/a1', deepLink: 'https://t.me/MixedCaseBot', createdAt: 'now',
    });
    s.store.setAgentRuntimeRef('a1', s.opts.runtimeRef);
    await s.provider.start(s.opts.runtimeRef);
    s.store.setAgentState('a1', 'RUNNING');
    s.store.insertMembership({
      id: 'm2', agentId: 'a1', userId: 'u2', role: 'user',
      displayName: 'Gran', channelUserId: '555', status: 'active',
    });
    return s;
  }

  it('revokes and scrubs the lowercased allowlist file on the volume', async () => {
    const { store, provider } = await withMember();
    await revokeMember({ store, provider }, 'a1', 'u2');
    expect(store.getMembership('a1', 'u2')!.status).toBe('revoked');
    expect(store.listAllowedChannelUserIds('a1')).toEqual([]);
    // On the VOLUME, not via exec into the container: the credentials file is
    // what actually admits people (OpenClaw unions it with config), and this
    // path also works while the agent is stopped. No restart needed — the
    // runtime re-reads the file per message.
    const sh = provider.execLog.find((a) => a[0] === 'sh-volume')!;
    expect(sh[1]).toContain('mixedcasebot'); // lowercased account id
    expect(sh[1]).toContain('allowFrom.json');
    expect(sh[1]).toContain('555');
    expect(provider.runtimes.get('mock://a1')!.phase).toBe('running'); // untouched
  });

  it('scrubs the allowlist even when the agent is stopped', async () => {
    const { store, provider } = await withMember();
    await provider.stop('mock://a1');
    store.setAgentState('a1', 'STOPPED');
    await revokeMember({ store, provider }, 'a1', 'u2');
    // Before the one-shot-container fix this path failed (docker exec needs a
    // running container) with advice to rebuild — which would NOT have
    // revoked: the file survives rebuilds on the volume.
    expect(provider.execLog.some((a) => a[0] === 'sh-volume')).toBe(true);
    expect(store.getMembership('a1', 'u2')!.status).toBe('revoked');
  });

  it("refuses to remove the owner and is idempotent on re-revoke", async () => {
    const { store, provider } = await withMember();
    await expect(revokeMember({ store, provider }, 'a1', 'o')).rejects.toBeInstanceOf(RevokeError);
    await revokeMember({ store, provider }, 'a1', 'u2');
    const callsAfterFirst = provider.execLog.length;
    await revokeMember({ store, provider }, 'a1', 'u2'); // no second surgery
    expect(provider.execLog.length).toBe(callsAfterFirst);
  });

  it('leaves the member active and retryable when the scrub fails', async () => {
    const { store, provider } = await withMember();
    provider.execResponses.set('sh-volume', { code: 1, stdout: '', stderr: 'boom' });
    await expect(revokeMember({ store, provider }, 'a1', 'u2')).rejects.toThrow(/still be able to chat/);
    // NOT flipped: the scrub is the thing that revokes, so a failed scrub must
    // leave the row active — otherwise "remove them again" hits the idempotent
    // early-return and never retries (the member stays permanently allowed).
    expect(store.getMembership('a1', 'u2')!.status).toBe('active');

    // Retry now actually re-runs the scrub and succeeds.
    provider.execResponses.delete('sh-volume');
    await revokeMember({ store, provider }, 'a1', 'u2');
    expect(store.getMembership('a1', 'u2')!.status).toBe('revoked');
  });

  it('scrubs BOTH the credentials file and openclaw.json config allowlist', async () => {
    const { store, provider } = await withMember();
    await revokeMember({ store, provider }, 'a1', 'u2');
    const sh = provider.execLog.find((a) => a[0] === 'sh-volume')!;
    // The runtime admits the union of the two, and rebuild re-seeds config
    // from active members — scrubbing only the credentials file left a
    // member baked into config at the last rebuild still able to chat.
    expect(sh[1]).toContain('allowFrom.json');   // credentials file
    expect(sh[1]).toContain('openclaw.json');     // config file
    expect(sh[1]).toContain('555');
    // Lock the deliberate casing asymmetry: the credentials FILENAME is
    // lowercased (OpenClaw's on-disk convention) while the config KEY keeps
    // the original case (matching what configWriter seeds). The account here
    // is 'MixedCaseBot' — both forms must appear, or a "helpful" lowercasing
    // of the config lookup would silently miss every mixed-case bot.
    expect(sh[1]).toContain('mixedcasebot'); // credentials path (lowercased)
    expect(sh[1]).toContain('MixedCaseBot'); // config account key (original case)
  });

  it('skips runtime surgery for a member with no telegram identity', async () => {
    const { store, provider } = await withMember();
    store.insertMembership({ id: 'm3', agentId: 'a1', userId: 'u3', role: 'user', status: 'active' });
    await revokeMember({ store, provider }, 'a1', 'u3');
    expect(provider.execLog.some((a) => a[0] === 'sh-volume')).toBe(false);
  });
});

describe('denyPairing', () => {
  const PAIRING_PATH = '/home/node/.openclaw/credentials/telegram-pairing.json';

  it('reports denied when the surgery removed a request, on the volume', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '1\n', stderr: '' });
    const out = await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef: opts.runtimeRef, code: 'CODE1' });
    expect(out).toEqual({ denied: true });
    // Volume surgery (works on a stopped agent), against the pairing store.
    const sh = provider.execLog.find((a) => a[0] === 'sh-volume')!;
    expect(sh[1]).toContain('telegram-pairing.json');
    expect(sh[1]).toContain('CODE1');
  });

  it('reports denied:false when the request was already gone', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '0\n', stderr: '' });
    expect(await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef: opts.runtimeRef, code: 'CODE1' }))
      .toEqual({ denied: false });
  });

  it('throws (retryable) when the surgery fails', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('sh-volume', { code: 1, stdout: '', stderr: 'boom' });
    await expect(denyPairing({ store, provider }, { agentId: 'a1', runtimeRef: opts.runtimeRef, code: 'CODE1' }))
      .rejects.toBeInstanceOf(AdmitError);
  });

  it('refuses a malformed code without touching the volume', async () => {
    const { store, provider, opts } = await setup();
    await expect(denyPairing({ store, provider }, { agentId: 'a1', runtimeRef: opts.runtimeRef, code: 'nope; rm -rf /' }))
      .rejects.toBeInstanceOf(AdmitError);
    expect(provider.execLog.some((a) => a[0] === 'sh-volume')).toBe(false);
  });

  // The script is the whole feature — OpenClaw has no deny verb — so run the
  // REAL emitted script against a real file and prove it edits it correctly.
  it('the emitted script removes exactly the named request and leaves the rest', async () => {
    const { store, provider, opts } = await setup();
    await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef: opts.runtimeRef, code: 'CODE1' });
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;

    const dir = mkdtempSync(join(tmpdir(), 'acl-deny-'));
    try {
      mkdirSync(join(dir, 'creds'));
      const file = join(dir, 'creds', 'telegram-pairing.json');
      writeFileSync(file, JSON.stringify({
        version: 1,
        requests: [
          { id: '111', code: 'CODE1', meta: { username: 'gran' } },
          { id: '222', code: 'KEEPME', meta: { username: 'other' } },
        ],
      }, null, 2));

      const out = execFileSync('sh', ['-c', script.replaceAll(PAIRING_PATH, file)], { encoding: 'utf8' });
      expect(out.trim()).toBe('1'); // one request removed

      const after = JSON.parse(readFileSync(file, 'utf8'));
      expect(after.requests.map((r: any) => r.code)).toEqual(['KEEPME']); // only the target went
      expect(after.version).toBe(1);                                     // rest of the file intact
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the emitted script is a no-op when the pairing file does not exist', async () => {
    const { store, provider, opts } = await setup();
    await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef: opts.runtimeRef, code: 'CODE1' });
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    const dir = mkdtempSync(join(tmpdir(), 'acl-deny-'));
    try {
      const missing = join(dir, 'nope.json');
      const out = execFileSync('sh', ['-c', script.replaceAll(PAIRING_PATH, missing)], { encoding: 'utf8' });
      expect(out.trim()).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('"That\'s me — link & approve" (account-level Telegram link)', () => {
  it('asSelf binds the owner seat, links the ACCOUNT, and future agents auto-admit', async () => {
    const { store, provider, opts } = await setup();
    const res = await admitMember({ store, provider }, { ...opts, asSelf: true });

    // The owner seat is bound — NOT a second member named from Telegram.
    expect(res).toMatchObject({ userId: 'u1', displayName: 'You', channelUserId: '555' });
    expect(store.listMemberships('a1').filter((m) => m.role !== 'owner')).toHaveLength(0);
    expect(store.getMembership('a1', 'u1')).toMatchObject({ channelUserId: '555' });

    // The account-level link exists and drives knownChannelUserId — even with
    // every membership gone (the flaw in the old inference).
    expect(store.accountTelegram('u1')).toBe('555');
    store.deleteMemberships('a1');
    expect(store.knownChannelUserId('u1')).toBe('555');
  });

  it('asSelf absorbs the duplicate member a pre-link approval minted', async () => {
    const { store, provider, opts } = await setup();
    // The rbc scenario: fresh account approved itself normally first → duplicate
    // member "Christopher" alongside the unbound owner seat.
    store.insertMembership({
      id: 'dup', agentId: 'a1', userId: 'member-x', role: 'user',
      displayName: 'Christopher', channelUserId: '555', status: 'active',
    });
    // A second agent of the same owner with an unbound seat gets bound too.
    store.insertAgent({
      id: 'a2', ownerId: 'u1', name: 'Second', slug: 'a2', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm9', agentId: 'a2', userId: 'u1', role: 'owner', status: 'active' });

    await admitMember({ store, provider }, { ...opts, asSelf: true });

    // Duplicate gone; both owner seats bound; allowlists still carry the id.
    expect(store.listMemberships('a1').map((m) => m.role)).toEqual(['owner']);
    expect(store.getMembership('a2', 'u1')).toMatchObject({ channelUserId: '555' });
    expect(store.listAllowedChannelUserIds('a1')).toEqual(['555']);
    expect(store.listAllowedChannelUserIds('a2')).toEqual(['555']);
  });

  it('without asSelf a fresh account still mints a member (the informed default)', async () => {
    const { store, provider, opts } = await setup();
    const res = await admitMember({ store, provider }, opts);
    expect(res.displayName).toBe('Grandma'); // could genuinely BE grandma
    expect(store.accountTelegram('u1')).toBeUndefined(); // no silent linking
  });

  it('unlink stops future auto-admit but keeps existing bindings', async () => {
    const { store, provider, opts } = await setup();
    await admitMember({ store, provider }, { ...opts, asSelf: true });
    store.setAccountTelegram('u1', null);
    expect(store.accountTelegram('u1')).toBeUndefined();
    // the membership fallback still knows it (existing agents keep working)
    expect(store.getMembership('a1', 'u1')).toMatchObject({ channelUserId: '555' });
  });
});

describe('announceToMembers', () => {
  it('DMs every active member with a bound Telegram id, skipping unbound seats', async () => {
    const { store, provider, opts } = await setup();
    // owner seat unbound (no channelUserId) + two bound members + one revoked
    store.insertMembership({ id: 'b1', agentId: 'a1', userId: 'x1', role: 'user', channelUserId: '111', status: 'active' });
    store.insertMembership({ id: 'b2', agentId: 'a1', userId: 'x2', role: 'user', channelUserId: '222', status: 'active' });
    store.insertMembership({ id: 'b3', agentId: 'a1', userId: 'x3', role: 'user', channelUserId: '333', status: 'revoked' });

    const sent = await announceToMembers({ store, provider }, {
      agentId: 'a1', runtimeRef: opts.runtimeRef, accountId: 'bot',
      text: '🏷 This bot is now named "Fam".',
    });
    expect(sent).toBe(2);
    const targets = provider.execLog
      .filter((a) => a[0] === 'message' && a[1] === 'send')
      .map((a) => a[a.indexOf('--target') + 1]);
    expect(targets.sort()).toEqual(['111', '222']); // not the unbound owner, not the revoked
    // the message rode along
    expect(provider.execLog.find((a) => a[0] === 'message')!.at(-1)).toContain('now named');
  });

  it('a failed send never throws — announcements must not fail the rename', async () => {
    const { store, provider, opts } = await setup();
    store.insertMembership({ id: 'b1', agentId: 'a1', userId: 'x1', role: 'user', channelUserId: '111', status: 'active' });
    provider.execResponses.set('message send', { code: 1, stdout: '', stderr: 'boom' });
    const sent = await announceToMembers({ store, provider }, {
      agentId: 'a1', runtimeRef: opts.runtimeRef, accountId: 'bot', text: 'x',
    });
    expect(sent).toBe(0); // reported honestly, thrown never
  });
});

describe('revoking across channels', () => {
  // Run the REAL emitted script against real files: the scrub is what revokes.
  async function member() {
    const s = await setup();
    s.store.insertChannel({ id: 'ct', agentId: 'a1', kind: 'telegram', accountId: 'FamBot', secretRef: 'x', deepLink: 'x', createdAt: 'now' });
    s.store.insertChannel({ id: 'cs', agentId: 'a1', kind: 'slack', accountId: 'U0BOT', secretRef: 'y', deepLink: 'y', createdAt: 'now' });
    s.store.insertChannel({ id: 'cd', agentId: 'a1', kind: 'discord', accountId: '1', secretRef: 'z', deepLink: 'z', createdAt: 'now' });
    s.store.setAgentRuntimeRef('a1', s.opts.runtimeRef);
    s.store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'u2', role: 'user', displayName: 'Gran', channelUserId: '555', status: 'active' });
    s.store.bindMemberIdentity('a1', 'u2', 'slack', 'U0GRAN');
    s.store.bindMemberIdentity('a1', 'u2', 'discord', '123456789012345678');
    return s;
  }

  it('one script scrubs Telegram, Slack and Discord, files and config', async () => {
    const { store, provider } = await member();
    await revokeMember({ store, provider }, 'a1', 'u2');
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    const dir = mkdtempSync(join(tmpdir(), 'revoke-'));
    try {
      mkdirSync(join(dir, 'credentials'));
      const cred = (n: string, ids: string[]) => writeFileSync(join(dir, 'credentials', n), JSON.stringify({ version: 1, allowFrom: ids }));
      cred('telegram-fambot-allowFrom.json', ['555', '777']);
      cred('slack-hatchabot-allowFrom.json', ['U0GRAN', 'U0OWNER']);
      cred('discord-hatchabot-allowFrom.json', ['123456789012345678']);
      writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ channels: {
        telegram: { accounts: { FamBot: { allowFrom: ['555', '777'] } } },
        slack: { accounts: { hatchabot: { allowFrom: ['U0GRAN', 'U0OWNER'] } } },
        discord: { accounts: { hatchabot: { allowFrom: ['123456789012345678'] } } },
      } }));
      execFileSync('sh', ['-c', script.replaceAll('/home/node/.openclaw', dir)]);
      const read = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
      expect(read('credentials/telegram-fambot-allowFrom.json').allowFrom).toEqual(['777']);
      expect(read('credentials/slack-hatchabot-allowFrom.json').allowFrom).toEqual(['U0OWNER']);
      expect(read('credentials/discord-hatchabot-allowFrom.json').allowFrom).toEqual([]);
      const cfg = read('openclaw.json').channels;
      expect(cfg.telegram.accounts.FamBot.allowFrom).toEqual(['777']);
      expect(cfg.slack.accounts.hatchabot.allowFrom).toEqual(['U0OWNER']);
      expect(cfg.discord.accounts.hatchabot.allowFrom).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(store.getMembership('a1', 'u2')!.status).toBe('revoked');
    expect(store.listAllowedChannelUserIds('a1', 'slack')).toEqual([]);
  });

  it('a Slack-only member is scrubbed too (they have no Telegram id)', async () => {
    const { store, provider } = await member();
    store.insertMembership({ id: 'm3', agentId: 'a1', userId: 'u3', role: 'user', status: 'active' });
    store.bindMemberIdentity('a1', 'u3', 'slack', 'U0SIS');
    await revokeMember({ store, provider }, 'a1', 'u3');
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    expect(script).toContain('U0SIS');
    expect(script).toContain('slack-hatchabot-allowFrom.json');
    expect(script).not.toContain('telegram-');
  });

  it('refuses to put an odd-looking id anywhere near a shell', async () => {
    const { store, provider } = await member();
    store.insertMembership({ id: 'm4', agentId: 'a1', userId: 'u4', role: 'user', status: 'active' });
    store.bindMemberIdentity('a1', 'u4', 'slack', "U0X'; rm -rf /");
    await expect(revokeMember({ store, provider }, 'a1', 'u4')).rejects.toBeInstanceOf(RevokeError);
    expect(provider.execLog.some((a) => a[0] === 'sh-volume')).toBe(false);
    expect(store.getMembership('a1', 'u4')!.status).toBe('active');
  });
});

describe('admitting on Slack and Discord', () => {
  it('a new Slack member is created, bound, and welcomed on Slack', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: 'U0GRAN', code: 'SLK1', meta: { firstName: 'Gran' } }] }), stderr: '' });
    const r = await admitMember({ store, provider }, { ...opts, accountId: 'hatchabot', code: 'SLK1', kind: 'slack' });
    expect(r).toMatchObject({ displayName: 'Gran', channelUserId: 'U0GRAN', alreadyMember: false });
    expect(store.getMemberByIdentity('a1', 'slack', 'U0GRAN')?.userId).toBe(r.userId);
    expect(store.getMembership('a1', r.userId)?.channelUserId).toBeUndefined(); // Telegram untouched
    const argv = provider.execLog.map((a) => a.join(' '));
    expect(argv).toContain('pairing approve slack SLK1 --account hatchabot');
    expect(argv.some((a) => a.includes('message send --channel slack --account hatchabot --target user:U0GRAN'))).toBe(true);
    expect(provider.execLog.find((a) => a[0] === 'sh')![1]).toContain('slack-pairing.json');
  });

  it('"That\'s me" binds the owner seat on that channel', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: '123456789012345678', code: 'DSC1' }] }), stderr: '' });
    const r = await admitMember({ store, provider }, { ...opts, accountId: 'hatchabot', code: 'DSC1', kind: 'discord', asSelf: true });
    expect(r).toMatchObject({ userId: 'u1', alreadyMember: true });
    expect(store.memberIdentities('a1', 'u1')).toEqual({ discord: '123456789012345678' });
  });
});
