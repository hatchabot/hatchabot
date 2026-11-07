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
/**
 * Map each line to whether it sits inside a fenced code block. A fence is closed
 * only by a delimiter of the SAME type that opened it (``` vs ~~~) — so a ~~~
 * line quoted inside a ``` example doesn't flip parity for the rest of the file,
 * which would hide a managed heading below it and make replaceSection append a
 * duplicate section on every rebuild (audit 2026-09-08).
 */
function fenceMask(lines: string[]): boolean[] {
  // As CommonMark and OpenClaw's own section finder (findToolsSection) read
  // them: a fence closes only on a run of the SAME character at least as long
  // as the one that opened it, with nothing else on the line. A ```` block
  // quoting ``` is one block (review of HB-0397).
  const inFence: boolean[] = [];
  let open: { ch: string; len: number } | null = null;
  for (const l of lines) {
    // Without a CRLF file's \r, which `.` does not match.
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(l.replace(/\r$/, ''));
    if (open === null) {
      inFence.push(false);
      if (m) open = { ch: m[1]![0]!, len: m[1]!.length };
    } else {
      inFence.push(true);
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && m[2]!.trim() === '') open = null;
    }
  }
  return inFence;
}

/**
 * The fence a file ends inside, or undefined. A section appended after it
 * would sit in the agent's code block, never be found again, and be appended
 * once more on every rebuild: the fence is closed first.
 */
function unclosedFence(lines: string[]): string | undefined {
  let open: string | undefined;
  for (const l of lines) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(l.replace(/\r$/, ''));
    if (!m) continue;
    if (open === undefined) open = m[1]!;
    else if (m[1]![0] === open[0] && m[1]!.length >= open.length && m[2]!.trim() === '') open = undefined;
  }
  return open;
}

/** Drop a managed section (heading through the line before the next heading). No-op if absent. */
export function removeSection(content: string, heading: string): string {
  const lines = content.split('\n');
  const inFence = fenceMask(lines);
  const start = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === heading);
  if (start === -1) return content;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!inFence[i] && /^#{1,6} /.test(lines[i]!)) { end = i; break; }
  }
  // Cutting the block leaves the blank line before it AND the one that ended
  // it back-to-back; collapse that to one separator.
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

export function replaceSection(content: string, heading: string, section: string): string {
  const lines = content.split('\n');
  // A ``` region can legitimately CONTAIN the heading text (docs showing an
  // example AGENTS.md); rewriting there mangles the fence and orphans the real
  // section, so heading detection skips fenced lines.
  const inFence = fenceMask(lines);
  const isHeading = (i: number) => !inFence[i] && /^#{1,6} /.test(lines[i]!);
  const start = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === heading);
  if (start === -1) {
    const fence = unclosedFence(lines);
    return `${content.trimEnd()}${fence ? `\n${fence}` : ''}\n\n${section}\n`;
  }
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

/**
 * The counterpart read: a managed section's current text (heading included),
 * with the same fence-aware boundaries as replaceSection — so a caller can
 * lift one file's section and splice it into another (push-definition keeps
 * each child's own "## Data sources" this way). Empty string when absent.
 */
