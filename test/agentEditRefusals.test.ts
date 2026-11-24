import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { ProviderError } from '../src/providers/provider.js';
import { as } from './support/world.js';
import { addRunner, bareAgent, gate, holdDockerUpdate, MEMBER, OTHER, patchWorld, pick, runningAgent, tick, type PatchWorld } from './support/patchWorld.js';

/**
 * PATCH /v1/agents/:id, what it refuses (HB-0825): every refusal it can give,
 * with its status and words, and, for each pair of refusals the code orders,
 * the one that wins when both apply. Pinned before the route moves out of
 * src/api/routes.ts: a move that keeps the order passes these unchanged.
 *
 * The order, as the route checks:
 *   the owner (404) → the body (400) → the name (409, then its hold) →
 *   nothing to update (400) → an operation on disk, for a browser, triggers
 *   or image change (409) → the manager's browser (400) → the shared memory
 *   search (400) → the memory cap (400/403) → the swap allowance (400/403) →
 *   runs here (409) → the image (403, then the pin, 400) → the folders (the
 *   step-up, 403, the runner 400, each path's problem or absence 400, a name
 *   twice 400, a data source's place 409) → the source (400s) → the model
 *   (400s) → the runtime check (400) → an operation, for a switch (409) →
 *   busy, for a switch (409) → shared memory off (400) → the source gone
 *   (409) → then, in the source's hold and the limits turn: the cap's docker
 *   update (502), the agent gone (404) and the swap's (502), and the
 *   transaction's own (no agent 404, moving 409, folder on a runner 400,
 *   triggers busy 409, busy 409, runner 400, no source 409).
 *
 * The data is made up.
 */
const SOURCE_SWITCH_BUSY = 'The agent is busy (a rebuild, a move or a backup) — switch its AI source when that is done.';
const SOURCE_GONE = 'That AI source was deleted meanwhile. Pick another one and try again.';
const MACHINE_OWNER_ONLY = 'Only the account that set up this machine can do that — it touches the machine itself (its runtime images, hosts and runners), not just your own agents.';
const MACHINE_LOGIN_NO_RUNNER = "This Claude Max profile uses this machine's login, which can't reach a runner. Run `claude setup-token` and add it as a setup-token AI source, or use an API-key profile.";
const OPS_NO_LOCAL = "The Hatchabot agent can't use a local model: its locked-down network reaches only the internet AI services. Pick a Claude, OpenAI or Gemini source.";
const MOVING = 'Its move to another machine is not over. Change its image or folders once that finishes.';
const TRIGGERS_BUSY = 'The agent is busy. Change its event-trigger permission once its current operation finishes.';
const GONE = 'It was deleted.';
const NOT_SHARED = "An agent's memory is always shared with everyone who talks to it. For something private, give that person their own agent.";
const NO_SEARCH_SERVICE = "The memory search service is not turned on. The machine's owner turns it on under Settings → Hosts; then agents can be switched to it.";
const NO_MANAGER_BROWSER = 'The manager has no browser: its tools are Hatchabot\'s only.';
const CAP_SHAPE = 'A memory cap looks like "4g" or "1536m", at least 512m.';
const SWAP_SHAPE = 'A swap allowance looks like "2g" or "512m" (at least 256m), or "off".';
const BOT_WENT = 'Its Telegram bot went with it to the other Hatchabot, so it cannot run here on that bot. Detach Telegram first (it keeps everything it knows), then give it another bot.';
const FOLDER_RUNNER_NOW = 'It runs on another machine now, which cannot see this machine\'s folders. Move it here first, or give it a git repo instead.';

