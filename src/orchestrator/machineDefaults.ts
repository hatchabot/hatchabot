/**
 * Defaults for this machine, set in the app (Settings → Hosts → Defaults for
 * this machine) instead of by editing .env. They ARE .env lines — the app
 * writes them there, the way the rebuild policy is written — so an operator
 * who prefers the file still can, and nothing is kept in two places.
 *
 * Operator-only knobs (ports, bind, data dir, prefix, secrets, managed mode,
 * sweep timings) stay out of this list on purpose: they are install
 * decisions, not things an owner tunes because of what their agents do.
 */
import { hibernateAfterMs } from './hibernate.js';
import { formatMemoryCap, MEMORY_CAP_CEILING_BYTES, MEMORY_CAP_MIN_BYTES, parseMemoryCap } from './memoryCap.js';
import { formatSwapAllowance, parseSwapAllowance } from './swap.js';
import { MAX_BUDGET, MIN_BUDGET, parseNewAgentBudget, parseStep } from './budgets.js';

export type ChannelKindForFiles = 'telegram' | 'discord' | 'slack';
/** What each app accepts at most (Telegram's Bot API; a Discord server at its highest boost; Slack held well below its 1 GB). */
export const FILES_MB_MAX: Record<ChannelKindForFiles, number> = { telegram: 50, discord: 500, slack: 1000 };
/** The default ceiling: each app's own limit for an ordinary account (a Discord server without boosts is 10). */
export const FILES_MB_DEFAULT: Record<ChannelKindForFiles, number> = { telegram: 50, discord: 10, slack: 100 };
const filesEnv = (kind: ChannelKindForFiles) => `HATCHABOT_FILES_MB_${kind.toUpperCase()}`;

/** The biggest file an agent may send on this app, in MB: its own override, else the machine's, else the default — never past the app's limit. */
export function filesMb(kind: ChannelKindForFiles, agentOverride?: number, env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env[filesEnv(kind)]);
  const base = Number.isInteger(set) && set >= 1 ? set : FILES_MB_DEFAULT[kind];
  const want = agentOverride && Number.isInteger(agentOverride) && agentOverride >= 1 ? agentOverride : base;
  return Math.min(Math.max(1, want), FILES_MB_MAX[kind]);
}

export type DefaultKey = 'sleepAfter' | 'agentMemory' | 'agentSwap' | 'engineMemory' | 'filesTelegram' | 'filesDiscord' | 'filesSlack' | 'newBudget' | 'newAlertEvery';
export interface DefaultSpec {
  key: DefaultKey;
  env: string;
  label: string;
  help: string;
  /** What it is when .env says nothing. */
  fallback: string;
  /** The normalised value to write, or an error message. */
  check(input: string): { ok: true; value: string } | { ok: false; error: string };
  /** When a change takes effect. */
  applies: string;
}

const mb = (kind: ChannelKindForFiles, label: string): DefaultSpec => ({
  key: `files${label}` as DefaultKey,
  env: filesEnv(kind),
  // OpenClaw applies mediaMaxMb to downloads too on Telegram and Slack, so
  // there it bounds what the agent receives as well (2026-09-30).
  label: `Files an agent may ${kind === 'discord' ? 'send' : 'send or receive'} on ${label}`,
  help: `In MB, 1–${FILES_MB_MAX[kind]}. ${kind === 'discord' ? 'A Discord server without boosts takes 10 MB; a boosted one more.' : kind === 'telegram' ? 'Telegram bots can send up to 50 MB.' : 'Slack itself takes up to 1 GB.'} A bigger file is left out of the reply.`,
  fallback: String(FILES_MB_DEFAULT[kind]),
  check(input) {
    const n = Number(String(input).trim());
    if (!Number.isInteger(n) || n < 1 || n > FILES_MB_MAX[kind]) return { ok: false, error: `A whole number of MB from 1 to ${FILES_MB_MAX[kind]}.` };
    return { ok: true, value: String(n) };
  },
  applies: `now, on every agent on ${label} (no rebuild)`,
});

const memory = (min: number, max: number, what: string) => (input: string): { ok: true; value: string } | { ok: false; error: string } => {
  const b = parseMemoryCap(String(input).trim());
  if (!b || b < min || b > max) return { ok: false, error: `${what}: a size like 3g or 1536m, from ${formatMemoryCap(min)} to ${formatMemoryCap(max)}.` };
  return { ok: true, value: formatMemoryCap(b) };
};