export function extractSection(content: string, heading: string): string {
  const lines = content.split('\n');
  const inFence = fenceMask(lines);
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

export const OPERATOR_HEADING = '## About the operator';

/**
 * The owner's identity text, as a managed AGENTS.md section every agent reads.
 * User content is free text; strip any markdown heading markers from it so a
 * stray `##` can't prematurely end this section on the next section-sync read
 * (replaceSection ends a section at the next heading of any level).
 */
export function operatorSection(content: string): string {
  const body = (content ?? '').trim();
  // Neutralise fence delimiters too: an unbalanced \`\`\` in free text would put
  // every later managed heading "inside a fence" for replaceSection, which then
  // appends a fresh copy of that section on every sync (unbounded growth).
  const safe = body
    ? body.split('\n').map((l) => l.replace(/^\s*#{1,6}\s+/, '').replace(/^(\s*)(```|~~~)/, '$1\u200b$2')).join('\n')
    : '_Not set — the operator can fill this in under ⚙ Settings → You._';
  return `${OPERATOR_HEADING}

The person who runs you (your operator). Treat this as background you already
know — don't ask them to re-introduce themselves.

${safe}`;
}

export const SCHEDULED_RESULTS_HEADING = '## Scheduled results';

/**
 * For an agent in no chat app: where a scheduled task's result goes. Asked in
 * its web chat for "a market summary every morning", one agent made the task
 * isolated (OpenClaw's own refusal of sessionTarget "main" for a non-default
 * agent says to), which has no conversation to post to, then told its owner
 * it needed Telegram (2026-10-12). Its console conversation is where results
 * go (crons.ts cronTargetFor): `current` bound to it, announced with no
 * channel. `conversation` false = an OpenClaw too old for that (before
 * 2026.9): such tasks are kept quiet and read in Hatchabot.
 */
export function scheduledResultsSection(slug: string, conversation: boolean): string {
  if (!conversation) {
    return `${SCHEDULED_RESULTS_HEADING}
- You are in no chat app (no Telegram, Discord or Slack), and this OpenClaw
  cannot post a scheduled result into the web chat. Your scheduled tasks run
  quietly: make them with delivery mode "none". Each run's result is kept in
  the task's run history, which your owner reads in Hatchabot (your Schedule
  tab).
- Never tell the person they need Telegram to get a scheduled result.`;
  }
  return `${SCHEDULED_RESULTS_HEADING}
- You are in no chat app (no Telegram, Discord or Slack): your owner talks to
  you in Hatchabot's web chat, and a scheduled task's result is delivered
  there, into the conversation your console opens on (\`agent:${slug}:main\`).
  It shows up without them sending anything.
- To make one, use your cron tool as usual: an \`agentTurn\` payload with
  sessionTarget "current" (the default when you are asked in a chat), and
  delivery left to announce with no channel and no \`to\`. Its result is then
  committed to the conversation you were asked in.
- Do not use sessionTarget "main": it is refused for you ("only valid for the
  default agent"). That refusal suggests "isolated"; an isolated task has no
  conversation to post to — but if one ends up that way, or with no
  recipient, Hatchabot points it at your web chat within minutes.
- Never tell the person they need Telegram (or any chat app) to get a
  scheduled result. If they also want it on their phone, they can add a chat
  app to you from your settings in Hatchabot.`;
}

export const PEERS_HEADING = '## Peers';

/** A peer's name on one line: how the Peers section and peers.json (call-agent) both name it. */
export function peerOneLine(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029\s]+/g, ' ').trim() || '(unnamed)';
}

/**
 * A peer's name as written in its "## Peers" line: on one line, and in a code
 * span, so nothing in it is read as markdown. A name is free text (an import
 * keeps whatever the template had): a line break followed by `## …` ended the
 * section early and put the rest into the agent's standing instructions, and
 * `**` broke the list (HB-0087). A code span keeps the name as it is, so the
 * agent can pass it to call-agent unchanged; its fence is one backtick longer
 * than any run of them in the name (CommonMark).
 */
function peerNameSpan(name: string): string {
  const one = peerOneLine(name);
  const tick = '`'.repeat(Math.max(0, ...(one.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${one}${pad}${tick}`;
}

/**
 * The AGENTS.md section listing the OTHER agents this one may consult, and how.
 * Managed by Hatchabot (owner-granted peers). Uses indented code, not a fence,
 * so it can't perturb fence parity in replaceSection.
 */
export function peerToolsSection(peers: Array<{ name: string }>): string {
  const list = peers.map((p) => `- ${peerNameSpan(p.name)}`).join('\n');
  return `${PEERS_HEADING}

You can consult these other agents when a question is squarely in their domain —
each answers with its own knowledge, memory, and accounts:

${list}

Consult one from a shell:

    call-agent "<Peer Name>" "<your question>"

It prints the peer's reply to stdout. Use it sparingly, for genuinely
cross-domain questions, and summarise what you learn rather than relaying it
verbatim.`;
}

export const INSTALL_HEADING = '## Installing tools (managed by Hatchabot)';

export const GOOGLE_ACCOUNTS_HEADING = '## Google accounts';

/**
 * The AGENTS.md section naming the Google accounts on this agent, rewritten on
 * every build and on attach and detach. Without it an agent had no way to know:
 * the accounts are not in OpenClaw's config, so its `openclaw` tool reported
 * none, and it saved that to its memory (HB-0394). Hence the last lines: they
 * correct a saved claim without Hatchabot editing the agent's memory.
 *
 * It also says how to run a shell command when the model's `exec` takes
 * JavaScript (OpenClaw's Code Mode, on by default for its preferred models).
 * Nothing OpenClaw tells the model says this: its prompt calls `exec`
 * JavaScript, "never shell". The shell tool is the guest's `exec` global; past
 * the cell's 10 seconds it answers `running` with a session to poll (run on
 * 2026.9.8). AGENTS.md, not TOOLS.md: 2026.9.8 does not put TOOLS.md in the
 * prompt (HB-0397).
 */
export function googleAccountsSection(accounts: Array<{ email: string; services: string[]; gmailNoSend: boolean }>): string {
  const lines = accounts.map((a) => {
    const reach = a.services.length ? `: ${a.services.join(', ')}` : '';
    return `- ${a.email}${reach}${a.gmailNoSend ? ' (sending mail is blocked)' : ''}`;
  });
  return `${GOOGLE_ACCOUNTS_HEADING}

<!-- Hatchabot rewrites this section - keep your own notes outside it. -->

These Google accounts are connected to you and ready to use:

${lines.join('\n')}

For mail, calendar, Drive and the like, use the \`gog\` command (your gog skill
has the details), with \`--account\` set to one of the addresses above. There is
nothing to set up: no OAuth, and no plugin to install. \`gog\` is a shell command,
so searching your tool catalog for it finds nothing, and the \`openclaw\` tool
does not know about these accounts because they are not in its config.

If your \`exec\` tool takes JavaScript (Code Mode), run it through the \`exec\`
function inside:
\`const r = await exec({ command: "gog auth list --json" }); return r;\`. The
output is in \`r.aggregated\`; a result saying \`running\` has a \`sessionId\` to read
later with \`await process({ action: "poll", sessionId })\`.

\`gog auth list --json\` shows what you hold right now. If your notes or memory
say you have no Google account or no shell, they are out of date: run that, then
correct them.`;
}

/**
 * A file without any of the install sections Hatchabot (or AgentClaw before
 * it) wrote: every copy of either heading goes. 34 agents once carried 2 or 3
 * copies in AGENTS.md, re-sent with every call (review, 2026-09-29).
 */
export function removeInstallSections(content: string): string {
  let out = content;
  for (const heading of ['## Installing tools (managed by AgentClaw)', INSTALL_HEADING]) {
    for (;;) { const next = removeSection(out, heading); if (next === out) break; out = next; }
  }
  return out;
}

/** The title Hatchabot gave a TOOLS.md it created (OpenClaw's template starts with it too). */
export const TOOLS_MD_TITLE = '# TOOLS.md - Local Notes';
/** Where OpenClaw's doctor (2026.9) puts a TOOLS.md it merges into AGENTS.md. */
const MIGRATED_TOOLS_HEADING = '### Local notes (migrated from TOOLS.md)';
const AGENTCLAW_INSTALL_HEADING = '## Installing tools (managed by AgentClaw)';
/**
 * OpenClaw's own TOOLS.md template after its title (LEGACY_TOOLS_MD_TEMPLATE
 * in 2026.9.8's doctor). An agent whose TOOLS.md was that template plus
 * Hatchabot's section had both merged into AGENTS.md by the doctor; the
 * template is nobody's notes, so it goes, but only when it is word for word.
 */
const OPENCLAW_TOOLS_TEMPLATE_BODY = [
  "Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.",
  '', '## Examples', '', '```markdown', '### Cameras', '', '- living-room → Main area, 180° wide angle', '- front-door → Entrance, motion-triggered', '',
  '### SSH', '', '- home-server → 192.168.1.100, user: admin', '', '### TTS', '', '- Preferred voice: "Nova" (warm, slightly British)', '- Default speaker: Kitchen HomePod', '```', '',
  '## Why Separate?', '', 'Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.', '',
  '---', '', 'Add whatever helps you do your job. This is your cheat sheet.', '', '## Related', '', '- [Agent workspace](/concepts/agent-workspace)',
];

const isHeadingLine = (l: string) => /^#{1,6} /.test(l);
const isBlank = (l: string) => l.trim() === '';

/**
 * Each install section's lines, [start, end). A copy of today's text ends
 * where that text ends, so notes written right after it with no heading of
 * their own are never taken for part of it (a doctor merge can leave them
 * there); any other copy, an older wording, runs to the next heading, as every
 * managed section does.
 */
function installBlocks(lines: string[], inFence: boolean[]): Array<[number, number]> {
  const known = installConventionsSection().split('\n');
  const blocks: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trimEnd();
    if (inFence[i] || (l !== INSTALL_HEADING && l !== AGENTCLAW_INSTALL_HEADING)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (!inFence[j] && isHeadingLine(lines[j]!)) { end = j; break; }
    if (l === INSTALL_HEADING && known.every((k, n) => lines[i + n]?.trimEnd() === k)) end = Math.min(end, i + known.length);
    else {
      // An edited or older copy (AgentClaw's) ends where its own last lines do,
      // not at the next heading, so notes after it stay: the latest line of
      // today's text still in it, plus the lines that followed that one (an edit
      // to the very last line). With none of them left, the next heading.
      outer: for (let k = known.length - 1; k > 0; k--) {
        const want = known[k]!.trimEnd();
        if (!want.trim()) continue;
        for (let j = end - 1; j > i; j--) {
          if (!inFence[j] && lines[j]!.trimEnd() === want) { end = Math.min(end, j + 1 + (known.length - 1 - k)); break outer; }
        }
      }
    }
    blocks.push([i, end]);
    i = end - 1;
  }
  return blocks;
}

/** Lines without these blocks; the blank lines a cut leaves back to back become one. */
function cutBlocks(lines: string[], blocks: Array<[number, number]>, mark?: string): string[] {
  const out: string[] = [];
  let b = 0;
  for (let i = 0; i < lines.length; i++) {
    const block = blocks[b];
    if (block && i === block[0]) {
      if (mark !== undefined && b === 0) out.push(mark);
      i = block[1] - 1;
      b++;
      // The blank lines after it: none when a blank line (or the top of the file) comes before, else one.
      const before = out.length === 0 || isBlank(out[out.length - 1]!);
      let kept = before ? 0 : 1;
      while (i + 1 < lines.length && isBlank(lines[i + 1]!)) { i++; if (kept) { out.push(lines[i]!); kept--; } }
      continue;
    }
    out.push(lines[i]!);
  }
  return out;
}

/**
 * AGENTS.md with exactly one current install section (HB-0397).
 *
 * The section lived in TOOLS.md from 2026-09-29, but OpenClaw 2026.9 puts
 * only AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md and MEMORY.md in
 * the prompt (`WORKSPACE_BOOTSTRAP_FILENAMES`, read in the 2026.9.7 and
 * 2026.9.8 packages), so agents never saw it. 2026.6.11 still read TOOLS.md;
 * every version reads AGENTS.md, so this one place works on old and new
 * images alike, and is sent once either way.
 *
 * The doctor's TOOLS.md migration, which Hatchabot's seed runs once per
 * OpenClaw version (`doctor --fix`), copies TOOLS.md, title and all, under its
 * `### Local notes (migrated from TOOLS.md)`; each later run puts the new text
 * right under that heading, AHEAD of what an earlier run brought. So:
 * 1. every install copy is cut while the titles still end them (a title is a
 *    heading), the first one's place kept;
 * 2. a title the doctor brought goes only when nothing but a heading (or the
 *    end) follows it: before the agent's own notes it stays, as their heading;
 * 3. the one current section goes back in the first copy's place (at the end
 *    when there was none), with a heading after it if text follows, so
 *    nothing of the agent's runs on inside it.
 * OpenClaw's untouched TOOLS.md template, merged the same way, goes too.
 */
export function withInstallSection(content: string): string {
  const eol = content.includes('\r\n') ? '\r' : '';
  let lines = content.split('\n');
  let inFence = fenceMask(lines);
  const migrated = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === MIGRATED_TOOLS_HEADING);
  if (migrated !== -1) {
    // OpenClaw's template, word for word, after the migrated heading.
    const t = OPENCLAW_TOOLS_TEMPLATE_BODY;
    for (let i = migrated + 1; i + t.length <= lines.length; i++) {
      if (!inFence[i] && t.every((k, n) => lines[i + n]!.trimEnd() === k)) {
        lines = cutBlocks(lines, [[i, i + t.length]]);
        inFence = fenceMask(lines);
        i--;
      }
    }
  }
  const mark = `${INSTALL_HEADING}\u0000`;
  lines = cutBlocks(lines, installBlocks(lines, inFence), mark);
  inFence = fenceMask(lines);
  if (migrated !== -1) {
    // A title follows the migrated heading, the section, or another such title.
    const at = lines.findIndex((l, i) => !inFence[i] && l.trimEnd() === MIGRATED_TOOLS_HEADING);
    const out: string[] = [];
    let chain = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (i <= at || inFence[i]) { out.push(l); if (i === at) chain = true; else if (!isBlank(l)) chain = false; continue; }
      if (isBlank(l)) { out.push(l); continue; }
      if (l.trimEnd() === TOOLS_MD_TITLE && chain) {
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        if (j === lines.length || (!inFence[j] && isHeadingLine(lines[j]!))) { i = j - 1; continue; } // nothing of its own under it
        out.push(l);
        continue;
      }
      chain = l === mark;
      out.push(l);
    }
    lines = out;
  }
  const section = installConventionsSection().split('\n').map((l) => l + eol);
  let pos = lines.indexOf(mark);
  if (pos === -1) {
    while (lines.length && isBlank(lines[lines.length - 1]!)) lines.pop();
    // A CRLF file with no newline at its end: its last line gets its \r first.
    if (eol && lines.length && !lines[lines.length - 1]!.endsWith(eol)) lines[lines.length - 1] += eol;
    const fence = unclosedFence(lines);
    if (fence) lines.push(fence + eol);
    lines.push(eol, mark, '');
    pos = lines.length - 2;
  }
  inFence = fenceMask(lines);
  let rest = lines.slice(pos + 1);
  let k = 0;
  while (k < rest.length && isBlank(rest[k]!)) k++;
  let tail: string[] = [];
  if (k < rest.length && (inFence[pos + 1 + k] || !isHeadingLine(rest[k]!))) {
    // Text of the agent's right after it: under a heading of its own, so no section reading runs on into it.
    tail = [eol, `### Local notes${eol}`, eol];
    rest = rest.slice(k);
  } else if (k === 0 && rest.length) tail = [eol]; // a blank line before the next heading
  lines = [...lines.slice(0, pos), ...section, ...tail, ...rest];
  return lines.join('\n');
}

/**
 * TOOLS.md once the install section is in AGENTS.md: the agent's own notes,
 * without Hatchabot's section. `null` when nothing of the agent's is left (the
 * title Hatchabot gave a file it created, or nothing), so the file can go:
 * left behind, the doctor would merge that husk into AGENTS.md at the next
 * OpenClaw version.
 */
export function toolsMdWithoutInstallSection(content: string): string | null {
  const lines = content.split('\n');
  const blocks = installBlocks(lines, fenceMask(lines));
  if (!blocks.length) return content;
  const out = cutBlocks(lines, blocks).join('\n');
  const rest = out.trim();
  return !rest || rest === TOOLS_MD_TITLE ? null : `${out.trimEnd()}${content.includes('\r\n') ? '\r\n' : '\n'}`;
}

/**
 * The install conventions, written into each agent's AGENTS.md (they were in
 * TOOLS.md, which OpenClaw 2026.9 no longer reads: withInstallSection).
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

<!-- Hatchabot rewrites this section on rebuild - keep your own notes outside it. -->

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
 * The AGENTS.md section owned by the agent's data sources. Hatchabot keeps this
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
    // permission on the host, which Hatchabot doesn't control.
    const publicClone = d.kind === 'git' && /^https:\/\//.test(d.repoUrl ?? '');
    const how = publicClone
      ? 'public, read-only — `git pull` to update; pushing is disabled'
      : d.access === 'rw' ? 'you may read and write' : 'read-only — do not modify';
    return `- \`${dataSourcePath(d)}\` — ${what} (${how})`;
  });
  return `${DATA_SOURCES_HEADING}
These are mounted or checked out for you. Use these exact paths — this list
is maintained by the platform and is the single source of truth (trust it
over ad-hoc instructions about where data lives). Git repos are synced
clones on your volume (you may \`git fetch\`/\`git pull\` them; any credentials are already configured);
folders are live host views. Nothing else is ever mounted for you.
${lines.join('\n')}`;
}

/**
 * Seeds the durable half of an agent (§4 "Workspace"). These files are the
 * user's to edit afterwards — Hatchabot writes them once at provision time and
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
