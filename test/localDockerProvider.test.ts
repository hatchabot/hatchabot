import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDiskFull, VolumeGoneError, VolumeUntouchedError } from '../src/providers/provider.js';
import { dockerMemoryBytes, LocalDockerProvider, remoteTarget, SEED_STEP_MARK, secretValuesOf, seedFailure, seedStepLabel, sshReachProbe, tcpReachable, THIS_PROCESS } from '../src/providers/localDockerProvider.js';
import { createServer } from 'node:net';
import { firstThen, heldPort, listenOnFreePort } from './helpers/ports.js';
import { GATEWAY_TOKEN } from './support/fixtures.js';

/**
 * The only real provider, and previously untested — mutation testing showed
 * that deleting the seed script's overwrite guards (i.e. destroying every
 * agent's MEMORY.md on rebuild) passed the whole suite silently.
 *
 * No daemon needed: the provider already takes the docker binary path, so a
 * recording stub captures the argv and the generated seed script.
 */
const dir = mkdtempSync(join(tmpdir(), 'acl-docker-'));
const LOG = join(dir, 'argv.log');
const SEED_COPY = join(dir, 'seed.sh');

const stub = join(dir, 'docker');
writeFileSync(
  stub,
  `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
# stash the staged seed script before the provider deletes its tmpdir
for a in "$@"; do
  case "$a" in
    *:/seed:ro) cp "\${a%%:*}/seed.sh" ${JSON.stringify(SEED_COPY)} 2>/dev/null || true ;;
  esac
done
exit 0
`,
  { mode: 0o755 },
);
chmodSync(stub, 0o755);

// These tests read the bind-mounted seed. A process that is not uid 1000 (the
// image's `node`) streams the seed over stdin instead — covered by the remote
// tests below — and GitHub's runner is uid 1001: red CI from 2026-09-28 on.
vi.spyOn(process, 'getuid').mockReturnValue(1000);
const provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest' });
const argv = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
const seed = () => (existsSync(SEED_COPY) ? readFileSync(SEED_COPY, 'utf8') : '');

const spec = (over: Record<string, unknown> = {}) => ({
  agentId: 'df918a55-88cd-4d00-a17c-b8415a26ceb6',
  slug: 'kitchen-helper',
  workspace: {
    files: { 'SOUL.md': '# soul', 'AGENTS.md': '# agents', 'MEMORY.md': '# memory' },
    configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' as const },
  },
  env: {},
  ...over,
});

beforeEach(() => {
  writeFileSync(LOG, '');
});

describe('seed script — the guards that protect an agent’s memory', () => {
  it('never copies a workspace file unconditionally', async () => {
    await provider.provision(spec() as any);
    const script = seed();
    expect(script).toBeTruthy();
    for (const name of ['SOUL.md', 'AGENTS.md', 'MEMORY.md']) {
      const line = script.split('\n').find((l) => l.includes(`/${name}'`) && l.includes('cp '));
      expect(line, `${name} must be guarded`).toBeTruthy();
      // `[ -f dest ] || cp …` — without this a rebuild lobotomizes the agent
      expect(line).toMatch(/\[ -f .* \] \|\| cp /);
    }
  });

  it('only scaffolds the agent when the workspace does not exist', async () => {
    await provider.provision(spec() as any);
    expect(seed()).toMatch(/if \[ ! -d .* \]; then openclaw 'agents' 'add'/);
  });

  it('creates directories for nested seed files (skills/…), still overwrite-safe', async () => {
    await provider.provision(
      spec({
        workspace: {
          files: { 'SOUL.md': '# soul', 'skills/gog/SKILL.md': '# gog' },
          configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' },
        },
      }) as any,
    );
    const script = seed();
    expect(script).toMatch(/mkdir -p '[^']*\/skills\/gog'/);
    const line = script.split('\n').find((l) => l.includes("skills/gog/SKILL.md'") && l.includes('cp '));
    expect(line).toMatch(/\[ -f .* \] \|\| cp /); // the guard still protects edits
  });

  it('produces a syntactically valid script even with hostile values', async () => {
    await provider.provision(
      spec({
        workspace: {
          files: { 'SOUL.md': "it's got quotes" },
          configPatch: {
            agentId: 'kitchen-helper',
            authMode: 'api-key',
            telegram: {
              accountId: 'bot',
              botToken: "123:AA'; touch /tmp/pwned; '",
              dmPolicy: 'pairing',
            },
          },
        },
      }) as any,
    );
    const path = join(dir, 'check.sh');
    writeFileSync(path, seed());
    // bash -n catches any quoting break wholesale
    execFileSync('bash', ['-n', path]);
    // The payload may appear — but only INERT, single-quote escaped, so it
    // can never break out of its argument and execute.
    expect(seed()).toContain(`'\\''`);
    expect(seed()).not.toMatch(/^\s*touch \/tmp\/pwned/m);
  });

  // 2026-09-30: argv is world-readable through /proc; the tokens went on
  // `openclaw config set --batch-json …`. Now only builtins carry them.
  it('secrets appear only inside printf (a builtin), never on an openclaw command line', async () => {
    const bot = ['made', 'up', 'bot', 'value'].join('-'), gw = ['made', 'up', 'gw', 'value'].join('-');
    await provider.provision(spec({
      workspace: {
        files: { 'SOUL.md': '# soul' },
        configPatch: { agentId: 'kitchen-helper', authMode: 'api-key', gatewayToken: gw, telegram: { accountId: 'bot', botToken: bot, dmPolicy: 'pairing' } },
      },
    }) as any);
    const lines = seed().split('\n').filter((l) => l.includes(bot) || l.includes(gw));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/^\{ __hb_f=\$\(mktemp\); printf %s '[^']*' > "\$__hb_f"; __hb_rc=0; openclaw config set --batch-file "\$__hb_f" --replace/);
    }
  });
});

