import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CURATED_SKILLS } from '../openclaw/skills.js';
import type { ExecResult, RuntimeProvider } from '../providers/provider.js';

export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const SKILL_HISTORY_LIMIT = 5;
export type SkillFileAction = 'update' | 'replace' | 'rollback';
export type SkillFileErrorCode = 'invalid' | 'conflict' | 'customized' | 'no_history' | 'unsafe' | 'too_large' | 'unavailable' | 'volume_missing';
const MESSAGES: Record<SkillFileErrorCode, string> = {
  invalid: 'Choose a catalog skill and a valid file action.',
  conflict: 'The skill changed or another file action is running. Read its preview again before continuing.',
  customized: 'This file contains local changes. Keep them, or explicitly replace it with the catalog copy after reviewing the preview.',
  no_history: 'There is no previous skill file to restore.',
  unsafe: 'The skill file or its history could not be read safely. Check its files before trying again.',
  too_large: 'The skill file is larger than 64 KB and cannot be updated here.',
  unavailable: 'The skill file operation could not be completed. Read its preview again to check the current state.',
  volume_missing: 'The agent’s volume is gone. Restore its files from a backup first.',
};
export class SkillFileError extends Error {
  readonly userMessage: string;
  constructor(readonly code: SkillFileErrorCode) {
    super(MESSAGES[code]); this.name = 'SkillFileError'; this.userMessage = MESSAGES[code];
  }
}
export interface SkillFileContext {
  runtimeRef: string;
  slug: string;
  onVolume?: boolean;
  image?: string;
}
export interface SkillFileView {
  id: string;
  /** Includes current bytes, history bytes and the reviewed catalog version. */
  revision: string;
  catalog: { version: string; hash: string; content: string };
  installed: { content: string | null; hash: string | null; version: string | null };
  state: 'missing' | 'current' | 'update_available' | 'customized' | 'untracked';
  canUpdate: boolean;
  canReplace: boolean;
  canRollback: boolean;
  /** Metadata only; private previous content stays on the agent's volume. */
  history: Array<{ version: string | null; hash: string | null; at: string }>;
}
type Reader = Pick<RuntimeProvider, 'execShell' | 'execShellOnVolume'>;
const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.string().max(63).regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
const Content = z.string().refine((value) => Buffer.byteLength(value) <= MAX_SKILL_FILE_BYTES);
const View = z.object({
  id: z.string(), revision: Hash,
  catalog: z.object({ version: Version, hash: Hash, content: Content }),
  installed: z.object({ content: Content.nullable(), hash: Hash.nullable(), version: Version.nullable() }),
  state: z.enum(['missing', 'current', 'update_available', 'customized', 'untracked']),
  canUpdate: z.boolean(), canReplace: z.boolean(), canRollback: z.boolean(),
  history: z.array(z.object({ version: Version.nullable(), hash: Hash.nullable(), at: z.iso.datetime() })).max(SKILL_HISTORY_LIMIT),
});

