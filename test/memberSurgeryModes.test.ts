import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowlistScrubScript, DROP_CHAT_ACCOUNTS_SCRIPT, keepOnlyTelegramAccountScript } from '../src/orchestrator/members.js';

/**
 * The scripts Hatchabot runs on an agent's volume to change its members
 * rewrite the allowlist and openclaw.json (which holds the bot tokens)
 * through a temp file and a rename. The temp file must be made 0600, or
 * the renamed file is readable by anyone in the container (HB-0038).
 */

const CFG = '/home/node/.openclaw/openclaw.json';
let home = '';
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = ''; });

/** The script's own body, run against files in a temp folder instead of the volume's. */
function run(script: string, swaps: Array<[string, string]>) {
  let body = script.replace(/^node -e '/, '').replace(/'$/, '');
  for (const [from, to] of swaps) body = body.split(from).join(to);
  execFileSync(process.execPath, ['-e', body], { env: { HOME: home, PATH: '' } });
}

function secretFile(name: string, obj: unknown): string {
  const f = join(home, name);
  writeFileSync(f, JSON.stringify(obj), { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

const mode = (f: string) => statSync(f).mode & 0o777;

describe('member surgery keeps the files it rewrites at 0600 (HB-0038)', () => {
  it('removing a member: the allowlist and the config', () => {
    home = mkdtempSync(join(tmpdir(), 'hb-surgery-'));
    const cred = secretFile('telegram-kitchenbot-allowFrom.json', { allowFrom: ['8001', '8002'] });
    const cfg = secretFile('openclaw.json', { channels: { telegram: { accounts: { kitchenbot: { botToken: 'not-a-token', allowFrom: ['8001', '8002'] } } } } });
    run(allowlistScrubScript([{ channel: 'telegram', acct: 'kitchenbot', id: '8002', cred }]), [[CFG, cfg]]);
    expect(JSON.parse(readFileSync(cred, 'utf8')).allowFrom).toEqual(['8001']);
    expect(JSON.parse(readFileSync(cfg, 'utf8')).channels.telegram.accounts.kitchenbot.allowFrom).toEqual(['8001']);
    expect(mode(cred)).toBe(0o600);
    expect(mode(cfg)).toBe(0o600);
  });

  it('a restore keeping only the current Telegram account, and dropping chat accounts', () => {
    home = mkdtempSync(join(tmpdir(), 'hb-surgery-'));
    const cfg = secretFile('openclaw.json', {
      channels: {
        telegram: { accounts: { kitchenbot: { botToken: 'not-a-token' }, oldbot: { botToken: 'not-a-token-either' } } },
        slack: { enabled: true, accounts: { default: { botToken: 'not-a-slack-token' } } },
      },
    });
    run(keepOnlyTelegramAccountScript('kitchenbot'), [[CFG, cfg]]);
    expect(Object.keys(JSON.parse(readFileSync(cfg, 'utf8')).channels.telegram.accounts)).toEqual(['kitchenbot']);
    expect(mode(cfg)).toBe(0o600);
    run(DROP_CHAT_ACCOUNTS_SCRIPT, [[CFG, cfg]]);
    expect(JSON.parse(readFileSync(cfg, 'utf8')).channels.slack).toEqual({ enabled: false, accounts: {} });
    expect(mode(cfg)).toBe(0o600);
  });
});
