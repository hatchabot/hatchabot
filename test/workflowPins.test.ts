import { describe, expect, it } from 'vitest';
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
