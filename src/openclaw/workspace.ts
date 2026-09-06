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
}

**Keep memory current — save as you go, recover on a fresh start.**

Your live conversation is NOT permanent: after a long idle gap the platform may
start you in a fresh session, and long threads get summarized over time. So the
durable record is **MEMORY.md**, and keeping it current is your job, not the
user's.

- **Write standing facts to MEMORY.md the moment they're settled** — names and
  relationships, ongoing plans and decisions, key numbers, preferences, open
  tasks you promised to do. Don't wait for the user to say "remember this," and
  don't leave important context living only in the chat.
- **If you wake into a session with no thread and the user refers to something
  earlier, DO NOT say you have no memory.** First read MEMORY.md and your recent
  \`memory/YYYY-MM-DD.md\` daily notes and try to pick the thread back up. Ask for
  specifics only if memory genuinely has nothing.`;
}

/**
 * Swaps one `## Heading` section of a markdown file for `section`, leaving
 * everything else (including sections the user added after it) untouched.
 * Appends the section when the heading is missing.
 *
 * The heading match is ANCHORED to a line start: an unanchored indexOf also
 * matched `### Data sources`, a mention in prose, and the same words inside a
 * fenced code block — rewriting the wrong place and deleting the text between
 * it and the next heading.
 */
export function replaceSection(content: string, heading: string, section: string): string {
  const lines = content.split('\n');
  // Track fenced code blocks: a ``` region can legitimately CONTAIN the heading
  // text (docs showing an example AGENTS.md), and rewriting there both mangles
  // the fence and orphans the real section.
  const inFence: boolean[] = [];
  let fence = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { inFence.push(fence); fence = !fence; continue; }
    inFence.push(fence);
  }
  const isHeading = (i: number) => !inFence[i] && /^#{1,6} /.test(lines[i]!);
  const start = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === heading);
  if (start === -1) return `${content.trimEnd()}\n\n${section}\n`;
  // Our section runs to the next heading of ANY level, so a following `###`
  // (or `#`) ends it rather than being swallowed.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(i)) { end = i; break; }
  }
  const out = [...lines.slice(0, start), ...section.split('\n'), ...lines.slice(end)].join('\n');
  // Preserve the file's trailing newline: when our section is last, slicing
  // consumed the empty final element that represented it.
  return content.endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out;
}

export function replaceMemoryPolicy(content: string, section: string): string {
  return replaceSection(content, '## Memory policy', section);
}

/**
 * The counterpart read: a managed section's current text (heading included),
 * with the same fence-aware boundaries as replaceSection — so a caller can
 * lift one file's section and splice it into another (push-definition keeps
 * each child's own "## Data sources" this way). Empty string when absent.
 */
export function extractSection(content: string, heading: string): string {
  const lines = content.split('\n');
  const inFence: boolean[] = [];
  let fence = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { inFence.push(fence); fence = !fence; continue; }
    inFence.push(fence);
  }
  const start = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === heading);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!inFence[i] && /^#{1,6} /.test(lines[i]!)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/** In-container location of a data source — where the agent actually finds it. */
export function dataSourcePath(d: {
  kind: string;
  mountName: string;
  hostPath?: string;
  mountAtHostPath?: boolean;
}): string {
  if (d.kind === 'git') return `/home/node/.openclaw/${d.mountName}`;
  return d.mountAtHostPath && d.hostPath ? d.hostPath : `/data/${d.mountName}`;
}

export const DATA_SOURCES_HEADING = '## Data sources';

export const INSTALL_HEADING = '## Installing tools (managed by AgentClaw)';

/**
 * The install conventions, written INTO each agent's TOOLS.md.
 *
 * Every mechanism here has existed for a while ($HOME survives rebuilds,
 * ~/.local/bin is on PATH, pylibs on PYTHONPATH, on-rebuild.sh runs after every
 * rebuild) — but the only place they were written down was comments in our own
 * source. An agent asked "install ffmpeg" would try apt, fail, and the request
 * escalated to a human. The whole point of the volume layer is that adding a
 * tool is a chat message to the agent; that's only true if the agent knows the
 * rules of the house.
 */
export function installConventionsSection(): string {
  return `${INSTALL_HEADING}

<!-- AgentClaw rewrites this section on rebuild - keep your own notes outside it. -->

This container is disposable; your HOME survives every rebuild. Install into
HOME, never into the system:

- **No root, no apt.** \`sudo\` and \`apt-get\` fail here - /usr belongs to the
  shared image. If a tool truly needs a system package, say so: the host owner
  can add it to the shared base image. Everything else fits below.
- **Single-binary tools** -> download into \`~/.local/bin\` (already on PATH).
  Most CLIs ship a static Linux build (jq, ripgrep, ffmpeg static builds, ...).
- **npm CLIs** -> \`npm install -g <pkg>\` (lands in \`~/.npm-global\`, on PATH).
- **Python libraries** -> \`pip install --target ~/.openclaw/pylibs <pkg>\`
  (that directory is on PYTHONPATH automatically).
- **OpenClaw skills** -> \`openclaw skills install <name>\`.
- **Anything you had to place outside HOME** must be reinstalled after a
  rebuild: append the install command to \`~/.openclaw/on-rebuild.sh\` and make
  it executable. It runs after every rebuild with a 5-minute cap - keep it
  fast and idempotent.`;
}

/**
 * The AGENTS.md section owned by the agent's data sources. AgentClaw keeps this
 * one section in sync (on every provision and rebuild) so the agent always knows
 * WHERE its repos and folders actually are — without it, adding a repo left the
 * files on disk and the agent unaware they existed. Everything else in the file
 * stays the user's.
 */
export function dataSourcesSection(
  sources: Array<{
    kind: string;
    access: string;
    mountName: string;
    hostPath?: string;
    mountAtHostPath?: boolean;
    repoUrl?: string;
  }>,
): string {
  if (!sources.length) {
    return `${DATA_SOURCES_HEADING}
- None. You can only see your own workspace.`;
  }
  const lines = sources.map((d) => {
    const what = d.kind === 'git' ? `git repo${d.repoUrl ? ` ${d.repoUrl}` : ''}` : 'folder';
    // For git, "writable" describes the checkout: the agent may edit and commit
    // locally either way — whether a push is accepted is the deploy key's
    // permission on the host, which AgentClaw doesn't control.
    const how = d.access === 'rw' ? 'you may read and write' : 'read-only — do not modify';
    return `- \`${dataSourcePath(d)}\` — ${what} (${how})`;
  });
  return `${DATA_SOURCES_HEADING}
These are mounted or checked out for you. Use these exact paths — this list
is maintained by the platform and is the single source of truth (trust it
over ad-hoc instructions about where data lives). Git repos are synced
clones on your volume (you may \`git fetch\` them; their SSH config is set);
folders are live host views. Nothing else is ever mounted for you.
${lines.join('\n')}`;
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
