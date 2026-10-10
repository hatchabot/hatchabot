#!/usr/bin/env node
/**
 * Checks that the release and CI workflows stay pinned and least-privileged
 * (#46, 2026-10-09). test/workflowPins.test.ts runs it in CI's test job, so a
 * change that loosens one of these fails there:
 *
 *   - every `uses:` names a full 40-character commit SHA (a tag can be moved);
 *   - every checkout sets `persist-credentials: false`, unless the job is in
 *     PUSHES (none is: no workflow pushes to git);
 *   - a workflow's top-level permissions are `{}` or read-only, and a job that
 *     can write neither checks out nor installs or builds anything;
 *   - a secret or the token is only ever passed through `env:`/`with:`, never
 *     written into a `run:` line, where it could reach the log;
 *   - base images and the images CI pulls name a digest.
 *
 *   node scripts/workflow-pins.mjs [repo]     # prints each problem; exit 1 if any
 *
 * It reads the YAML line by line (the repo has no YAML parser), which holds
 * for workflows written the way these are: two-space indent, one step per `-`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<workflow file>:<job>` that must keep git credentials to push. */
export const PUSHES = new Set();

/** Steps that install or build: a job that can write runs none of these. */
const BUILDS = /\bnpm (ci|install|run)\b|\bnpx\b|\bnode scripts\/|build-bundle\.sh|docker\/build-push-action|\bdocker build\b|\bbuildx build\b/;

const indentOf = (line) => line.length - line.trimStart().length;

/** The jobs of a workflow: name → its lines (the job's key line excluded). */
function jobsOf(lines) {
  const jobs = new Map();
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return jobs;
  let cur;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([\w-]+):\s*(#.*)?$/.exec(line);
    if (m) { cur = []; jobs.set(m[1], cur); continue; }
    cur?.push(line);
  }
  return jobs;
}

/** A `permissions:` block at the given indent: 'none' if absent, else its key → value. */
function permissionsAt(lines, indent) {
  const pad = ' '.repeat(indent);
  const i = lines.findIndex((l) => l.startsWith(`${pad}permissions:`) && indentOf(l) === indent);
  if (i < 0) return undefined;
  const inline = lines[i].slice(indent + 'permissions:'.length).replace(/#.*/, '').trim();
  if (inline) return inline === '{}' ? {} : { '*': inline };
  const out = {};
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (indentOf(l) <= indent) break;
    const m = /^\s*([\w-]+):\s*(\S+)/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const canWrite = (perms) => !!perms && Object.values(perms).some((v) => /write/.test(v));

/** The steps of a job: each step's lines, from its `-` to the next one at that indent. */
function stepsOf(jobLines) {
  const steps = [];
  const at = jobLines.findIndex((l) => /^\s+steps:\s*$/.test(l));
  if (at < 0) return steps;
  const stepIndent = indentOf(jobLines[at]) + 2;
  for (const l of jobLines.slice(at + 1)) {
    if (l.trim() && indentOf(l) < stepIndent) break;
    if (indentOf(l) === stepIndent && l.trimStart().startsWith('- ')) steps.push([l]);
    else steps.at(-1)?.push(l);
  }
  return steps;
}

/** Problems in one workflow's text. */
export function checkWorkflow(name, text) {
  const bad = [];
  const lines = text.split('\n');
  lines.forEach((line, n) => {
    const where = `${name}:${n + 1}`;
    const uses = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(#.*)?$/.exec(line);
    if (uses) {
      const ref = uses[1];
      if (ref.startsWith('./')) return;
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) bad.push(`${where}: ${ref} is not pinned to a digest`);
      } else if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(`${where}: ${ref} is not pinned to a full commit SHA`);
      else if (!uses[2]) bad.push(`${where}: ${ref} has no "# <tag>" comment saying which release the SHA is`);
    }
    // ${{ secrets.X }} or the token written into a script prints wherever the script echoes it.
    if (/\$\{\{\s*(secrets\.|github\.token)/.test(line) && !/^\s*(?:-\s+)?(?!run:)[\w-]+:\s*\$\{\{[^}]*\}\}\s*$/.test(line)) {
      bad.push(`${where}: a secret or the token outside an env:/with: value`);
    }
    if (/\bdocker (pull|run)\b/.test(line) && !/@sha256:[0-9a-f]{64}/.test(line)) bad.push(`${where}: a docker image with no digest`);
  });

  const top = permissionsAt(lines, 0);
  if (!top) bad.push(`${name}: no top-level permissions (the default token can write)`);
  else if (canWrite(top) || (top['*'] && top['*'] !== 'read-all')) bad.push(`${name}: top-level permissions can write — grant write to the one job that needs it`);

  for (const [job, jobLines] of jobsOf(lines)) {
    const perms = permissionsAt(jobLines, 4);
    const writes = canWrite(perms ?? top);
    for (const step of stepsOf(jobLines)) {
      const body = step.join('\n');
      if (/uses:\s*actions\/checkout@/.test(body)) {
        if (writes) bad.push(`${name}: job "${job}" can write and checks out the code — build in a read-only job and hand the result on`);
        if (!PUSHES.has(`${name}:${job}`) && !/^\s*persist-credentials:\s*false\s*$/m.test(body)) {
          bad.push(`${name}: a checkout in job "${job}" keeps its git credentials (persist-credentials: false)`);
        }
      }
      if (writes && BUILDS.test(body)) bad.push(`${name}: job "${job}" can write and installs or builds — move that to a read-only job`);
    }
  }
  return bad;
}

/** Problems in the Dockerfiles' base images and the Chrome image the UI gate runs. */
export function checkImages(root) {
  const bad = [];
  const dir = join(root, 'docker');
  for (const f of readdirSync(dir).filter((f) => /^Dockerfile/.test(f))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const args = Object.fromEntries([...text.matchAll(/^ARG (\w+)=(\S+)/gm)].map((m) => [m[1], m[2]]));
    for (const m of text.matchAll(/^FROM\s+(\S+)/gm)) {
      const arg = /^\$\{?(\w+)\}?$/.exec(m[1]);
      const image = arg ? args[arg[1]] : m[1];
      if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) bad.push(`docker/${f}: FROM ${m[1]} is not pinned to a digest`);
    }
  }
  const pinned = /const CHROME_IMAGE = '([^']+)'/.exec(readFileSync(join(root, 'scripts', 'ui-clickthrough.mjs'), 'utf8'))?.[1];
  if (!pinned || !/@sha256:[0-9a-f]{64}$/.test(pinned)) bad.push('scripts/ui-clickthrough.mjs: CHROME_IMAGE is not pinned to a digest');
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  if (pinned && !ci.includes(`docker pull ${pinned}`)) bad.push('ci.yml: the ui job does not pull the CHROME_IMAGE scripts/ui-clickthrough.mjs runs');
  return bad;
}

/** Every problem in a checkout of the repo. */
export function checkRepo(root) {
  const dir = join(root, '.github', 'workflows');
  const bad = [];
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) bad.push(...checkWorkflow(f, readFileSync(join(dir, f), 'utf8')));
  return [...bad, ...checkImages(root)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const bad = checkRepo(root);
  for (const b of bad) console.error(`✗ ${b}`);
  if (bad.length) process.exit(1);
  console.log('✓ workflows pinned and least-privileged');
}
