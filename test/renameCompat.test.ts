import { describe, expect, it } from 'vitest';
import { applyLegacyEnv } from '../src/envCompat.js';
import { baseProblem, deriveTag } from '../src/orchestrator/derivedImage.js';
import { DEFAULT_PREFIX, LEGACY_PREFIXES } from '../src/providers/localDockerProvider.js';
import { EXPORT_FORMAT, LEGACY_EXPORT_FORMAT } from '../src/orchestrator/transfer.js';
import { LEGACY_TEMPLATE_FORMAT, TEMPLATE_FORMAT } from '../src/orchestrator/template.js';

// Hatchabot shipped as AgentClaw first; a host that upgraded in place keeps
// AGENTCLAW_* env files, agentclaw-* docker objects and agentclaw_ tokens.

describe('applyLegacyEnv', () => {
  it('aliases AGENTCLAW_* to HATCHABOT_* without overriding an explicit new value', () => {
    const env: NodeJS.ProcessEnv = { AGENTCLAW_DB: '/old/db', AGENTCLAW_PORT: '1', HATCHABOT_PORT: '2', OTHER: 'x' };
    expect(applyLegacyEnv(env)).toEqual(['HATCHABOT_DB']);
    expect(env.HATCHABOT_DB).toBe('/old/db');
    expect(env.HATCHABOT_PORT).toBe('2');
    expect(env.AGENTCLAW_DB).toBe('/old/db'); // left in place for scripts that still read it
  });
  it('is a no-op on a fresh install', () => {
    const env: NodeJS.ProcessEnv = { HATCHABOT_DB: 'x' };
    expect(applyLegacyEnv(env)).toEqual([]);
  });
});

describe('docker naming', () => {
  it('new agents get the hatchabot- prefix; agentclaw- is the recognised legacy prefix', () => {
    expect(DEFAULT_PREFIX).toBe('hatchabot');
    expect(LEGACY_PREFIXES).toContain('agentclaw');
  });
  it('derived images may still be based on the pre-rename runtime repo', () => {
    expect(baseProblem('hatchabot-runtime:latest')).toBeNull();
    expect(baseProblem('agentclaw-runtime:2026.7.1-2')).toBeNull();
    expect(baseProblem('agentclaw-runtime:derived-x')).toMatch(/cannot be based on another derived/);
    expect(baseProblem('other-runtime:latest')).toMatch(/hatchabot-runtime/);
    expect(deriveTag('py')).toBe('hatchabot-runtime:derived-py');
  });
});

describe('file formats', () => {
  it('keeps the pre-rename format ids importable', () => {
    expect(EXPORT_FORMAT).toBe('hatchabot-export');
    expect(LEGACY_EXPORT_FORMAT).toBe('agentclaw-export');
    expect(TEMPLATE_FORMAT).toBe('hatchabot-template');
    expect(LEGACY_TEMPLATE_FORMAT).toBe('agentclaw-template');
  });
});
