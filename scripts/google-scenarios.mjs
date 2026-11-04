#!/usr/bin/env node
/**
 * A plain request for mail reaches `gog` under OpenClaw's Code Mode, on a live
 * install (scripts/live.mjs runs it; HB-0394). A web-only test agent with Code
 * Mode forced on gets the section Hatchabot writes for an attached account and
 * a stand-in `gog` over a made-up mailbox, because attaching a real account
 * needs a person at Google's consent screen. One AI turn, in a fresh session,
 * that names no command. It shows the agent runs gog and reads the result; it
 * does not show that a real mailbox answers (docs/live-tests.md).
 *
 *   node_modules/.bin/tsx scripts/google-scenarios.mjs [--keep]
 *
 * The agent is "zz google test …" and is deleted at the end unless --keep.
 */
import { googleAccountsSection } from '../src/openclaw/workspace.ts';
import { cleanupAgents, createAgent, inAgent, log, requireRoom, scenario, summary, workspaceOf } from './live-lib.mjs';

const PREFIX = 'zz google test';
const keep = process.argv.includes('--keep');
const ACCOUNT = 'pat@example.org';
const SUBJECT = 'Pumpkin soup recipe';
const CALLS = '/home/node/gog-calls.log';
const STAND_IN = `#!/bin/sh
echo "$*" >> ${CALLS}
case "$*" in
  *"auth list"*) echo '{"accounts":[{"email":"${ACCOUNT}","services":["gmail"]}]}';;
  *gmail*) echo '{"threads":[{"id":"t1","date":"2026-11-03 09:14","from":"Sam Rivers <sam@example.org>","subject":"${SUBJECT}","labels":["INBOX"]}]}';;
  *) echo '{}';;
esac
`;
const inShell = (agent, script, ms) => inAgent(agent, ['sh', '-c', script], ms);
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function main() {
  await requireRoom(1);
  const agent = await createAgent(`${PREFIX} ${Date.now().toString(36)}`);
  log(`agent ${agent.name}`);
  await scenario('G1 a plain request for mail runs gog under Code Mode', async () => {
    const set = await inAgent(agent, ['openclaw', 'config', 'set', 'tools.codeMode', 'true'], 120_000);
    const gog = await inShell(agent, `mkdir -p ~/.local/bin && echo ${b64(STAND_IN)} | base64 -d > ~/.local/bin/gog && chmod 755 ~/.local/bin/gog && command -v gog`, 60_000);
    const section = googleAccountsSection([{ email: ACCOUNT, services: ['gmail'], gmailNoSend: true }]);
    const notes = await inShell(agent, `printf '\\n' >> ${workspaceOf(agent)}/AGENTS.md && echo ${b64(section)} | base64 -d >> ${workspaceOf(agent)}/AGENTS.md`, 60_000);
    const turn = await inAgent(agent, ['openclaw', 'agent', '--agent', agent.slug, '--session-id', `google-${Date.now().toString(36)}`,
      '--message', 'What is the newest email in my inbox?', '--json', '--timeout', '300'], 360_000);
    const calls = await inShell(agent, `cat ${CALLS} 2>/dev/null || true`, 60_000);
    return [
      ['Code Mode set', set.code === 0, set.out],
      ['the stand-in is the gog it finds', gog.out.includes('/.local/bin/gog'), gog.out],
      ['its AGENTS.md names the account', notes.code === 0, notes.out],
      ['Code Mode owned the turn', /"codeModeEngaged":\s*true/.test(turn.out), turn.out.slice(-600)],
      ['it ran gog for mail', /gmail/.test(calls.out), `calls: ${calls.out || 'none'}; reply: ${turn.out.slice(-600)}`],
      ['it answered from the mailbox', turn.out.includes(SUBJECT), turn.out.slice(-600)],
    ];
  });
}

main()
  .catch((err) => log(`✗ ${err.message || err}`))
  .finally(async () => {
    if (!keep) await cleanupAgents(PREFIX);
    process.exitCode = summary() ? 0 : 1;
  });