// OpenClaw 2026.9's `agents add` scaffolds SOUL.md/AGENTS.md/USER.md, and the
// copy-if-absent kept those over a template's, a clone's and the manager's
// own (2026-09-30). Run the workspace part of the real script, in a sandbox.
describe('seed script — a first build replaces the scaffold with the files it was given', () => {
  const files = { 'SOUL.md': '# ours', 'USER.md': '# them', 'MEMORY.md': '# memory', 'memory/2026-09-29.md': 'notes' };
  const run = (script: string, root: string) => {
    // Only the lines that decide and copy: the fresh test, `agents add`, the workspace step.
    const keep = script.split('\n').filter((l) => /__hb_fresh|'agents' 'add'|^mkdir -p '\/home\/node\/\.openclaw\/agents|cp '\/seed\/|\.hatchabot-first-build/.test(l));
    const body = keep.join('\n').replaceAll('/home/node', `${root}/home`).replaceAll('/seed/', `${root}/seed/`);
    // `openclaw agents add` stands in for the real scaffold; nothing else runs.
    const openclaw = `openclaw() { d="$6"; mkdir -p "$d"; for f in SOUL.md AGENTS.md USER.md; do echo "# scaffold" > "$d/$f"; done; }`;
    const bin = join(root, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    for (const b of ['bash', 'mkdir', 'cp', 'rm']) execFileSync('ln', ['-sf', execFileSync('bash', ['-c', `command -v ${b}`], { encoding: 'utf8' }).trim(), join(bin, b)]);
    const r = spawnSync(join(bin, 'bash'), ['-c', `set -euo pipefail\n${openclaw}\n${body}`], { encoding: 'utf8', env: { PATH: bin, HOME: join(root, 'home') } });
    expect(r.status, r.stderr).toBe(0);
  };
  const ws = (root: string, name: string) => readFileSync(join(root, 'home/.openclaw/agents/kitchen-helper/agent', name), 'utf8');

  it('first build: ours over the scaffold; later builds: the agent’s edits stay', async () => {
    await provider.provision(spec({ workspace: { files, replaceScaffold: Object.keys(files), configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' } } }) as any);
    const script = seed();
    const root = mkdtempSync(join(tmpdir(), 'acl-scaffold-'));
    for (const [n, t] of Object.entries(files)) { execFileSync('mkdir', ['-p', dirname(join(root, 'seed/workspace', n))]); writeFileSync(join(root, 'seed/workspace', n), t); }
    run(script, root);
    expect(ws(root, 'SOUL.md')).toBe('# ours');
    expect(ws(root, 'USER.md')).toBe('# them');
    expect(ws(root, 'AGENTS.md')).toBe('# scaffold\n'); // not given: OpenClaw's stays
    expect(ws(root, 'memory/2026-09-29.md')).toBe('notes');
    expect(existsSync(join(root, 'home/.openclaw/.hatchabot-first-build-kitchen-helper'))).toBe(false);
    // The agent edits its files; a rebuild must not undo that.
    writeFileSync(join(root, 'home/.openclaw/agents/kitchen-helper/agent/SOUL.md'), '# edited');
    run(script, root);
    expect(ws(root, 'SOUL.md')).toBe('# edited');
  });

  it('a first build that stopped before its files were in still counts as first', async () => {
    await provider.provision(spec({ workspace: { files, replaceScaffold: ['SOUL.md'], configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' } } }) as any);
    const root = mkdtempSync(join(tmpdir(), 'acl-scaffold-'));
    for (const [n, t] of Object.entries(files)) { execFileSync('mkdir', ['-p', dirname(join(root, 'seed/workspace', n))]); writeFileSync(join(root, 'seed/workspace', n), t); }
    const agentDir = join(root, 'home/.openclaw/agents/kitchen-helper/agent');
    execFileSync('mkdir', ['-p', agentDir]);
    writeFileSync(join(agentDir, 'SOUL.md'), '# scaffold\n');
    writeFileSync(join(root, 'home/.openclaw/.hatchabot-first-build-kitchen-helper'), '');
    run(seed(), root);
    expect(ws(root, 'SOUL.md')).toBe('# ours');
  });

  it('without replaceScaffold the script is as before: every copy guarded', async () => {
    await provider.provision(spec() as any);
    expect(seed()).not.toContain('__hb_fresh');
  });
});

describe('a failed seed names the step it died in (To Do Agent, 2026-09-25)', () => {
  it('the script marks each step, and the ERR trap writes the current one to stderr', async () => {
    await provider.provision(spec({ workspace: { files: {}, configPatch: { agentId: 'kitchen-helper', authMode: 'api-key', openclawVersion: '2026.9.6', pluginInstall: 'npm' } } }) as any);
    const script = seed();
    expect(script).toContain(`trap 'echo "${SEED_STEP_MARK}$__hb_step" >&2' ERR`);
    expect(script).toContain("__hb_step='openclaw plugins enable duckduckgo'");
    expect(script).toContain('npm_config_fetch_retry_mintimeout=1000'); // below the 5 s ceiling, or npm refuses the pair
    // Run it for real with an `openclaw` that fails on that step: the trap line names it.
    const d = mkdtempSync(join(tmpdir(), 'acl-seedrun-'));
    writeFileSync(join(d, 'openclaw'), '#!/usr/bin/env bash\nif [ "$1 $2 $3" = "plugins enable duckduckgo" ]; then echo "Plugin not found" ; exit 1; fi\nexit 0\n', { mode: 0o755 });
    const r = spawnSync('bash', [SEED_COPY], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}`, HOME: d } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${SEED_STEP_MARK}openclaw plugins enable duckduckgo`);
    expect(seedFailure(r)).toMatch(/^seed failed at "openclaw plugins enable duckduckgo": /);
  });
  it('nothing secret survives into the failure text: every token-like value of the spec is replaced (2026-09-25)', () => {
    const spec = { workspace: { files: {}, configPatch: { agentId: 'k', authMode: 'oauth-claude-cli', setupToken: 'sk-ant-oat01-SECRETSETUP', gatewayToken: GATEWAY_TOKEN, telegram: { accountId: 'b', botToken: '123456:ABC-SECRET-TOKEN', allowFrom: ['1'] }, discord: { token: 'MTIz.SECRET.discord-token', applicationId: '1' }, model: 'm' } }, env: { BRAVE_API_KEY: 'brave-secret-key', HATCHABOT_MEMORY_CAP: '3g' } } as never;
    const values = secretValuesOf(spec);
    expect(values).toEqual(expect.arrayContaining(['sk-ant-oat01-SECRETSETUP', GATEWAY_TOKEN, '123456:ABC-SECRET-TOKEN', 'MTIz.SECRET.discord-token', 'brave-secret-key']));
    expect(values).not.toContain('3g'); expect(values).not.toContain('m'); expect(values).not.toContain('b');
    const out = seedFailure({ stderr: 'config set refused value "123456:ABC-SECRET-TOKEN" at channels.telegram.accounts.b.botToken\n', stdout: 'token MTIz.SECRET.discord-token rejected' }, values);
    expect(out).not.toContain('SECRET');
    expect(out).toContain('refused value "<redacted>"');
    expect(out).toContain('token <redacted> rejected');
  });
  it('the error leads with the step and keeps stdout, where OpenClaw puts many of its errors', async () => {
    expect(seedFailure({ stderr: `[skills] noise\n${SEED_STEP_MARK}shell: V=$(node -p ...)\n`, stdout: 'Updated 24 config paths.\nnpm error something\n' }))
      .toBe('seed failed at "shell: V=$(node -p ...)": [skills] noise\n--- stdout ---\nUpdated 24 config paths.\nnpm error something');
    expect(seedFailure({ stderr: '', stdout: '' })).toBe('seed failed: (no output)');
    expect(seedFailure({ stderr: 'boom\n', stdout: '' })).toBe('seed failed: boom');
    // No secret reaches a label: the stdin-fed and batch forms are the redacted log form.
    expect(seedStepLabel('<redacted> | openclaw models auth paste-token')).toBe('<redacted> | openclaw models auth paste-token');
    expect(seedStepLabel('sh: ' + 'x'.repeat(200))).toHaveLength(96);
    // The provider surfaces it: a docker whose seed run fails with a marked stderr.
    const dd = mkdtempSync(join(tmpdir(), 'acl-seedfail-'));
    const st = join(dd, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\ncase "$*" in *seed.sh*) echo "Updated 3 config paths."; echo "${SEED_STEP_MARK}openclaw plugins enable discord" >&2; exit 1;; esac\nexit 0\n`, { mode: 0o755 });
    await expect(new LocalDockerProvider({ docker: st, image: 'test-image:latest' }).provision(spec() as any))
      .rejects.toThrow('seed failed at "openclaw plugins enable discord": Updated 3 config paths.'); // stdout alone needs no divider
  });
});

describe('container and volume shape', () => {
  it('publishes the gateway port on loopback only', async () => {
    await provider.provision(spec({ ports: [{ host: 19100, container: 18789 }] }) as any);
    expect(argv()).toContain('127.0.0.1:19100:18789');
    expect(argv()).not.toMatch(/-p 19100:18789/);
  });

  it('puts agents on the isolated agents network (no agent-to-agent traffic)', async () => {
    await provider.provision(spec() as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '));
    expect(create).toContain('--network hatchabot-agents');
  });

  it('creates that network with inter-container traffic off when it is missing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-net-'));
    const log = join(d, 'argv.log');
    const st = join(d, 'docker');
    // `network inspect` fails until `network create` has run.
    writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "network inspect" ] && [ ! -f ${JSON.stringify(join(d, 'made'))} ]; then exit 1; fi
if [ "$1 $2" = "network create" ]; then touch ${JSON.stringify(join(d, 'made'))}; fi
exit 0
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest' });
    await p.provision(spec() as any);
    await p.provision(spec() as any);
    const lines = readFileSync(log, 'utf8').split('\n');
    const creates = lines.filter((l) => l.startsWith('network create'));
    expect(creates).toHaveLength(1); // once per provider, not per agent
    expect(creates[0]).toContain('com.docker.network.bridge.enable_icc=false');
  });

  it('a network pruned since it was made is made again when a create finds it gone, and is not looked for on every create (HB-1029)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-net-gone-'));
    const log = join(d, 'argv.log');
    const made = join(d, 'made');
    const st = join(d, 'docker');
    // A create or an inspect of the network fails, as Docker words it, while it is not there.
    writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "network inspect" ] && [ "$3" = hatchabot-agents ] && [ ! -f ${JSON.stringify(made)} ]; then echo 'Error response from daemon: network hatchabot-agents not found' >&2; exit 1; fi
if [ "$1 $2" = "network inspect" ] && [ "$3" = hatchabot-agents ]; then echo '172.30.0.1 '; exit 0; fi
if [ "$1 $2" = "network create" ]; then touch ${JSON.stringify(made)}; fi
if [ "$1" = create ] && [ ! -f ${JSON.stringify(made)} ] && echo "$*" | grep -q -- '--network hatchabot-agents'; then echo 'Error response from daemon: network hatchabot-agents not found' >&2; exit 1; fi
exit 0
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest' });
    const lines = () => readFileSync(log, 'utf8').split('\n');
    const count = (prefix: string) => lines().filter((l) => l.startsWith(prefix)).length;
    await p.provision(spec() as any);
    expect(count('network create')).toBe(1);
    // Every agent on it deleted, and `docker network prune` took it.
    rmSync(made);
    const inspects = count('network inspect hatchabot-agents');
    await p.provision(spec() as any);
    expect(count('network create')).toBe(2);
    expect(lines().filter((l) => l.startsWith('create ')).length).toBe(3); // the one refused, then again
    // Made again, known made: the next create asks nothing first.
    const after = count('network inspect hatchabot-agents');
    expect(after - inspects).toBe(1);
    await p.provision(spec() as any);
    expect(count('network inspect hatchabot-agents')).toBe(after);
    // Its gateway address (the console's trusted proxy, read before a create) after a prune: made again too.
    rmSync(made);
    expect(await p.agentProxySource()).toBe('172.30.0.1');
    expect(count('network create')).toBe(3);
  });

  it('two creates that meet the pruned network at once share its one re-make, and both go through (HB-1029 review)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-net-two-'));
    const log = join(d, 'argv.log');
    const made = join(d, 'made');
    const remaking = join(d, 'remaking');
    const second = join(d, 'second');
    const st = join(d, 'docker');
    // Both creates reach Docker with the network known made; the first is
    // refused, and the second is refused while the first's re-make is under way.
    writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
wait_for() { for i in $(seq 1 100); do [ -f "$1" ] && return; sleep 0.05; done; }
if [ "$1 $2" = "network inspect" ] && [ "$3" = hatchabot-agents ] && [ ! -f ${JSON.stringify(made)} ]; then echo 'Error response from daemon: network hatchabot-agents not found' >&2; exit 1; fi
if [ "$1 $2" = "network create" ]; then touch ${JSON.stringify(remaking)}; sleep 0.5; touch ${JSON.stringify(made)}; exit 0; fi
if [ "$1" = create ] && echo "$*" | grep -q -- '--name hatchabot-porch-helper-'; then touch ${JSON.stringify(second)}; wait_for ${JSON.stringify(remaking)}; fi
if [ "$1" = create ] && echo "$*" | grep -q -- '--name hatchabot-kitchen-helper-'; then wait_for ${JSON.stringify(second)}; fi
if [ "$1" = create ] && [ ! -f ${JSON.stringify(made)} ] && echo "$*" | grep -q -- '--network hatchabot-agents'; then echo 'Error response from daemon: network hatchabot-agents not found' >&2; exit 1; fi
exit 0
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest' });
    const lines = () => readFileSync(log, 'utf8').split('\n');
    writeFileSync(made, '');
    await p.provision(spec() as any);
    rmSync(made);
    const other = spec({ agentId: 'aa11bb22-0000-4000-8000-000000000001', slug: 'porch-helper' });
    const both = await Promise.allSettled([p.provision(spec() as any), p.provision(other as any)]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(lines().filter((l) => l.startsWith('network create')).length).toBe(1);
    expect(lines().filter((l) => l.startsWith('create ') && l.includes('--name hatchabot-porch-helper-')).length).toBe(2); // refused, then again
  });

  describe('a sleeping agent whose network a prune took (HB-1400)', () => {
    const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64), OPS = 'hatchabot-ops-df918a55c3e1';
    /**
     * Docker as moby behaves after `docker network prune` took the agents
     * network while the agent was stopped: the container still holds the old
     * network's id, and its start fails naming it, until it is put on the
     * network made again. `$net` is the network's id while it exists.
     */
    /** `manager`: a management agent made on its own --internal network (`mode`), or one only its label says is one. */
    const world = (o: { connectFails?: boolean; otherNetwork?: boolean; none?: boolean; netGone?: boolean; manager?: 'ops' | 'label'; opsGone?: boolean; opsOpen?: boolean } = {}) => {
      const d = mkdtempSync(join(tmpdir(), 'acl-net-start-'));
      const log = join(d, 'argv.log');
      const net = join(d, 'net'), held = join(d, 'held'), facts = join(d, 'facts'), ops = join(d, 'ops');
      writeFileSync(held, o.none ? '' : o.otherNetwork ? `other=${OLD}` : `hatchabot-agents=${OLD}`);
      if (o.none && !o.netGone) writeFileSync(net, NEW);
      writeFileSync(facts, o.manager === 'ops' ? `|${OPS}|18789` : o.manager === 'label' ? '|bridge|18789' : '|hatchabot-agents|<no value>');
      if (!o.opsGone) writeFileSync(ops, o.opsOpen ? 'false' : 'true');
      const st = join(d, 'docker');
      writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "network inspect" ]; then case "$*" in *-ops-*) [ -f ${JSON.stringify(ops)} ] && { cat ${JSON.stringify(ops)}; echo; exit 0; }; echo "Error response from daemon: network ${OPS} not found" >&2; exit 1;; esac; [ -f ${JSON.stringify(net)} ] && exit 0; echo 'Error response from daemon: network hatchabot-agents not found' >&2; exit 1; fi
if [ "$1 $2" = "network create" ]; then echo ${NEW} > ${JSON.stringify(net)}; exit 0; fi
if [ "$1 $2" = "container inspect" ]; then case "$*" in *'{{len .NetworkSettings.Networks}}'*) printf '%s%s\n' "$(grep -c = ${JSON.stringify(held)})" "$(cat ${JSON.stringify(facts)})"; exit 0;; esac; cat ${JSON.stringify(held)}; echo; exit 0; fi
if [ "$1 $2" = "network disconnect" ]; then : > ${JSON.stringify(held)}; exit 0; fi
if [ "$1 $2" = "network connect" ]; then case "$*" in *-ops-*) [ -f ${JSON.stringify(ops)} ] || exit 1; echo "${OPS}=${NEW}" > ${JSON.stringify(held)}; exit 0;; esac; [ -f ${JSON.stringify(net)} ] || { echo 'Error response from daemon: network hatchabot-agents not found' >&2; exit 1; }; ${o.connectFails ? `echo 'Error response from daemon: connect refused' >&2; exit 1` : `echo "hatchabot-agents=$(cat ${JSON.stringify(net)})" > ${JSON.stringify(held)}; exit 0`}; fi
if [ "$1" = start ]; then id=$(sed -n 's/.*=//p' ${JSON.stringify(held)}); if [ -n "$id" ] && ! grep -qx "$id" ${JSON.stringify(net)} 2>/dev/null; then echo "Error response from daemon: network $id not found" >&2; exit 1; fi; fi
exit 0
`, { mode: 0o755 });
      const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
      return { p: new LocalDockerProvider({ docker: st, image: 'test-image:latest' }), lines };
    };
    const ref = 'kitchen-helper-df918a55';

    it('is put on the network made again, once, and starts', async () => {
      const { p, lines } = world();
      const ctr = p.containerName(ref);
      await p.start(ref);
      expect(lines()).toEqual([
        `container inspect --format {{len .NetworkSettings.Networks}}|{{.HostConfig.NetworkMode}}|{{index .Config.Labels "hatchabot.console-port"}} ${ctr}`,
        `start ${ctr}`,
        expect.stringMatching(new RegExp(`^container inspect --format .* ${ctr}$`)),
        'network inspect hatchabot-agents',
        'network create --driver bridge -o com.docker.network.bridge.enable_icc=false --label hatchabot.role=agents hatchabot-agents',
        `network disconnect --force hatchabot-agents ${ctr}`,
        `network connect hatchabot-agents ${ctr}`,
        `start ${ctr}`,
      ]);
    });

    it('a network that will not take it says to Rebuild, and no start is tried that would run it on none', async () => {
      const { p, lines } = world({ connectFails: true });
      await expect(p.start(ref)).rejects.toMatchObject({ userMessage: "The agent's network was removed (a docker network prune?), and it could not be put on the new one. Rebuild it." });
      expect(lines().filter((l) => l.startsWith('start '))).toHaveLength(1);
    });

    it('one left on no network at all is put back on the agents network before it starts, made again if it is gone (HB-1400 review)', async () => {
      for (const netGone of [false, true]) {
        const { p, lines } = world({ none: true, netGone });
        const ctr = p.containerName(ref);
        await p.start(ref);
        const calls = lines();
        expect(calls.filter((l) => l.startsWith('network connect ') || l.startsWith('start '))).toEqual([`network connect hatchabot-agents ${ctr}`, `start ${ctr}`]);
        expect(calls.some((l) => l.startsWith('network create '))).toBe(netGone);
        expect(calls.indexOf(`network connect hatchabot-agents ${ctr}`)).toBeLessThan(calls.indexOf(`start ${ctr}`));
      }
    });

    it('one on no network that cannot be put on one is never started: it says to Rebuild (HB-1400 review)', async () => {
      const { p, lines } = world({ none: true, connectFails: true });
      await expect(p.start(ref)).rejects.toMatchObject({ userMessage: 'The agent is on no network (its network was removed, a docker network prune?), and it could not be put back on one. Rebuild it.' });
      expect(lines().some((l) => l.startsWith('start '))).toBe(false);
      // After the rejoin whose connect failed, the next start is refused too, never run on none.
      const { p: q, lines: seen } = world({ connectFails: true });
      await expect(q.start(ref)).rejects.toThrow();
      await expect(q.start(ref)).rejects.toMatchObject({ userMessage: 'The agent is on no network (its network was removed, a docker network prune?), and it could not be put back on one. Rebuild it.' });
      expect(seen().filter((l) => l.startsWith('start '))).toHaveLength(1);
    });

    it("a management agent on no network goes back on its own --internal network, never on the agents network, or is refused with Rebuild (round-2 review)", async () => {
      const { p, lines } = world({ none: true, manager: 'ops' });
      const ctr = p.containerName(ref);
      await p.start(ref);
      expect(lines().filter((l) => l.startsWith('network ') || l.startsWith('start '))).toEqual([
        `network inspect --format {{.Internal}} ${OPS}`, `network connect ${OPS} ${ctr}`, `start ${ctr}`,
      ]);
      const refused = "The management agent is on no network (its network was removed, a docker network prune?), and it could not be put back on its own. Rebuild it.";
      // Its network gone, one that is not --internal under its name, or one only its label says is a manager's: refused.
      for (const o of [{ opsGone: true }, { opsOpen: true }, { manager: 'label' as const }]) {
        const w = world({ none: true, manager: 'ops', ...o });
        await expect(w.p.start(ref), JSON.stringify(o)).rejects.toMatchObject({ userMessage: refused });
        expect(w.lines().filter((l) => l.startsWith('start ') || l.includes('hatchabot-agents')), JSON.stringify(o)).toEqual([]);
      }
      // HATCHABOT_AGENT_NETWORK=bridge changes nothing for it.
      const prev = process.env.HATCHABOT_AGENT_NETWORK;
      process.env.HATCHABOT_AGENT_NETWORK = 'bridge';
      try {
        const w = world({ none: true, manager: 'ops', opsGone: true });
        await expect(w.p.start(ref)).rejects.toMatchObject({ userMessage: refused });
      } finally {
        if (prev === undefined) delete process.env.HATCHABOT_AGENT_NETWORK; else process.env.HATCHABOT_AGENT_NETWORK = prev;
      }
    });

    it('another network gone, not the agents network, is not touched: the start fails as before', async () => {
      const { p, lines } = world({ otherNetwork: true });
      await expect(p.start(ref)).rejects.toMatchObject({ userMessage: 'The agent could not start. Try again?' });
      expect(lines().some((l) => l.startsWith('network '))).toBe(false);
    });
  });

  it('a default image, or a pin, in a registry with a port runs the agent on it (HB-1357)', async () => {
    const p = new LocalDockerProvider({ docker: stub, image: 'registry.example:5000/family/runtime:latest' });
    await p.provision(spec() as any);
    expect(argv().split('\n').find((l) => l.startsWith('create '))).toMatch(/ registry\.example:5000\/family\/runtime:latest openclaw gateway$/);
    writeFileSync(LOG, '');
    await p.provision(spec({ image: 'registry.example:5000/family/runtime:2026.9.8' }) as any);
    expect(argv().split('\n').find((l) => l.startsWith('create '))).toMatch(/ registry\.example:5000\/family\/runtime:2026\.9\.8 openclaw gateway$/);
    // Still never a flag, nor a port with no repository after it.
    await expect(p.provision(spec({ image: '-registry.example:5000/x:1' }) as any)).rejects.toThrow(/bad image ref/);
    await expect(p.provision(spec({ image: 'registry.example:5000:1' }) as any)).rejects.toThrow(/bad image ref/);
  });

  it('an agent given no limit, with HATCHABOT_AGENT_MEMORY set but empty, gets the default 3g, not an empty --memory (HB-1401)', async () => {
    const prev = process.env.HATCHABOT_AGENT_MEMORY;
    process.env.HATCHABOT_AGENT_MEMORY = '';
    try {
      await provider.provision(spec() as any);
      const create = argv().split('\n').find((l) => l.startsWith('create '));
      expect(create).toContain('--memory 3g --memory-swap 3g ');
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_AGENT_MEMORY; else process.env.HATCHABOT_AGENT_MEMORY = prev;
    }
  });

  it('HATCHABOT_AGENT_NETWORK=bridge keeps the old default network', async () => {
    const prev = process.env.HATCHABOT_AGENT_NETWORK;
    process.env.HATCHABOT_AGENT_NETWORK = 'bridge';
    try {
      const d = mkdtempSync(join(tmpdir(), 'acl-br-'));
      const log = join(d, 'argv.log');
      const st = join(d, 'docker');
      writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
      await new LocalDockerProvider({ docker: st, image: 'test-image:latest' }).provision(spec() as any);
      const create = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('create '));
      expect(create).not.toContain('--network');
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_AGENT_NETWORK; else process.env.HATCHABOT_AGENT_NETWORK = prev;
    }
  });

  it('a value with line breaks reaches the container without appearing on the docker command line (#203)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-envml-'));
    const out = (n: string) => join(d, n);
    const st = join(d, 'docker');
    // The stub keeps what `create` was given: its arguments (NUL-separated, so a
    // value with line breaks stays whole), the variable from its own
    // environment, and the env file's contents.
    writeFileSync(st, `#!/usr/bin/env bash
if [ "$1" = create ]; then
  printf '%s\\0' "$@" > ${JSON.stringify(out('args'))}
  printf '%s' "\${SERVICE_KEY_JSON-unset}" > ${JSON.stringify(out('childenv'))}
  prev=; for a in "$@"; do [ "$prev" = --env-file ] && cat "$a" > ${JSON.stringify(out('envfile'))}; prev=$a; done
fi
exit 0
`, { mode: 0o755 });
    const multiline = '{\n  "fixture": "line one",\n  "also": "fixture line two"\n}';
    await new LocalDockerProvider({ docker: st, image: 'test-image:latest' })
      .provision(spec({ env: { BRAVE_API_KEY: 'brave-fixture', SERVICE_KEY_JSON: multiline } }) as any);
    const args = readFileSync(out('args'), 'utf8');
    expect(args).not.toContain('fixture line two');
    expect(args).not.toContain('brave-fixture');
    expect(args).toContain('\0-e\0SERVICE_KEY_JSON\0'); // a bare -e: docker reads the value from its environment
    expect(readFileSync(out('childenv'), 'utf8')).toBe(multiline);
    expect(readFileSync(out('envfile'), 'utf8')).toBe('BRAVE_API_KEY=brave-fixture\n');
  });

  it('runs with an init process, so orphaned grandchildren get reaped', async () => {
    await provider.provision(spec() as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '));
    expect(create).toContain('--init');
  });

  it('sets the container hostname when the spec carries one (the where-am-I compass)', async () => {
    await provider.provision(spec({ hostname: 'kitchen-helper.studio-mini' }) as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '));
    expect(create).toContain('--hostname kitchen-helper.studio-mini');
  });

  it('mounts the volume as the agent\'s HOME, not just ~/.openclaw', async () => {
    // /usr is the image (replaced by a rebuild); $HOME is the agent's and
    // persists. That single boundary is what makes a credential the agent
    // writes to ~/.config/<tool> survive, with no per-tool plumbing.
    await provider.provision(spec() as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '))!;
    expect(create).toMatch(/-v \S+-vol:\/home\/node(?!\/)/);
    expect(create).not.toContain(':/home/node/.openclaw');
  });

  it('reshapes an older volume before anything writes to it, exactly once', async () => {
    await provider.provision(spec() as any);
    const lines = argv().split('\n');
    const mig = lines.findIndex((l) => l.includes('.agentclaw-home-v2'));
    const seed = lines.findIndex((l) => l.includes('seed.sh') || l.includes('/seed'));
    expect(mig).toBeGreaterThanOrEqual(0);
    // Must precede the seed: the seed writes .openclaw paths, which would
    // collide with pre-migration content still sitting at the volume root.
    if (seed >= 0) expect(mig).toBeLessThan(seed);
    // Marker-guarded, so a re-provision is a no-op rather than a second move.
    expect(lines[mig]).toContain('if [ -f /vol/.openclaw/.agentclaw-home-v2 ]; then exit 0; fi');
    // …and the marker is written LAST, so a half-finished run self-heals.
    expect(lines[mig]!.indexOf('touch')).toBeGreaterThan(lines[mig]!.indexOf('find /vol'));
  });

  it('keeps the volume unless purge is explicitly requested', async () => {
    const { runtimeRef } = await provider.provision(spec() as any);
    writeFileSync(LOG, '');
    await provider.destroy(runtimeRef);
    expect(argv()).not.toMatch(/volume rm/);

    writeFileSync(LOG, '');
    await provider.destroy(runtimeRef, { purge: true });
    expect(argv()).toMatch(/volume rm/);
  });

  it('reuses the same volume on re-provision (memory survives rebuilds)', async () => {
    const { runtimeRef } = await provider.provision(spec() as any);
    writeFileSync(LOG, '');
    await provider.provision(spec({ previousRef: runtimeRef }) as any);
    const created = argv().split('\n').filter((l) => l.startsWith('volume create'));
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('kitchen-helper');
  });

  it('restores archives without trusting their ownership or setuid bits', async () => {
    const { runtimeRef } = await provider.provision(spec() as any);
    writeFileSync(LOG, '');
    await provider.importState(runtimeRef, Buffer.from('x'));
    const line = argv();
    expect(line).toContain('--no-same-owner');
    expect(line).toContain('chown -R 1000:1000');
    expect(line).toContain('chmod -R a-s');
  });
});

describe('HB-0333: an archive restores to the same place however its paths are spelled', () => {
  /** A docker stub that runs the import's real script, its /vol and /tmp files moved into a folder of the test's own. */
  function importer(change = '') {
    const dd = mkdtempSync(join(tmpdir(), 'acl-import-layout-'));
    const target = join(dd, 'target');
    const scratch = join(dd, 'scratch');
    execFileSync('mkdir', ['-p', target, scratch]);
    const bin = join(dd, 'docker');
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] !== 'run') process.exit(0);
// As docker does once it has made the one-shot, before it starts it.
if (a.includes('--cidfile')) fs.writeFileSync(a[a.indexOf('--cidfile') + 1], 'f00dfeed');
const script = a[a.length - 1].replaceAll('/tmp/s.tgz', ${JSON.stringify(join(scratch, 's.tgz'))}).replaceAll('/tmp/s.list', ${JSON.stringify(join(scratch, 's.list'))})
  .replaceAll('/vol', ${JSON.stringify(target)}).replace('chown -R 1000:1000', 'true')${change};
const r = require('node:child_process').spawnSync('/bin/sh', ['-c', script], { input: fs.readFileSync(0), env: { PATH: '/usr/bin:/bin' } });
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 1);
`, { mode: 0o755 });
    const tree = join(dd, 'tree');
    execFileSync('mkdir', ['-p', join(tree, '.openclaw/agents/main/agent')]);
    writeFileSync(join(tree, '.openclaw/openclaw.json'), '{}');
    writeFileSync(join(tree, '.openclaw/agents/main/agent/SOUL.md'), '# soul');
    const tgz = (args: string[]) => { const out = join(dd, `a${Math.random().toString(36).slice(2)}.tgz`); execFileSync('tar', ['czf', out, ...args]); return readFileSync(out); };
    return { p: new LocalDockerProvider({ docker: bin, image: 'test-image:latest' }), target, tree, tgz };
  }
  it('./.openclaw/…, .openclaw/… and the old layout all end in the volume\'s .openclaw', async () => {
    for (const make of [
      (w: ReturnType<typeof importer>) => w.tgz(['-C', w.tree, '.']),
      (w: ReturnType<typeof importer>) => w.tgz(['-C', w.tree, '.openclaw']),
      (w: ReturnType<typeof importer>) => w.tgz(['-C', join(w.tree, '.openclaw'), '.']),
    ]) {
      const w = importer();
      await w.p.importState('docker://hatchabot-kitchen-helper-df918a55', make(w));
      expect(readFileSync(join(w.target, '.openclaw/openclaw.json'), 'utf8')).toBe('{}');
      expect(readFileSync(join(w.target, '.openclaw/agents/main/agent/SOUL.md'), 'utf8')).toBe('# soul');
      expect(existsSync(join(w.target, '.openclaw/.openclaw'))).toBe(false);
    }
  });

  describe('whether it touched the volume is known', () => {
    const REF = 'docker://hatchabot-kitchen-helper-df918a55';
    const keep = (w: ReturnType<typeof importer>) => writeFileSync(join(w.target, 'memory.md'), 'the memory');
    it('a disk too full to stage the archive: untouched, and named', async () => {
      const w = importer(`.replace(/cat > \\S+/, '{ echo "cat: write error: No space left on device" >&2; false; }')`);
      keep(w);
      const err = await w.p.importState(REF, w.tgz(['-C', w.tree, '.'])).catch((e) => e);
      expect(err).toBeInstanceOf(VolumeUntouchedError);
      expect(isDiskFull(err)).toBe(true);
      expect(err.userMessage).toMatch(/disk of the machine it runs on is full/);
      expect(readFileSync(join(w.target, 'memory.md'), 'utf8')).toBe('the memory');
    });
    it('an archive that fails its check: untouched', async () => {
      const w = importer();
      keep(w);
      await expect(w.p.importState(REF, Buffer.from('not a gzip'))).rejects.toBeInstanceOf(VolumeUntouchedError);
      expect(readFileSync(join(w.target, 'memory.md'), 'utf8')).toBe('the memory');
    });
    it('a failure in the extract, after the volume was emptied, does not claim so', async () => {
      const w = importer(`.replace('tar xz --no-same-owner', 'false')`);
      keep(w);
      const err = await w.p.importState(REF, w.tgz(['-C', w.tree, '.'])).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(VolumeUntouchedError);
      expect(existsSync(join(w.target, 'memory.md'))).toBe(false);
    });
  });
});

describe('daemon-access errors are unknown, not absent', () => {
  it('reports unknown on a docker permission-denied error', async () => {
    // A user briefly out of the docker group after a reboot: inspect exits
    // non-zero with "permission denied", which used to fall through to absent
    // and make boot reconcile FAIL the whole fleet.
    const d = mkdtempSync(join(tmpdir(), 'acl-perm-'));
    const permStub = join(d, 'docker');
    writeFileSync(permStub,
      '#!/usr/bin/env bash\n' +
      'echo "Got permission denied while trying to connect to the Docker daemon socket" >&2\n' +
      'exit 1\n', { mode: 0o755 });
    chmodSync(permStub, 0o755);
    const p = new LocalDockerProvider({ docker: permStub, image: 'test-image:latest' });
    const status = await p.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
    expect(status.phase).toBe('unknown');
  });

  it('still reports absent on a genuine "No such container"', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-gone-'));
    const goneStub = join(d, 'docker');
    writeFileSync(goneStub,
      '#!/usr/bin/env bash\necho "Error: No such container: x" >&2\nexit 1\n', { mode: 0o755 });
    chmodSync(goneStub, 0o755);
    const p = new LocalDockerProvider({ docker: goneStub, image: 'test-image:latest' });
    const status = await p.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
    expect(status.phase).toBe('absent');
  });
});

describe('a running container is judged by the gateway\'s HTTP health (2026-09-25)', () => {
  const inspectStub = (out: string) => {
    const d = mkdtempSync(join(tmpdir(), 'acl-health-'));
    const log = join(d, 'argv.log');
    const st = join(d, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in inspect) echo "${out}";; esac\nexit 0\n`, { mode: 0o755 });
    return { st, argv: () => readFileSync(log, 'utf8') };
  };
  it('one GET to the container\'s address, no process in the container; a refusal is unhealthy', async () => {
    const calls: string[] = [];
    const ok = { st: inspectStub('running 172.18.0.25 '), fetchImpl: (async (u: string) => { calls.push(u); return new Response('ok', { status: 200 }); }) as never };
    const p = new LocalDockerProvider({ docker: ok.st.st, image: 'test-image:latest', fetchImpl: ok.fetchImpl });
    expect(await p.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper')).toEqual({ phase: 'running', healthy: true });
    expect(calls).toEqual(['http://172.18.0.25:18789/health']);
    expect(ok.st.argv()).not.toContain('exec');
    const down = new LocalDockerProvider({ docker: inspectStub('running 172.18.0.25 ').st, image: 'test-image:latest', fetchImpl: (async () => new Response('', { status: 503 })) as never });
    expect(await down.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper')).toEqual({ phase: 'running', healthy: false });
  });
  it('falls back to the CLI when the address is unreachable or absent', async () => {
    const noIp = inspectStub('running ');
    const p = new LocalDockerProvider({ docker: noIp.st, image: 'test-image:latest', fetchImpl: (async () => { throw new Error('never called'); }) as never });
    expect(await p.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper')).toEqual({ phase: 'running', healthy: true });
    expect(noIp.argv()).toMatch(/exec .* openclaw health/);
    const unreachable = inspectStub('running 10.9.9.9 ');
    const q = new LocalDockerProvider({ docker: unreachable.st, image: 'test-image:latest', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as never });
    expect(await q.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper')).toEqual({ phase: 'running', healthy: true });
    expect(unreachable.argv()).toMatch(/exec .* openclaw health/);
  });
});

describe('a stalled daemon is not a missing container', () => {
  it('reports unknown, never absent, when docker inspect times out', async () => {
    // A timed-out inspect has empty stderr, so the daemon-down regex can't
    // rescue it — reading it as "absent" made reconcile FAIL every healthy
    // agent whenever the daemon stalled (IO load, backups). The timeout must
    // surface as unknown so callers wait instead of judging.
    const slowDir = mkdtempSync(join(tmpdir(), 'acl-slow-'));
    const slowStub = join(slowDir, 'docker');
    writeFileSync(slowStub, '#!/usr/bin/env bash\nsleep 5\n', { mode: 0o755 });
    chmodSync(slowStub, 0o755);
    const slow = new LocalDockerProvider({ docker: slowStub, image: 'test-image:latest' });

    const prev = process.env.HATCHABOT_DOCKER_TIMEOUT_MS;
    process.env.HATCHABOT_DOCKER_TIMEOUT_MS = '200';
    try {
      const status = await slow.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
      expect(status.phase).toBe('unknown');
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_DOCKER_TIMEOUT_MS;
      else process.env.HATCHABOT_DOCKER_TIMEOUT_MS = prev;
    }
  });
});

describe('remote (fleet) provider — points docker at a remote daemon', () => {
  const rdir = mkdtempSync(join(tmpdir(), 'acl-rdocker-'));
  const RLOG = join(rdir, 'argv.log');
  const rstub = join(rdir, 'docker');
  writeFileSync(rstub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(RLOG)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(rstub, 0o755);
  const HOST = 'ssh://runner@10.0.0.9';
  const remote = new LocalDockerProvider({ docker: rstub, image: 'test-image:latest', host: HOST, reachProbe: async () => true });
  const rargv = () => (existsSync(RLOG) ? readFileSync(RLOG, 'utf8') : '');

  beforeEach(() => writeFileSync(RLOG, ''));

  it('advertises itself as remote-docker', () => {
    expect(remote.key).toBe('remote-docker');
    expect(remote.remote).toBe(true);
  });

  it('prepends -H <host> to every docker command', async () => {
    await remote.stop('docker://hatchabot-kitchen-helper-df918a55');
    for (const line of rargv().split('\n').filter(Boolean)) {
      expect(line.startsWith(`-H ${HOST} `), line).toBe(true);
    }
  });

  it('seeds over stdin (no bind-mount of this box\'s seed dir) and skips host mounts', async () => {
    await remote.provision(spec({
      hostMounts: [{ source: '/home/me/docs', target: '/home/me/docs', readonly: true }],
    }) as any);
    const log = rargv();
    // remote seed is streamed in, not bind-mounted
    expect(log).not.toContain(':/seed:ro');
    // …and extracted to a world-writable path: the runtime runs as a NON-ROOT
    // user and can't `mkdir /seed` at the root fs — that was a real "Setting up
    // the agent workspace failed" on a live runner.
    expect(log).toContain('mkdir -p /tmp/hatchabot-seed && tar xz -C /tmp/hatchabot-seed');
    expect(log).not.toContain('mkdir -p /seed');
    // the control-plane host path is NOT mounted into the remote container
    expect(log).not.toContain('/home/me/docs:/home/me/docs');
    // and everything still targeted the remote daemon
    expect(log.split('\n').filter(Boolean).every((l) => l.startsWith(`-H ${HOST} `))).toBe(true);
  });
});

// 2026-09-30: a Google refresh token or a deploy key rode `docker exec … bash
// -c '<script>'`, readable by any local user's ps. A secret script goes over stdin.
describe('execShell with a secret sends the script over stdin', () => {
  it('argv carries no script; bash -s runs it whole, with nothing left for its commands to read', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-stdin-'));
    const log = join(d, 'argv'), input = join(d, 'stdin');
    const stdinStub = join(d, 'docker');
    writeFileSync(stdinStub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncat > ${JSON.stringify(input)}\necho done\n`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: stdinStub, image: 'test-image:latest' });
    const secret = ['made', 'up', 'refresh', 'value'].join('-');
    const b64 = Buffer.from(secret).toString('base64');
    const script = [
      'set -e',
      `trap 'echo cleaned' EXIT`,
      `echo ${JSON.stringify(b64)} | base64 -d > "$OUT"`,
      // A command that reads stdin must not swallow the rest of the script.
      'read -r line || echo no-input',
      "cat <<'EOT'",
      'heredoc-ok',
      'EOT',
      'false',
      'echo not-reached',
    ].join('\n');
    const res = await p.execShell('rt-1', script, { secret: true });
    expect(res.code).toBe(0);
    const args = readFileSync(log, 'utf8');
    expect(args).toMatch(/^exec -i \S+ bash -s$/m);
    expect(args).not.toContain(b64);
    // What the container's bash would read: run it the same way here.
    const out = join(d, 'out');
    const r = spawnSync('bash', ['-s'], { input: readFileSync(input, 'utf8'), encoding: 'utf8', env: { PATH: process.env.PATH, OUT: out } });
    expect(readFileSync(out, 'utf8')).toBe(secret);
    expect(r.stdout).toBe('no-input\nheredoc-ok\ncleaned\n');
    expect(r.status).not.toBe(0); // set -e still ends it at `false`
    // Without `secret`, the old argv form (non-secret scripts are unchanged).
    await provider.execShell('rt-1', 'echo hi');
    expect(argv()).toMatch(/^exec \S+ bash -c echo hi$/m);
  });
});

describe('a remote machine that is asleep or offline answers at once (2026-10-05)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acl-reach-'));
  const LOG = join(dir, 'argv.log');
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(LOG)}\necho running\nexit 0\n`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const ran = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
  beforeEach(() => writeFileSync(LOG, ''));

  it('where it is reached: ssh (22 unless given), tcp; anything else is not probed', () => {
    expect(remoteTarget('ssh://laptop.local')).toEqual({ host: 'laptop.local', port: 22 });
    expect(remoteTarget('ssh://runner@10.0.0.9:2222')).toEqual({ host: '10.0.0.9', port: 2222 });
    expect(remoteTarget('tcp://10.0.0.9:2376')).toEqual({ host: '10.0.0.9', port: 2376 });
    expect(remoteTarget('unix:///var/run/docker.sock')).toBeUndefined();
  });

  it('down: no docker call is made; status is unknown (never "gone"), exec is a timeout, streams and copies fail at once', async () => {
    let probes = 0;
    const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: 'ssh://runner@10.0.0.9', reachProbe: async () => { probes++; return false; } });
    const t0 = Date.now();
    expect(await p.reachable()).toBe(false);
    expect((await p.status('docker://hatchabot-kitchen-helper-df918a55')).phase).toBe('unknown');
    const r = await p.execShell('docker://hatchabot-kitchen-helper-df918a55', 'true');
    expect(r).toMatchObject({ code: 1, timedOut: true, unreachable: true });
    await expect(p.importState('docker://hatchabot-kitchen-helper-df918a55', Buffer.from(''))).rejects.toMatchObject({ userMessage: expect.stringContaining("isn't answering") });
    const stream = p.streamFromVolume('docker://hatchabot-kitchen-helper-df918a55', ['cat', 'x']);
    await expect(new Promise((_, reject) => stream.on('error', reject))).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ran()).toEqual([]);
    expect(probes).toBe(1); // remembered: one probe for all of these
  });

  it('back up: the next probe after the down window lets calls through', async () => {
    let up = false, probes = 0;
    const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: 'ssh://runner@10.0.0.9', reachProbe: async () => { probes++; return up; } });
    expect(await p.reachable()).toBe(false);
    up = true;
    expect(await p.reachable()).toBe(false); // still inside the 30 s it is remembered
    const real = Date.now;
    try {
      Date.now = () => real() + 31_000;
      expect(await p.reachable()).toBe(true);
      await p.execShell('docker://hatchabot-kitchen-helper-df918a55', 'true');
    } finally { Date.now = real; }
    expect(probes).toBe(2);
    expect(ran().length).toBe(1);
  });

  it('this machine is never probed', async () => {
    let probes = 0;
    const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', reachProbe: async () => { probes++; return false; } });
    expect(await p.reachable()).toBe(true);
    await p.execShell('docker://hatchabot-kitchen-helper-df918a55', 'true');
    expect(probes).toBe(0);
    expect(ran().length).toBe(1);
  });

  it('the connect test: a listening port answers, a closed one does not', async () => {
    const srv = createServer((c) => c.destroy());
    // Outside the kernel's ephemeral range: once closed, no other test's listen(0) can be handed it (HB-0505).
    // The first port it is given is held, so choosing again is shown every run.
    const held = await heldPort();
    const port = await listenOnFreePort(srv, { choose: firstThen(held.port) }).finally(() => held.release());
    expect(port).not.toBe(held.port);
    expect(await tcpReachable('127.0.0.1', port, 2000)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await tcpReachable('127.0.0.1', port, 2000)).toBe(false);
  });
});

describe('exporting a volume that is not there (2026-10-09)', () => {
  /** A docker stub that records its argv and knows no volume. */
  function noVolume() {
    const d = mkdtempSync(join(tmpdir(), 'acl-novol-'));
    const log = join(d, 'argv.log');
    const bin = join(d, 'docker');
    writeFileSync(bin,
      '#!/usr/bin/env bash\n' +
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` +
      'if [ "$1" = volume ] && [ "$2" = inspect ]; then echo "Error response from daemon: get x-vol: no such volume" >&2; exit 1; fi\n' +
      'exit 0\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
    return { p: new LocalDockerProvider({ docker: bin, image: 'test-image:latest' }), argv: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
  }

  it('fails clearly instead of creating it empty and exporting nothing', async () => {
    const { p, argv } = noVolume();
    await expect(p.exportState('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper')).rejects.toThrow(/does not exist/);
    expect(argv()).not.toMatch(/^run /m); // no one-shot that would have created the volume
  });

  it('a read-only look inside reports the volume missing instead of creating it (HB-0332)', async () => {
    const { p, argv } = noVolume();
    const res = await p.execShellOnVolume('docker://hatchabot-kitchen-helper-df918a55', 'find . -type f', { readOnly: true });
    expect(res).toMatchObject({ code: 1, volumeMissing: true });
    expect(argv()).toMatch(/^volume inspect --format \{\{\.Name\}\} hatchabot-kitchen-helper-df918a55-vol$/m);
    expect(argv()).not.toMatch(/^run /m);
    const { listInspectableFiles } = await import('../src/orchestrator/diagnostics/inspect.js');
    await expect(listInspectableFiles(p, 'docker://hatchabot-kitchen-helper-df918a55', 'kitchen-helper')).rejects.toThrow(/volume is gone/);
  });

  it('a run goes on as before when the volume is there, asking first whether it reads or writes (HB-0373)', async () => {
    // A volume no other test here writes: the first write to it looks.
    await provider.execShellOnVolume('docker://hatchabot-kitchen-helper-0f0f0f01', 'true', { readOnly: true });
    expect(argv()).toMatch(/^volume inspect .*\n.*run --rm .*hatchabot-kitchen-helper-0f0f0f01-vol:\/home\/node:ro /m);
    writeFileSync(LOG, '');
    await provider.execShellOnVolume('docker://hatchabot-kitchen-helper-0f0f0f01', 'true');
    // A write looks for a writer an earlier call left first (HB-0509), the first time after start-up; a read does not.
    expect(argv()).toMatch(/^volume inspect .*\nps -a --filter volume=hatchabot-kitchen-helper-0f0f0f01-vol .*\n.*run --rm .*hatchabot-kitchen-helper-0f0f0f01-vol:\/home\/node /m);
  });

  it('a write, an upload, a download and a workspace copy all say it is gone and never make it (HB-0373)', async () => {
    const { p, argv: seen } = noVolume();
    const ref = 'docker://hatchabot-kitchen-helper-df918a55';
    expect(await p.execShellOnVolume(ref, 'openclaw models set x')).toMatchObject({ code: 1, volumeMissing: true, stderr: expect.stringMatching(/volume is gone/) });
    expect(await p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/x'], Buffer.from('x'))).toMatchObject({ code: 1, volumeMissing: true });
    await expect(p.importWorkspace(ref, 'kitchen-helper', Buffer.from('x'))).rejects.toThrow(/does not exist/);
    const failed = await new Promise<Error>((resolve, reject) => {
      const s = p.streamFromVolume(ref, ['tar', 'c', '.']);
      s.on('error', resolve);
      s.on('end', () => reject(new Error('a download of a missing volume ended as a good, empty one')));
      s.resume();
    });
    expect(failed).toBeInstanceOf(VolumeGoneError);
    expect(seen()).not.toMatch(/^run /m);
  });

  it('a daemon that did not answer the check is not "gone"', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-novol-'));
    const bin = join(d, 'docker');
    writeFileSync(bin, '#!/usr/bin/env bash\nif [ "$1" = volume ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi\nexit 0\n', { mode: 0o755 });
    const res = await new LocalDockerProvider({ docker: bin, image: 'test-image:latest' }).execShellOnVolume('docker://hatchabot-kitchen-helper-df918a55', 'true');
    expect(res.code).toBe(1);
    expect(res.volumeMissing).toBeUndefined();
    expect(res.stderr).toMatch(/Cannot connect/);
  });

  it('a download still streams when the volume is there, and a reader gone before the check starts nothing', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-stream-'));
    const log = join(d, 'argv.log');
    const bin = join(d, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nif [ "$1" = run ]; then printf 'bytes'; fi\nexit 0\n`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest' });
    const ref = 'docker://hatchabot-kitchen-helper-df918a55';
    const chunks: Buffer[] = [];
    for await (const c of p.streamFromVolume(ref, ['cat', 'x'])) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('bytes');
    writeFileSync(log, '');
    const gone = p.streamFromVolume(ref, ['cat', 'x']);
    gone.destroy();
    await new Promise((r) => setTimeout(r, 150));
    expect(readFileSync(log, 'utf8')).not.toMatch(/^run /m);
  });

  it('exports as before when the volume is there', async () => {
    await provider.exportState('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
    expect(argv()).toMatch(/^volume inspect /m);
    expect(argv()).toMatch(/^run .*:\/vol:ro alpine tar cz/m);
  });
});

describe('a download stream from a volume (#178)', () => {
  /** A docker stub whose one-shot prints part of a file, then exits `code`. */
  function streaming(code: number) {
    const d = mkdtempSync(join(tmpdir(), 'acl-stream-'));
    const bin = join(d, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = volume ]; then exit 0; fi\nprintf 'first half'\necho 'cat: read error' >&2\nexit ${code}\n`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    return new LocalDockerProvider({ docker: bin, image: 'test-image:latest' });
  }
  const drain = async (s: NodeJS.ReadableStream) => { let got = ''; for await (const c of s) got += String(c); return got; };

  it('a copy that fails half-way errors instead of ending as a good, short download', async () => {
    const s = streaming(1).streamFromVolume('docker://hatchabot-kitchen-helper-df918a55', ['cat', 'x']);
    await expect(drain(s)).rejects.toThrow(/exit 1: cat: read error/);
  });

  it('a copy that finishes ends with every byte', async () => {
    const s = streaming(0).streamFromVolume('docker://hatchabot-kitchen-helper-df918a55', ['cat', 'x']);
    expect(await drain(s)).toBe('first half');
  });
});

describe('HB-0065: a pre-rename daemon gets the new image name before the seed runs in it', () => {
  it('tags agentclaw-runtime:<tag> as hatchabot-runtime:<tag> before the seed one-shot', async () => {
    const dd = mkdtempSync(join(tmpdir(), 'acl-legacy-alias-'));
    const log = join(dd, 'argv.log');
    const st = join(dd, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$*" in "image inspect --format {{.Id}} hatchabot-runtime:"*) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
    await new LocalDockerProvider({ docker: st, image: 'hatchabot-runtime:2026.9.6-1' }).provision(spec() as any);
    const lines = readFileSync(log, 'utf8').split('\n');
    const tag = lines.findIndex((l) => l === 'tag agentclaw-runtime:2026.9.6-1 hatchabot-runtime:2026.9.6-1');
    const seedRun = lines.findIndex((l) => l.startsWith('run ') && l.includes('seed.sh'));
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(seedRun).toBeGreaterThan(tag);
  });
});

describe('HB-0029: a tcp:// runner is spoken to over verified TLS only', () => {
  it('every docker call to a tcp:// endpoint carries --tlsverify; ssh:// does not', async () => {
    const dd = mkdtempSync(join(tmpdir(), 'acl-tcp-tls-'));
    const log = join(dd, 'argv.log');
    const st = join(dd, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
    const reachProbe = async () => true;
    await new LocalDockerProvider({ docker: st, host: 'tcp://10.0.0.9:2376', reachProbe }).status('kitchen-helper-df918a55');
    await new LocalDockerProvider({ docker: st, host: 'ssh://runner@10.0.0.9', reachProbe }).status('kitchen-helper-df918a55');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.filter((l) => l.startsWith('-H tcp://')).every((l) => l.startsWith('-H tcp://10.0.0.9:2376 --tlsverify '))).toBe(true);
    expect(lines.some((l) => l.startsWith('-H tcp://'))).toBe(true);
    expect(lines.filter((l) => l.startsWith('-H ssh://')).some((l) => l.includes('--tlsverify'))).toBe(false);
    expect(remoteTarget('tcp://10.0.0.9')).toEqual({ host: '10.0.0.9', port: 2376 });
  });
});

describe('HB-0050: info() does not run docker inspect on every poll', () => {
  it('a second ask within the window, or one at the same moment, reuses the answer; start, stop and provision forget it', async () => {
    const dd = mkdtempSync(join(tmpdir(), 'acl-info-cache-'));
    const log = join(dd, 'argv.log');
    const st = join(dd, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in inspect) echo 'sha256:abc|2026.9.6|telegram|3|hatchabot-agents,|2026-10-20T08:00:00Z||||0|2026-10-20T08:00:01Z|0|0|abcdef123456|0';; esac\nexit 0\n`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest' });
    const ref = 'kitchen-helper-df918a55';
    const inspects = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('inspect -f {{.Image}}')).length;
    const [a, b] = await Promise.all([p.info(ref), p.info(ref)]);
    expect(a.openclawVersion).toBe('2026.9.6');
    expect(b.imageId).toBe('sha256:abc');
    expect((await p.info(ref)).containerGen).toBe(3);
    expect(inspects()).toBe(1);
    await p.stop(ref);
    await p.info(ref);
    expect(inspects()).toBe(2);
    await p.start(ref);
    await p.info(ref);
    expect(inspects()).toBe(3);
  });
});

describe('HB-0278: an info() failure the caller handles does not end the process', () => {
  it('a missing docker binary rejects info() once, with no second, unhandled rejection', () => {
    const dd = mkdtempSync(join(tmpdir(), 'acl-info-nodocker-'));
    const mod = JSON.stringify(join(process.cwd(), 'src/providers/localDockerProvider.ts'));
    const code = `import { LocalDockerProvider } from ${mod};
const p = new LocalDockerProvider({ docker: ${JSON.stringify(join(dd, 'no-docker-here'))} });
await p.info('kitchen-helper-df918a55').catch(() => process.stdout.write('caught\\n'));
await new Promise((r) => setTimeout(r, 100));
process.stdout.write('still here\\n');`;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env, HOME: dd }, encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).not.toMatch(/Docker is not available/);
    expect(r.stdout).toBe('caught\nstill here\n');
    expect(r.status).toBe(0);
  });
});