const worlds: PatchWorld[] = [];
const busy: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const id of busy.splice(0)) clearBusy(id);
  for (const w of worlds.splice(0)) { w.routes?.stop(); await w.f.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
const said = (r: { statusCode: number; json(): any }) => ({ status: r.statusCode, error: r.json().error });
/** A second source of the owner's, with its own models. */
const addSource = (w: PatchWorld, id = 'p2', over: Record<string, unknown> = {}) =>
  w.store.insertAIProfile({ id, ownerId: w.owner, name: `Source ${id}`, vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: `ai/${id}`, createdAt: 'now', ...over } as never);
/** A machine-login Max source (no secretRef): this machine's own login. */
const machineLogin = (w: PatchWorld, id: string, ownerId = w.owner, shared = false) =>
  w.store.insertAIProfile({ id, ownerId, name: `Max ${id}`, vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', createdAt: 'now', ...(shared ? { shared: true } : {}) } as never);
/** A move to another machine under way on disk. */
const moving = (w: PatchWorld, id: string) => beginOperation(w.store, 'move-host', id, {});
const markBusyHere = (id: string) => { markBusy(id); busy.push(id); };

describe('PATCH /v1/agents/:id refuses, each with its words', () => {
  it('another account\'s agent, or none: 404', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, { name: 'Larder' }, MEMBER))).toEqual({ status: 404, error: 'Not found' });
    expect(said(await w.patch('nope', { name: 'Larder' }))).toEqual({ status: 404, error: 'Not found' });
  });

  it('a body of the wrong shape: 400 with the first field\'s problem, nothing written', async () => {
    const w = await world();
    const id = await runningAgent(w);
    const bad: Array<[string, unknown, string]> = [
      ['name', '', 'name: Too small: expected string to have >=1 characters'],
      ['name', 'x'.repeat(65), 'name: Too big: expected string to have <=64 characters'],
      ['persona', 'x'.repeat(4001), 'persona: Too big: expected string to have <=4000 characters'],
      ['sharedMemory', 'yes', 'sharedMemory: Invalid input: expected boolean, received string'],
      ['aiProfileId', '', 'aiProfileId: Too small: expected string to have >=1 characters'],
      ['model', '', 'model: Too small: expected string to have >=1 characters'],
      ['model', 'x'.repeat(65), 'model: Too big: expected string to have <=64 characters'],
      ['runsHere', false, 'runsHere: Invalid input: expected true'],
      ['sharedPaths', [''], 'sharedPaths.0: Too small: expected string to have >=1 characters'],
      ['sharedPaths', Array(9).fill('/x'), 'sharedPaths: Too big: expected array to have <=8 items'],
      ['group', 'x'.repeat(49), 'group: Too big: expected string to have <=48 characters'],
      ['image', '', 'image: Too small: expected string to have >=1 characters'],
      ['parameters', [{ key: 'a' }], 'parameters.0.label: Invalid input: expected string, received undefined'],
      ['groupAccess', { mode: 'room' }, 'groupAccess: room mode needs the bound group chat id'],
      ['groupAccess', { mode: 'all' }, 'groupAccess.mode: Invalid option: expected one of "off"|"members"|"room"'],
      ['richMessages', 'on', 'richMessages: Invalid input: expected boolean, received string'],
      ['cronTriggers', 1, 'cronTriggers: Invalid input: expected boolean, received number'],
      ['browser', 'on', 'browser: Invalid input: expected boolean, received string'],
      ['embedMode', 'cloud', 'embedMode: Invalid option: expected one of "baked"|"shared"'],
      ['memoryCap', 'x'.repeat(17), 'memoryCap: Too big: expected string to have <=16 characters'],
      ['swapAllowance', 'x'.repeat(17), 'swapAllowance: Too big: expected string to have <=16 characters'],
      ['icon', 'ab', 'icon: icon must be a single emoji'],
      ['iconColor', 'red', 'iconColor: iconColor must look like #3a8fd0'],
      ['attentionAck', 'x'.repeat(4001), 'attentionAck: Too big: expected string to have <=4000 characters'],
      ['hibernate', 'always', 'hibernate: Invalid input: expected "never"'],
      ['filesMaxMb', 0, 'filesMaxMb: Too small: expected number to be >=1'],
      ['filesMaxMb', 1.5, 'filesMaxMb: Invalid input: expected int, received number'],
    ];
    for (const [field, value, error] of bad) {
      expect(said(await w.patch(id, { [field]: value })), field).toEqual({ status: 400, error });
    }
    // Parameters whose keys repeat.
    const p = { key: 'city', label: 'City', required: false, type: 'text', target: 'soul' };
    expect(said(await w.patch(id, { parameters: [p, p] }))).toEqual({ status: 400, error: 'parameters: parameter keys must be unique' });
    // Not an object at all; an empty one, null and unknown keys are "nothing".
    const raw = (payload: string) => w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: { ...as(), 'content-type': 'application/json' }, payload });
    expect(said(await raw('[]'))).toEqual({ status: 400, error: 'Invalid input: expected object, received array' });
    expect(said(await raw('"x"'))).toEqual({ status: 400, error: 'Invalid input: expected object, received string' });
    expect(said(await raw('7'))).toEqual({ status: 400, error: 'Invalid input: expected object, received number' });
    for (const body of ['null', '{}', '{"unknown":1}']) expect(said(await raw(body)), body).toEqual({ status: 400, error: 'Nothing to update' });
    expect(said(await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as() }))).toEqual({ status: 400, error: 'Nothing to update' });
    expect(pick(w.log, 'tx{', 'set*')).toEqual([]);
  });

  it('a name another of yours has, whatever its case or spaces: 409; its own name in another case is no clash', async () => {
    const w = await world();
    const id = await runningAgent(w);
    bareAgent(w, { id: 'a2', name: 'Pantry' });
    expect(said(await w.patch(id, { name: ' pantry ' }))).toEqual({ status: 409, error: 'You already have an agent called "Pantry". Pick another name.' });
    // Another account's agent of that name, or a deleted one of yours, is no clash.
    bareAgent(w, { id: 'a3', name: 'Larder', owner: MEMBER });
    bareAgent(w, { id: 'a4', name: 'Cellar' });
    w.store.setAgentState('a4', 'DELETING');
    w.store.setAgentState('a4', 'DELETED');
    expect((await w.patch(id, { name: 'Larder' })).statusCode).toBe(200);
    expect((await w.patch(id, { name: 'Cellar' })).statusCode).toBe(200);
    expect((await w.patch(id, { name: 'CELLAR' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.name).toBe('CELLAR');
  });

  it('a name another request is giving an agent right now: 409, until that request answers', async () => {
    const w = await world();
    const id = await runningAgent(w);
    bareAgent(w, { id: 'a2', name: 'Pantry' });
    const g = holdDockerUpdate(w.provider);
    const first = Promise.resolve(w.patch(id, { name: 'Larder', memoryCap: '4g' }));
    await g.reached;
    expect(said(await w.patch('a2', { name: 'larder' }))).toEqual({ status: 409, error: 'An agent of yours is being renamed "larder" right now. Pick another name, or try again in a moment.' });
    g.open();
    expect((await first).statusCode).toBe(200);
    // Answered: the name is taken by the agent now, not held.
    expect(said(await w.patch('a2', { name: 'larder' }))).toEqual({ status: 409, error: 'You already have an agent called "Larder". Pick another name.' });
  });

  it('nothing to update: 400', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, {}))).toEqual({ status: 400, error: 'Nothing to update' });
    // `runsHere` must be true to count; sharedMemory true counts (and changes nothing).
    expect((await w.patch(id, { sharedMemory: true })).statusCode).toBe(200);
  });

  it('a browser, triggers or image change while an operation is not over: 409 with the operation; others are not refused for it', async () => {
    const w = await world();
    const id = await runningAgent(w);
    const op = moving(w, id);
    for (const body of [{ browser: true }, { cronTriggers: false }, { image: 'hatchabot-runtime:trial' }]) {
      const r = await w.patch(id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(409);
      expect(r.json()).toEqual({ error: 'Move to another machine is under way — wait for it to finish.', operation: op.id });
    }
    // The browser as it is and the image it has are no change: not refused here.
    expect((await w.patch(id, { browser: false })).statusCode).toBe(200);
    expect((await w.patch(id, { group: 'Home' })).statusCode).toBe(200);
    expect(pick(w.log, 'setAgentBrowser', 'setAgentCronTriggers', 'setAgentImage', 'setAgentGroup')).toEqual(['setAgentGroup']);
  });

  it('the manager\'s browser: 400; turning it off is allowed', async () => {
    const w = await world();
    bareAgent(w, { id: 'm1', name: 'Hatchabot', ops: true });
    expect(said(await w.patch('m1', { browser: true }))).toEqual({ status: 400, error: NO_MANAGER_BROWSER });
    expect((await w.patch('m1', { browser: false })).statusCode).toBe(200);
  });

  it('the shared memory search, not on, for someone not the machine\'s owner: 400; the owner may', async () => {
    const w = await world();
    bareAgent(w, { id: 'b1', owner: MEMBER });
    expect(said(await w.patch('b1', { embedMode: 'shared' }, MEMBER))).toEqual({ status: 400, error: NO_SEARCH_SERVICE });
    expect((await w.patch('b1', { embedMode: 'baked' }, MEMBER)).statusCode).toBe(200);
    bareAgent(w, { id: 'a2' });
    expect((await w.patch('a2', { embedMode: 'shared' })).statusCode).toBe(200);
  });

  it('a memory cap of the wrong size: 400; above the per-agent maximum for a member: 403', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, { memoryCap: 'lots' }))).toEqual({ status: 400, error: CAP_SHAPE });
    expect(said(await w.patch(id, { memoryCap: '256m' }))).toEqual({ status: 400, error: CAP_SHAPE });
    bareAgent(w, { id: 'b1', owner: MEMBER });
    expect(said(await w.patch('b1', { memoryCap: '64g' }, MEMBER))).toEqual({ status: 403, error: 'Up to 8g per agent here; the machine\'s owner can go higher (HATCHABOT_AGENT_MEMORY_MAX).' });
    expect(pick(w.log, 'docker:*', 'tx{')).toEqual([]);
  });

  it('a swap allowance of the wrong size or above the cap it sits on: 400; above the maximum for a member: 403', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, { swapAllowance: 'lots' }))).toEqual({ status: 400, error: SWAP_SHAPE });
    expect(said(await w.patch(id, { swapAllowance: '4g' }))).toEqual({ status: 400, error: 'At most the memory cap it sits on top of (3g). Raise the cap first, or give it less swap.' });
    // Against the cap this request sets.
    expect(said(await w.patch(id, { memoryCap: '2g', swapAllowance: '3g' }))).toEqual({ status: 400, error: 'At most the memory cap it sits on top of (2g). Raise the cap first, or give it less swap.' });
    expect((await w.patch(id, { memoryCap: '6g', swapAllowance: '4g' })).statusCode).toBe(200);
    bareAgent(w, { id: 'b1', owner: MEMBER });
    w.store.setAgentMemoryCap('b1', '16g');
    expect(said(await w.patch('b1', { swapAllowance: '10g' }, MEMBER))).toEqual({ status: 403, error: 'Up to 8g per agent here; the machine\'s owner can go higher (HATCHABOT_AGENT_MEMORY_MAX).' });
  });

  it('"runs here" when its Telegram bot\'s token went with it: 409', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.store.setAgentMigratedTo(id, 'https://other.example.org');
    await w.secrets.delete(`chan/${id}`);
    expect(said(await w.patch(id, { runsHere: true }))).toEqual({ status: 409, error: BOT_WENT });
    expect(w.store.getAgent(id)!.migratedTo).toBe('https://other.example.org');
  });

  it('an image pin by someone not the machine\'s owner: 403; one across the 2026.8 line: 400', async () => {
    const w = await world();
    const id = await runningAgent(w);
    bareAgent(w, { id: 'b1', owner: MEMBER });
    expect(said(await w.patch('b1', { image: 'hatchabot-runtime:trial' }, MEMBER))).toEqual({ status: 403, error: MACHINE_OWNER_ONLY });
    expect(said(await w.patch('b1', { image: null }, MEMBER))).toEqual({ status: 403, error: MACHINE_OWNER_ONLY });
    w.provider.infoOverride.set(w.store.getAgent(id)!.runtimeRef!, { openclawVersion: '2026.8.2' });
    w.provider.tags.push({ tag: 'hatchabot-runtime:old', imageId: 'old-image', openclawVersion: '2026.7.1' });
    expect(said(await w.patch(id, { image: 'hatchabot-runtime:old' }))).toEqual({ status: 400, error: "This agent's data was migrated for OpenClaw 2026.8.2; hatchabot-runtime:old runs 2026.7.1, which cannot read it. To go back, restore the copy downloaded before the move." });
    expect(pick(w.log, 'setAgentImage')).toEqual([]);
  });

  it('folders: a member 403; a runner\'s agent 400; a path refused by name or not there 400; two of one name 400; a data source\'s place 409', async () => {
    const w = await world();
    const id = await runningAgent(w);
    const notes = folder('notes');
    bareAgent(w, { id: 'b1', owner: MEMBER });
    expect(said(await w.patch('b1', { sharedPaths: [notes] }, MEMBER))).toEqual({ status: 403, error: MACHINE_OWNER_ONLY });
    // Taking every folder away asks nothing of a member.
    expect((await w.patch('b1', { sharedPaths: [] }, MEMBER)).statusCode).toBe(200);
    addRunner(w);
    bareAgent(w, { id: 'r1', name: 'Remote', hostId: 'h2' });
    expect(said(await w.patch('r1', { sharedPaths: [notes] }))).toEqual({ status: 400, error: '"Remote" runs on another machine, which cannot see this machine\'s folders. Move it here first, or give it a git repo instead.' });
    expect(said(await w.patch(id, { sharedPaths: ['/'] }))).toEqual({ status: 400, error: 'Sharing the whole filesystem is not allowed.' });
    expect(said(await w.patch(id, { sharedPaths: ['notes'] }))).toEqual({ status: 400, error: 'Use an absolute path.' });
    expect(said(await w.patch(id, { sharedPaths: [`${notes}-missing`] }))).toEqual({ status: 400, error: `No such folder on this machine: ${notes}-missing` });
    const other = folder('notes');
    expect(said(await w.patch(id, { sharedPaths: [notes, other] }))).toEqual({ status: 400, error: 'Two folders share a name — the agent would see them at the same place.' });
    w.store.insertDataSource({ id: 'ds1', agentId: id, kind: 'folder', mountName: 'notes', hostPath: '/srv/elsewhere', access: 'ro', createdAt: 'now' } as never);
    expect(said(await w.patch(id, { sharedPaths: [notes] }))).toEqual({ status: 409, error: 'A data source already lives at /data/notes. Remove it before mounting a folder with the same name.' });
    expect(pick(w.log, 'setAgentSharedPaths')).toEqual(['setAgentSharedPaths']); // the member's []
  });

  it('a source: unknown or another account\'s 400; another account\'s machine login 400; a machine login on a runner 400; a local one for the manager 400', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, { aiProfileId: 'nope' }))).toEqual({ status: 400, error: 'Unknown AI profile' });
    addSource(w, 'q1', { ownerId: MEMBER });
    expect(said(await w.patch(id, { aiProfileId: 'q1' }))).toEqual({ status: 400, error: 'Unknown AI profile' });
    machineLogin(w, 'q2', MEMBER, true);
    expect(said(await w.patch(id, { aiProfileId: 'q2' }))).toEqual({ status: 400, error: "That Max source uses its owner's machine login and can't be used by another account. Use a setup-token source or your own API key." });
    machineLogin(w, 'max');
    addRunner(w);
    bareAgent(w, { id: 'r1', name: 'Remote', hostId: 'h2' });
    expect(said(await w.patch('r1', { aiProfileId: 'max' }))).toEqual({ status: 400, error: MACHINE_LOGIN_NO_RUNNER });
    addSource(w, 'local', { vendor: 'local', kind: 'local', model: 'llama3', secretRef: undefined, baseUrl: 'http://127.0.0.1:11434' });
    bareAgent(w, { id: 'm1', name: 'Hatchabot', ops: true });
    expect(said(await w.patch('m1', { aiProfileId: 'local' }))).toEqual({ status: 400, error: OPS_NO_LOCAL });
    // Its own source again is no switch.
    expect((await w.patch(id, { aiProfileId: 'p1' })).statusCode).toBe(200);
    expect(pick(w.log, 'setAgentAIProfile')).toEqual([]);
  });

  it('a model: with no source 400; not on the source\'s menu 400; for a local source 400; checked against the source it switches to', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, { model: 'claude-sonnet-5' }))).toEqual({ status: 400, error: '"claude-sonnet-5" isn’t one of this source’s models. Add it to the source’s switchable list first.' });
    addSource(w, 'p2');
    expect((await w.patch(id, { aiProfileId: 'p2', model: 'claude-sonnet-5' })).statusCode).toBe(200);
    addSource(w, 'local', { vendor: 'local', kind: 'local', model: 'llama3', secretRef: undefined, baseUrl: 'http://127.0.0.1:11434' });
    expect(said(await w.patch(id, { aiProfileId: 'local', model: 'llama3' }))).toEqual({ status: 400, error: 'Local sources run one model at a time, so agents follow the source’s model — set it on the source, not per agent.' });
    // Its source gone from under it.
    bareAgent(w, { id: 'a2', profile: 'gone' });
    expect(said(await w.patch('a2', { model: OTHER }))).toEqual({ status: 400, error: 'Unknown AI profile' });
    // Clearing it with no source is no model to check.
    expect((await w.patch('a2', { name: 'Still here' })).statusCode).toBe(200);
  });

  it('what it would run cannot run there (the runtime check): 400', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.store.insertAIProfile({ id: 'max', ownerId: w.owner, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/max', createdAt: 'now' } as never);
    w.provider.imageOpenclawVersion = '2026.9.6';
    expect(said(await w.patch(id, { aiProfileId: 'max' }))).toEqual({ status: 400, error: 'claude-opus-5-5 needs OpenClaw 2026.9.7 or newer on a Claude subscription, and this agent runs 2026.9.6: Anthropic would refuse every message ("request format rejected, HTTP 400"). Try a newer runtime image on this agent (Settings → Advanced → Runtime images), or use an API-key source.' });
    expect(pick(w.log, 'setAgentAIProfile')).toEqual([]);
  });

  it('a source switch while an operation is not over: 409 with it; while busy: 409', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w, 'p2');
    const op = moving(w, id);
    const r = await w.patch(id, { aiProfileId: 'p2' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'Move to another machine is under way — wait for it to finish.', operation: op.id });
    const w2 = await world();
    const id2 = await runningAgent(w2);
    addSource(w2, 'p2');
    markBusyHere(id2);
    expect(said(await w2.patch(id2, { aiProfileId: 'p2' }))).toEqual({ status: 409, error: SOURCE_SWITCH_BUSY });
    // Busy refuses only a switch.
    expect((await w2.patch(id2, { name: 'Larder' })).statusCode).toBe(200);
  });

  it('shared memory off: 400, but for the manager, which keeps its own', async () => {
    const w = await world();
    const id = await runningAgent(w);
    expect(said(await w.patch(id, { sharedMemory: false }))).toEqual({ status: 400, error: NOT_SHARED });
    bareAgent(w, { id: 'm1', name: 'Hatchabot', ops: true });
    expect((await w.patch('m1', { sharedMemory: false })).statusCode).toBe(200);
  });

  it('the source deleted during the runtime check: 409, and it was not held then', async () => {
    const w = await world();
    const id = await runningAgent(w);
    // A setup-token Max source whose default model needs a recent OpenClaw: the check asks the image it lands on.
    addSource(w, 'p2', { kind: 'subscription', model: 'claude-opus-5-5' });
    w.provider.imageOpenclawVersion = '2026.9.8';
    const g = gate();
    const imageInfo = w.provider.currentImageInfo.bind(w.provider);
    w.provider.currentImageInfo = async (image?: string) => { g.reach(); await g.held; return imageInfo(image); };
    const r = Promise.resolve(w.patch(id, { aiProfileId: 'p2', group: 'Home' }));
    await g.reached;
    // No hold yet: the delete goes through.
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p2', headers: as() })).statusCode).toBe(200);
    g.open();
    expect(said(await r)).toEqual({ status: 409, error: SOURCE_GONE });
    expect(pick(w.log, 'tx{', 'setAgentGroup')).toEqual([]);
  });
});

