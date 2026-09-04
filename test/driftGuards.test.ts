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
    expect(df).toMatch(new RegExp(`AGENTCLAW_EMBED_PLUGIN=${EMBED_PLUGIN_DIR}`));
    expect(df).toMatch(new RegExp(`AGENTCLAW_EMBED_MODEL=${EMBED_MODEL_PATH}`));
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

describe('heartbeat llm label: sender slice ↔ receiver max (audit 2026-09-03)', () => {
  // The sender composes "model via profileName" (unbounded inputs) and the
  // receiver 400s the WHOLE beat past 64 chars — this pair diverging is how a
  // healthy bot showed as offline forever. Both sides must name 64.
  it('both files carry the 64-char bound', () => {
    expect(read('src/mgmt/index.ts')).toMatch(/\.slice\(0,\s*64\)/);
    expect(read('src/api/routes.ts')).toMatch(/llm:\s*z\.string\(\)\.trim\(\)\.max\(64\)/);
  });
});

describe('heartbeat cadence: sender 30s ↔ receiver 90s window (audit 2026-09-04)', () => {
  // "Three missed beats = offline" is arithmetic across two processes with no
  // import edge. If either number moves alone, presence flaps or lags.
  it('both constants are present and the window is 3× the beat', () => {
    const sender = read('src/mgmt/index.ts');
    const receiver = read('src/api/routes.ts');
    expect(sender).toMatch(/setInterval\(\(\) => void beat\(\), 30_000\)/);
    expect(receiver).toMatch(/< 90_000/);
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
