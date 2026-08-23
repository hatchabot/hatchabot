/**
 * Discovering and quiescing the OpenClaw agents installed for the user this
 * server runs as — the "bring in everything" side of adopt. Discovery reads the
 * same `~/.openclaw/openclaw.json` findExistingBot() uses; quiesce disables a
 * bot there and restarts the gateway so its poller actually stops, which is the
 * one manual step that trips people up. Every write backs the config up first.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { botPollState } from './adopt.js';
import type { Store } from '../store/store.js';

/** Same default location adopt uses; overridable for tests and odd installs. */
export function openclawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG || resolve(homedir(), '.openclaw/openclaw.json');
}

/** The systemd --user unit whose restart makes a config change take effect. */
function gatewayUnit(): string {
  return process.env.AGENTCLAW_OPENCLAW_GATEWAY_UNIT || 'openclaw-gateway';
}

interface Cfg {
  agents?: { list?: Array<{ id?: string; workspace?: string; agentDir?: string }> };
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
  /** the AgentClaw agent already on this bot, if one exists — don't re-import */
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

/** Every OpenClaw agent in the config, annotated with its bot and whether it's
 *  already been brought into AgentClaw. */
export function discoverOpenclawAgents(deps: { store: Store }, configPath = openclawConfigPath()): OpenclawAgent[] {
  const cfg = readCfg(configPath);
  if (!cfg) return [];
  const out: OpenclawAgent[] = [];
  for (const a of cfg.agents?.list ?? []) {
    const workspace = a.workspace ?? a.agentDir;
    if (!a.id || !workspace) continue;
    const ws = resolve(workspace);
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
    const adopted = bot ? deps.store.findAgentUsingAccount(bot.accountId) : undefined;
    out.push({
      id: a.id,
      workspace: ws,
      name: friendlyName(a.id, ws),
      bot,
      alreadyAdoptedAs: adopted?.name,
      problem: existsSync(ws) ? undefined : 'workspace folder is missing',
    });
  }
  return out;
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
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { changed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Restart the OpenClaw gateway so config changes (disabled bots) take effect. */
export async function restartOpenclawGateway(): Promise<void> {
  await new Promise<void>((res, rej) => {
    const child = spawn('systemctl', ['--user', 'restart', gatewayUnit()], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`Couldn't restart ${gatewayUnit()} (exit ${code}): ${err.slice(-300)}`)),
    );
  });
}

async function botQuiet(token: string, fetchImpl: typeof fetch, tries = 4, gapMs = 700): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await botPollState(token, fetchImpl)) === 'busy') return false;
    if (i < tries - 1) await sleep(gapMs);
  }
  return true;
}

export interface QuiesceResult {
  /** account ids confirmed no longer polled — safe to take over */
  quiet: string[];
  /** account ids that still look polled after the restart */
  stillBusy: string[];
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
  } = {},
): Promise<QuiesceResult> {
  const configPath = opts.configPath ?? openclawConfigPath();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const restart = opts.restart ?? restartOpenclawGateway;

  for (const id of accountIds) disableOpenclawBot(id, configPath);
  await restart();
  // Give the freshly-started gateway a moment to settle before probing.
  await sleep(opts.settleMs ?? 1500);

  const cfg = readCfg(configPath);
  const quiet: string[] = [];
  const stillBusy: string[] = [];
  for (const id of accountIds) {
    const token = cfg?.channels?.telegram?.accounts?.[id]?.botToken;
    if (!token) {
      stillBusy.push(id);
      continue;
    }
    ((await botQuiet(token, fetchImpl)) ? quiet : stillBusy).push(id);
  }
  return { quiet, stillBusy };
}