describe('PATCH /v1/agents/:id refuses inside its holds (the source, the limits turn, the transaction)', () => {
  it('the cap\'s docker update refused by a machine that answers: 502, nothing stored, and the source let go', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w, 'p2');
    w.provider.updateMemory = async () => { throw new ProviderError('docker update failed', 'Docker refused the new memory limit.'); };
    expect(said(await w.patch(id, { aiProfileId: 'p2', memoryCap: '4g', group: 'Home', name: 'Larder', browser: true, cronTriggers: true, filesMaxMb: 20 }))).toEqual({ status: 502, error: 'Docker refused the new memory limit.' });
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'p1', name: 'Kitchen' });
    expect(w.store.getAgent(id)!.group).toBeUndefined();
    await tick();
    // Nothing of what follows a stored change: no write, no trace, no rebuild, nothing asked of the agent or its bot.
    expect(pick(w.log, 'tx{', 'event:*', 'exec:*', 'operation:*', 'owe', 'secret:*', 'shell', 'volume')).toEqual([]);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p2', headers: as() })).statusCode).toBe(200);
  });

  it('the source is held from the cap\'s docker call until the change is stored', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w, 'p2');
    const g = holdDockerUpdate(w.provider);
    const r = Promise.resolve(w.patch(id, { aiProfileId: 'p2', memoryCap: '4g' }));
    await g.reached;
    expect(said(await w.f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p2', headers: as() }))).toEqual({ status: 409, error: 'An agent is switching to it; try again in a moment.' });
    g.open();
    expect((await r).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.aiProfileId).toBe('p2');
  });

  it('the agent deleted during the cap\'s docker call, with a swap allowance to set: 404, and no swap update', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.provider.swapState = { kind: 'zswap', compressed: true, swapDevices: [] };
    const g = holdDockerUpdate(w.provider);
    const r = Promise.resolve(w.patch(id, { memoryCap: '4g', swapAllowance: '1g' }));
    await g.reached;
    w.store.setAgentState(id, 'DELETING');
    g.open();
    expect(said(await r)).toEqual({ status: 404, error: GONE });
    expect(pick(w.log, 'docker:*', 'tx{')).toEqual(['docker:4g']);
  });

  it('the swap\'s docker update refused: 502, and the container put back on what is stored', async () => {
    const w = await world();
    const id = await runningAgent(w);
    w.provider.swapState = { kind: 'zswap', compressed: true, swapDevices: [] };
    const update = w.provider.updateMemory.bind(w.provider);
    let n = 0;
    w.provider.updateMemory = async (...a: Parameters<typeof update>) => { if (++n === 2) throw new ProviderError('docker update failed', 'Docker refused the swap.'); return update(...a); };
    expect(said(await w.patch(id, { memoryCap: '4g', swapAllowance: '1g' }))).toEqual({ status: 502, error: 'Docker refused the swap.' });
    expect(w.provider.memoryUpdates.map((u) => u.cap)).toEqual(['4g', '3g']);
    expect(w.store.getAgent(id)!.memoryCap).toBeUndefined();
  });

  it('the transaction\'s refusals, each after its waits: deleted 404, moving 409, folders on a runner 400, triggers busy 409, busy 409, runner 400, no source 409', async () => {
    const cases: Array<{ what: string; body: (w: PatchWorld) => Record<string, unknown>; meanwhile: (w: PatchWorld, id: string) => void; want: { status: number; error: string } }> = [
      { what: 'deleted', body: () => ({ memoryCap: '4g', group: 'Home' }), meanwhile: (w, id) => w.store.setAgentState(id, 'DELETING'), want: { status: 404, error: GONE } },
      { what: 'moving', body: () => ({ memoryCap: '4g', image: null }), meanwhile: (w, id) => { moving(w, id); }, want: { status: 409, error: MOVING } },
      { what: 'folder-runner', body: () => ({ memoryCap: '4g', sharedPaths: [folder()] }), meanwhile: (w, id) => { addRunner(w); w.store.setAgentHost(id, 'h2'); }, want: { status: 400, error: FOLDER_RUNNER_NOW } },
      { what: 'triggers-busy', body: () => ({ memoryCap: '4g', cronTriggers: true }), meanwhile: (_w, id) => markBusyHere(id), want: { status: 409, error: TRIGGERS_BUSY } },
      { what: 'triggers-busy (an operation)', body: () => ({ memoryCap: '4g', cronTriggers: true }), meanwhile: (w, id) => { moving(w, id); }, want: { status: 409, error: TRIGGERS_BUSY } },
      { what: 'busy', body: () => ({ memoryCap: '4g', aiProfileId: 'p2' }), meanwhile: (_w, id) => markBusyHere(id), want: { status: 409, error: SOURCE_SWITCH_BUSY } },
      { what: 'runner', body: () => ({ memoryCap: '4g', aiProfileId: 'max' }), meanwhile: (w, id) => { addRunner(w); w.store.setAgentHost(id, 'h2'); }, want: { status: 400, error: MACHINE_LOGIN_NO_RUNNER } },
      { what: 'no-source', body: () => ({ memoryCap: '4g', aiProfileId: 'p2' }), meanwhile: (w) => w.store.deleteAIProfile('p2'), want: { status: 409, error: SOURCE_GONE } },
    ];
    for (const c of cases) {
      const w = await world();
      const id = await runningAgent(w);
      addSource(w, 'p2');
      machineLogin(w, 'max');
      const g = holdDockerUpdate(w.provider);
      const r = Promise.resolve(w.patch(id, c.body(w)));
      await g.reached;
      c.meanwhile(w, id);
      g.open();
      expect(said(await r), c.what).toEqual(c.want);
      // Inside the transaction and before any write (the source's write is the one that refuses).
      expect(pick(w.log, 'tx{', 'set*', '}tx'), c.what).toEqual(c.what === 'no-source' ? ['tx{', 'setAgentAIProfile', '}tx'] : ['tx{', '}tx']);
      expect(w.store.getAgent(id)!.memoryCap, c.what).toBeUndefined();
      for (const b of busy.splice(0)) clearBusy(b);
    }
  });

  it('refused in the transaction, the container is put back on what is stored, after the refusal is decided and before the answer', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w, 'p2');
    const g = holdDockerUpdate(w.provider);
    const r = Promise.resolve(w.patch(id, { memoryCap: '4g', aiProfileId: 'p2' }));
    await g.reached;
    markBusyHere(id);
    g.open();
    expect((await r).statusCode).toBe(409);
    expect(pick(w.log, 'docker:*', 'tx{', '}tx', 'reply')).toEqual(['docker:4g', 'tx{', '}tx', 'docker:3g', 'reply']);
  });

  it('a write that throws in the transaction: 500, nothing stored, the container put back', async () => {
    const w = await world();
    const id = await runningAgent(w);
    const icon = w.store.setAgentIcon.bind(w.store);
    w.store.setAgentIcon = () => { void icon; throw new Error('the disk said no'); };
    const r = await w.patch(id, { memoryCap: '4g', icon: '🍳', group: 'Home' });
    expect(r.statusCode).toBe(500);
    expect(w.store.getAgent(id)!.memoryCap).toBeUndefined();
    expect(w.store.getAgent(id)!.group).toBeUndefined();
    expect(pick(w.log, 'docker:*', 'tx{', '}tx', 'reply')).toEqual(['docker:4g', 'tx{', '}tx', 'docker:3g', 'reply']);
  });

  it('refused inside the holds, the limits turn is let go: the next change of its cap goes through', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w, 'p2');
    w.store.deleteAIProfile('p2');
    // Unknown now: refused before the holds. Then one refused inside them.
    w.store.insertAIProfile({ id: 'p3', ownerId: w.owner, name: 'Third', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p3', createdAt: 'now' } as never);
    const g = holdDockerUpdate(w.provider);
    const r = Promise.resolve(w.patch(id, { memoryCap: '4g', aiProfileId: 'p3' }));
    await g.reached;
    w.store.deleteAIProfile('p3');
    g.open();
    expect(said(await r)).toEqual({ status: 409, error: SOURCE_GONE });
    expect((await w.patch(id, { memoryCap: '5g' })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.memoryCap).toBe('5g');
  });
});

