/**
 * Discovering and quiescing the OpenClaw agents installed for the user this
 * server runs as — the "bring in everything" side of adopt. Discovery reads the
 * same `~/.openclaw/openclaw.json` findExistingBot() uses; quiesce disables a
 * bot there and restarts the gateway so its poller actually stops, which is the
 * one manual step that trips people up. Every write backs the config up first.
 */
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { openclawConfigAgents, openclawUserPath } from '../../openclaw/configWriter.js';
import { botPollState } from './adopt.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';

/** Same default location adopt uses; overridable for tests and odd installs. */
export function openclawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG || resolve(homedir(), '.openclaw/openclaw.json');
}

/** The systemd --user unit whose restart makes a config change take effect. */
function gatewayUnit(): string {
  return process.env.HATCHABOT_OPENCLAW_GATEWAY_UNIT || 'openclaw-gateway';
}

interface Cfg {
  agents?: unknown;
  bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
  channels?: {
    telegram?: {
      accounts?: Record<string, { botToken?: string; allowFrom?: string[]; enabled?: boolean }>;
    };
  };
}

export interface DiscoveredBot {
  accountId: string;
  /** still switched on in OpenClaw — so its gateway is (or will be) polling it */
  enabledInSource: boolean;
  /** approved Telegram ids, carried so the adopted copy needs no re-pairing */
  allowFrom: string[];
}

export interface OpenclawAgent {
  id: string;
  workspace: string;
  name: string;
  bot?: DiscoveredBot;
  /** the Hatchabot agent already on this bot, if one exists — don't re-import */
  alreadyAdoptedAs?: string;
  /** a soft reason it can't be brought in as-is (missing folder); full checks run at adopt */
  problem?: string;
}

function readCfg(path: string): Cfg | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Cfg;
  } catch {
    return undefined;
  }
}

function friendlyName(id: string, workspace: string): string {
  const base = (workspace.split('/').pop() || id).replace(/^workspace-/, '').replace(/[-_]+/g, ' ').trim();
  return base.replace(/\b\w/g, (c) => c.toUpperCase()) || id;
}

/** The stable identity of a Telegram bot is the number before the ':' in its
 *  token, not its username — and definitely not the label a config gives the
 *  account. Match on that so an already-imported agent is recognised even when
 *  OpenClaw's account key differs from the real @username Hatchabot stored. */
function botIdOf(token: string | undefined): string | undefined {
  const id = token?.split(':')[0]?.trim();
  return id || undefined;
}

/** Every OpenClaw agent in the config, annotated with its bot and whether it's
 *  already been brought into Hatchabot (matched by bot-token id, so a relabelled
 *  account still resolves). */
export async function discoverOpenclawAgents(
  deps: { store: Store; secrets: SecretStore },
  configPath = openclawConfigPath(),
): Promise<OpenclawAgent[]> {
  const cfg = readCfg(configPath);
  if (!cfg) return [];

  // Map every Hatchabot Telegram bot's token-id to the agent using it.
  const adoptedByBotId = new Map<string, string>();
  for (const ag of deps.store.listAllActiveAgents()) {
    const ch = deps.store.getChannelForAgent(ag.id);
    if (!ch || ch.kind !== 'telegram') continue;
    try {
      const id = botIdOf(await deps.secrets.get(ch.secretRef));
      if (id) adoptedByBotId.set(id, ag.name);
    } catch {
      /* token unreadable — just can't match this one */
    }
  }

  const out: OpenclawAgent[] = [];
  for (const a of openclawConfigAgents(cfg)) {
    const workspace = a.workspace ?? a.agentDir;
    if (!a.id || !workspace) continue;
    const ws = openclawUserPath(workspace);
    const accountId = (cfg.bindings ?? []).find(
      (b) => b.agentId === a.id && (b.match?.channel ?? 'telegram') === 'telegram',
    )?.match?.accountId;
    const account = accountId ? cfg.channels?.telegram?.accounts?.[accountId] : undefined;
    const bot: DiscoveredBot | undefined =
      accountId && account?.botToken
        ? {
            accountId,
            enabledInSource: account.enabled !== false,
            allowFrom: (account.allowFrom ?? []).filter((id) => /^\d{1,32}$/.test(id)),
          }
        : undefined;
    const botId = botIdOf(account?.botToken);
    out.push({
      id: a.id,
      workspace: ws,
      name: friendlyName(a.id, ws),
      bot,
      alreadyAdoptedAs: botId ? adoptedByBotId.get(botId) : undefined,
      problem: existsSync(ws) ? undefined : 'workspace folder is missing',
    });
  }
  return out;
}

