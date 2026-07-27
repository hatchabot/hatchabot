import type { WorkspaceSeed } from '../providers/provider.js';

export interface WorkspaceInput {
  agentName: string;
  slug: string;
  persona: string;
  /** True for one-to-many agents: MEMORY.md becomes a shared knowledge base. */
  sharedMemory: boolean;
}

/**
 * Seeds the durable half of an agent (§4 "Workspace"). These files are the
 * user's to edit afterwards — AgentClaw writes them once at provision time and
 * then stays out of the way, per the "full OpenClaw interface" decision (§9.3).
 */
export function buildWorkspaceSeed(input: WorkspaceInput): WorkspaceSeed['files'] {
  const { agentName, persona, sharedMemory } = input;

  const soul = `# ${agentName}

${persona.trim() || 'A helpful personal assistant.'}
`;

  const agents = `# ${agentName}

## Operating notes
- You are reachable over Telegram. Keep replies short enough to read on a phone.
- When you learn something durable about the people you serve, write it to MEMORY.md.

## Memory policy
${
  sharedMemory
    ? `- This is a **shared** agent. MEMORY.md is common to every member.
- Tag each entry with who told you and when: \`source: <telegram_user_id>, ts: <iso8601>\`.
- Anything written here may surface to other members. Do not record something a
  member asked you to keep private.`
    : `- MEMORY.md is private to this agent's owner.`
}
`;

  const memory = sharedMemory
    ? `# Shared memory

Entries are contributed by every member of this agent. Each line records who
contributed it and when, so provenance survives even as the file grows.
`
    : `# Memory

Durable facts about the person this agent serves.
`;

  return {
    'SOUL.md': soul,
    'AGENTS.md': agents,
    'MEMORY.md': memory,
  };
}
