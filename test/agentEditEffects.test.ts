import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '../src/providers/provider.js';
import { as } from './support/world.js';
import { DEFAULT, gate, OTHER, patchWorld, pick, runningAgent, stop, tick, type PatchWorld } from './support/patchWorld.js';

/**
 * PATCH /v1/agents/:id, what a change does and in which order (HB-0825),
 * kind by kind: what is asked of the machine before the store is written
 * (the cap's and the swap's docker updates, the image's check), the one
 * transaction and the order of its writes (HB-0809's holds and owed rebuilds
 * among them: a trigger's owed rebuild is in it, a model's write ends an
 * earlier ask), the timeline after the commit, and what follows outside the
 * store: the swap's trace, the browser's rebuild or owed start, the
 * triggers' live apply, the files limit, the renames inside OpenClaw and on
 * the bots, the model ledger, the budget told to the agent, then the answer.
 * Pinned before the route moves out of src/api/routes.ts: a move that keeps
 * the order passes these unchanged.
 *
 * Each test picks the log's entries that are the route's own (support/patchWorld.ts),
 * so a rebuild running beside it does not change what is pinned. What is
 * started and not waited for (a bot's rename) is pinned as started before
 * the answer, and its own steps in their order once they have run.
 *
 * The data is made up.
 */
const worlds: PatchWorld[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) { w.routes?.stop(); await w.f.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function world(): Promise<PatchWorld> {
  const w = await patchWorld();
  worlds.push(w);
  return w;
}
function folder(name = 'notes'): string {
  const d = mkdtempSync(join(tmpdir(), 'hb-patch-'));
  dirs.push(d);
  const p = join(d, name);
  mkdirSync(p);
  return p;
}
const addSource = (w: PatchWorld, id = 'p2') =>
  w.store.insertAIProfile({ id, ownerId: w.owner, name: `Source ${id}`, vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: `ai/${id}`, createdAt: 'now' } as never);
const zswap = (w: PatchWorld) => { w.provider.swapState = { kind: 'zswap', compressed: true, swapDevices: [] }; };
/** A fresh log: what the test set up is not the route's. */
const fresh = (w: PatchWorld) => { w.log.length = 0; };
/** Wait until `done` or a second. */
const settle = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await tick(10); };

