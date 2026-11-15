import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { buildWorkspaceSeed } from '../src/openclaw/workspace.js';
import { batchConfigCommands, buildConfigCommands } from '../src/openclaw/configWriter.js';
import { CURATED_SKILLS, GOG_SKILL_MD } from '../src/openclaw/skills.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function storeWithAgent(selection?: string[]) {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new Store(db);
  store.insertHost({ id: 'host', ownerId: 'owner', name: 'Test machine', kind: 'local', provider: 'mock', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'profile', ownerId: 'owner', name: 'Test source', vendor: 'anthropic', kind: 'api_key', model: 'test-model', createdAt: 'now' });
  store.insertAgent({ id: 'agent', ownerId: 'owner', name: 'Test agent', slug: 'test-agent', aiProfileId: 'profile', hostId: 'host', state: 'STOPPED', persona: '', sharedMemory: false, curatedSkills: selection, createdAt: 'now', updatedAt: 'now' });
  return { store, db };
}

describe('curated skill persistence', () => {
  it('keeps legacy unset, explicit empty, and applied selections distinct across migration/reopen', () => {
    const { store, db } = storeWithAgent();
    expect(store.getAgent('agent')).toMatchObject({ curatedSkills: undefined, appliedCuratedSkills: undefined });
    store.setAgentCuratedSkills('agent', []);
    expect(store.getAgent('agent')).toMatchObject({ curatedSkills: [], appliedCuratedSkills: undefined });
    store.setAgentCuratedSkillsApplied('agent', ['gog']);
    const reopened = new Store(db);
    expect(reopened.getAgent('agent')).toMatchObject({ curatedSkills: [], appliedCuratedSkills: ['gog'] });
    reopened.setAgentCuratedSkillsApplied('agent', []);
    expect(reopened.getAgent('agent')?.appliedCuratedSkills).toEqual([]);
  });

  it('preserves an explicit selection on insertion and does not alias caller arrays', () => {
    const selection = ['gog'];
    const { store } = storeWithAgent(selection);
    selection.push('hatchabot-writing');
    expect(store.getAgent('agent')?.curatedSkills).toEqual(['gog']);
    expect(store.getAgent('agent')?.appliedCuratedSkills).toBeUndefined();
    const next = ['hatchabot-research'];
    store.setAgentCuratedSkills('agent', next);
    next.length = 0;
    expect(store.getAgent('agent')?.curatedSkills).toEqual(['hatchabot-research']);
  });
});

const workspace = { agentName: 'Test agent', slug: 'test-agent', persona: 'Test persona', sharedMemory: false };
const skillFiles = (files: Record<string, string>) => Object.keys(files).filter((path) => path.startsWith('skills/'));

describe('curated skill seeds', () => {
  it('preserves the existing gog default and seeds no skills for an explicit empty selection', () => {
    expect(skillFiles(buildWorkspaceSeed(workspace))).toEqual(['skills/gog/SKILL.md']);
    expect(buildWorkspaceSeed(workspace)['skills/gog/SKILL.md']).toBe(GOG_SKILL_MD);
    expect(skillFiles(buildWorkspaceSeed({ ...workspace, curatedSkills: [] }))).toEqual([]);
  });

  it('seeds only known selected paths and lets an explicitly supplied file retain its custom content', () => {
    const files = buildWorkspaceSeed({ ...workspace, curatedSkills: ['hatchabot-writing', '../../outside'], seedFiles: { 'skills/hatchabot-writing/SKILL.md': 'Custom instructions' } });
    expect(skillFiles(files)).toEqual(['skills/hatchabot-writing/SKILL.md']);
    expect(files['skills/hatchabot-writing/SKILL.md']).toBe('Custom instructions');
    expect(buildWorkspaceSeed({ ...workspace, curatedSkills: ['hatchabot-research'] })['skills/hatchabot-research/SKILL.md'])
      .toBe(CURATED_SKILLS.find((skill) => skill.id === 'hatchabot-research')!.content);
  });
});

const config = { agentId: 'test-agent', model: 'test-model', authMode: 'api-key' as const, provider: 'ollama' as const };
const skillCommands = (selected?: string[], ops = false) => buildConfigCommands({ ...config, curatedSkills: selected, ...(ops ? { ops: { mcpUrl: 'http://example.invalid/tools', token: 'fixture-only' } } : {}) })
  .filter((command) => command.argv[2]?.startsWith('skills.'));

describe('curated skill runtime configuration', () => {
  it('leaves legacy and management-agent skill settings untouched', () => {
    expect(skillCommands()).toEqual([]);
    expect(skillCommands(['gog'], true)).toEqual([]);
    expect(skillCommands([], true)).toEqual([]);
  });

  it('changes only fixed enabled leaves, retaining credentials and unrelated skill policies', () => {
    const commands = skillCommands(['hatchabot-writing', '__proto__']);
    expect(commands.map((command) => command.argv[2])).toEqual(CURATED_SKILLS.map((skill) => `skills.entries.${skill.id}.enabled`));
    const current: any = { skills: { entries: { gog: { enabled: true, apiKey: 'example-private-value', env: { EXAMPLE: 'keep' } }, custom: { enabled: true } }, allowBundled: ['custom'] } };
    for (const command of commands) {
      const id = command.argv[2]!.split('.')[2]!;
      current.skills.entries[id] = { ...current.skills.entries[id], enabled: JSON.parse(command.argv[3]!) };
    }
    expect(current.skills.entries.gog).toEqual({ enabled: false, apiKey: 'example-private-value', env: { EXAMPLE: 'keep' } });
    expect(current.skills.entries.custom).toEqual({ enabled: true });
    expect(current.skills.allowBundled).toEqual(['custom']);
    expect(current.skills.entries['hatchabot-writing'].enabled).toBe(true);
    const batched = batchConfigCommands(commands);
    const ops = JSON.parse(batched[0]!.argv[batched[0]!.argv.indexOf('--batch-json') + 1]!);
    expect(ops.every((op: any) => typeof op.value === 'boolean')).toBe(true);
    expect(skillCommands([]).every((command) => command.argv[3] === 'false')).toBe(true);
  });
});
