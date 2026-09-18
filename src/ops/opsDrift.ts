import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';
import { OPS_TOOLS_ALLOW, OPS_TOOLS_DENY } from '../openclaw/configWriter.js';

/**
 * The management agent's tool lockdown lives in OpenClaw's config, which its
 * owner can edit from the console. Its key and its network jail hold either
 * way, but a manager running with a shell is not what anyone signed up for:
 * so check, and if the lockdown has been loosened, suspend its key until the
 * next rebuild re-asserts the config (and mints a new key).
 */
const drifted = new Map<string, string>(); // agentId → what was wrong

export const opsDriftOf = (agentId: string): string | undefined => drifted.get(agentId);
export const clearOpsDrift = (agentId: string): void => { drifted.delete(agentId); };

/** What is wrong with this tools/mcp config, or undefined when it is as we set it. */
export function lockdownProblem(tools: unknown, mcpServers: unknown): string | undefined {
  const t = (tools ?? {}) as { allow?: unknown; deny?: unknown; profile?: unknown; elevated?: { enabled?: unknown } };
  const allow = Array.isArray(t.allow) ? t.allow.map(String) : [];
  const deny = Array.isArray(t.deny) ? t.deny.map(String) : [];
  const extra = allow.filter((a) => !OPS_TOOLS_ALLOW.includes(a));
  if (!allow.length) return 'its tool allow-list was removed';
  if (extra.length) return `extra tools were allowed: ${extra.join(', ')}`;
  const missing = OPS_TOOLS_DENY.filter((d) => !deny.includes(d));
  if (missing.length) return `these are no longer denied: ${missing.join(', ')}`;
  if (t.elevated?.enabled === true) return 'elevated tools were enabled';
  const servers = Object.keys((mcpServers ?? {}) as Record<string, unknown>);
  const others = servers.filter((s) => s !== 'hatchabot');
  if (others.length) return `other tool servers were added: ${others.join(', ')}`;
  return undefined;
}

export async function checkOpsDrift(
  deps: { store: Store; providerFor: (hostId: string) => RuntimeProvider; log?: (event: string, detail: Record<string, unknown>) => void },
): Promise<void> {
  for (const agent of deps.store.listOpsAgents()) {
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) continue;
    try {
      const provider = deps.providerFor(agent.hostId);
      const [tools, mcp] = await Promise.all([
        provider.exec(agent.runtimeRef, ['config', 'get', 'tools'], { timeoutMs: 20_000 }),
        provider.exec(agent.runtimeRef, ['config', 'get', 'mcp.servers'], { timeoutMs: 20_000 }),
      ]);
      if (tools.code !== 0) continue; // can't tell; never suspend on a hiccup
      const parse = (s: string) => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return undefined; } };
      const problem = lockdownProblem(parse(tools.stdout), mcp.code === 0 ? parse(mcp.stdout) : {});
      if (problem && !drifted.has(agent.id)) {
        drifted.set(agent.id, problem);
        deps.store.deleteOpsToken(agent.id);
        deps.log?.('ops.lockdown_drift', { agentId: agent.id, problem });
      }
    } catch { /* unreachable container: the health view covers that */ }
  }
}
