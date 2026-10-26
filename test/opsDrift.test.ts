import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store/store.js';
import { checkOpsDrift, clearOpsDrift, LOCKDOWN_READ, lockdownProblem, opsDriftOf } from '../src/ops/opsDrift.js';
import { OPS_TOOLS_ALLOW, OPS_TOOLS_DENY } from '../src/openclaw/configWriter.js';

const good = { allow: [...OPS_TOOLS_ALLOW], deny: [...OPS_TOOLS_DENY] };
const servers = { hatchabot: { url: 'http://x/mcp' } };

describe('lockdownProblem', () => {
  it('passes the config Hatchabot writes', () => expect(lockdownProblem(good, servers)).toBeUndefined());
  it('catches each way of loosening it', () => {
    expect(lockdownProblem({ ...good, allow: [...good.allow, 'exec'] }, servers)).toMatch(/extra tools.*exec/);
    expect(lockdownProblem({ ...good, deny: good.deny.filter((d) => d !== 'group:runtime') }, servers)).toMatch(/no longer denied.*group:runtime/);
    expect(lockdownProblem({ deny: good.deny }, servers)).toMatch(/allow-list was removed/);
    expect(lockdownProblem({ ...good, elevated: { enabled: true } }, servers)).toMatch(/elevated/);
    expect(lockdownProblem(good, { ...servers, other: {} })).toMatch(/other tool servers.*other/);
  });
});

describe('checkOpsDrift', () => {
  it('suspends the key on drift, never on a hiccup, and a rebuild clears it', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertAgent({ id: 'm1', ownerId: 'o', name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', runtimeRef: 'r', ops: true, aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    store.setOpsToken('m1', 'o', 'key');
    let tools: { code: number; stdout: string } = { code: 1, stdout: '' };
    const providerFor = () => ({ exec: async (_r: string, argv: string[]) => (argv[2] === 'tools' ? tools : { code: 0, stdout: JSON.stringify(servers) }) }) as any;
    await checkOpsDrift({ store, providerFor });
    expect(store.opsAgentForToken('key')?.id).toBe('m1'); // exec failed: no judgement
    tools = { code: 0, stdout: `some banner\n${JSON.stringify(good)}` };
    await checkOpsDrift({ store, providerFor });
    expect(opsDriftOf('m1')).toBeUndefined();
    tools = { code: 0, stdout: JSON.stringify({ ...good, allow: [...good.allow, 'exec'] }) };
    await checkOpsDrift({ store, providerFor });
    expect(opsDriftOf('m1')).toMatch(/exec/);
    expect(store.opsAgentForToken('key')).toBeUndefined();
    clearOpsDrift('m1');
    expect(opsDriftOf('m1')).toBeUndefined();
  });
});

describe('the lockdown read from the config file (HB-0058)', () => {
  const store = () => {
    const st = new Store(new Database(':memory:'));
    st.insertAgent({ id: 'm2', ownerId: 'o', name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', runtimeRef: 'r', ops: true, aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    st.setOpsToken('m2', 'o', 'key2');
    return st;
  };
  // The script itself, on a config file in a temp dir.
  const read = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-lockdown-'));
    writeFileSync(join(dir, 'openclaw.json'), text);
    return spawnSync('bash', ['-c', LOCKDOWN_READ], { env: { PATH: process.env.PATH, OPENCLAW_CONFIG_PATH: join(dir, 'openclaw.json') }, encoding: 'utf8' }).stdout;
  };

  it('settles a plain JSON config with no CLI start; anything else goes to the CLI', () => {
    expect(JSON.parse(read(JSON.stringify({ tools: good, mcp: { servers } })))).toEqual({ tools: good, mcp: servers });
    expect(read(JSON.stringify({ tools: good, $include: './more.json' }))).toBe('cli');
    expect(read(JSON.stringify({ tools: { ...good, allow: ['${EXTRA}'] } }))).toBe('cli');
    expect(read('{ tools: { allow: [] }, // json5\n }')).toBe('cli');
    expect(read(JSON.stringify({ agents: {} }))).toBe('cli');
  });

  it('judges from the file when it can, and asks the CLI when the file says so', async () => {
    const asked: string[][] = [];
    let file = { code: 0, stdout: JSON.stringify({ tools: { ...good, allow: [...good.allow, 'exec'] }, mcp: servers }) };
    const providerFor = () => ({
      execShell: async () => file,
      exec: async (_r: string, argv: string[]) => { asked.push(argv); return argv[2] === 'tools' ? { code: 0, stdout: JSON.stringify(good) } : { code: 0, stdout: JSON.stringify(servers) }; },
    }) as any;
    const s1 = store();
    await checkOpsDrift({ store: s1, providerFor });
    expect(asked).toEqual([]);
    expect(opsDriftOf('m2')).toMatch(/exec/);
    clearOpsDrift('m2');
    file = { code: 0, stdout: 'cli' };
    const s2 = store();
    await checkOpsDrift({ store: s2, providerFor });
    expect(asked.map((a) => a[2])).toEqual(['tools', 'mcp.servers']);
    expect(opsDriftOf('m2')).toBeUndefined();
    expect(s2.opsAgentForToken('key2')?.id).toBe('m2');
  });
});
