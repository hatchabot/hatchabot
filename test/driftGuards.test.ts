import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EMBED_MODEL_PATH, EMBED_PLUGIN_DIR } from '../src/openclaw/configWriter.js';

/**
 * Cross-file drift guards (audit 2026-09-02). Each pair here is two files that
 * MUST agree but share no import edge — the classic silent-drift shape: one
 * side changes, nothing fails, and the symptom surfaces weeks later in
 * production. These tests are the missing import edge.
 */

const read = (p: string) => readFileSync(p, 'utf8');

describe('embed paths: configWriter ↔ Dockerfile.runtime', () => {
  // configWriter points every agent's memorySearch at these image paths. If the
  // Dockerfile moves or renames them (a model bump changes the FILENAME), the
  // config silently points at nothing and semantic memory search dies quietly.
  it('the Dockerfile bakes exactly the paths configWriter references', () => {
    const df = read('docker/Dockerfile.runtime');
    expect(df).toContain(EMBED_PLUGIN_DIR);
    expect(df).toContain(EMBED_MODEL_PATH);
    // The env the image exports for discovery must name the same paths.
    expect(df).toMatch(new RegExp(`HATCHABOT_EMBED_PLUGIN=${EMBED_PLUGIN_DIR}`));
    expect(df).toMatch(new RegExp(`HATCHABOT_EMBED_MODEL=${EMBED_MODEL_PATH}`));
  });
});

describe('OPENCLAW_VERSION: Dockerfile ARG ↔ build script default', () => {
  // A bare `docker build` must produce the same version the build script ships;
  // the Dockerfile's own comment demands this and nothing enforced it.
  it('defaults match', () => {
    const df = /ARG OPENCLAW_VERSION=(\S+)/.exec(read('docker/Dockerfile.runtime'));
    const sh = /OPENCLAW_VERSION="\$\{OPENCLAW_VERSION:-([^}]+)\}"/.exec(
      read('scripts/build-runtime-image.sh'),
    );
    expect(df?.[1]).toBeTruthy();
    expect(df?.[1]).toBe(sh?.[1]);
  });
});