export const MACHINE_DEFAULTS: DefaultSpec[] = [
  {
    key: 'newBudget',
    env: 'HATCHABOT_NEW_AGENT_BUDGET',
    label: 'Monthly budget for new agents',
    help: `US dollars a month at API prices, then what happens at the limit: "50" warns at 80% and 100%, "50 pause" pauses it until the 1st, "50 cheaper" moves it to the cheapest model its source offers until the 1st; "off" for none. Each agent's own budget can be changed afterwards (its Usage tab). Your Hatchabot agent's only warns.`,
    fallback: 'off',
    check(input) {
      const v = String(input).trim().toLowerCase();
      if (v === '' || v === 'off' || v === 'none' || v === '0') return { ok: true, value: '' };
      const b = parseNewAgentBudget(v);
      if (!b) return { ok: false, error: `A number of dollars from ${MIN_BUDGET} to ${MAX_BUDGET}, then "pause" or "cheaper" if you like — like 50, 50 pause or 50 cheaper — or off.` };
      return { ok: true, value: b.atLimit === 'warn' ? String(b.usd) : `${b.usd} ${b.atLimit}` };
    },
    applies: 'to agents created from now on',
  },
  {
    key: 'newAlertEvery',
    env: 'HATCHABOT_NEW_AGENT_ALERT_EVERY',
    label: 'Tell me every $… a new agent spends',
    help: 'US dollars: each time a new agent\'s spend this month passes another this much, you get a message and a line under Alerts (at $25, $50, $75 … for 25). "off" for none. Change any agent\'s own afterwards (its Usage tab).',
    fallback: 'off',
    check(input) {
      const v = String(input).trim().toLowerCase();
      if (v === '' || v === 'off' || v === 'none' || v === '0') return { ok: true, value: '' };
      const n = parseStep(v);
      if (n === undefined) return { ok: false, error: `A number of dollars from ${MIN_BUDGET} to ${MAX_BUDGET}, like 25 — or off.` };
      return { ok: true, value: String(n) };
    },
    applies: 'to agents created from now on',
  },
  {
    key: 'sleepAfter',
    env: 'HATCHABOT_HIBERNATE_AFTER',
    label: 'Put idle agents to sleep after',
    help: 'Like 36h, 90m or 2d; "off" keeps every agent awake. A message, its console or an ask wakes one in about a minute. Agents on Discord or Slack, with scheduled tasks of their own, the manager, and agents set to stay awake never sleep.',
    fallback: 'off',
    check(input) {
      const v = String(input).trim().toLowerCase();
      if (v === '' || v === 'off' || v === '0' || v === 'never') return { ok: true, value: '' };
      const ms = hibernateAfterMs(v);
      if (!ms) return { ok: false, error: 'Like 36h, 90m or 2d — or off.' };
      if (ms < 30 * 60_000) return { ok: false, error: 'At least 30m: waking takes about a minute.' };
      return { ok: true, value: v.replace(/\s+/g, '') };
    },
    applies: 'now (the next idle sweep, within five minutes)',
  },
  {
    key: 'agentMemory',
    env: 'HATCHABOT_AGENT_MEMORY',
    label: 'Memory per agent (the default cap)',
    help: 'The most one agent\'s container may use, unless the agent or its class says otherwise. 3g suits most; a busy agent with a long history may want more.',
    fallback: '3g',
    check: memory(MEMORY_CAP_MIN_BYTES, MEMORY_CAP_CEILING_BYTES, 'Memory per agent'),
    applies: 'now, on every agent that uses the default, runners included (no rebuild; a runner that cannot be reached gets it at its next rebuild)',
  },
  {
    key: 'agentSwap',
    env: 'HATCHABOT_AGENT_SWAP',
    label: 'Compressed swap per agent',
    help: 'Swap an agent may use on top of its memory cap, like 2g, or off. Only where this machine compresses swap (zswap or zram: scripts/enable-compressed-swap.sh); with plain disk swap or none, agents get no swap. An idle agent then shrinks about 3:1 and answers again in milliseconds; a busy one slows down instead of being killed. Never more than an agent\'s cap. An agent or class can say otherwise.',
    fallback: 'off',
    check(input) {
      const v = String(input).trim();
      if (v === '') return { ok: true, value: '' };
      const b = parseSwapAllowance(v);
      if (b === undefined) return { ok: false, error: 'Compressed swap per agent: a size like 2g or 512m (at least 256m), or off.' };
      return { ok: true, value: b ? formatSwapAllowance(b) : '' };
    },
    applies: 'now, on every agent that follows the machine\'s setting, runners included (no rebuild)',
  },
  {
    key: 'engineMemory',
    env: 'HATCHABOT_EMBEDDER_MEMORY',
    label: 'Memory for the memory search service',
    help: 'The shared engine that indexes every agent\'s memory. 2g is enough for a household fleet re-indexing at once.',
    fallback: '2g',
    check: memory(1024 ** 3, 8 * 1024 ** 3, 'Memory for the search service'),
    applies: 'now (the service restarts: a few seconds without memory search)',
  },
  mb('telegram', 'Telegram'),
  mb('discord', 'Discord'),
  mb('slack', 'Slack'),
];

export const defaultSpec = (key: string): DefaultSpec | undefined => MACHINE_DEFAULTS.find((d) => d.key === key);

/** Every default as the page shows it: what it is now and whether .env set it. */
export function readMachineDefaults(env: NodeJS.ProcessEnv = process.env) {
  return MACHINE_DEFAULTS.map((d) => {
    const raw = env[d.env];
    const set = raw !== undefined && raw.trim() !== '';
    return { key: d.key, label: d.label, help: d.help, applies: d.applies, fallback: d.fallback, value: set ? raw!.trim() : d.fallback, set };
  });
}