describe('PATCH /v1/agents/:id: a rename', () => {
  it('stored, then OpenClaw\'s name, then the Telegram bot\'s (its token read), started before the answer; the bot\'s members told once it took', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    const r = await w.patch(id, { name: 'Larder' });
    expect(r.statusCode).toBe(200);
    expect(r.json().name).toBe('Larder');
    expect(pick(w.log, 'tx{', 'setAgentName', '}tx', 'exec:agents set-identity', 'secret:chan/a1', 'reply'))
      .toEqual(['tx{', 'setAgentName', '}tx', 'exec:agents set-identity', 'secret:chan/a1', 'reply']);
    await settle(() => w.log.includes('event:members.announced'));
    expect(pick(w.log, 'telegram:setMyName', 'event:channel.renamed', 'exec:message send', 'event:members.announced'))
      .toEqual(['telegram:setMyName', 'event:channel.renamed', 'exec:message send', 'event:members.announced']);
    expect(w.provider.execLog.find((a) => a[0] === 'agents')).toEqual(['agents', 'set-identity', '--agent', 'kitchen', '--name', 'Larder']);
    expect(w.store.listEvents([id]).find((e) => e.event === 'channel.renamed')?.detail).toMatchObject({ name: 'Larder', ok: true });
  });

  it('a pool bot through the pool; a name Telegram queued is said and its members are not told', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.channel.pool.entries.push({ username: 'kitchenbot', token: 'made-up' });
    fresh(w);
    expect((await w.patch(id, { name: 'Larder' })).statusCode).toBe(200);
    expect(pick(w.log, '}tx', 'exec:agents set-identity', 'pool-rename', 'secret:*', 'reply')).toEqual(['}tx', 'exec:agents set-identity', 'pool-rename', 'reply']);
    await settle(() => w.log.includes('event:members.announced'));
    expect(pick(w.log, 'event:channel.renamed', 'exec:message send')).toEqual(['event:channel.renamed', 'exec:message send']);
    // Refused for now: queued in the pool.
    w.channel.pool.pending.add('kitchenbot');
    fresh(w);
    expect((await w.patch(id, { name: 'Cellar' })).statusCode).toBe(200);
    await settle(() => w.store.listEvents([id]).filter((e) => e.event === 'channel.renamed').length >= 2);
    await tick();
    expect(pick(w.log, 'pool-rename', 'event:channel.renamed', 'exec:message send')).toEqual(['pool-rename', 'event:channel.renamed']);
    expect(w.store.listEvents([id]).find((e) => e.event === 'channel.renamed' && e.detail?.name === 'Cellar')?.detail).toMatchObject({ name: 'Cellar', ok: false, via: 'pool' });
  });

  it('a Slack bot too, after the Telegram one is started', async () => {
    const w = await world();
    const id = await runningAgent(w);
    await w.secrets.put('slack/a1', 'ok-made-up');
    w.store.insertChannel({ id: 's-a1', agentId: id, kind: 'slack', accountId: 'U0BOT', secretRef: 'slack/a1', deepLink: 'https://slack.example.org', createdAt: 'now' });
    fresh(w);
    expect((await w.patch(id, { name: 'Larder' })).statusCode).toBe(200);
    expect(pick(w.log, 'exec:agents set-identity', 'secret:chan/a1', 'secret:slack/a1', 'reply')).toEqual(['exec:agents set-identity', 'secret:chan/a1', 'secret:slack/a1', 'reply']);
    await settle(() => w.log.filter((e) => e === 'event:members.announced').length >= 2);
    expect(pick(w.log, 'rename:slack', 'setChannelSettings')).toEqual(['rename:slack', 'setChannelSettings']);
    expect(w.store.getChannelForAgent(id, 'slack')?.settings).toMatchObject({ botName: 'Larder', displayName: '@Larder' });
  });

  it('stopped: no OpenClaw rename, the bot\'s still; the same name again: nothing', async () => {
    const w = await world();
    const id = await runningAgent(w);
    await stop(w, id);
    fresh(w);
    expect((await w.patch(id, { name: 'Larder' })).statusCode).toBe(200);
    expect(pick(w.log, 'tx{', 'setAgentName', '}tx', 'exec:agents set-identity', 'secret:chan/a1', 'reply')).toEqual(['tx{', 'setAgentName', '}tx', 'secret:chan/a1', 'reply']);
    await settle(() => w.log.includes('event:members.announced'));
    fresh(w);
    expect((await w.patch(id, { name: 'Larder' })).statusCode).toBe(200);
    await tick();
    expect(pick(w.log, 'setAgentName', 'exec:*', 'secret:*', 'telegram:*', 'event:*')).toEqual([]);
  });
});