describe('claude-opus-5 must stay banished from offered model lists', () => {
  // The claude-cli (Max) runtime has no catalog entry for it: it once became a
  // fleet default and every conversation broke on compaction. The server list
  // was fixed; the web copy resurrected it (found by audit). Pin both.
  it('web and e2e never offer it', () => {
    const web = read('web/index.html');
    const models = /const CLAUDE_MODELS = \[([\s\S]*?)\]/.exec(web)?.[1] ?? '';
    expect(models).not.toContain('claude-opus-5');
    expect(read('scripts/e2e.ts')).not.toContain('claude-opus-5');
  });

  it('web offers every curated model the server would stock', () => {
    // CURATED_ANTHROPIC_MODELS in routes.ts is the server-side source of
    // truth; the web fallback list must at least cover it.
    const routes = read('src/api/routes.ts');
    const curated = [...(/CURATED_ANTHROPIC_MODELS = \[([\s\S]*?)\]/.exec(routes)?.[1] ?? '')
      .matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(curated.length).toBeGreaterThan(2);
    const webModels = /const CLAUDE_MODELS = \[([\s\S]*?)\]/.exec(read('web/index.html'))?.[1] ?? '';
    for (const m of curated) expect(webModels).toContain(`'${m}'`);
  });
});

describe('mgmt SETUP_FIELD json-schema ↔ TemplateParamSchema zod (audit 2026-09-03)', () => {
  // multichoice was hand-added to both sides; nothing linked them. The broker
  // re-validates with the zod schema, so drift here means the model is offered
  // shapes the broker then rejects (or worse, never offered valid ones).
  it('type enums and bounds agree', async () => {
    const { MANIFEST } = await import('../src/mgmt/tools.js');
    const { TemplateParamSchema } = await import('../src/orchestrator/template.js');
    const createTool = MANIFEST.find((t) => t.name === 'create_agent')!;
    const field = (createTool.input_schema.properties as any).fields.items;
    const zodShape = (TemplateParamSchema as any).def.schema?.shape ?? (TemplateParamSchema as any).shape;
    const zodTypes = (zodShape.type as any).options ?? (zodShape.type as any).def.values;
    expect([...field.properties.type.enum].sort()).toEqual([...zodTypes].sort());
    const zodTargets = (zodShape.target as any).options ?? (zodShape.target as any).def.values;
    expect([...field.properties.target.enum].sort()).toEqual([...zodTargets].sort());
    expect(field.properties.label.maxLength).toBe(64);
    expect(field.properties.help.maxLength).toBe(200);
    expect(field.properties.default.maxLength).toBe(2000);
    expect(field.properties.options.maxItems).toBe(12);
  });
});

describe('AUTHORING_TOOLS ↔ manifest (audit 2026-09-03)', () => {
  it('every authoring tool exists in the manifest and is mutate-tier', async () => {
    const { AUTHORING_TOOLS } = await import('../src/mgmt/broker.js');
    const { toolDef } = await import('../src/mgmt/tools.js');
    for (const name of AUTHORING_TOOLS) {
      const def = toolDef(name);
      expect(def, `${name} missing from manifest`).toBeTruthy();
      expect(def!.tier).toBe('mutate');
    }
  });
});

describe('fleet search key: provision injection ↔ web hint', () => {
  it('the injected env name and the UI hint agree on BRAVE_API_KEY', async () => {
    const prov = read('src/orchestrator/provision.ts');
    expect(prov).toContain("BRAVE_API_KEY: searchKey");
    expect(read('web/index.html')).toContain('BRAVE_API_KEY');
  });
});

describe('base image carries the OCR stack (silent-fail class)', () => {
  // Image-only PDF pages silently drop without local OCR — the condo agent
  // lost 7 pages of vendor approvals to exactly this. Base, not derived:
  // every agent gets handed PDFs eventually.
  it('the Dockerfile installs the PDF/OCR packages', () => {
    const df = read('docker/Dockerfile.runtime');
    for (const pkg of ['poppler-utils', 'qpdf', 'tesseract-ocr', 'ocrmypdf']) {
      expect(df).toContain(pkg);
    }
  });

  it('the Dockerfile installs the PDF-creation packages (pandoc + weasyprint)', () => {
    const df = read('docker/Dockerfile.runtime');
    for (const pkg of ['pandoc', 'weasyprint', 'fonts-liberation']) {
      expect(df).toContain(pkg);
    }
  });
});

describe('agent list position pickers are filled where the cards render', () => {
  // v1.5.6 wired fillPositionPickers() into the fleet-sources view instead of
  // renderAgents(), so every picker stayed hidden and nothing failed. The
  // pickers start `hidden`; only this call reveals them.
  it('renderAgents() calls fillPositionPickers() after writing the list', () => {
    const web = read('web/index.html');
    const start = web.indexOf('\nfunction renderAgents()');
    expect(start).toBeGreaterThan(0);
    const body = web.slice(start, web.indexOf('\n}\n', start));
    expect(body).toMatch(/el\.innerHTML = html;\s*\n\s*fillPositionPickers\(el\);/);
  });
});

describe('the hatchabot CLI runs from any directory', () => {
  // The bin was `#!/usr/bin/env -S npx tsx`, which resolves tsx against the
  // CURRENT directory: the first `hatchabot ls` run from $HOME on a fresh
  // install stopped to ask "Need to install the following packages: tsx".
  // The wrapper runs the tsx installed beside the CLI instead.
  it('bin points at the wrapper, and the wrapper resolves tsx from the checkout', async () => {
    const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string> };
    expect(pkg.bin.hatchabot).toBe('bin/hatchabot.mjs');
    const wrapper = read('bin/hatchabot.mjs');
    expect(wrapper).toContain("join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')");
    expect(wrapper.startsWith('#!/usr/bin/env node\n')).toBe(true); // not `env -S npx tsx`
  });
});

describe('dependencies are installed once, by one code path', () => {
  // setup-host.sh ran `npm ci` (which deletes node_modules, and with it the
  // stamp restart.sh writes), so the restart that follows an install
  // reinstalled everything again: "added 154 packages" on a machine that had
  // just installed them. One helper owns the decision now.
  it('no script runs npm ci directly except the helper', () => {
    for (const f of ['scripts/restart.sh', 'scripts/setup-host.sh', 'install.sh']) {
      expect(read(f), `${f} should call scripts/ensure-deps.sh`).not.toMatch(/^\s*npm ci/m);
    }
    expect(read('scripts/ensure-deps.sh')).toMatch(/npm ci/);
  });

  it('both callers use the helper', () => {
    expect(read('scripts/restart.sh')).toContain('./scripts/ensure-deps.sh');
    expect(read('scripts/setup-host.sh')).toContain('./scripts/ensure-deps.sh');
  });
});

describe('operator scripts name what blocks them', () => {
  // Twice in one day a script refused to proceed and did not say which file was
  // at fault: the installer silently left a checkout on an old release, and the
  // deploy guard refused over a stray note saved into the prod directory.
  it('the deploy guard and the installer both print the offending paths', () => {
    const deploy = read('scripts/deploy-release.sh');
    expect(deploy).toContain('git status --porcelain | sed');
    expect(deploy).toMatch(/untracked file/i);
    expect(read('install.sh')).toContain('These files differ from the release');
  });
});