describe('HB-0331: a rootless runner gets the rootless host address and a loopback door', () => {
  function runner(securityOptions: string) {
    const dd = mkdtempSync(join(tmpdir(), 'acl-rootless-runner-'));
    const st = join(dd, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash
case "$*" in
  *" info --format "*) echo 'Ubuntu 24.04 LTS|${securityOptions}' ;;
  *" network inspect bridge "*) echo '172.17.0.1' ;;
esac
exit 0
`, { mode: 0o755 });
    return new LocalDockerProvider({ docker: st, host: 'ssh://runner@10.0.0.9', reachProbe: async () => true });
  }
  it('rootless: no bridge address to bind, and agents reach the runner at 10.0.2.2', async () => {
    const p = runner('[name=seccomp,profile=builtin name=rootless name=cgroupns]');
    expect(await p.rootless()).toBe(true);
    expect(await p.hostGatewayAddress()).toBeUndefined();
    expect(await p.hostAliasTarget()).toBe('10.0.2.2');
    expect(await p.hostAddressForAgents()).toBe('10.0.2.2');
  });
  it('a runner under root Docker keeps its bridge gateway and host-gateway', async () => {
    const p = runner('[name=seccomp,profile=builtin name=cgroupns]');
    expect(await p.hostGatewayAddress()).toBe('172.17.0.1');
    expect(await p.hostAliasTarget()).toBe('host-gateway');
    expect(await p.hostAddressForAgents()).toBe('172.17.0.1');
  });
  it('HATCHABOT_DOCKER_ROOTLESS speaks for this machine only: a runner is always asked', async () => {
    vi.stubEnv('HATCHABOT_DOCKER_ROOTLESS', '0');
    try {
      expect(await runner('[name=rootless]').rootless()).toBe(true);
      vi.stubEnv('HATCHABOT_DOCKER_ROOTLESS', '1');
      expect(await runner('[name=seccomp]').rootless()).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('HB-0977: which daemon a runner reaches is asked each time, never remembered', () => {
  /** A docker whose `info` answers what the file `daemon` holds, or fails when there is none. */
  function world() {
    const d = mkdtempSync(join(tmpdir(), 'acl-daemon-id-'));
    const answer = join(d, 'daemon');
    const log = join(d, 'argv.log');
    const bin = join(d, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  *"info --format"*) [ -f ${JSON.stringify(answer)} ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }; cat ${JSON.stringify(answer)} ;;
esac
exit 0
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', host: 'ssh://runner@10.0.0.9', reachProbe: async () => true });
    const asked = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.includes('info --format {{.ID}}')).length;
    return { p, asked, says: (id: string | undefined) => (id === undefined ? rmSync(answer, { force: true }) : writeFileSync(answer, `${id}\n`)) };
  }

  it('the address repointed at another machine: its own ID, not the one it had', async () => {
    const w = world();
    w.says('made-up-daemon-one');
    expect(await w.p.daemonId()).toBe('made-up-daemon-one');
    w.says('made-up-daemon-two');
    expect(await w.p.daemonId()).toBe('made-up-daemon-two');
    expect(w.asked()).toBe(2);
  });

  it('a daemon that no longer answers is not vouched for by an earlier answer', async () => {
    const { machineAnswers } = await import('../src/orchestrator/transfer/moveHost.js');
    const w = world();
    w.says('made-up-daemon-one');
    expect(await machineAnswers(w.p)).toBe(true);
    w.says(undefined);
    await expect(w.p.daemonId()).rejects.toMatchObject({ userMessage: "Couldn't reach that host's Docker daemon." });
    expect(await machineAnswers(w.p)).toBe(false);
  });
});

describe('HB-1057: a runner is probed where its ssh connects, not where its name says', () => {
  /** An ssh that logs its argv and, for -G, says `config` (or fails when that is undefined). */
  function sshSays(config: string | undefined) {
    const d = mkdtempSync(join(tmpdir(), 'acl-ssh-g-'));
    const log = join(d, 'argv.log');
    const ssh = join(d, 'ssh');
    writeFileSync(ssh, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
${config === undefined ? 'process.exit(255);' : `process.stdout.write(${JSON.stringify(config)});`}
`, { mode: 0o755 });
    return { ssh, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) };
  }
  async function listening() {
    const srv = createServer((c) => c.destroy());
    const held = await heldPort();
    const port = await listenOnFreePort(srv, { choose: firstThen(held.port) }).finally(() => held.release());
    return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
  }

  it('a Host alias with its own HostName and Port: reached there, and docker is asked', async () => {
    const srv = await listening();
    try {
      const s = sshSays(`user runner\nhostname 127.0.0.1\nport ${srv.port}\naddressfamily any\n`);
      writeFileSync(LOG, '');
      const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: 'ssh://fixture-alias.invalid', ssh: s.ssh });
      expect(await p.reachable()).toBe(true);
      expect((await p.execShell('docker://hatchabot-kitchen-helper-df918a55', 'true')).code).toBe(0);
      expect(readFileSync(LOG, 'utf8')).toContain('-H ssh://fixture-alias.invalid exec');
      // Asked with what docker passes ssh: the name, and a port only when the address has one.
      expect(s.argv()).toEqual([['-G', 'fixture-alias.invalid']]);
    } finally { await srv.close(); }
  });

  it('through another machine (ProxyJump, ProxyCommand): not probed from here', async () => {
    for (const via of ['proxyjump jump.fixture.invalid', 'proxycommand nc -X connect %h %p']) {
      const s = sshSays(`hostname fixture-alias.invalid\nport 22\n${via}\n`);
      const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: 'ssh://fixture-alias.invalid', ssh: s.ssh });
      expect(await p.reachable()).toBe(true);
    }
  });

  it('ssh cannot say: the address as written, its port passed on', async () => {
    const srv = await listening();
    try {
      const s = sshSays(undefined);
      const p = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: `ssh://127.0.0.1:${srv.port}`, ssh: s.ssh });
      expect(await p.reachable()).toBe(true);
      expect(s.argv()).toEqual([['-G', '-p', String(srv.port), '127.0.0.1']]);
      // And one ssh routes nowhere that answers is down, as before.
      const gone = sshSays(`hostname 127.0.0.1\nport ${srv.port}\n`);
      await srv.close();
      const q = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', host: 'ssh://fixture-alias.invalid', ssh: gone.ssh });
      expect(await q.reachable()).toBe(false);
    } finally { await srv.close().catch(() => {}); }
  });

  it('the alias edited to another machine: the next probe knocks where ssh goes now', async () => {
    const before = await listening(), after = await listening();
    try {
      // An ssh whose -G answer is a file the test rewrites, as the owner edits ~/.ssh/config.
      const d = mkdtempSync(join(tmpdir(), 'acl-ssh-moved-'));
      const said = join(d, 'said'), ssh = join(d, 'ssh');
      writeFileSync(ssh, `#!${process.execPath}\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(said)}, 'utf8'));\n`, { mode: 0o755 });
      writeFileSync(said, `hostname 127.0.0.1\nport ${before.port}\n`);
      const probe = sshReachProbe('ssh://fixture-alias.invalid', ssh);
      expect(await probe('fixture-alias.invalid', 22, 1_000)).toBe(true);
      // The VM is made again at a new address and the alias follows it; the old one is gone.
      writeFileSync(said, `hostname 127.0.0.1\nport ${after.port}\n`);
      await before.close();
      expect(await probe('fixture-alias.invalid', 22, 1_000)).toBe(true);
    } finally { await before.close().catch(() => {}); await after.close(); }
  });

  it('one ssh -G that fails: the probe knocks where ssh said last, not on the name as written (HB-1157)', async () => {
    const srv = await listening();
    const d = mkdtempSync(join(tmpdir(), 'acl-ssh-once-'));
    try {
      // An ssh whose -G answer is a file; with none there, it fails, as one killed at its limit does.
      const said = join(d, 'said'), ssh = join(d, 'ssh');
      writeFileSync(ssh, `#!${process.execPath}\nconst fs = require('fs');\nif (!fs.existsSync(${JSON.stringify(said)})) process.exit(255);\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(said)}, 'utf8'));\n`, { mode: 0o755 });
      writeFileSync(said, `hostname 127.0.0.1\nport ${srv.port}\n`);
      const probe = sshReachProbe('ssh://fixture-alias.invalid', ssh);
      expect(await probe('fixture-alias.invalid', 22, 1_000)).toBe(true);
      // Was: the alias as written, port 22 (a name that resolves nowhere), and "down".
      rmSync(said);
      expect(await probe('fixture-alias.invalid', 22, 1_000)).toBe(true);
      // Through another machine, as ssh said last: still not probed from here.
      writeFileSync(said, 'hostname 127.0.0.1\nport 22\nproxyjump jump.fixture.invalid\n');
      const through = sshReachProbe('ssh://fixture-alias.invalid', ssh);
      expect(await through('fixture-alias.invalid', 22, 1_000)).toBe(true);
      rmSync(said);
      expect(await through('fixture-alias.invalid', 22, 1_000)).toBe(true);
      // Never answered: the address as written, as before.
      const never = sshReachProbe(`ssh://127.0.0.1:${srv.port}`, ssh);
      expect(await never('127.0.0.1', srv.port, 1_000)).toBe(true);
    } finally { await srv.close(); rmSync(d, { recursive: true, force: true }); }
  });
});

