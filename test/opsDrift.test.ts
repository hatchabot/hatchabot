import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { checkOpsDrift, clearOpsDrift, lockdownProblem, opsDriftOf } from '../src/ops/opsDrift.js';
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
