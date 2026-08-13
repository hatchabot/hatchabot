/**
 * Drives the whole §11.1 flow in-process against the mock provider:
 *
 *   AI profile -> host -> tap + -> bot leased -> runtime provisioned ->
 *   booted -> healthy -> RUNNING -> deep link
 *
 * Then proves the failure path rolls everything back. No cloud, no cost.
 *
 *   AGENTCLAW_SECRET_KEY=$(openssl rand -hex 32) npm run e2e
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { provisionAgent } from '../src/orchestrator/provision.js';
import { buildConfigCommands, describeConfigCommands } from '../src/openclaw/configWriter.js';

const db = new Database(':memory:');
const store = new Store(db);
// Use the same key derivation the server does (keyFromEnv), so a
// passphrase-style AGENTCLAW_SECRET_KEY in the environment doesn't crash the
// e2e with "must be 32 bytes"; default to a fixed hex key when unset.
const secrets = new LocalSecretStore(
  db,
  process.env.AGENTCLAW_SECRET_KEY
    ? LocalSecretStore.keyFromEnv()
    : Buffer.from('0'.repeat(64), 'hex'),
);
const channel = new TelegramPoolProvisioner(db, secrets);

const log = (event: string, detail: Record<string, unknown>) =>
  console.log(`  · ${event}`, JSON.stringify(detail));

// --- one-time setup (§11.0) -------------------------------------------------

await channel.addToPool('KitchenHelperBot', '123456:FAKE-TOKEN-FOR-LOCAL-TESTING');
await channel.addToPool('SpareAgentBot', '654321:FAKE-TOKEN-FOR-LOCAL-TESTING');

const profileId = randomUUID();
await secrets.put(`ai-profile/${profileId}`, 'sk-ant-fake-key-for-local-testing');
store.insertAIProfile({
  id: profileId,
  ownerId: 'chris',
  name: 'My Claude',
  vendor: 'anthropic',
  kind: 'api_key',
  model: 'claude-opus-5',
  secretRef: `ai-profile/${profileId}`,
  createdAt: new Date().toISOString(),
});

const hostId = randomUUID();
store.insertHost({
  id: hostId,
  ownerId: 'chris',
  kind: 'cloud',
  provider: 'mock',
  name: "Chris's GCP",
  settings: {},
  createdAt: new Date().toISOString(),
});

// --- happy path -------------------------------------------------------------

console.log('\n▸ Tap +, name it "Kitchen Helper"');
const provider = new MockProvider({ healthyAfter: 2 });
const started = Date.now();
const result = await provisionAgent(
  { store, secrets, provider, channel, sleep: async () => {}, log },
  {
    ownerId: 'chris',
    name: 'Kitchen Helper',
    persona: 'You help plan meals and keep the pantry list current.',
    aiProfileId: profileId,
    hostId,
  },
);

console.log(`\n  state:     ${result.agent.state}`);
console.log(`  deep link: ${result.deepLink}`);
console.log(`  elapsed:   ${Date.now() - started}ms (mock — no real provisioning)`);
assert(result.agent.state === 'RUNNING', 'agent should be RUNNING');
assert(result.deepLink === 'https://t.me/KitchenHelperBot', 'deep link should point at the bot');

console.log('\n▸ OpenClaw config commands the provisioner would run on the runtime:');
const spec = provider.runtimes.get(result.agent.runtimeRef!)!.spec;
for (const line of describeConfigCommands(buildConfigCommands(spec.workspace.configPatch))) {
  console.log(`    ${line}`);
}
console.log('\n▸ Workspace files seeded:');
for (const name of Object.keys(spec.workspace.files)) console.log(`    ${name}`);

// --- lifecycle --------------------------------------------------------------

console.log('\n▸ Lifecycle: stop / start');
await provider.stop(result.agent.runtimeRef!);
store.setAgentState(result.agent.id, 'STOPPED');
await provider.start(result.agent.runtimeRef!);
const restarted = store.setAgentState(result.agent.id, 'RUNNING');
assert(restarted.state === 'RUNNING', 'agent should be RUNNING again');
console.log('  ok');

// --- failure path: rollback leaves nothing orphaned -------------------------

console.log('\n▸ Failure path: runtime provisioning fails after the bot is leased');
const before = channel.availableCount();
const failing = new MockProvider({ failOn: 'provision' });
const failed = await provisionAgent(
  { store, secrets, provider: failing, channel, sleep: async () => {}, log },
  { ownerId: 'chris', name: 'Doomed Agent', aiProfileId: profileId, hostId },
);

console.log(`\n  state:  ${failed.agent.state}`);
console.log(`  reason: ${failed.agent.stateReason}`);
assert(failed.agent.state === 'FAILED', 'agent should be FAILED');
assert(
  channel.availableCount() === before,
  `bot lease should be released on rollback (was ${before}, now ${channel.availableCount()})`,
);
console.log('  bot lease returned to the pool — nothing orphaned');

console.log('\n✅ End-to-end loop passes against the mock provider.\n');

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`\n❌ ${msg}\n`);
    process.exit(1);
  }
}