describe('HB-1027: the container a model copy makes is a one-shot the sweep can find', () => {
  it('named and labelled; one whose removal failed is taken by the next sweep', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-copyimg-'));
    const log = join(d, 'argv.log');
    const st = join(d, 'docker');
    // Remembers what it made (its name, or a made-up id for an unnamed one) and the labels it wore;
    // the first removal fails, as a daemon that did not answer in time; ps lists what wears the label.
    writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
d=${JSON.stringify(d)}
case "$1" in
  create)
    name=$(echo "$*" | grep -oE -- '--name [^ ]+' | cut -d' ' -f2); [ -n "$name" ] || name=c0ffee000001
    echo "$*" | grep -q -- '--label hatchabot.oneshot=hatchabot ' && touch "$d/$name.labelled"
    touch "$d/$name.made"; echo "$name" ;;
  cp) printf 'made-up model' > "$3" ;;
  rm)
    if [ ! -f "$d/rm-failed" ]; then touch "$d/rm-failed"; echo 'Error response from daemon: timed out' >&2; exit 1; fi
    shift 2; for n in "$@"; do rm -f "$d/$n.made" "$d/$n.labelled"; done ;;
  ps) for f in "$d"/*.labelled; do [ -e "$f" ] && basename "$f" .labelled; done ;;
esac
exit 0
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest' });
    const dest = join(d, 'model.gguf.part');
    expect(await p.copyFromImage('test-image:latest', '/opt/model.gguf', dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('made-up model');
    const lines = readFileSync(log, 'utf8').split('\n');
    const create = lines.find((l) => l.startsWith('create '))!;
    const name = /--name (\S+)/.exec(create)?.[1];
    expect(name).toMatch(/^hatchabot-cp-[0-9a-f]{12}$/);
    expect(create).toContain('--label hatchabot.oneshot=hatchabot ');
    expect(lines).toContain(`cp ${name}:/opt/model.gguf ${dest}`);
    // Its removal failed: it is still there, and the sweep (at boot, and every 10 minutes) removes it.
    expect(existsSync(join(d, `${name}.made`))).toBe(true);
    expect(await p.sweepOneShots({ created: true })).toBe(1);
    expect(existsSync(join(d, `${name}.made`))).toBe(false);
  });

  it('one still copying is left to its copy by the timed sweep, however long the copy takes (HB-1027 review)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-copyslow-'));
    const log = join(d, 'argv.log');
    const st = join(d, 'docker');
    // Every one-shot made ten minutes ago by the daemon's clock, never run: past ONESHOT_STALE_MS.
    // The copy waits for "go"; one left by an earlier copy of this process lies there too.
    writeFileSync(st, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
d=${JSON.stringify(d)}
case "$1" in
  create) name=$(echo "$*" | grep -oE -- '--name [^ ]+' | cut -d' ' -f2); touch "$d/$name.made"; echo "$name" ;;
  cp) touch "$d/copying"; for i in $(seq 1 100); do [ -f "$d/go" ] && break; sleep 0.05; done; printf 'made-up model' > "$3" ;;
  ps) for f in "$d"/*.made; do [ -e "$f" ] && n=$(basename "$f" .made) && echo "id-$n|${THIS_PROCESS}|$n|created"; done ;;
  info) echo 2026-01-01T00:10:00Z ;;
  container) shift 3; for id in "$@"; do echo "$id|2026-01-01T00:00:00Z|created|0001-01-01T00:00:00Z"; done ;;
  rm) shift 2; for id in "$@"; do rm -f "$d/\${id#id-}.made"; done ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(d, 'hatchabot-cp-0000000000aa.made'), '');
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest' });
    const copy = p.copyFromImage('test-image:latest', '/opt/model.gguf', join(d, 'model.gguf.part'));
    for (let i = 0; i < 100 && !existsSync(join(d, 'copying')); i++) await new Promise((r) => setTimeout(r, 50));
    const name = /--name (\S+)/.exec(readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('create '))!)?.[1];
    expect(name).toMatch(/^hatchabot-cp-[0-9a-f]{12}$/);
    // The 10-minute sweep, mid-copy: the one left behind goes, the one being copied from stays.
    expect(await p.sweepOneShots({ created: true, notThisProcess: true })).toBe(1);
    expect(existsSync(join(d, 'hatchabot-cp-0000000000aa.made'))).toBe(false);
    expect(existsSync(join(d, `${name}.made`))).toBe(true);
    writeFileSync(join(d, 'go'), '');
    expect(await copy).toBe(true);
    expect(existsSync(join(d, `${name}.made`))).toBe(false);
    // Done: a next one of the same name would be swept again.
    writeFileSync(join(d, `${name}.made`), '');
    expect(await p.sweepOneShots({ created: true, notThisProcess: true })).toBe(1);
  });
});

describe('HB-1107: an agent\'s logs keep the order the container wrote them in', () => {
  // A docker whose `logs` writes the container's lines to its stdout and stderr in turn, as docker demultiplexes them.
  const logsStub = (body: string) => {
    const d = mkdtempSync(join(tmpdir(), 'acl-logs-'));
    const st = join(d, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(d, 'argv.log'))}\n[ "$1" = logs ] || exit 0\n${body}\n`, { mode: 0o755 });
    return { p: new LocalDockerProvider({ docker: st, image: 'test-image:latest' }), argv: () => readFileSync(join(d, 'argv.log'), 'utf8') };
  };

  it('stdout and stderr interleaved as written, not every stderr line after all of stdout', async () => {
    const { p, argv } = logsStub(`echo 'gateway: starting'\necho 'error: the AI source refused the key' >&2\necho 'gateway: retrying with the setup token'\necho 'warn: slow reply' >&2\necho 'gateway: ready'`);
    expect(await p.logs('docker://hatchabot-kitchen-helper-df918a55', 40)).toBe([
      'gateway: starting', 'error: the AI source refused the key', 'gateway: retrying with the setup token', 'warn: slow reply', 'gateway: ready',
    ].join('\n'));
    expect(argv()).toContain('logs --tail 40 hatchabot-kitchen-helper-df918a55');
  });

  it('what docker says when it fails is still the answer, and a missing docker is still "not available"', async () => {
    const { p } = logsStub(`echo 'Error response from daemon: No such container: hatchabot-kitchen-helper-df918a55' >&2\nexit 1`);
    expect(await p.logs('docker://hatchabot-kitchen-helper-df918a55', 40)).toBe('Error response from daemon: No such container: hatchabot-kitchen-helper-df918a55');
    const gone = new LocalDockerProvider({ docker: join(tmpdir(), 'acl-no-docker-here', 'docker'), image: 'test-image:latest' });
    await expect(gone.logs('docker://hatchabot-kitchen-helper-df918a55', 40)).rejects.toThrow(/docker unavailable/);
  });

  it('a runner\'s logs go through the same one pipe, with its connection flags', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-logs-remote-'));
    const st = join(d, 'docker');
    writeFileSync(st, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(d, 'argv.log'))}\necho one\necho two >&2\necho three\n`, { mode: 0o755 });
    // Known up, so no probe runs: the fixture address answers nothing.
    const p = new LocalDockerProvider({ docker: st, image: 'test-image:latest', host: 'tcp://runner.invalid:2376', reachProbe: async () => true });
    expect(await p.logs('docker://hatchabot-kitchen-helper-df918a55', 10)).toBe('one\ntwo\nthree');
    expect(readFileSync(join(d, 'argv.log'), 'utf8')).toMatch(/^-H tcp:\/\/runner\.invalid:2376 .*logs --tail 10 hatchabot-kitchen-helper-df918a55$/m);
  });
});

describe('HB-1114: a reader whose docker link dropped is removed, not left reading', () => {
  /**
   * A runner's docker: the volume is there, the reader's `run` prints a little
   * and then the link drops (exit 255, as the ssh under docker does), and the
   * one-shot is still running there until removed by name.
   */
  function dropping() {
    const d = mkdtempSync(join(tmpdir(), 'acl-dropped-'));
    const log = join(d, 'argv.log');
    const bin = join(d, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  *" volume inspect "*) exit 0 ;;
  *" run --rm "*) printf 'part of it'; echo 'Connection to runner.invalid closed by remote host.' >&2; exit 255 ;;
  *" container inspect "*) echo 'running|2026-11-24T08:00:00Z' ;;
  *" rm -f "*) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', host: 'tcp://runner.invalid:2376', reachProbe: async () => true, reapRetryMs: 10 });
    const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []);
    const named = (kind: string) => lines().map((l) => new RegExp(`--name (hatchabot-${kind}-[0-9a-f]{12})`).exec(l)?.[1]).find(Boolean);
    const removed = async (name: string) => {
      for (let i = 0; i < 100 && !lines().some((l) => l.endsWith(` rm -f ${name}`)); i++) await new Promise((r) => setTimeout(r, 20));
      return lines().some((l) => l.endsWith(` rm -f ${name}`));
    };
    return { p, named, removed };
  }
  const drain = async (s: NodeJS.ReadableStream) => { let got = ''; for await (const c of s) got += String(c); return got; };

  it('a download: the stream fails, and its reader is removed by name', async () => {
    const { p, named, removed } = dropping();
    await expect(drain(p.streamFromVolume('docker://hatchabot-kitchen-helper-df918a55', ['cat', 'x']))).rejects.toThrow(/exit 255/);
    const name = named('fs');
    expect(name).toBeTruthy();
    expect(await removed(name!)).toBe(true);
  });

  it('a read-only shell on the volume: it fails, and its one-shot is removed by name (HB-1399)', async () => {
    const { p, named, removed } = dropping();
    expect((await p.execShellOnVolume('docker://hatchabot-kitchen-helper-df918a55', 'ls', { readOnly: true })).code).toBe(255);
    const name = named('ro');
    expect(name).toBeTruthy();
    expect(await removed(name!)).toBe(true);
  });

  it('a buffered export: it fails, and its reader is removed by name', async () => {
    const { p, named, removed } = dropping();
    await expect(p.exportState('docker://hatchabot-kitchen-helper-df918a55')).rejects.toThrow(/volume export failed/);
    const name = named('ex');
    expect(name).toBeTruthy();
    expect(await removed(name!)).toBe(true);
  });
});

describe('dockerMemoryBytes reads a memory limit as Docker does', () => {
  it('every form Docker takes, and none it refuses', () => {
    const G = 1024 ** 3, M = 1024 ** 2;
    const takes: Array<[string, number]> = [
      ['2g', 2 * G], ['2048m', 2 * G], ['1.5GiB', 1.5 * G], ['2GB', 2 * G], ['2 g', 2 * G], ['512M', 512 * M],
      ['.5g', 0.5 * G], ['5.', 5], ['1e9', 1e9], ['1e3m', 1000 * M], ['+2g', 2 * G], ['100b', 100], ['100', 100], ['1.5', 1],
    ];
    for (const [v, b] of takes) expect([v, dockerMemoryBytes(v)]).toEqual([v, b]);
    for (const v of ['', 'g', '.', '1gi', '1ib', '1bb', '-1g', '2  g', '2gb2', 'inf', '0x10', '2x', ' 2g', '2g ', '\t2g', '2 g ', '2g\n']) expect([v, dockerMemoryBytes(v)]).toEqual([v, undefined]);
  });
});
