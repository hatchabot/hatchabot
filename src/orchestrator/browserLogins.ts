/**
 * Keep its logins (HB-0680, docs/browser-logins-design.md): what the owner is
 * told before an agent's browser keeps its sign-ins, and the sites it was
 * signed in to. The profile itself and its volume are browser.ts's.
 */
import type { Store } from '../store/store.js';
import type { Agent } from '../domain/types.js';

const APP: Record<string, string> = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord' };

/**
 * Who besides its owner can steer the agent, by name: each of them can ask a
 * signed-in agent to act as the owner on those sites (section 3). People with
 * a chat app or its web chat (someone invited and not linked yet too, who can
 * once they are), everyone in a Telegram group it is open to, the agents that
 * may consult it, and people admitted inside OpenClaw itself, unknown to
 * Hatchabot. A web page that tricks it is said apart, for every agent.
 */
export function browserSteerers(store: Store, agent: Agent): string[] {
  const out: string[] = [];
  for (const m of store.listMemberships(agent.id)) {
    if (m.status !== 'active' || m.role === 'owner') continue;
    const ids = store.memberIdentities(agent.id, m.userId);
    const via = [
      ...(m.channelUserId ? ['Telegram'] : []),
      ...Object.keys(ids).filter((k) => k !== 'telegram').map((k) => APP[k] ?? k),
      ...(m.webChat ? ['web chat'] : []),
    ];
    const name = m.displayName || 'Someone';
    out.push(via.length ? `${name} (${[...new Set(via)].join(', ')})` : `${name} (invited, not linked yet)`);
  }
  if (agent.groupAccess?.mode === 'room') out.push('everyone in its Telegram group');
  for (const c of store.listAgentCallers(agent.id)) {
    const peer = store.getAgent(c.agentId);
    if (!peer || peer.state === 'DELETED' || peer.state === 'ARCHIVED') continue;
    out.push(`the agent ${peer.name} (${c.actions ? 'may ask it to act' : 'may ask it questions'})`);
  }
  for (const c of store.listAccessChecks(agent.id)) {
    if (c.kind !== 'person-unknown' || !c.present) continue;
    const n = Number(c.detail) || 0;
    if (n > 0) out.push(`${n} other ${n === 1 ? 'person' : 'people'} on ${APP[c.subject] ?? c.subject}, let in inside OpenClaw itself`);
  }
  return out;
}

/** The site a page of the sign-in panel is on (its host), or undefined for one that is not a web page. */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase().slice(0, 253) || undefined : undefined;
  } catch { return undefined; }
}