// All file access is relative to O_NOFOLLOW directory descriptors. Apart from
// rejecting symlinks at rest, this anchors operations if a parent is renamed
// while they run. The runtime is Linux; /proc/self/fd is present in its image.
// History is committed before the file, so a failed final rename cannot lose
// the previous content. Interrupted operations can always be inspected and
// rolled back; reads themselves never repair or change state.
const PROGRAM = String.raw`
const fs = require('node:fs'), crypto = require('node:crypto');
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const MAX = 65536, KEEP = 5, META_MAX = MAX * 7;
const root = '/home/node';
const descriptors = [], temporary = [];
let lockDir, lockHeld = false;
const fail = code => { throw Object.assign(new Error(code), {skillCode:code}); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hashOrNull = value => value === null ? null : hash(value);
const pathAt = (fd, name) => '/proc/self/fd/' + fd + '/' + name;
const own = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join(',') === keys.slice().sort().join(',');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = value => value === null || (typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) && value.length < 64);
function directory(parent, name, create = false, optional = false) {
  const path = parent === null ? name : pathAt(parent, name);
  if (create) { try { fs.mkdirSync(path, {mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  let fd;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  descriptors.push(fd); return fd;
}
function file(fd, name, cap) {
  if (fd === null) return null;
  let handle;
  try { handle = fs.openSync(pathAt(fd, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const st = fs.fstatSync(handle);
    if (!st.isFile() || st.nlink !== 1) fail('unsafe');
    if (st.size > cap) fail('too_large');
    const buffer = Buffer.alloc(cap + 1);
    let used = 0, count;
    do { count = fs.readSync(handle, buffer, used, buffer.length - used, null); used += count; } while (count && used < buffer.length);
    if (used > cap) fail('too_large');
    return new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(buffer.subarray(0, used));
  } finally { fs.closeSync(handle); }
}
function snapshot(value) {
  if (!own(value, ['content','hash','version','at']) || !(value.content === null || typeof value.content === 'string') ||
      (value.content !== null && Buffer.byteLength(value.content) > MAX) || value.hash !== hashOrNull(value.content) || !version(value.version) ||
      (value.content === null && value.version !== null) || typeof value.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) fail('unsafe');
  return value;
}
function metadata(raw) {
  if (raw === null) return null;
  let value; try { value = JSON.parse(raw); } catch { fail('unsafe'); }
  if (!own(value, ['format','id','base','history']) || value.format !== 1 || value.id !== input.id ||
      !own(value.base, ['hash','version']) || !(value.base.hash === null || sha(value.base.hash)) || !version(value.base.version) ||
      (value.base.hash === null && value.base.version !== null) || !Array.isArray(value.history) || value.history.length > KEEP) fail('unsafe');
  value.history.forEach(snapshot); return value;
}
function atomic(fd, name, value) {
  const temporaryName = '.' + name + '.tmp-' + crypto.randomBytes(12).toString('hex');
  const path = pathAt(fd, temporaryName); temporary.push(path);
  const handle = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(handle, value, 'utf8'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(path, pathAt(fd, name));
  fs.fsyncSync(fd);
}
function exists(fd, name) {
  if (fd === null) return false;
  try { fs.lstatSync(pathAt(fd, name)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
try {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id) ||
      !['read','update','replace','rollback'].includes(input.action) || !version(input.catalog.version) || !input.catalog.version ||
      typeof input.catalog.content !== 'string' || Buffer.byteLength(input.catalog.content) > MAX) fail('invalid');
  let workspace = directory(null, '/');
  for (const component of (root + '/.openclaw/agents/' + input.slug + '/agent').split('/').filter(Boolean)) workspace = directory(workspace, component);
  let skills = directory(workspace, 'skills', false, true);
  let skill = skills === null ? null : directory(skills, input.id, false, true);
  let history = directory(workspace, '.hatchabot-skills', false, true);
  const catalogHash = hash(input.catalog.content), name = input.id + '.json';
  const get = () => {
    const content = file(skill, 'SKILL.md', MAX);
    const raw = file(history, name, META_MAX);
    const meta = metadata(raw);
    const fileHash = hashOrNull(content);
    const state = content === null ? 'missing' : fileHash === catalogHash ? 'current'
      : meta === null ? 'untracked' : fileHash === meta.base.hash ? 'update_available' : 'customized';
    const installedVersion = content === null ? null : fileHash === catalogHash ? input.catalog.version
      : fileHash === meta?.base.hash ? meta.base.version : null;
    const revision = hash(JSON.stringify([content, raw, input.catalog.version, catalogHash]));
    return {content,raw,meta,fileHash,state,installedVersion,revision};
  };
  const view = state => ({id:input.id,revision:state.revision,catalog:{...input.catalog,hash:catalogHash},
    installed:{content:state.content,hash:state.fileHash,version:state.installedVersion},state:state.state,
    canUpdate:['missing','update_available'].includes(state.state),canReplace:state.state !== 'current',
    canRollback:!!state.meta?.history.length,
    history:(state.meta?.history ?? []).map(({version,hash,at}) => ({version,hash,at}))});
  if (exists(history, input.id + '.lock')) fail('conflict');
  let before = get();
  if (input.action === 'read') {
    if (exists(history, input.id + '.lock')) fail('conflict');
    process.stdout.write(JSON.stringify(view(before)));
  } else {
    if (!sha(input.expectedRevision) || before.revision !== input.expectedRevision) fail('conflict');
    if (input.action === 'update' && ['customized','untracked'].includes(before.state)) fail('customized');
    if (input.action === 'rollback' && !before.meta?.history.length) fail('no_history');
    if (input.action !== 'rollback' && before.state === 'current') { process.stdout.write(JSON.stringify(view(before))); }
    else {
      history ??= directory(workspace, '.hatchabot-skills', true);
      lockDir = pathAt(history, input.id + '.lock');
      try { fs.mkdirSync(lockDir, {mode:0o700}); } catch (e) { if (e.code === 'EEXIST') fail('conflict'); throw e; }
      lockHeld = true;
      before = get();
      if (before.revision !== input.expectedRevision) fail('conflict');
      const previous = {content:before.content,hash:before.fileHash,version:before.installedVersion,at:new Date().toISOString()};
      const target = input.action === 'rollback' ? before.meta.history[0]
        : {content:input.catalog.content,hash:catalogHash,version:input.catalog.version};
      const old = before.meta?.history ?? [];
      const next = {format:1,id:input.id,base:{hash:target.hash,version:target.version},
        history:[previous,...(input.action === 'rollback' ? old.slice(1) : old)].slice(0,KEEP)};
      // Commit recovery evidence before touching current bytes. A crash at any
      // later instruction leaves both the previous version and its metadata.
      atomic(history, name, JSON.stringify(next));
      if (file(skill, 'SKILL.md', MAX) !== before.content) fail('conflict');
      if (target.content === null) {
        if (skill !== null && before.content !== null) fs.unlinkSync(pathAt(skill, 'SKILL.md'));
      } else {
        skills ??= directory(workspace, 'skills', true);
        skill ??= directory(skills, input.id, true);
        // A missing directory may have been created by the agent since the
        // preview. Recheck its file after opening the actual directory.
        if (file(skill, 'SKILL.md', MAX) !== before.content) fail('conflict');
        atomic(skill, 'SKILL.md', target.content);
      }
      process.stdout.write(JSON.stringify(view(get())));
    }
  }
} catch (error) {
  const code = error.skillCode ?? (['ELOOP','ENOTDIR'].includes(error.code) || error instanceof TypeError ? 'unsafe' : 'unavailable');
  process.stdout.write(JSON.stringify({error:code})); process.exitCode = 1;
} finally {
  for (const path of temporary) { try { fs.unlinkSync(path); } catch {} }
  if (lockHeld) { try { fs.rmdirSync(lockDir); } catch {} }
  for (const fd of descriptors.reverse()) { try { fs.closeSync(fd); } catch {} }
}
`;