describe('PATCH /v1/agents/:id: the cosmetic settings, one transaction each', () => {
  it('persona trimmed, and its setup layer kept in step when it has one', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    expect((await w.patch(id, { persona: '  bakes bread  ' })).json().persona).toBe('bakes bread');
    expect(pick(w.log, 'tx{', 'set*', '}tx', 'reply')).toEqual(['tx{', 'setAgentPersona', '}tx', 'reply']);
    w.store.setAgentParamFile(id, 'soul', 'You are {{name}}.');
    fresh(w);
    expect((await w.patch(id, { persona: ' keeps lists ' })).statusCode).toBe(200);
    expect(pick(w.log, 'tx{', 'set*', '}tx', 'reply')).toEqual(['tx{', 'setAgentPersona', 'setAgentParamFile', '}tx', 'reply']);
    expect(w.store.getAgent(id)!.paramFiles).toMatchObject({ persona: 'keeps lists', soul: 'You are {{name}}.' });
  });

  it('icon, group, alerts, hibernation, parameters, group access, rich messages, memory search: stored, nothing asked of the machine', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    const r = await w.patch(id, { icon: '🍳', group: '', attentionAck: 'flag-1', hibernate: 'never', parameters: null, groupAccess: { mode: 'room', roomId: '-100' }, richMessages: null, embedMode: 'baked' });
    expect(r.statusCode).toBe(200);
    expect(pick(w.log, 'tx{', 'set*', '}tx', 'event:*', 'exec:*', 'docker:*', 'reply')).toEqual([
      'tx{', 'setAgentAttentionAck', 'setHibernatePolicy', 'setAgentIcon', 'setAgentParameters', 'setAgentGroupAccess', 'setAgentRichMessages', 'setAgentEmbedMode', 'setAgentGroup', '}tx',
      'event:embed.mode', 'reply',
    ]);
    expect(w.store.getAgent(id)).toMatchObject({ icon: '🍳', attentionAck: 'flag-1', hibernate: 'never', groupAccess: { mode: 'room', roomId: '-100' } });
    expect(w.store.getAgent(id)!.group).toBeUndefined(); // '' clears it
    // The tint alone keeps the icon.
    expect((await w.patch(id, { iconColor: '#3a8fd0' })).json()).toMatchObject({ icon: '🍳', iconColor: '#3a8fd0' });
    // Memory is always shared: true changes nothing.
    fresh(w);
    expect((await w.patch(id, { sharedMemory: true })).statusCode).toBe(200);
    expect(pick(w.log, 'set*')).toEqual([]);
  });

  it('"runs here": its bot\'s token read first, then the mark cleared in the transaction', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.store.setAgentMigratedTo(id, 'https://other.example.org');
    fresh(w);
    expect((await w.patch(id, { runsHere: true })).statusCode).toBe(200);
    expect(pick(w.log, 'secret:*', 'tx{', 'setAgentMigratedTo', '}tx', 'reply')).toEqual(['secret:chan/a1', 'tx{', 'setAgentMigratedTo', '}tx', 'reply']);
    expect(w.store.getAgent(id)!.migratedTo).toBeUndefined();
  });

  it('folders: trimmed and stored; taken away, nothing is checked', async () => {
    const w = await world();
    const id = await runningAgent(w);
    const notes = folder();
    fresh(w);
    expect((await w.patch(id, { sharedPaths: [`  ${notes} `, ' '] })).statusCode).toBe(200);
    expect(pick(w.log, 'tx{', 'set*', '}tx', 'reply')).toEqual(['tx{', 'setAgentSharedPaths', '}tx', 'reply']);
    expect(w.store.getAgent(id)!.sharedPaths).toEqual([notes]);
    rmSync(notes, { recursive: true });
    expect((await w.patch(id, { sharedPaths: [] })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.sharedPaths ?? []).toEqual([]);
  });
});

