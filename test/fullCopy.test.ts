/**
 * What a full copy (Download copy, a move to another Hatchabot) carries
 * besides the volume (deep audit of v2.166.2, 2026-10-24): the editable setup
 * layer (#005), the installed app's record (#006) and the runtime switches
 * provisioning writes into its config (#007).
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { exportAgent, importAgent } from '../src/orchestrator/transfer/transfer.js';
import { parseManifest } from '../src/orchestrator/apps/apps.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { MemSecrets } from './support/world.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';
import { ranOnAnEarlierSource } from '../src/orchestrator/usage/usageReadings.js';

async function installation(owner: string, sourceId = 'p1') {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: owner, kind: 'local', provider: 'mock', name: 'Family box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: sourceId, ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: `ai/${sourceId}`, createdAt: 'now' });
  await secrets.put(`ai/${sourceId}`, 'fixture-value');
  return { store, secrets, provider, deps: { store, secrets, provider, channel: { kind: 'telegram' } as unknown as ChannelProvisioner, sleep: async () => {} } };
}

const APP = parseManifest(JSON.stringify({ app: 'garden-log', name: 'Garden log', tasks: [{ name: 'daily', every: '1d', command: ['garden-log', 'run'] }] }));
const OLDER_APP = parseManifest(JSON.stringify({ app: 'garden-log', name: 'Garden log', tasks: [{ name: 'weekly', every: '7d', command: ['garden-log', 'run'] }] }));

/** A running web-only agent with everything the copy should carry. */
async function source() {
  const src = await installation('owner-src');
  src.store.insertAgent({ id: 'a1', ownerId: 'owner-src', name: 'Garden Notes', slug: 'garden-notes', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: 'Helps with roses.', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
  src.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'owner-src', role: 'owner', status: 'active' });
  const { runtimeRef } = await src.provider.provision({ agentId: 'a1', slug: 'garden-notes', workspace: { files: {}, configPatch: { agentId: 'garden-notes', authMode: 'api-key' } }, env: {} });
  src.store.setAgentRuntimeRef('a1', runtimeRef);
  await src.provider.start(runtimeRef);
  src.store.setAgentState('a1', 'RUNNING');
  src.provider.stateStore.set(runtimeRef, Buffer.from('app files and scheduled jobs'));
  src.store.setAgentParameters('a1', [{ key: 'plant', label: 'Plant', type: 'text', required: true, target: 'soul' }]);
  src.store.setAgentParamState('a1', { plant: 'roses' }, { soul: 'Help with {{plant}}.', agents: 'Water the {{plant}}.', persona: 'Helps with {{plant}}.' });
  src.store.setAgentBrowser('a1', true);
  src.store.setAgentCronTriggers('a1', true);
  src.store.setAgentRichMessages('a1', false);
  src.store.setAgentFilesMaxMb('a1', 40);
  src.store.setAgentApp({ agentId: 'a1', app: 'garden-log', source: 'https://example.invalid/household/garden-log.git', ref: 'main',
    sha: 'b'.repeat(40), manifest: APP, previousSha: 'a'.repeat(40), previousManifest: OLDER_APP, installedAt: '2026-10-19T00:00:00Z', testOk: true });
  return src;
}

