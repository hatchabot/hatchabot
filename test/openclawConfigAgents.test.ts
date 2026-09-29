import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openclawConfigAgents } from '../src/openclaw/configWriter.js';
import { discoverOpenclawAgents } from '../src/orchestrator/openclawImport.js';
import { findExistingBot } from '../src/orchestrator/adopt.js';
import { openclawAgentEntryForWorkspace } from '../src/orchestrator/cronImport.js';
import { Store } from '../src/store/store.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

// OpenClaw 2026.8+ keeps its agents in keyed `agents.entries` (no id field:
// the key is the id). Discover, adopt and cron import read only `agents.list`
// and saw nothing on such a host (review, 2026-09-29).

const root = mkdtempSync(join(tmpdir(), 'hb-oc-entries-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ws = join(root, 'workspace-tech-advisor');
mkdirSync(ws, { recursive: true });

const cfgPath = join(root, 'openclaw.json');
writeFileSync(cfgPath, JSON.stringify({
  agents: {
    defaults: { model: 'x' },
    ownership: {},
    entries: {
      'tech-advisor': { workspace: ws, agentDir: `${ws}/agent` },
      main: {},
    },
  },
  bindings: [{ agentId: 'tech-advisor', match: { channel: 'telegram', accountId: 'TechAdvBot' } }],
  channels: { telegram: { accounts: { TechAdvBot: { botToken: '4242:fake-test-token', allowFrom: ['1000000001'] } } } },
}));

class NoSecrets implements SecretStore {
  async put() {}
  async get(ref: string): Promise<string> { throw new Error(`no secret ${ref}`); }
  async delete() {}
}

describe('agents.entries (OpenClaw 2026.8+) as well as agents.list', () => {
  it('the normalizer takes the id from the key, and still reads a list', () => {
    expect(openclawConfigAgents({ agents: { entries: { a: { workspace: '/w' } } } })).toEqual([{ id: 'a', workspace: '/w' }]);
    expect(openclawConfigAgents({ agents: { list: [{ id: 'b' }] } })).toEqual([{ id: 'b' }]);
    expect(openclawConfigAgents({})).toEqual([]);
    expect(openclawConfigAgents({ agents: { entries: { bad: null } } })).toEqual([]);
  });

  it('discover lists the agents', async () => {
    const found = await discoverOpenclawAgents({ store: new Store(new Database(':memory:')), secrets: new NoSecrets() }, cfgPath);
    const tech = found.find((a) => a.id === 'tech-advisor');
    expect(tech?.bot?.accountId).toBe('TechAdvBot');
  });

  it('adopt finds the existing bot', () => {
    expect(findExistingBot(ws, cfgPath)?.sourceAgentId).toBe('tech-advisor');
  });

  it('cron import resolves the agent id', () => {
    expect(openclawAgentEntryForWorkspace(ws, cfgPath)?.id).toBe('tech-advisor');
  });
});