describe('PATCH /v1/agents/:id: the source and the model', () => {
  it('a switch: the source, the pin it strands dropped (ending an earlier ask), then the ledger; no rebuild started', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w);
    w.store.setAgentModel(id, OTHER, { apply: true });
    expect(w.store.agentHold(id, 'model-apply')).toBeTruthy();
    fresh(w);
    const r = await w.patch(id, { aiProfileId: 'p2' });
    expect(r.json()).toMatchObject({ aiProfileId: 'p2' });
    expect(pick(w.log, 'tx{', 'set*', 'hold:*', 'unhold:*', '}tx', 'event:*', 'operation:*', 'reply'))
      .toEqual(['tx{', 'setAgentAIProfile', 'setAgentModel:null', 'unhold:model-apply', '}tx', 'event:model.changed', 'reply']);
    expect(w.store.agentHold(id, 'model-apply')).toBeUndefined();
    expect(w.store.listEvents([id]).find((e) => e.event === 'model.changed')?.detail).toMatchObject({ from: OTHER, to: 'claude-sonnet-5', source: 'source-switch' });
  });

  it('a model: stored without asking its runtime (an earlier ask ends), its class let go, the ledger after the commit', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Fast', model: DEFAULT, memoryCap: '5g' });
    w.store.setAgentClassIf(id, null, 'c1');
    fresh(w);
    const r = await w.patch(id, { model: OTHER });
    expect(r.json()).toMatchObject({ model: OTHER, classDetached: true });
    expect(pick(w.log, 'tx{', 'set*', 'hold:*', 'unhold:*', '}tx', 'event:model.changed', 'reply'))
      .toEqual(['tx{', 'setAgentModel:claude-haiku-4-5', 'unhold:model-apply', 'setAgentClassIf', '}tx', 'event:model.changed', 'reply']);
    // The limits that apply without its class are on its container before the answer.
    expect(pick(w.log, 'docker:*', 'reply')).toEqual(['docker:3g', 'reply']);
    expect(w.store.getAgent(id)!.classId).toBeUndefined();
    expect(w.store.listEvents([id]).find((e) => e.event === 'model.changed')?.detail).toMatchObject({ to: OTHER, source: 'model' });
    // Cleared: the source's default. No model moved, no ledger line.
    expect((await w.patch(id, { model: null })).json().model).toBe(DEFAULT);
    fresh(w);
    expect((await w.patch(id, { model: null })).statusCode).toBe(200);
    expect(pick(w.log, 'event:model.changed')).toEqual([]);
  });

  it('HB-0820: its class\'s edit under way, the decision to let it go is stored in the same transaction and made once the edit is done', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Fast', model: DEFAULT, image: 'hatchabot-runtime:latest' });
    w.store.setAgentClassIf(id, null, 'c1');
    // The class's edit waits on its member's machine (the image pin's check).
    const g = gate();
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (ref: string) => { g.reach(); await g.held; return info(ref); };
    const edit = Promise.resolve(w.f.inject({ method: 'PUT', url: '/v1/agent-classes/c1', headers: as(), payload: { name: 'Fast', model: DEFAULT, image: 'hatchabot-runtime:latest' } }));
    await g.reached;
    w.provider.info = info;
    fresh(w);
    const r = await w.patch(id, { model: OTHER });
    expect(r.json()).toMatchObject({ model: OTHER, classDetached: 'pending' });
    expect(pick(w.log, 'tx{', 'setAgentModel:*', 'hold:*', 'setAgentClassIf', '}tx', 'reply')).toEqual(['tx{', 'setAgentModel:claude-haiku-4-5', 'hold:class-detach', '}tx', 'reply']);
    expect(w.store.agentHold(id, 'class-detach')).toBe('c1');
    expect(w.store.getAgent(id)!.classId).toBe('c1');
    g.open();
    await edit;
    await settle(() => w.store.getAgent(id)!.classId === undefined);
    expect(w.store.getAgent(id)!.classId).toBeUndefined();
    expect(w.store.agentHold(id, 'class-detach')).toBeUndefined();
  });
});