describe('a changed app icon actually reaches browsers', () => {
  // Chrome stores favicons separately from the HTTP cache and the service
  // worker, and re-reads one when its URL changes rather than when its bytes
  // do — a renamed install kept the old icon in the tab for days. The ?v= on
  // the link and the SW cache name have to move together.
  it('the icon href carries a version and the SW caches that exact URL', () => {
    const html = read('web/index.html');
    const sw = read('web/sw.js');
    const version = /href="\/icons\/icon-192\.png\?v=(\d+)"/.exec(html)?.[1];
    expect(version, 'icon link must carry ?v=').toBeTruthy();
    // The service worker is cache-first on the shell, so it must hold the same
    // URL the page asks for — otherwise it caches a copy nothing requests.
    expect(sw).toContain(`/icons/icon-192.png?v=${version}`);
    expect(sw).toMatch(/hatchabot-shell-v\d+/);
  });
});

describe('action buttons never refuse in silence (UI audit 2026-09-17)', () => {
  // Driving all 283 controls in a headless browser turned up a class, not a
  // one-off: bulk-action buttons that `return` when nothing is selected, with
  // no message. To the person clicking, that is a broken button.
  it('the bulk-action handlers say why they refused', () => {
    const web = read('web/index.html');
    const handlers = [
      'faApply', 'moveAgentsApply', 'runMigrate', 'bringInSelected',
      'attachConnection', 'applyModelToSelected',
    ];
    for (const name of handlers) {
      const start = web.search(new RegExp(`(async )?function ${name}\\(`));
      expect(start, `${name} not found`).toBeGreaterThan(0);
      const body = web.slice(start, start + 700);
      // Every early return in the guard block must carry a toast.
      const bareReturns = [...body.matchAll(/if \([^)]*\) \{? ?return;/g)]
        .filter((m) => !/toast|renderAgents|\$\(/.test(body.slice(Math.max(0, m.index! - 90), m.index! + 12)));
      expect(bareReturns.map((m) => m[0]), `${name} refuses silently`).toEqual([]);
    }
  });
});

describe('the CLI keeps up with the app', () => {
  // Two ways the command line drifts from the product: a vendor or auth mode
  // the app supports but the docs/CLI never mention, and a saved token used
  // against a server it was never minted for.
  it('documents all three auth modes and all three API vendors', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/`accounts` \(what the installer writes\), `password` \(the fallback when unset\) or `identity`/);
    for (const vendor of ['Anthropic', 'OpenAI', 'Gemini']) {
      expect(readme, `README should name ${vendor} as an API-key vendor`).toContain(vendor);
    }
  });

  it('never sends a saved token to a server it was not minted for', () => {
    const cli = read('src/cli.ts');
    expect(cli).toContain('preferPassword');
    expect(cli).toMatch(/saved access token was minted for/);
  });

  it('surfaces rate-limit state in `hatchabot sources`', () => {
    const cli = read('src/cli.ts');
    expect(cli).toContain("'/v1/ai-profiles/usage'");
    expect(cli).toMatch(/RATE-LIMITED since/);
  });
});

describe('icon palette: agentIcons.ts ↔ the v2 home screen', () => {
  // The page shows a stable colour for an agent with none stored by hashing its
  // name into the same palette the server uses. Two copies of the list, no
  // import edge: if they drift, an icon's colour changes the moment the server
  // stores one.
  it('the page carries the same palette, in the same order', async () => {
    const { ICON_PALETTE } = await import('../src/orchestrator/agentIcons.js');
    const html = read('web/index.html');
    const m = html.match(/const V2_PALETTE = \[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const page = [...m![1]!.matchAll(/'(#[0-9a-f]{6})'/gi)].map((x) => x[1]);
    expect(page).toEqual([...ICON_PALETTE]);
  });
});

describe('console session: the page ↔ configWriter agent ids', () => {
  // Every container also holds OpenClaw's unused default agent "main"; the
  // console's bare address opens that one, which looks like total amnesia. The
  // page must open `agent:<slug>:main` — the session Telegram DMs use — which
  // relies on OpenClaw's agent id being the slug, as configWriter adds it.
  it('openGateway opens the agent’s own session, keyed by slug', () => {
    const html = read('web/index.html');
    expect(html).toMatch(/\/ui\/chat\?session=\$\{session\}/);
    expect(html).toContain('`agent:${slug}:main`');
    expect(read('src/openclaw/configWriter.ts')).toMatch(/'agents',\s*'add'/);
  });
});
