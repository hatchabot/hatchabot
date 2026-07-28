import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

/**
 * Revoke = flip status + drop the member from the bot's allowlist immediately
 * (§12.3 step 5). OpenClaw keeps pairing approvals in
 * credentials/telegram-<account>-allowFrom.json on the agent's volume, and its
 * CLI has approve/list but no verb to un-approve — so the removal is a small
 * file surgery via execShell, followed by a runtime restart to make the
 * gateway reload it.
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
  if (member.status === 'revoked') return; // idempotent

  store.revokeMembership(agentId, userId);
  log('member.revoked', { agentId, userId });

  // No Telegram identity bound yet → nothing to scrub on the runtime.
  if (!member.channelUserId) return;

  const agent = store.getAgent(agentId);
  const channel = store.getChannelForAgent(agentId);
  if (!agent?.runtimeRef || !channel) return;

  // Filename uses the lowercased account id (observed on 2026.6.11).
  const file = `/home/node/.openclaw/credentials/telegram-${channel.accountId.toLowerCase()}-allowFrom.json`;
  const script = `node -e '
    const fs = require("fs");
    const f = ${JSON.stringify(file)};
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      d.allowFrom = (d.allowFrom || []).filter((x) => String(x) !== ${JSON.stringify(member.channelUserId)});
      fs.writeFileSync(f, JSON.stringify(d, null, 2));
    }'`;
  const res = await provider.execShell(agent.runtimeRef, script);
  if (res.code !== 0) {
    throw new RevokeError(
      'Removed from the member list, but updating the bot allowlist failed — rebuild the agent to enforce it.',
    );
  }

  // Restart so the gateway drops any cached allowlist state.
  if (agent.state === 'RUNNING') {
    await provider.stop(agent.runtimeRef).catch(() => {});
    await provider.start(agent.runtimeRef);
  }
  log('member.allowlist_scrubbed', { agentId, userId, channelUserId: member.channelUserId });
}
