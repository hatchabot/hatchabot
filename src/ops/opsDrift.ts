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

/**
 * The two settings read straight from the manager's config file: one `node -e`
 * instead of two OpenClaw CLI starts (4–8 s each on 2026.9) every ten minutes
 * (HB-0058). Prints `cli` for anything the file alone cannot settle — an
 * `$include`, a `${VAR}`, JSON5 syntax, no `tools` block — which the CLI is
 * then asked, as before: it resolves them as the gateway does.
 */
export const LOCKDOWN_READ = `node -e '
  let t = ""; try { t = require("fs").readFileSync(process.env.OPENCLAW_CONFIG_PATH || "/home/node/.openclaw/openclaw.json", "utf8"); } catch { process.stdout.write("cli"); process.exit(0); }
  if (t.includes("$include") || t.includes("\${")) { process.stdout.write("cli"); process.exit(0); }
  let c; try { c = JSON.parse(t); } catch { process.stdout.write("cli"); process.exit(0); }
  if (!c || typeof c !== "object" || !c.tools) { process.stdout.write("cli"); process.exit(0); }
  process.stdout.write(JSON.stringify({ tools: c.tools, mcp: (c.mcp && c.mcp.servers) || {} }));'`;

export async function checkOpsDrift(
  deps: { store: Store; providerFor: (hostId: string) => RuntimeProvider; log?: (event: string, detail: Record<string, unknown>) => void },
): Promise<void> {
  for (const agent of deps.store.listOpsAgents()) {
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) continue;
    try {
      const provider = deps.providerFor(agent.hostId);
      const parse = (s: string) => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return undefined; } };
      let read: { tools: unknown; mcp: unknown } | undefined;
      try {
        const file = await provider.execShell(agent.runtimeRef, LOCKDOWN_READ, { timeoutMs: 20_000 });
        const j = file.code === 0 && file.stdout.trim() !== 'cli' ? parse(file.stdout) : undefined;
        if (j && typeof j === 'object' && 'tools' in j) read = j;
      } catch { /* the CLI below */ }
      if (!read) {
        const [tools, mcp] = await Promise.all([
          provider.exec(agent.runtimeRef, ['config', 'get', 'tools'], { timeoutMs: 20_000 }),
          provider.exec(agent.runtimeRef, ['config', 'get', 'mcp.servers'], { timeoutMs: 20_000 }),
        ]);
        if (tools.code !== 0) continue; // can't tell; never suspend on a hiccup
        read = { tools: parse(tools.stdout), mcp: mcp.code === 0 ? parse(mcp.stdout) : {} };
      }
      const problem = lockdownProblem(read.tools, read.mcp);
      if (problem && !drifted.has(agent.id)) {
        drifted.set(agent.id, problem);
        deps.store.deleteOpsToken(agent.id);
        deps.log?.('ops.lockdown_drift', { agentId: agent.id, problem });
      }
    } catch { /* unreachable container: the health view covers that */ }
  }
}