describe('PATCH /v1/agents/:id: which refusal wins when two apply', () => {
  /** Each row: what the request asks, the state that makes two refusals apply, and the one that wins. */
  type Row = { what: string; who?: string; agent?: 'running' | 'member' | 'manager' | 'member-manager' | 'runner'; setup?: (w: PatchWorld, id: string) => void | Promise<void>; body: (w: PatchWorld) => Record<string, unknown>; want: { status: number; error: string } };
  const rows: Row[] = [
    { what: 'the owner before the body', who: MEMBER, body: () => ({ name: '' }), want: { status: 404, error: 'Not found' } },
    { what: 'the body before the name', setup: (w) => { bareAgent(w, { id: 'a2', name: 'Pantry' }); }, body: () => ({ name: 'Pantry', icon: 'ab' }), want: { status: 400, error: 'icon: icon must be a single emoji' } },
    { what: 'the name before its hold', setup: (w) => { bareAgent(w, { id: 'a2', name: 'Pantry' }); }, body: () => ({ name: 'Pantry' }), want: { status: 409, error: 'You already have an agent called "Pantry". Pick another name.' } },
    { what: 'the name before an operation', setup: (w, id) => { bareAgent(w, { id: 'a2', name: 'Pantry' }); moving(w, id); }, body: () => ({ name: 'Pantry', browser: true }), want: { status: 409, error: 'You already have an agent called "Pantry". Pick another name.' } },
    { what: 'nothing to update before an operation', setup: (w, id) => { moving(w, id); }, body: () => ({}), want: { status: 400, error: 'Nothing to update' } },
    { what: 'an operation before the manager\'s browser', agent: 'manager', setup: (w, id) => { moving(w, id); }, body: () => ({ browser: true }), want: { status: 409, error: 'Move to another machine is under way — wait for it to finish.' } },
    { what: 'an operation before an unknown source', setup: (w, id) => { moving(w, id); }, body: () => ({ browser: true, aiProfileId: 'nope' }), want: { status: 409, error: 'Move to another machine is under way — wait for it to finish.' } },
    { what: 'the manager\'s browser before the memory search', agent: 'member-manager', who: MEMBER, body: () => ({ browser: true, embedMode: 'shared' }), want: { status: 400, error: NO_MANAGER_BROWSER } },
    { what: 'the memory search before the cap', agent: 'member', who: MEMBER, body: () => ({ embedMode: 'shared', memoryCap: 'lots' }), want: { status: 400, error: NO_SEARCH_SERVICE } },
    { what: 'the cap before the swap', body: () => ({ memoryCap: 'lots', swapAllowance: 'lots' }), want: { status: 400, error: CAP_SHAPE } },
    { what: 'the swap before runs here', setup: async (w, id) => { await w.secrets.delete(`chan/${id}`); }, body: () => ({ swapAllowance: 'lots', runsHere: true }), want: { status: 400, error: SWAP_SHAPE } },
    { what: 'runs here before the image', agent: 'member', who: MEMBER, setup: (w, id) => { w.store.insertChannel({ id: 'c-b1', agentId: id, kind: 'telegram', accountId: 'pantrybot', secretRef: 'chan/missing', deepLink: 'https://t.me/pantrybot', createdAt: 'now' }); }, body: () => ({ runsHere: true, image: 'hatchabot-runtime:trial' }), want: { status: 409, error: BOT_WENT } },
    { what: 'the image\'s owner check before the folders', agent: 'member', who: MEMBER, body: () => ({ image: 'hatchabot-runtime:trial', sharedPaths: ['/'] }), want: { status: 403, error: MACHINE_OWNER_ONLY } },
    { what: 'the image pin before the folders', setup: (w, id) => { w.provider.infoOverride.set(w.store.getAgent(id)!.runtimeRef!, { openclawVersion: '2026.8.2' }); w.provider.tags.push({ tag: 'hatchabot-runtime:old', imageId: 'old-image', openclawVersion: '2026.7.1' }); }, body: () => ({ image: 'hatchabot-runtime:old', sharedPaths: ['/'] }), want: { status: 400, error: "This agent's data was migrated for OpenClaw 2026.8.2; hatchabot-runtime:old runs 2026.7.1, which cannot read it. To go back, restore the copy downloaded before the move." } },
    { what: 'the folders\' owner check before the runner', agent: 'member', who: MEMBER, setup: (w, id) => { addRunner(w); w.store.setAgentHost(id, 'h2'); }, body: () => ({ sharedPaths: ['/'] }), want: { status: 403, error: MACHINE_OWNER_ONLY } },
    { what: 'the runner before a path\'s problem', agent: 'runner', body: () => ({ sharedPaths: ['/'] }), want: { status: 400, error: '"Remote" runs on another machine, which cannot see this machine\'s folders. Move it here first, or give it a git repo instead.' } },
    { what: 'each path in its order: a missing one first', body: () => ({ sharedPaths: ['/no/such/folder/here', '/'] }), want: { status: 400, error: 'No such folder on this machine: /no/such/folder/here' } },
    { what: 'each path in its order: a refused one first', body: () => ({ sharedPaths: ['/', '/no/such/folder/here'] }), want: { status: 400, error: 'Sharing the whole filesystem is not allowed.' } },
    { what: 'a path\'s problem before two of one name', body: () => { const a = folder('x'), b = folder('x'); return { sharedPaths: [a, b, '/'] }; }, want: { status: 400, error: 'Sharing the whole filesystem is not allowed.' } },
    { what: 'two of one name before a data source\'s place', setup: (w, id) => { w.store.insertDataSource({ id: 'ds1', agentId: id, kind: 'folder', mountName: 'x', hostPath: '/srv/elsewhere', access: 'ro', createdAt: 'now' } as never); }, body: () => { const a = folder('x'), b = folder('x'); return { sharedPaths: [a, b] }; }, want: { status: 400, error: 'Two folders share a name — the agent would see them at the same place.' } },
    { what: 'the folders before the source', body: () => ({ sharedPaths: ['/'], aiProfileId: 'nope' }), want: { status: 400, error: 'Sharing the whole filesystem is not allowed.' } },
    { what: 'another account\'s machine login before the runner', agent: 'runner', setup: (w) => { machineLogin(w, 'q2', MEMBER, true); }, body: () => ({ aiProfileId: 'q2' }), want: { status: 400, error: "That Max source uses its owner's machine login and can't be used by another account. Use a setup-token source or your own API key." } },
    { what: 'the source before the model', body: () => ({ aiProfileId: 'nope', model: 'not-on-any-menu' }), want: { status: 400, error: 'Unknown AI profile' } },
    { what: 'the model\'s menu before the runtime check', setup: (w) => { w.store.insertAIProfile({ id: 'max', ownerId: w.owner, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/max', createdAt: 'now' } as never); w.provider.imageOpenclawVersion = '2026.9.6'; }, body: () => ({ aiProfileId: 'max', model: 'not-on-any-menu' }), want: { status: 400, error: '"not-on-any-menu" isn’t one of this source’s models. Add it to the source’s switchable list first.' } },
    { what: 'the runtime check before an operation', setup: (w, id) => { w.store.insertAIProfile({ id: 'max', ownerId: w.owner, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/max', createdAt: 'now' } as never); w.provider.imageOpenclawVersion = '2026.9.6'; moving(w, id); }, body: () => ({ aiProfileId: 'max' }), want: { status: 400, error: 'claude-opus-5-5 needs OpenClaw 2026.9.7 or newer on a Claude subscription, and this agent runs 2026.9.6: Anthropic would refuse every message ("request format rejected, HTTP 400"). Try a newer runtime image on this agent (Settings → Advanced → Runtime images), or use an API-key source.' } },
    { what: 'an operation before busy', setup: (w, id) => { addSource(w, 'p2'); moving(w, id); markBusyHere(id); }, body: () => ({ aiProfileId: 'p2' }), want: { status: 409, error: 'Move to another machine is under way — wait for it to finish.' } },
    { what: 'busy before shared memory off', setup: (w, id) => { addSource(w, 'p2'); markBusyHere(id); }, body: () => ({ aiProfileId: 'p2', sharedMemory: false }), want: { status: 409, error: SOURCE_SWITCH_BUSY } },
    { what: 'the cap before shared memory off', body: () => ({ sharedMemory: false, memoryCap: 'lots' }), want: { status: 400, error: CAP_SHAPE } },
    { what: 'shared memory off before the cap\'s docker update', setup: (w) => { w.provider.updateMemory = async () => { throw new ProviderError('docker update failed', 'Docker refused the new memory limit.'); }; }, body: () => ({ sharedMemory: false, memoryCap: '4g' }), want: { status: 400, error: NOT_SHARED } },
    { what: 'the cap\'s docker update before the transaction', setup: (w, id) => { addSource(w, 'p2'); w.provider.updateMemory = async () => { markBusyHere(id); throw new ProviderError('docker update failed', 'Docker refused the new memory limit.'); }; }, body: () => ({ aiProfileId: 'p2', memoryCap: '4g' }), want: { status: 502, error: 'Docker refused the new memory limit.' } },
  ];
  for (const row of rows) {
    it(row.what, async () => {
      const w = await world();
      let id: string;
      if (row.agent === 'member') id = bareAgent(w, { id: 'b1', owner: MEMBER });
      else if (row.agent === 'manager') id = bareAgent(w, { id: 'm1', name: 'Hatchabot', ops: true });
      else if (row.agent === 'member-manager') id = bareAgent(w, { id: 'm2', name: 'Hatchabot', ops: true, owner: MEMBER });
      else if (row.agent === 'runner') { addRunner(w); id = bareAgent(w, { id: 'r1', name: 'Remote', hostId: 'h2' }); }
      else id = await runningAgent(w);
      await row.setup?.(w, id);
      const r = await w.patch(id, row.body(w), row.who);
      expect(said(r)).toEqual(row.want);
      expect(pick(w.log, 'tx{')).toEqual([]);
    });
  }

  it('in the transaction, in its order: deleted, moving, folders on a runner, triggers busy, busy, runner, no source', async () => {
    // Each pair: the body, what happens during the cap's docker call (both refusals then apply), the one that wins.
    const pairs: Array<[string, (w: PatchWorld) => Record<string, unknown>, (w: PatchWorld, id: string) => void, { status: number; error: string }]> = [
      ['deleted before moving', () => ({ memoryCap: '4g', image: null }), (w, id) => { moving(w, id); w.store.setAgentState(id, 'DELETING'); }, { status: 404, error: GONE }],
      ['moving before folders on a runner', () => ({ memoryCap: '4g', sharedPaths: [folder()] }), (w, id) => { moving(w, id); addRunner(w); w.store.setAgentHost(id, 'h2'); }, { status: 409, error: MOVING }],
      ['folders on a runner before triggers busy', () => ({ memoryCap: '4g', sharedPaths: [folder()], cronTriggers: true }), (w, id) => { addRunner(w); w.store.setAgentHost(id, 'h2'); markBusyHere(id); }, { status: 400, error: FOLDER_RUNNER_NOW }],
      ['triggers busy before busy', () => ({ memoryCap: '4g', cronTriggers: true, aiProfileId: 'p2' }), (_w, id) => markBusyHere(id), { status: 409, error: TRIGGERS_BUSY }],
      ['busy before runner', () => ({ memoryCap: '4g', aiProfileId: 'max' }), (w, id) => { addRunner(w); w.store.setAgentHost(id, 'h2'); markBusyHere(id); }, { status: 409, error: SOURCE_SWITCH_BUSY }],
      ['runner before no source', () => ({ memoryCap: '4g', aiProfileId: 'max' }), (w, id) => { addRunner(w); w.store.setAgentHost(id, 'h2'); w.store.deleteAIProfile('max'); }, { status: 400, error: MACHINE_LOGIN_NO_RUNNER }],
    ];
    for (const [what, body, meanwhile, want] of pairs) {
      const w = await world();
      const id = await runningAgent(w);
      addSource(w, 'p2');
      machineLogin(w, 'max');
      const g = holdDockerUpdate(w.provider);
      const r = Promise.resolve(w.patch(id, body(w)));
      await g.reached;
      meanwhile(w, id);
      g.open();
      expect(said(await r), what).toEqual(want);
      for (const b of busy.splice(0)) clearBusy(b);
    }
  });

  it('the swap\'s refusal before the transaction\'s', async () => {
    const w = await world();
    const id = await runningAgent(w);
    addSource(w, 'p2');
    w.provider.swapState = { kind: 'zswap', compressed: true, swapDevices: [] };
    const update = w.provider.updateMemory.bind(w.provider);
    let n = 0;
    w.provider.updateMemory = async (...a: Parameters<typeof update>) => {
      if (++n === 2) { markBusyHere(id); throw new ProviderError('docker update failed', 'Docker refused the swap.'); }
      return update(...a);
    };
    expect(said(await w.patch(id, { memoryCap: '4g', swapAllowance: '1g', aiProfileId: 'p2' }))).toEqual({ status: 502, error: 'Docker refused the swap.' });
    expect(pick(w.log, 'tx{')).toEqual([]);
  });
});
