import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — a plain .mjs script, no types
import { checkRepo, checkWorkflow } from '../scripts/workflow-pins.mjs';

// #46 (2026-10-09): the workflows pinned actions by moving tags, and the
// release jobs installed dependencies and built while holding write access.
// This keeps the pins and the build/publish split from sliding back.
describe('workflow pins and permissions', () => {
  it('the repository passes: actions on SHAs, images on digests, builds read-only', () => {
    expect(checkRepo('.')).toEqual([]);
  });

  // A made-up workflow with each regression the check exists to catch.
  const loose = [
    'name: example',
    'on: push',
    'permissions:',
    '  contents: write',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - run: npm ci',
    '      - run: echo ${{ secrets.EXAMPLE_VALUE }}',
    '      - run: docker pull example/image',
  ].join('\n');

  it('names each regression in a loose workflow', () => {
    const bad = checkWorkflow('example.yml', loose).join('\n');
    expect(bad).toMatch(/actions\/checkout@v7 is not pinned to a full commit SHA/);
    expect(bad).toMatch(/top-level permissions can write/);
    expect(bad).toMatch(/job "build" can write and checks out/);
    expect(bad).toMatch(/keeps its git credentials/);
    expect(bad).toMatch(/job "build" can write and installs or builds/);
    expect(bad).toMatch(/a secret or the token outside an env:\/with: value/);
    expect(bad).toMatch(/a docker image with no digest/);
  });

  // Release by workflow (issues #37, #38, #47, 2026-10-10): what the release
  // path must keep, read from the workflow files themselves.
  it('release by workflow: one release at a time, aliases only by promote-images, no replacing uploads', () => {
    const read = (f: string) => readFileSync(join('.github', 'workflows', f), 'utf8');
    const release = read('release.yml');
    expect(release).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(release).toMatch(/^concurrency:\n {2}group: release\n {2}cancel-in-progress: false/m);
    expect(release).toContain('bash scripts/release-check.sh');
    expect(release).toContain('node scripts/privacy-ci.mjs --text');
    expect(release).toContain('uses: ./.github/workflows/bundles.yml');
    expect(release).toContain('uses: ./.github/workflows/runtime-image-build.yml');
    expect(release).toContain('uses: ./.github/workflows/promote-images.yml');
    expect(release).toMatch(/actions\/attest-build-provenance@[0-9a-f]{40}/);
    expect(release).toContain('gh attestation verify');
    // Drafted, checked, then tagged and published — in that order; never --clobber.
    const at = (s: string) => { const i = release.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(at('-F draft=true')).toBeLessThan(at("the draft's assets are not the manifest's"));
    expect(at("the draft's assets are not the manifest's")).toBeLessThan(at('refs/tags/$TAG'));
    expect(at('refs/tags/$TAG')).toBeLessThan(at('-F draft=false'));
    expect(at('a release\'s image is never replaced')).toBeGreaterThan(0);
    for (const f of ['release.yml', 'bundles.yml', 'runtime-image.yml', 'runtime-image-build.yml', 'promote-images.yml']) expect(read(f)).not.toContain('--clobber');
    // bundles.yml and the image build only build; neither runs on a tag or a release any more.
    expect(read('bundles.yml')).not.toMatch(/^\s+release:\s*$/m);
    expect(read('bundles.yml')).not.toMatch(/gh release/);
    expect(read('runtime-image.yml')).not.toMatch(/^\s+push:\s*$/m);
    expect(read('runtime-image.yml')).not.toMatch(/IMAGE:latest|IMAGE:\$GITHUB_REF_NAME|promote_latest/);
    expect(read('runtime-image-build.yml')).not.toMatch(/packages: write|docker\/login-action/);
    const promote = read('promote-images.yml');
    expect(promote).toMatch(/concurrency:\n\s+group: image-aliases\n\s+cancel-in-progress: false/);
    expect(promote).toContain('allow_backwards');
    expect(promote).toContain('org.hatchabot.release');
  });

  it('accepts the same workflow split into a read-only build and a write-only publish', () => {
    const sha = 'a'.repeat(40);
    const split = [
      'name: example',
      'on: push',
      'permissions: {}',
      'jobs:',
      '  build:',
      '    permissions:',
      '      contents: read',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${sha} # v7.0.0`,
      '        with:',
      '          persist-credentials: false',
      '      - run: npm ci',
      '  publish:',
      '    needs: build',
      '    permissions:',
      '      contents: write',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/download-artifact@${sha} # v8.0.0`,
      '      - env:',
      '          GH_TOKEN: ${{ github.token }}',
      '        run: gh release upload "$TAG" out/* --repo "$GITHUB_REPOSITORY"',
    ].join('\n');
    expect(checkWorkflow('example.yml', split)).toEqual([]);
  });
});
