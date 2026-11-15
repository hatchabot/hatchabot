import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.f.close(); });

async function fixture() {
  const w = await makeWorld();
  worlds.push(w);
  await seedRunningAgent(w);
  w.provider.execResponses.set('sh', { code: 0, stdout: 'PRIVATE INSTRUCTIONS', stderr: '' });
  return w;
}

function transferOwner(w: World) {
  (w.store as unknown as { db: Database.Database }).db.prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('user-other', 'a1');
}

describe('sharing and cloning retain the authorized source (HB-0720)', () => {
  it.each(['export', 'export/scan'])('%s returns no private bytes after ownership changes while reading', async (path) => {
    const w = await fixture();
    const exec = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, options) => {
      const response = await exec(ref, script, options);
      transferOwner(w);
      return response;
    };
    const response = await w.f.inject({ method: 'GET', url: `/v1/agents/a1/${path}`, headers: as() });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).not.toContain('PRIVATE INSTRUCTIONS');
    expect(response.headers['x-hatchabot-personal']).toBeUndefined();
  });

  it.each(['secret read', 'secret write', 'private memory'])('rolls a clone back if ownership changes during %s', async (stage) => {
    const w = await fixture();
    w.store.insertAgentEnv({ id: 'source-env', agentId: 'a1', name: 'APP_KEY', secretRef: 'env/source', createdAt: 'now' });
    await w.secrets.put('env/source', 'synthetic-private-value');
    const keysBefore = [...w.secrets.map.keys()].sort();
    if (stage === 'secret read') {
      const get = w.secrets.get.bind(w.secrets);
      w.secrets.get = async (ref) => {
        const value = await get(ref);
        if (ref === 'env/source') transferOwner(w);
        return value;
      };
    } else if (stage === 'secret write') {
      const put = w.secrets.put.bind(w.secrets);
      w.secrets.put = async (ref, value) => {
        await put(ref, value);
        if (ref.startsWith('agent-env/')) transferOwner(w);
      };
    } else {
      const exec = w.provider.execShell.bind(w.provider);
      w.provider.execShell = async (ref, script, options) => {
        if (script.includes('&& node -e "$(printf %s ')) {
          transferOwner(w);
          return { code: 0, stdout: JSON.stringify({ files: { 'USER.md': 'PRIVATE MEMORY' }, skipped: [] }), stderr: '' };
        }
        return exec(ref, script, options);
      };
    }
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/clone', headers: as(), payload: { name: 'Copy', telegram: false } });
    expect(response.statusCode, response.body).toBe(400);
    expect(w.store.listAgents(w.owner)).toEqual([]);
    expect([...w.secrets.map.keys()].sort()).toEqual(keysBefore);
    expect(w.provider.runtimes.size).toBe(1);
  });
});

describe('definition pushes recheck each child at its turn (HB-0721)', () => {
  it.each(['child owner', 'child parent', 'master owner'])('does not write after the %s changes during the master read', async (change) => {
    const w = await fixture();
    await seedRunningAgent(w, { id: 'child', slug: 'child', accountId: 'childbot' });
    w.store.setAgentParent('child', 'a1');
    const db = (w.store as unknown as { db: Database.Database }).db;
    const exec = w.provider.execShell.bind(w.provider);
    let changed = false;
    w.provider.execShell = async (ref, script, options) => {
      const result = await exec(ref, script, options);
      if (!changed && ref === w.store.getAgent('a1')!.runtimeRef) {
        changed = true;
        if (change === 'child owner') db.prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('user-other', 'child');
        if (change === 'child parent') w.store.setAgentParent('child', null);
        if (change === 'master owner') transferOwner(w);
      }
      return result;
    };
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/push-definition', headers: as(), payload: {} });
    expect(response.json().pushed ?? 0, response.body).toBe(0);
    expect(w.store.getAgent('child')?.paramFiles).toBeUndefined();
    expect(w.store.listSnapshots('child')).toHaveLength(0);
    expect(w.provider.execLog.some((a) => a[0] === 'sh' && a[1]!.includes('HATCHABOT_WRITE_OK'))).toBe(false);
  });

  it.each(['owner', 'parent', 'runtime'])('refuses a child whose %s changes during its own file read', async (change) => {
    const w = await fixture();
    await seedRunningAgent(w, { id: 'child', slug: 'child', accountId: 'childbot' });
    w.store.setAgentParent('child', 'a1');
    const childRef = w.store.getAgent('child')!.runtimeRef!;
    const db = (w.store as unknown as { db: Database.Database }).db;
    const exec = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, options) => {
      const result = await exec(ref, script, options);
      if (ref === childRef) {
        if (change === 'owner') db.prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('user-other', 'child');
        if (change === 'parent') w.store.setAgentParent('child', null);
        if (change === 'runtime') w.store.setAgentRuntimeRef('child', 'replacement');
      }
      return result;
    };
    const response = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/push-definition', headers: as(), payload: {} });
    expect(response.json().pushed, response.body).toBe(0);
    expect(response.json().results[0].ok).toBe(false);
    expect(w.store.getAgent('child')?.paramFiles).toBeUndefined();
    expect(w.store.listSnapshots('child')).toHaveLength(0);
  });
});