describe('PATCH /v1/agents/:id: what needs a new container', () => {
  it('an image: checked (its running image, then the pin\'s) before the transaction; stopped on another image, its next start is owed', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.provider.tags.push({ tag: 'hatchabot-runtime:trial', imageId: 'trial-image' });
    await stop(w, id);
    fresh(w);
    const r = await w.patch(id, { image: 'hatchabot-runtime:trial' });
    expect(r.json()).toMatchObject({ image: 'hatchabot-runtime:trial', sameImage: false });
    expect(pick(w.log, 'info', 'imageInfo', 'tx{', 'set*', 'owe', '}tx', 'event:*', 'reply'))
      .toEqual(['info', 'imageInfo', 'tx{', 'setAgentImage', 'owe', '}tx', 'event:rebuild.owed', 'reply']);
    // The image it already runs, under another name: no rebuild owed.
    const w2 = await world();
    const id2 = await runningAgent(w2);
    await stop(w2, id2);
    fresh(w2);
    expect((await w2.patch(id2, { image: 'hatchabot-runtime:latest' })).json()).toMatchObject({ sameImage: true });
    expect(pick(w2.log, 'owe')).toEqual([]);
    // Running: the caller rebuilds it (the page and the manager's pin_image send one after).
    const w3 = await world();
    const id3 = await runningAgent(w3);
    w3.provider.tags.push({ tag: 'hatchabot-runtime:trial', imageId: 'trial-image' });
    fresh(w3);
    expect((await w3.patch(id3, { image: 'hatchabot-runtime:trial' })).json()).toMatchObject({ sameImage: false });
    expect(pick(w3.log, 'owe', 'operation:*')).toEqual([]);
  });

  it('a browser, running: stored, traced, then its rebuild queued before the answer', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    const r = await w.patch(id, { browser: true });
    expect(r.json().browser).toBe(true);
    expect(r.json().browserPending).toBeUndefined();
    // (The rebuild it queued runs on beside the answer, with transactions of its own:
    // its usage sample's may close before the answer goes, HB-1096.)
    expect(pick(w.log, 'tx{', 'setAgentBrowser', '}tx').slice(0, 3)).toEqual(['tx{', 'setAgentBrowser', '}tx']);
    expect(pick(w.log, '}tx', 'event:browser.switched', 'operation:rebuild').slice(0, 3)).toEqual(['}tx', 'event:browser.switched', 'operation:rebuild']);
    expect(pick(w.log, 'operation:rebuild', 'reply').slice(0, 2)).toEqual(['operation:rebuild', 'reply']);
  });

  it('a browser, stopped or asleep: its next start is owed, and said', async () => {
    const w = await world();
    const id = await runningAgent(w);
    await stop(w, id);
    fresh(w);
    const r = await w.patch(id, { browser: true });
    expect(r.json().browserPending).toBe('Saved. It stays stopped, and has its browser when it next starts.');
    expect(pick(w.log, 'tx{', 'setAgentBrowser', '}tx', 'event:*', 'owe', 'operation:*', 'reply'))
      .toEqual(['tx{', 'setAgentBrowser', '}tx', 'event:browser.switched', 'owe', 'event:rebuild.owed', 'reply']);
    w.store.setHibernated(id, new Date().toISOString());
    expect((await w.patch(id, { browser: false })).json().browserPending).toBe('Saved. It stays asleep, and loses its browser when it next starts.');
  });

  it('a browser while a rebuild is under way: said, and traced', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.store.setAgentState(id, 'REBUILDING');
    fresh(w);
    const r = await w.patch(id, { browser: true });
    expect(r.json().browserPending).toBe('Saved. A rebuild was already under way and may have begun before this change: if its browser is not as you set it once that rebuild ends, rebuild the agent.');
    expect(pick(w.log, 'event:*', 'operation:*', 'owe', 'reply')).toEqual(['event:browser.switched', 'event:browser.rebuild_pending', 'reply']);
  });

  it('event triggers, running: the flag and its owed rebuild in one transaction, then the live apply, which clears its own', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    const r = await w.patch(id, { cronTriggers: true });
    expect(r.json().cronTriggers).toBe(true);
    expect(r.json().cronTriggersPending).toBeUndefined();
    expect(pick(w.log, 'tx{', 'setAgentCronTriggers', 'owe', '}tx', 'event:*', 'exec:config set', 'owe-cleared', 'reply'))
      .toEqual(['tx{', 'setAgentCronTriggers', 'owe', '}tx', 'event:rebuild.owed', 'exec:config set', 'event:cron.triggers', 'owe-cleared', 'reply']);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
    expect(w.provider.execLog.at(-1)).toEqual(['config', 'set', 'cron.triggers.enabled', 'true']);
  });

  it('event triggers, stopped: owed, and said', async () => {
    const w = await world();
    const id = await runningAgent(w);
    await stop(w, id);
    fresh(w);
    const r = await w.patch(id, { cronTriggers: true });
    expect(r.json().cronTriggersPending).toBe('Saved. Event-triggered tasks will be enabled when the agent next starts.');
    expect(pick(w.log, 'tx{', 'setAgentCronTriggers', 'owe', '}tx', 'event:*', 'exec:*', 'owe-cleared', 'reply'))
      .toEqual(['tx{', 'setAgentCronTriggers', 'owe', '}tx', 'event:rebuild.owed', 'event:cron.triggers', 'reply']);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
  });
});

