import { applyLegacyEnv } from '../src/envCompat.js';
applyLegacyEnv();
/**
 * Real-runtime smoke test: provisions an actual OpenClaw container through
 * LocalDockerProvider, waits for the gateway to report healthy, exercises
 * exec(), then tears down. Run after scripts/build-runtime-image.sh.
 *
 * Two modes:
 *   - No TELEGRAM_BOT_TOKEN: boots without a channel (proves runtime + config
 *     injection + health + lifecycle).
 *   - TELEGRAM_BOT_TOKEN set: full flow — the bot goes live in pairing mode;
 *     DM it and watch the claim land.
 *
 *   npm run e2e:docker
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { TelegramManualProvisioner, verifyBotToken } from '../src/channels/telegramManual.js';
import { provisionAgent, claudeAuthDir } from '../src/orchestrator/provision.js';
import { claimFirstContact } from '../src/orchestrator/claim.js';
import { existsSync } from 'node:fs';

const provider = new LocalDockerProvider({ image: process.env.HATCHABOT_IMAGE });
const log = (event: string, detail: Record<string, unknown>) =>
  console.log(`  · ${event}`, JSON.stringify(detail));

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!existsSync(`${claudeAuthDir()}/.credentials.json`)) {
  console.error('No ~/.claude/.credentials.json — log into Claude Code first.');
  process.exit(1);
}

if (!botToken) {
  // ---- runtime-only smoke: no channel, drive the provider directly --------
  console.log('▸ No TELEGRAM_BOT_TOKEN — runtime-only smoke test');
  const agentId = randomUUID();
  const { runtimeRef } = await provider.provision({
    agentId,
    slug: 'smoke-agent',
    workspace: {
      files: { 'SOUL.md': '# Smoke Agent\nYou exist to prove the plumbing works.\n' },
      configPatch: { agentId: 'smoke-agent', model: 'claude-opus-4-8', authMode: 'oauth-claude-cli' },
    },
    env: {},
    hostMounts: [{ source: claudeAuthDir(), target: '/home/node/.claude' }],
  });
  console.log(`  provisioned ${runtimeRef}`);

  try {
    await provider.start(runtimeRef);
    console.log('  started, waiting for gateway health…');
    await waitHealthy(runtimeRef);
    console.log('  ✅ gateway healthy');

    const agents = await provider.exec(runtimeRef, ['agents', 'list', '--json']);
    console.log(`  agents list (code ${agents.code}): ${agents.stdout.trim().slice(0, 200)}`);

    await provider.stop(runtimeRef);
    console.log('  stopped cleanly');
  } finally {
    await provider.destroy(runtimeRef, { purge: true });
    console.log('  destroyed + volume purged');
  }
  console.log('\n✅ Docker runtime smoke passes.\n');
  process.exit(0);
}

// ---- full flow: real bot, real pairing --------------------------------------
console.log('▸ TELEGRAM_BOT_TOKEN set — full provisioning flow');
const username = await verifyBotToken(botToken);
console.log(`  token ok: @${username}`);

const db = new Database(':memory:');
const store = new Store(db);
const secrets = new LocalSecretStore(
  db,
  Buffer.from(process.env.HATCHABOT_SECRET_KEY ?? '0'.repeat(64), 'hex'),
);
const channel = new TelegramManualProvisioner(secrets);

const profileId = randomUUID();
store.insertAIProfile({
  id: profileId,
  ownerId: 'test-owner',
  name: 'My Claude (Max)',
  vendor: 'anthropic',
  kind: 'subscription',
  model: 'claude-opus-4-8',
  createdAt: new Date().toISOString(),
});
const hostId = randomUUID();
store.insertHost({
  id: hostId,
  ownerId: 'test-owner',
  kind: 'local',
  provider: 'local-docker',
  name: 'this box',
  settings: {},
  createdAt: new Date().toISOString(),
});

const agentName = process.env.AGENT_NAME ?? 'Test Agent';
await channel.submitToken('pending', botToken); // placeholder; real key set below

// TelegramManualProvisioner keys pending tokens by agentId, which we don't
// know until provisionAgent creates it. Wrap to inject on first call.
const wrapped = {
  ...channel,
  kind: channel.kind,
  provision: async (req: Parameters<typeof channel.provision>[0]) => {
    await channel.submitToken(req.agentId, botToken!);
    return channel.provision(req);
  },
  release: channel.release.bind(channel),
};

const result = await provisionAgent(
  { store, secrets, provider, channel: wrapped, log },
  { ownerId: 'test-owner', name: agentName, persona: 'You are a friendly smoke test.', aiProfileId: profileId, hostId },
);

console.log(`\n  state:     ${result.agent.state}`);
if (result.agent.state !== 'RUNNING') {
  console.error(`  reason: ${result.agent.stateReason}`);
  process.exit(1);
}
console.log(`  deep link: ${result.deepLink}`);
console.log('\n▸ DM the bot now — watching for the pairing request (5 min)…');

const claimed = await claimFirstContact(
  { store, provider, log },
  {
    agentId: result.agent.id,
    runtimeRef: result.agent.runtimeRef!,
    accountId: username,
    forUserId: 'test-owner',
    timeoutMs: 5 * 60_000,
  },
);
console.log(claimed ? `\n✅ Claimed by telegram user ${claimed} — send another message and the agent replies.` : '\n⚠ Claim window closed unclaimed.');
console.log(`\nRuntime left running: ${result.agent.runtimeRef} (docker ps | grep hatchabot)`);

async function waitHealthy(runtimeRef: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const s = await provider.status(runtimeRef);
    if (s.phase === 'running' && s.healthy) return;
    if (s.phase === 'error') throw new Error(s.message);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('gateway never became healthy');
}