describe('a full copy keeps what manages the agent, not only its volume', () => {
  it('the setup layer, the app record and the switches come back, and the second provision writes the switches as they were', async () => {
    const src = await source();
    const { data } = await exportAgent(src.deps, 'a1');
    const dst = await installation('owner-dst');
    const a = await importAgent(dst.deps, data, { ownerId: 'owner-dst' });
    // #005: re-configurable, and re-shareable with its placeholders.
    expect(a.parameters).toEqual([{ key: 'plant', label: 'Plant', type: 'text', required: true, target: 'soul' }]);
    expect(a.paramValues).toEqual({ plant: 'roses' });
    expect(a.paramFiles).toEqual({ soul: 'Help with {{plant}}.', agents: 'Water the {{plant}}.', persona: 'Helps with {{plant}}.' });
    // #006: Update, Roll back and Stop app have their record.
    expect(dst.store.getAgentApp(a.id)).toMatchObject({ app: 'garden-log', ref: 'main', sha: 'b'.repeat(40), previousSha: 'a'.repeat(40), testOk: true,
      manifest: { app: 'garden-log', tasks: [{ name: 'daily' }] }, previousManifest: { tasks: [{ name: 'weekly' }] } });
    expect(dst.provider.stateStore.get(a.runtimeRef!)?.toString()).toBe('app files and scheduled jobs');
    // #007: the runtime config the import writes over the restored one.
    expect(a).toMatchObject({ browser: true, cronTriggers: true, richMessages: false, filesMaxMb: 40 });
    expect(dst.provider.lastSpec?.workspace.configPatch).toMatchObject({ browser: true, cronTriggers: true, filesMaxMb: 40 });
  });

  it('a part that fails its own rules is left out, and the agent still comes back', async () => {
    const src = await source();
    const { data } = await exportAgent(src.deps, 'a1');
    const m = JSON.parse(gunzipSync(data).toString());
    m.agent.setup.parameters[0].key = 'Not A Key';                 // not a setup field's key
    m.agent.app.manifest.app = 'another-app';                       // the record names another app than its manifest
    m.agent.switches = { browser: 'yes', cronTriggers: true, groupAccess: { mode: 'room' }, filesMaxMb: 5000 };
    const dst = await installation('owner-dst');
    const a = await importAgent(dst.deps, gzipSync(JSON.stringify(m)), { ownerId: 'owner-dst' });
    expect(a.state).toBe('RUNNING');
    expect(a.parameters).toBeUndefined();
    expect(a.paramFiles).toBeUndefined();
    expect(dst.store.getAgentApp(a.id)).toBeUndefined();
    expect(a.browser).toBeFalsy();
    expect(a.cronTriggers).toBe(true);
    expect(a.groupAccess).toBeUndefined();
    expect(a.filesMaxMb).toBeUndefined();
  });

  it('its lifetime totals are marked for its time on the other machine\'s source, or an earlier one there, and kept so after its build here (HB-1551)', async () => {
    const src = await source();
    src.store.setAgentApplied('a1', 'p1', 'claude-opus-4-8');
    const copy = (await exportAgent(src.deps, 'a1')).data;
    // Moved to another Hatchabot: its transcripts came, and they were on that machine's source.
    const there = await installation('owner-dst', 'p-dst');
    const moved = await importAgent(there.deps, copy, { ownerId: 'owner-dst' });
    // Was: unmarked, its record starting with the source it runs here.
    expect(moved.appliedProfileId).toBe('p-dst');
    expect(ranOnAnEarlierSource(there.store.getAgent(moved.id)!)).toBe(true);
    // Restored where it was made, onto the source it ran on: nothing to mark.
    const home = await installation('owner-src');
    const back = await importAgent(home.deps, copy, { ownerId: 'owner-src' });
    expect(ranOnAnEarlierSource(home.store.getAgent(back.id)!)).toBe(false);
    // One that ran on an earlier source there before, restored onto the one it runs: marked for the earlier one.
    src.store.insertAIProfile({ id: 'p0', ownerId: 'owner-src', name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', createdAt: 'now' });
    src.store.setAgentApplied('a1', 'p0', 'claude-sonnet-5');
    src.store.setAgentApplied('a1', 'p1', 'claude-opus-4-8');
    const earlier = await importAgent((await installation('owner-src')).deps, (await exportAgent(src.deps, 'a1')).data, { ownerId: 'owner-src' });
    expect(earlier.appliedProfilePrevId).toBe('p0');
    // An older file, with no mark: as before.
    const m = JSON.parse(gunzipSync(copy).toString());
    expect(m.ai).toMatchObject({ ranOn: 'p1' });
    delete m.ai.ranOn;
    const old = await installation('owner-dst', 'p-dst');
    const unmarked = await importAgent(old.deps, gzipSync(JSON.stringify(m)), { ownerId: 'owner-dst' });
    expect(ranOnAnEarlierSource(old.store.getAgent(unmarked.id)!)).toBe(false);
  });
});