describe('PATCH /v1/agents/:id: memory limits and the files limit', () => {
  it('a memory cap: its baseline read, then docker, then the record, its trace after the commit, its budget asked of the agent last', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    const r = await w.patch(id, { memoryCap: '4g' });
    expect(r.json()).toMatchObject({ memoryCap: '4g' });
    expect(pick(w.log, 'info', 'docker:*', 'tx{', 'setAgentMemoryCap', '}tx', 'event:*', 'shell', 'reply'))
      .toEqual(['info', 'docker:4g', 'tx{', 'setAgentMemoryCap', '}tx', 'event:memory.cap_set', 'shell', 'reply']);
  });

  it('a memory cap its machine did not take (asleep): stored, said, and the agent not told', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.provider.awake = false;
    w.provider.updateMemory = async () => { throw new ProviderError('docker update failed', 'Its machine is not answering.'); };
    fresh(w);
    const r = await w.patch(id, { memoryCap: '4g' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      memoryCap: '4g',
      memoryPending: 'Its container kept its old memory limits (Its machine is not answering.); a rebuild applies them.',
      limitsKept: { name: 'Kitchen', why: 'Its machine is not answering.' },
    });
    expect(pick(w.log, 'tx{', 'setAgentMemoryCap', '}tx', 'shell', 'reply')).toEqual(['tx{', 'setAgentMemoryCap', '}tx', 'reply']);
  });

  it('a swap allowance: docker, the record, then its trace once stored', async () => {
    const w = await world();
    const id = await runningAgent(w);
    zswap(w);
    fresh(w);
    expect((await w.patch(id, { swapAllowance: '1g' })).json()).toMatchObject({ swapAllowance: '1g' });
    expect(pick(w.log, 'info', 'docker:*', 'tx{', 'set*', '}tx', 'event:*', 'shell', 'reply'))
      .toEqual(['docker:3g+1g', 'tx{', 'setAgentSwapAllowance', '}tx', 'event:memory.swap_set', 'reply']);
  });

  it('both: the cap\'s docker call, the swap\'s on top of it, both records in one transaction, the traces in that order', async () => {
    const w = await world();
    const id = await runningAgent(w);
    zswap(w);
    fresh(w);
    expect((await w.patch(id, { memoryCap: '4g', swapAllowance: '1g' })).statusCode).toBe(200);
    expect(pick(w.log, 'info', 'docker:*', 'tx{', 'set*', '}tx', 'event:*', 'shell', 'reply'))
      .toEqual(['info', 'docker:4g', 'docker:4g+1g', 'tx{', 'setAgentMemoryCap', 'setAgentSwapAllowance', '}tx', 'event:memory.cap_set', 'event:memory.swap_set', 'shell', 'reply']);
  });

  it('the files limit: stored, then written to its app (live when running, on its volume when stopped); a volume gone is said', async () => {
    const w = await world();
    const id = await runningAgent(w);
    fresh(w);
    expect((await w.patch(id, { filesMaxMb: 20 })).statusCode).toBe(200);
    expect(pick(w.log, 'tx{', 'setAgentFilesMaxMb', '}tx', 'exec:config set', 'volume', 'reply')).toEqual(['tx{', 'setAgentFilesMaxMb', '}tx', 'exec:config set', 'reply']);
    expect(w.provider.execLog.at(-1)).toEqual(['config', 'set', 'channels.telegram.mediaMaxMb', '20']);
    await stop(w, id);
    fresh(w);
    expect((await w.patch(id, { filesMaxMb: null })).json().filesCapPending).toBeUndefined();
    expect(pick(w.log, '}tx', 'exec:config set', 'volume', 'reply')).toEqual(['}tx', 'volume', 'reply']);
    w.provider.execShellOnVolume = async () => ({ code: 1, stdout: '', stderr: 'no volume', volumeMissing: true });
    expect((await w.patch(id, { filesMaxMb: 30 })).json().filesCapPending).toMatch(/^The limit is saved, but it could not be written to the agent\. /);
  });
});