/**
 * Write the person's openclaw.json whole or not at all (HB-0080): a temp file
 * beside the real file (a symlinked config stays a symlink), with its mode,
 * synced, then renamed over it. A crash or a full disk mid-write used to leave
 * their running OpenClaw a truncated config.
 */
function writeConfigAtomic(configPath: string, cfg: unknown): void {
  const target = realpathSync(configPath);
  const tmp = `${target}.hatchabot-${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', statSync(target).mode & 0o7777);
  try {
    writeSync(fd, `${JSON.stringify(cfg, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, target);
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Set one Telegram account's `enabled: false` in the OpenClaw config, backing
 *  the file up first. Returns whether a change was actually made. */
export function disableOpenclawBot(accountId: string, configPath = openclawConfigPath()): { changed: boolean } {
  const cfg = readCfg(configPath);
  if (!cfg) throw new Error('OpenClaw config not found or unreadable.');
  const acct = cfg.channels?.telegram?.accounts?.[accountId];
  if (!acct) throw new Error(`No Telegram account "${accountId}" in the OpenClaw config.`);
  if (acct.enabled === false) return { changed: false };
  // Recoverable: keep the last pre-edit copy beside the config.
  copyFileSync(configPath, `${configPath}.agentclaw-bak`);
  acct.enabled = false;
  writeConfigAtomic(configPath, cfg);
  return { changed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An executable named `name` on `env`'s PATH, or in ~/.npm-global/bin (where an npm install without root puts it). */
function findCommand(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), resolve(homedir(), '.npm-global/bin')];
  for (const dir of dirs) {
    const p = resolve(dir, name);
    try { accessSync(p, fsConstants.X_OK); if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return undefined;
}

/** How long a gateway restart may take before it is stopped and called failed. */
const GATEWAY_RESTART_MS = 3 * 60_000;

/** The restart, as its owner types it. */
function restartByHand(how: ReturnType<typeof gatewayRestart>): string {
  if ('problem' in how || how.cmd !== 'systemctl') return 'openclaw gateway restart';
  return ['systemctl', ...how.args].join(' ');
}

/**
 * How this machine restarts OpenClaw's gateway, or why it cannot, judged
 * before anything is changed. On Linux, its systemd user unit, as always.
 * Elsewhere (a Mac, whose gateway launchd runs) OpenClaw's own `openclaw
 * gateway restart`, which knows its service manager: systemctl there was
 * not found after the bot was already switched off in the config, and its
 * poller ran on until a restart by hand (HB-0981). Bounded either way: a
 * stuck service stop, or a user service manager that does not answer, held
 * the request, and the command, for as long as the server ran (HB-1028).
 */
export function gatewayRestart(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env):
  { cmd: string; args: string[]; name: string; timeoutMs?: number } | { problem: string } {
  if (platform === 'linux') return { cmd: 'systemctl', args: ['--user', 'restart', gatewayUnit()], name: gatewayUnit(), timeoutMs: GATEWAY_RESTART_MS };
  const openclaw = findCommand('openclaw', env);
  // Bounded: OpenClaw's restart waits for its gateway's work in hand first.
  if (openclaw) return { cmd: openclaw, args: ['gateway', 'restart'], name: "OpenClaw's gateway", timeoutMs: GATEWAY_RESTART_MS };
  return {
    problem: "Hatchabot could not find OpenClaw's own command (openclaw) to restart its gateway on this machine, so nothing was changed. " +
      'Switch the bot off in OpenClaw yourself (openclaw config set channels.telegram.accounts.<its id>.enabled false), ' +
      'restart its gateway (openclaw gateway restart), then try again.',
  };
}

/** Restart the OpenClaw gateway so config changes (disabled bots) take effect. */
export async function restartOpenclawGateway(how: ReturnType<typeof gatewayRestart> = gatewayRestart()): Promise<void> {
  if ('problem' in how) throw new Error(how.problem);
  await new Promise<void>((res, rej) => {
    const child = spawn(how.cmd, how.args, { stdio: ['ignore', 'ignore', 'pipe'], ...(how.timeoutMs ? { timeout: how.timeoutMs } : {}) });
    let err = '';
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', rej);
    child.on('close', (code, signal) =>
      code === 0 ? res() : rej(new Error(`Couldn't restart ${how.name} (${signal ? `stopped after ${(how.timeoutMs ?? 0) / 60_000} minutes` : `exit ${code}`}): ${err.slice(-300)}`)),
    );
  });
}

/**
 * Whether a bot's poller has stopped: quiet only when Telegram said so on
 * every try. A try that got no answer (no network, an unreadable reply) is no
 * proof — counting it as quiet reported an unreachable Telegram as "safe to
 * take over" (C065) — so such a bot is `unconfirmed`, not `quiet`.
 */
async function botQuiet(token: string, fetchImpl: typeof fetch, tries = 4, gapMs = 700): Promise<'quiet' | 'busy' | 'unconfirmed'> {
  let confirmed = true;
  for (let i = 0; i < tries; i++) {
    const state = await botPollState(token, fetchImpl);
    if (state === 'busy') return 'busy';
    if (state !== 'quiet') confirmed = false;
    if (i < tries - 1) await sleep(gapMs);
  }
  return confirmed ? 'quiet' : 'unconfirmed';
}

export interface QuiesceResult {
  /** account ids confirmed no longer polled — safe to take over */
  quiet: string[];
  /** account ids that still look polled after the restart */
  stillBusy: string[];
  /** account ids Telegram did not answer for, so neither is known: not safe to take over yet */
  unconfirmed: string[];
}

/**
 * Disable each named bot in OpenClaw, restart the gateway ONCE, then confirm
 * each bot has actually gone quiet before the caller reuses it. Injectables
 * (`configPath`, `fetchImpl`, `settleMs`, `restart`) keep it testable without a
 * real gateway or Telegram.
 */
export async function quiesceOpenclawBots(
  accountIds: string[],
  opts: {
    configPath?: string;
    fetchImpl?: typeof fetch;
    settleMs?: number;
    restart?: () => Promise<void>;
    /** The gap between polls of one bot (tests). */
    pollGapMs?: number;
    /** The machine's platform and environment, for how its gateway restarts (tests). */
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<QuiesceResult> {
  const configPath = opts.configPath ?? openclawConfigPath();
  const fetchImpl = opts.fetchImpl ?? fetch;
  // How the gateway restarts, known before the config is touched (HB-0981).
  const how = gatewayRestart(opts.platform, opts.env);
  const restart = opts.restart ?? (() => restartOpenclawGateway(how));

  const cfg = readCfg(configPath);
  if (!cfg) throw new Error('OpenClaw config not found or unreadable.');
  const accounts = cfg.channels?.telegram?.accounts ?? {};

  // Validate EVERY id before writing anything: a bad id partway through must
  // not leave earlier bots disabled-in-config with no gateway restart — the
  // silent split-poll state this whole module exists to prevent.
  for (const id of accountIds) {
    // Own keys only: "__proto__" or "constructor" would pass a truthiness check and the write below
    // would land on Object.prototype (CodeQL js/prototype-polluting-assignment, 2026-10-24).
    if (!Object.hasOwn(accounts, id) || !accounts[id]) throw new Error(`No Telegram account "${id}" in the OpenClaw config.`);
  }
  // No way to restart it here: refused before a bot is switched off in its config.
  if (!opts.restart && 'problem' in how) throw new Error(how.problem);

  // One backup, one atomic write for the whole batch.
  let changed = false;
  for (const id of accountIds) {
    if (accounts[id]!.enabled !== false) {
      accounts[id]!.enabled = false;
      changed = true;
    }
  }
  if (changed) {
    copyFileSync(configPath, `${configPath}.agentclaw-bak`);
    writeConfigAtomic(configPath, cfg);
  }

  // Restart unconditionally so the disables take effect AND any lingering
  // poller (a bot disabled earlier but never reloaded) actually stops. One
  // that fails or runs out of time leaves them switched off in the config,
  // the gateway perhaps still polling: said, with how to finish (HB-1028).
  try {
    await restart();
  } catch (err) {
    // One sentence end, whatever the failure ended with (systemctl's own ends in a full stop).
    const why = String((err as Error)?.message ?? err).replace(/[:.\s]+$/, '');
    // Named as OpenClaw's config names them: an account's key ("default") is no bot's @handle.
    const named = accountIds.map((id) => `"${id}"`).join(', ');
    const bots = accountIds.length === 1 ? `OpenClaw's Telegram account ${named} is` : `OpenClaw's Telegram accounts ${named} are`;
    throw new Error(`${why}. ${bots} already switched off in its config: `
      + `restart its gateway yourself (${restartByHand(how)}), then try again.`);
  }
  await sleep(opts.settleMs ?? 1500);

  const quiet: string[] = [];
  const stillBusy: string[] = [];
  const unconfirmed: string[] = [];
  for (const id of accountIds) {
    const token = accounts[id]?.botToken;
    if (!token) {
      stillBusy.push(id);
      continue;
    }
    const state = await botQuiet(token, fetchImpl, 4, opts.pollGapMs);
    (state === 'quiet' ? quiet : state === 'busy' ? stillBusy : unconfirmed).push(id);
  }
  return { quiet, stillBusy, unconfirmed };
}