/** Exported for isolated execution tests; production never accepts a path. */
export function skillFileScript(context: SkillFileContext, skillId: string, action: SkillFileAction | 'read', expectedRevision?: string): string {
  const skill = CURATED_SKILLS.find(({ id }) => id === skillId);
  if (!skill || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(context.slug) || !context.runtimeRef ||
      !['read', 'update', 'replace', 'rollback'].includes(action) ||
      (action !== 'read' && !/^[a-f0-9]{64}$/.test(expectedRevision ?? ''))) throw new SkillFileError('invalid');
  const payload = Buffer.from(JSON.stringify({ slug: context.slug, id: skillId, action, expectedRevision,
    catalog: { version: skill.version, content: skill.content } })).toString('base64');
  return `node - '${payload}' <<'HB_SKILL_FILES_JS'\n${PROGRAM}\nHB_SKILL_FILES_JS`;
}

async function run(provider: Reader, context: SkillFileContext, skillId: string, action: SkillFileAction | 'read', expectedRevision?: string): Promise<SkillFileView> {
  const script = skillFileScript(context, skillId, action, expectedRevision);
  let result: ExecResult;
  try {
    result = context.onVolume
      ? await provider.execShellOnVolume(context.runtimeRef, script, { readOnly: action === 'read', image: context.image })
      : await provider.execShell(context.runtimeRef, script, { timeoutMs: 30_000 });
  } catch { throw new SkillFileError('unavailable'); }
  if (result.volumeMissing) throw new SkillFileError('volume_missing');
  if (result.timedOut || result.unreachable || result.signalled || Buffer.byteLength(result.stdout ?? '') > 1024 * 1024) throw new SkillFileError('unavailable');
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new SkillFileError('unavailable'); }
  if (result.code !== 0) {
    const error = typeof value === 'object' && value !== null && 'error' in value ? value.error : undefined;
    throw new SkillFileError(typeof error === 'string' && Object.hasOwn(MESSAGES, error) ? error as SkillFileErrorCode : 'unavailable');
  }
  const parsed = View.safeParse(value), catalog = CURATED_SKILLS.find(({ id }) => id === skillId)!;
  if (!parsed.success) throw new SkillFileError('unavailable');
  const view = parsed.data;
  if (view.id !== skillId || view.catalog.content !== catalog.content || view.catalog.version !== catalog.version ||
      view.catalog.hash !== digest(catalog.content) || view.installed.hash !== (view.installed.content === null ? null : digest(view.installed.content)) ||
      view.canRollback !== !!view.history.length || view.canUpdate !== ['missing', 'update_available'].includes(view.state) ||
      view.canReplace !== (view.state !== 'current') || (view.state === 'missing') !== (view.installed.content === null) ||
      (view.state === 'current') !== (view.installed.hash === view.catalog.hash)) throw new SkillFileError('unavailable');
  return view;
}

export function readSkillFile(provider: Reader, context: SkillFileContext, skillId: string): Promise<SkillFileView> {
  return run(provider, context, skillId, 'read');
}
export function mutateSkillFile(provider: Reader, context: SkillFileContext, skillId: string,
  change: { action: SkillFileAction; expectedRevision: string }): Promise<SkillFileView> {
  return run(provider, context, skillId, change.action, change.expectedRevision);
}