describe('PATCH /v1/agents/:id: everything at once', () => {
  it('running: the checks\' machine calls, then one transaction in its order, then the traces, the live applies, the renames, the ledger, the budget, the answer', async () => {
    const w = await world();
    const id = await runningAgent(w);
    zswap(w);
    w.store.setAgentMigratedTo(id, 'https://other.example.org');
    fresh(w);
    const r = await w.patch(id, {
      name: 'Larder', persona: 'p', group: 'Home', icon: '🍳', iconColor: '#3a8fd0', attentionAck: 'x', hibernate: 'never', filesMaxMb: 20,
      parameters: [], groupAccess: { mode: 'off' }, richMessages: false, embedMode: 'baked', cronTriggers: true, model: OTHER,
      memoryCap: '4g', swapAllowance: '1g', runsHere: true,
    });
    expect(r.statusCode).toBe(200);
    expect(pick(w.log, 'secret:chan/a1', 'info', 'docker:*', 'tx{', 'set*', 'owe', 'owe-cleared', 'unhold:*', 'hold:*', '}tx', 'event:memory.*', 'event:embed.mode', 'event:rebuild.owed', 'event:cron.triggers', 'event:model.changed', 'exec:config set', 'exec:agents set-identity', 'shell', 'reply')).toEqual([
      'secret:chan/a1', 'info', 'docker:4g', 'docker:4g+1g',
      'tx{', 'setAgentModel:claude-haiku-4-5', 'unhold:model-apply', 'setAgentMemoryCap', 'setAgentSwapAllowance', 'setAgentAttentionAck', 'setHibernatePolicy',
      'setAgentFilesMaxMb', 'setAgentIcon', 'setAgentParameters', 'setAgentGroupAccess', 'setAgentRichMessages', 'setAgentEmbedMode',
      'setAgentCronTriggers', 'owe', 'setAgentPersona', 'setAgentGroup', 'setAgentMigratedTo', 'setAgentName', '}tx',
      'event:memory.cap_set', 'event:embed.mode', 'event:rebuild.owed', 'event:memory.swap_set',
      'exec:config set', 'event:cron.triggers', 'owe-cleared', 'exec:config set', 'exec:agents set-identity', 'secret:chan/a1', 'event:model.changed', 'shell', 'reply',
    ]);
  });

  it('stopped, with a source, an image, folders and a browser: the image\'s owed start in the transaction, the browser\'s after it', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w);
    w.provider.tags.push({ tag: 'hatchabot-runtime:trial', imageId: 'trial-image' });
    await stop(w, id);
    w.store.setAgentMigratedTo(id, 'https://other.example.org');
    w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Fast', image: 'hatchabot-runtime:latest' });
    w.store.setAgentClassIf(id, null, 'c1');
    const notes = folder();
    fresh(w);
    const r = await w.patch(id, { aiProfileId: 'p2', image: 'hatchabot-runtime:trial', sharedPaths: [notes], name: 'Larder', runsHere: true, browser: true });
    expect(r.json()).toMatchObject({ aiProfileId: 'p2', classDetached: true, sameImage: false, browserPending: 'Saved. It stays stopped, and has its browser when it next starts.' });
    expect(pick(w.log, 'secret:chan/a1', 'info', 'imageInfo', 'tx{', 'set*', 'owe', '}tx', 'event:browser.switched', 'event:rebuild.owed', 'event:model.changed', 'reply')).toEqual([
      'secret:chan/a1', 'info', 'imageInfo',
      'tx{', 'setAgentAIProfile', 'setAgentBrowser', 'setAgentMigratedTo', 'setAgentImage', 'setAgentClassIf', 'owe', 'setAgentSharedPaths', 'setAgentName', '}tx',
      'event:browser.switched', 'event:rebuild.owed', 'owe', 'event:rebuild.owed', 'secret:chan/a1', 'event:model.changed', 'reply',
    ]);
  });
});
