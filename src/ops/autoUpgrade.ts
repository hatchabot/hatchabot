import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Does this install upgrade itself from the stable channel? A Hatchabot whose
 * sign-in page is on the internet must take security fixes without waiting
 * for its owner, so public access is refused when it does not
 * (docs/public-access.md, safeguard i).
 *
 * "Yes" means all of: the channel timer scripts/follow-channel.sh installs
 * (hatchabot-follow-channel.timer, systemd --user) is enabled and active; its
 * service follows `stable` (not beta or latest: a public box runs what was
 * promoted); and nobody pinned this machine to a version by hand
 * (~/.config/hatchabot/channel holding vX.Y.Z pauses the timer's upgrades).
 *
 * A Mac has no timer (follow-channel.sh needs systemd), so the answer there
 * is no, and public access stays off.
 */
export interface AutoUpgradeStatus { ok: boolean; channel?: string; why?: string }

export interface AutoUpgradeProbes {
  platform: NodeJS.Platform;
  /** `systemctl --user <args>`: trimmed stdout, or undefined when it failed. */
  systemctl(args: string[]): Promise<string | undefined>;
  readFile(path: string): Promise<string | undefined>;
  home: string;
}

const TIMER = 'hatchabot-follow-channel.timer';

export const realProbes = (): AutoUpgradeProbes => ({
  platform: process.platform,
  systemctl: (args) => new Promise((resolve) => {
    // is-enabled / is-active exit non-zero for "disabled"/"inactive" and still print the word.
    execFile('systemctl', ['--user', ...args], { timeout: 5000, encoding: 'utf8' }, (_err, stdout) => resolve(String(stdout ?? '').trim() || undefined));
  }),
  readFile: (path) => readFile(path, 'utf8').catch(() => undefined),
  home: homedir(),
});

export async function autoUpgradeStatus(p: AutoUpgradeProbes = realProbes()): Promise<AutoUpgradeStatus> {
  if (p.platform !== 'linux') {
    return { ok: false, why: 'Automatic upgrades need the channel timer, which exists on Linux (systemd) only. On this system upgrades are by hand, so public access stays off.' };
  }
  const enabled = await p.systemctl(['is-enabled', TIMER]);
  if (enabled !== 'enabled') return { ok: false, why: 'The channel timer is not installed: this install upgrades only when someone runs `hatchabot upgrade`.' };
  const active = await p.systemctl(['is-active', TIMER]);
  if (active !== 'active') return { ok: false, why: 'The channel timer is installed but not running.' };
  const unit = await p.readFile(join(p.home, '.config/systemd/user/hatchabot-follow-channel.service'));
  const channel = /^ExecStart=.*follow-channel\.sh"?\s+(\S+)\s*$/m.exec(unit ?? '')?.[1];
  if (channel !== 'stable') {
    return { ok: false, channel, why: channel ? `The channel timer follows "${channel}", not stable.` : 'The channel timer\'s service could not be read, so the channel it follows is unknown.' };
  }
  const pin = (await p.readFile(join(p.home, '.config/hatchabot/channel')))?.trim();
  if (pin && /^v[0-9]/.test(pin)) return { ok: false, channel, why: `This machine is pinned to ${pin}: automatic upgrades are paused.` };
  return { ok: true, channel };
}
