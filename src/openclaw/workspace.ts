import type { WorkspaceSeed } from '../providers/provider.js';
import { GOG_SKILL_MD } from './skills.js';

export interface WorkspaceInput {
  agentName: string;
  slug: string;
  persona: string;
  /** True for one-to-many agents: MEMORY.md becomes a shared knowledge base. */
  sharedMemory: boolean;
  /** Verbatim file contents to seed instead of the generated ones — how a
   *  template import lands its trained SOUL.md / AGENTS.md. Keys not given fall
   *  back to the generated default (so an imported template gets a fresh
   *  MEMORY.md, not the exporter's). */
  seedFiles?: Record<string, string>;
}

/**
 * The AGENTS.md section owned by the sharedMemory flag. Exported so the
 * make-private/make-shared toggle can rewrite exactly this section on a live
 * agent without touching the rest of the user's file.
 */
export function memoryPolicySection(sharedMemory: boolean): string {
  return `## Memory policy
${
  sharedMemory
    ? `- This is a **shared** agent. MEMORY.md is common to every member.
- Tag each entry with who told you and when: \`source: <telegram_user_id>, ts: <iso8601>\`.
- Anything written here may surface to other members. Do not record something a
  member asked you to keep private.`
    : `- MEMORY.md is private to this agent's owner.`
}`;
}

/**
 * Swaps the "## Memory policy" section of an AGENTS.md for `section`, leaving
 * everything else (including any sections the user added after it) untouched.
 * Appends the section when the heading is missing.
 */
export function replaceMemoryPolicy(content: string, section: string): string {
  const start = content.indexOf('## Memory policy');
  if (start === -1) return `${content.trimEnd()}\n\n${section}\n`;
  const rest = content.indexOf('\n## ', start + 1);
  const tail = rest === -1 ? '\n' : content.slice(rest);
  return `${content.slice(0, start)}${section}${tail}`;
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

${memoryPolicySection(sharedMemory)}
`;

  const memory = sharedMemory
    ? `# Shared memory

Entries are contributed by every member of this agent. Each line records who
contributed it and when, so provenance survives even as the file grows.
`
    : `# Memory

Durable facts about the person this agent serves.
`;

  // A template import overrides SOUL.md / AGENTS.md with its trained versions;
  // anything it doesn't carry (e.g. MEMORY.md) keeps the fresh generated default.
  return {
    'SOUL.md': soul,
    'AGENTS.md': agents,
    'MEMORY.md': memory,
    // Seeded skills (the seed never overwrites, so an agent's edits stick).
    // gog: the Google-connections tool — binary ships in the image, and this
    // card teaches the chat-based connect flow (docs/connections-design.md).
    'skills/gog/SKILL.md': GOG_SKILL_MD,
    ...(input.seedFiles ?? {}),
  };
}
