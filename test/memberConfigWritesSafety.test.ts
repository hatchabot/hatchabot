import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { allowlistScrubScript, denyPairing, DROP_CHAT_ACCOUNTS_SCRIPT, grantChannelAccess, grantRoomAccess, keepOnlyTelegramAccountScript, setDmPolicy } from '../src/orchestrator/members/members.js';

const STATE = '/home/node/.openclaw';

async function scriptFor(action: string): Promise<{ script: string; target: string }> {
  let script = '';
  const deps = {
    store: {} as never,
    provider: { execShellOnVolume: async (_ref: string, emitted: string) => {
      script = emitted;
      return { code: 0, stdout: 'set', stderr: '' };
    } } as never,
  };
  let target = 'openclaw.json';
  if (action === 'deny') {
    target = 'credentials/telegram-pairing.json';
    await denyPairing(deps, { agentId: 'a-fixture', runtimeRef: 'r', code: 'CODE1' });
  } else if (action === 'grant') {
    target = 'credentials/telegram-hatchabot-allowFrom.json';
    await grantChannelAccess(deps, { agentId: 'a-fixture', runtimeRef: 'r', kind: 'telegram', accountId: 'hatchabot', channelUserId: '555' });
  } else if (action === 'rooms') {
    await grantRoomAccess(deps, { agentId: 'a-fixture', runtimeRef: 'r', kind: 'slack', channelUserId: 'U0GUEST' });
  } else if (action === 'policy') {
    await setDmPolicy(deps, { agentId: `a-fixture-${crypto.randomUUID()}`, runtimeRef: 'r', kind: 'telegram', accountId: 'hatchabot', policy: 'allowlist', allowFrom: ['555'] });
  } else if (action === 'keep') {
    script = keepOnlyTelegramAccountScript('hatchabot');
  } else if (action === 'drop') {
    script = DROP_CHAT_ACCOUNTS_SCRIPT;
  } else {
    script = allowlistScrubScript([{ channel: 'telegram', acct: 'hatchabot', id: '555', cred: `${STATE}/credentials/telegram-hatchabot-allowFrom.json` }]);
  }
  return { script, target };
}

describe('channel configuration file writes', () => {
  it.each(['deny', 'grant', 'rooms', 'policy', 'keep', 'drop', 'scrub'])('%s never follows a preexisting staging symlink or publishes it as the config', async (action) => {
    const { script, target } = await scriptFor(action);
    const dir = fs.mkdtempSync(join(tmpdir(), 'hb-member-config-'));
    try {
      fs.mkdirSync(join(dir, 'credentials'));
      fs.writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ channels: {
        telegram: { accounts: { hatchabot: { dmPolicy: 'pairing', allowFrom: ['555'] }, retired: {} } },
        slack: { enabled: true, accounts: { hatchabot: {} }, channels: { fixture: { users: ['U0OWNER'] } } },
        discord: { enabled: true, accounts: { hatchabot: {} } },
      } }));
      fs.writeFileSync(join(dir, 'credentials/telegram-pairing.json'), JSON.stringify({ requests: [{ code: 'CODE1' }] }));
      fs.writeFileSync(join(dir, 'credentials/telegram-hatchabot-allowFrom.json'), JSON.stringify({ allowFrom: ['555'] }));
      const victim = join(dir, 'notes.txt');
      fs.writeFileSync(victim, 'Keep these unrelated notes.');
      fs.symlinkSync(victim, join(dir, `${target}.tmp`));
      const source = script.replaceAll(STATE, dir);
      runInNewContext(source.slice("node -e '".length, -1), {
        require: (name: string) => {
          if (name === 'fs') return fs;
          if (name === 'crypto' || name === 'node:crypto') return crypto;
          throw new Error(`Unexpected module: ${name}`);
        },
        console: { log: () => {} },
      });
      expect(fs.readFileSync(victim, 'utf8')).toBe('Keep these unrelated notes.');
      expect(fs.lstatSync(join(dir, target)).isSymbolicLink()).toBe(false);
      expect(fs.statSync(join(dir, target)).mode & 0o777).toBe(0o600);
      expect(() => JSON.parse(fs.readFileSync(join(dir, target), 'utf8'))).not.toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
