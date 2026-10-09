import { createHash } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Agent, ChannelKind } from '../domain/types.js';
import { CHANNEL_ACCOUNT } from '../openclaw/configWriter.js';
import { PAIRING_DB } from './claim.js';
import { gogAccounts, recordGoogleSeen, withConnectionLock } from './googleConnections.js';

/**
 * What each agent can reach (docs/access-overview-design.md): what Hatchabot
 * intends, what it last found inside the running agent, removals still
 * pending, and — said plainly — what it cannot see at all.
 *
 * Records: access_checks (store.recordAccessCheck). Google rows are also
 * written by googleConnections.ts whenever it reads or changes gog; the rest
 * by verifyAgentAccess (Verify now, after a start or wake, after a build).
 */

export type AccessKind = 'google' | ChannelKind | 'folder' | 'repo' | 'repo-key' | 'env' | 'person' | 'person-unknown';
export type Verified = { status: 'present' | 'absent' | 'unknown' | 'enforced'; at?: string; detail?: string };
export type Mismatch = 'extra' | 'differs' | 'stale-removal' | 'missing';

export interface AccessRow {
  kind: string;
  subject: string;
  label: string;
  /** Hatchabot's records say it should have this. */
  intended: boolean;
  /** Hatchabot put it there and can look for it. */
  managed: boolean;
  verified: Verified;
  pendingRemoval?: { since: string | null };
  mismatch?: Mismatch;
  note?: string;
}
export interface AccessGroup { key: string; title: string; rows: AccessRow[] }
export interface AgentAccess {
  agentId: string;
  name: string;
  state: string;
  /** The newest check of anything on this agent. */
  checkedAt: string | null;
  groups: AccessGroup[];
  /** What Hatchabot does not check, in plain words. */
  notChecked: string[];
  /** Counts: alert-level mismatches, intended-but-not-found, pending removals. */
  summary: { mismatches: number; missing: number; pending: number; rows: number };
}

/** A removal still pending after this long is an Alerts line. */
export const STALE_REMOVAL_MS = 24 * 3600_000;
/** An account verified gone is still shown ("removed — verified gone") this long. */
const GONE_SHOWN_MS = 7 * 24 * 3600_000;
/** Mismatches that go under Alerts (a missing one is ⚠ in the section only). */
export const ALERT_MISMATCHES: readonly Mismatch[] = ['extra', 'differs', 'stale-removal'];

const GIT_BASE = '/home/node/.openclaw';
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);

/** Where Hatchabot put each folder and repo, and what it injects — the intent. */
function intent(store: Store, agent: Agent) {
  const folders = [
    ...(agent.sharedPaths ?? []).map((p) => ({ path: `/data/${p.replace(/\/+$/, '').split('/').pop()}`, label: p.replace(/\/+$/, '').split('/').pop() ?? p, note: 'read-only' })),
    ...store.listDataSources(agent.id).filter((d) => d.kind === 'folder' && d.hostPath).map((d) => ({
      path: d.mountAtHostPath ? d.hostPath! : `/data/${d.mountName}`, label: d.mountName, note: d.access === 'rw' ? 'can change files' : 'read-only',
    })),
  ];
  const repos = store.listDataSources(agent.id).filter((d) => d.kind === 'git' && /^[A-Za-z0-9._-]+$/.test(d.mountName))
    .map((d) => ({ mount: d.mountName, url: d.repoUrl ?? '', keyed: !!d.secretRef }));
  const channels = store.listChannelsForAgent(agent.id).map((c) => ({
    kind: c.kind,
    subject: c.kind === 'telegram' ? c.accountId : CHANNEL_ACCOUNT,
    label: c.kind === 'telegram' ? `Telegram @${c.accountId}` : `${c.kind === 'slack' ? 'Slack' : 'Discord'}${typeof c.settings?.displayName === 'string' ? ` · ${c.settings.displayName}` : ''}`,
    secretRef: c.secretRef,
  }));
  const env = store.listAgentEnv(agent.id).map((e) => e.name);
  return { folders, repos, channels, env };
}

/**
 * The read-only probe run inside the agent: only paths and names go in; a token's hash prefix, never the token, comes out.
 *
 * 2026-10-09 (#23): a source of admitted chat ids that cannot be read (openclaw.json, an allowFrom file, the
 * pairing store — node:sqlite missing, the file unreadable, a query error) is no proof that nobody is
 * admitted. `unread` names, per chat app, each source that failed with a short reason; a chat app with
 * none listed was read completely. A path whose stat fails other than "no such file" is null (unknown).
 */
export function accessProbeScript(input: { paths: string[]; env: string[] }): string {
  const b64 = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  // No single quotes below: the code sits inside node -e '…'.
  const code = [
    'const fs=require("fs"),path=require("path"),cr=require("crypto");',
    'const inp=JSON.parse(Buffer.from(process.env.HB_ACCESS_PROBE,"base64").toString("utf8"));',
    'const d=process.env.OPENCLAW_STATE_DIR||"/home/node/.openclaw";',
    'const gone=(e)=>!!e&&(e.code==="ENOENT"||e.code==="ENOTDIR");',
    // Never a parse error's message: it quotes the file (openclaw.json holds bot tokens).
    'const er=(e)=>String((e&&(e.code||(e.name==="SyntaxError"?"not valid JSON":e.message)))||e||"unreadable").slice(0,60);',
    'let cfg=null,cfgErr=null;try{cfg=JSON.parse(fs.readFileSync(d+"/openclaw.json","utf8"))}catch(e){cfgErr=e}',
    'if(cfg&&typeof cfg!=="object")cfg=null;',
    'const h=(t)=>typeof t==="string"&&t?cr.createHash("sha256").update(t).digest("hex").slice(0,16):null;',
    'const out={config:!!cfg,channels:{},env:{},paths:{},admitted:{},unread:{telegram:[],slack:[],discord:[]}};',
    'const bad=(k,s,e)=>{for(const c of (k?[k]:["telegram","slack","discord"]))out.unread[c]&&out.unread[c].push(s+": "+er(e))};',
    'if(!cfg)bad(null,"openclaw.json",cfgErr||"not an object");',
    'const adm=(k,x)=>{if(x===undefined||x===null)return;let v=String(x);if(v.startsWith(k+":"))v=v.slice(k.length+1);(out.admitted[k]=out.admitted[k]||[]).includes(v)||out.admitted[k].push(v)};',
    'const ch=(cfg&&cfg.channels)||{};',
    'for(const k of ["telegram","slack","discord"]){const x=ch[k];if(!x||typeof x!=="object")continue;const a={};',
    'try{for(const [id,v] of Object.entries(x.accounts||{})){a[id]={enabled:!!v&&v.enabled!==false,h:h(v&&(v.botToken||v.token))};for(const y of ((v&&v.allowFrom)||[]))adm(k,y)}}catch(e){bad(k,"openclaw.json",e)}',
    'out.channels[k]={enabled:x.enabled!==false,accounts:a}}',
    'const cd=d+"/credentials";try{for(const f of fs.readdirSync(cd)){const m=/^(telegram|slack|discord)-.*-allowFrom\\.json$/.exec(f);if(!m)continue;try{for(const y of (JSON.parse(fs.readFileSync(path.join(cd,f),"utf8")).allowFrom||[]))adm(m[1],y)}catch(e){bad(m[1],"allowFrom file",e)}}}catch(e){if(!gone(e))bad(null,"allowFrom files",e)}',
    `let st=null;try{st=fs.statSync(${JSON.stringify(PAIRING_DB)})}catch(e){if(!gone(e))bad(null,"pairing store",e)}`,
    `if(st){try{const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(PAIRING_DB)},{readOnly:true});try{for(const r of db.prepare("select channel_key, entry from channel_pairing_allow_entries").all())adm(String(r.channel_key),r.entry)}finally{try{db.close()}catch(e){}}}catch(e){bad(null,"pairing store",e)}}`,
    'for(const n of inp.env)out.env[n]=Object.prototype.hasOwnProperty.call(process.env,n);',
    'for(const p of inp.paths){try{fs.statSync(p);out.paths[p]=true}catch(e){out.paths[p]=gone(e)?false:null}}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');
  return `HB_ACCESS_PROBE=${b64} node -e '${code}'`;
}

export interface ProbeResult {
  config: boolean;
  channels: Partial<Record<ChannelKind, { enabled: boolean; accounts: Record<string, { enabled: boolean; h: string | null }> }>>;
  env: Record<string, boolean>;
  /** true found, false no such file, null could not be looked at. */
  paths: Record<string, boolean | null>;
  admitted: Partial<Record<ChannelKind, string[]>>;
  /** Per chat app, the admission sources that could not be read ("pairing store: EACCES"); empty = read completely. */
  unread: Record<ChannelKind, string[]>;
}

export function parseProbe(stdout: string): ProbeResult | null {
  try {
    const j = JSON.parse(stdout) as Partial<ProbeResult>;
    if (!j || typeof j !== 'object' || typeof j.env !== 'object' || typeof j.paths !== 'object') return null;
    // A probe that says nothing of what it read is not a complete read of anything.
    const u = (j.unread && typeof j.unread === 'object' ? j.unread : {}) as Partial<Record<ChannelKind, unknown>>;
    const unreadOf = (k: ChannelKind) => (Array.isArray(u[k]) ? (u[k] as unknown[]).map(String) : ['not reported']);
    return {
      config: !!j.config, channels: j.channels ?? {}, env: j.env ?? {}, paths: j.paths ?? {}, admitted: j.admitted ?? {},
      unread: { telegram: unreadOf('telegram'), slack: unreadOf('slack'), discord: unreadOf('discord') },
    };
  } catch { return null; }
}

export interface VerifyDeps { store: Store; secrets: SecretStore; provider: RuntimeProvider }
export type VerifyResult =
  | { status: 'checked'; at: string; checked: number; skipped?: string[] }
  | { status: 'not-checkable'; reason: string };

/** Why an agent in this state can't be looked into, or undefined when it can. */
export function notCheckableReason(agent: Agent | undefined): string | undefined {
  if (!agent) return 'no such agent';
  if (agent.state === 'RUNNING' && agent.runtimeRef) return undefined;
  if (agent.state === 'STOPPED' && agent.hibernatedAt) return 'it is asleep — wake it to check';
  if (agent.state === 'STOPPED') return 'it is stopped — start it to check';
  if (agent.state === 'ARCHIVED') return 'it is archived';
  return `it is ${agent.state.toLowerCase().replace(/_/g, ' ')}`;
}

/**
 * Look inside one RUNNING agent with no side effects and record what is there:
 * Google accounts (gog auth list), chat bots and their tokens (compared by a
 * hash prefix computed in the container), folders and repo keys (the paths
 * exist), environment variable names, the chat ids OpenClaw admits. A run
 * that cannot happen (stopped, asleep, the machine not answering) records
 * nothing and says why; the last results and their times stay.
 */
export async function verifyAgentAccess(deps: VerifyDeps, agentId: string, runtimeRefOverride?: string): Promise<VerifyResult> {
  const { store, provider } = deps;
  const agent = store.getAgent(agentId);
  // A build in progress passes its ref: the container is up though the state is not RUNNING yet.
  const why = runtimeRefOverride && agent ? undefined : notCheckableReason(agent);
  if (why) return { status: 'not-checkable', reason: why };
  const runtimeRef = runtimeRefOverride ?? agent!.runtimeRef!;
  if ((await provider.reachable?.().catch(() => true)) === false) return { status: 'not-checkable', reason: 'its machine is asleep or offline' };
  return withConnectionLock(agentId, () => verifyNow(deps, agent!, runtimeRef));
}

async function verifyNow(deps: VerifyDeps, agent: Agent, runtimeRef: string): Promise<VerifyResult> {
  const { store, secrets, provider } = deps;
  const at = new Date().toISOString();
  const want = intent(store, agent);
  const prior = store.listAccessChecks(agent.id);
  const priorPresent = (kind: string) => prior.filter((c) => c.kind === kind && c.present).map((c) => c.subject);
  const skipped: string[] = [];
  let checked = 0;

  // Google: one gog list, judged against everything Hatchabot knows of.
  const held = await gogAccounts({ store, secrets, provider }, runtimeRef);
  if (held) {
    const also = [
      ...store.listAgentConnections(agent.id).map((a) => store.getConnection(a.connectionId)?.email).filter((e): e is string => !!e),
      ...store.connectionRemovals(agent.id),
      ...store.listConnections(agent.ownerId).map((c) => c.email),
      ...prior.filter((c) => c.kind === 'google').map((c) => c.subject),
    ];
    recordGoogleSeen(store, agent.id, held, also, at);
    checked++;
  } else skipped.push('Google accounts (gog did not answer)');

  // Everything else: one read-only probe.
  const folderPaths = [...new Set([...want.folders.map((f) => f.path), ...priorPresent('folder')])];
  const repoPaths = want.repos.map((r) => `${GIT_BASE}/${r.mount}`);
  const keyMounts = [...new Set([...want.repos.filter((r) => r.keyed).map((r) => r.mount), ...priorPresent('repo-key')])].filter((m) => /^[A-Za-z0-9._-]+$/.test(m));
  const keyPath = (m: string) => `${GIT_BASE}/.ssh/${m}_deploy`;
  const envNames = [...new Set([...want.env, ...priorPresent('env')])].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const res = await provider.execShell(runtimeRef, accessProbeScript({ paths: [...folderPaths, ...repoPaths, ...keyMounts.map(keyPath)], env: envNames }))
    .catch(() => undefined);
  if (!res || res.unreachable) return held ? { status: 'checked', at, checked, skipped: [...skipped, 'the rest (its machine stopped answering)'] } : { status: 'not-checkable', reason: 'its machine is asleep or offline' };
  const probe = res.code === 0 ? parseProbe(res.stdout) : null;
  if (!probe) {
    if (!held) return { status: 'not-checkable', reason: res.timedOut ? 'it did not answer in time' : 'could not read inside it' };
    return { status: 'checked', at, checked, skipped: [...skipped, 'bots, folders, variables and people (could not read inside it)'] };
  }

  // 2026-10-09 (#23): what could not be read is no proof of absence. Record unknown — but a thing last
  // found present keeps that finding (and its time), so a warning stays until a complete read shows it gone.
  const unread = (kind: string, subject: string) => {
    if (prior.some((c) => c.kind === kind && c.subject === subject && c.present)) return;
    store.recordAccessCheck(agent.id, kind, subject, null, undefined, at);
  };
  const unseenPaths: string[] = [];
  const pathCheck = (kind: string, subject: string, p: string) => {
    const v = probe.paths[p];
    if (v === true || v === false) { store.recordAccessCheck(agent.id, kind, subject, v, undefined, at); checked++; } else { unread(kind, subject); unseenPaths.push(subject); }
  };
  for (const p of folderPaths) pathCheck('folder', p, p);
  for (const r of want.repos) pathCheck('repo', r.mount, `${GIT_BASE}/${r.mount}`);
  for (const m of keyMounts) pathCheck('repo-key', m, keyPath(m));
  if (unseenPaths.length) skipped.push(`${unseenPaths.join(', ')} (could not be looked at)`);
  for (const n of envNames) { store.recordAccessCheck(agent.id, 'env', n, !!probe.env[n], undefined, at); checked++; }

  // Chat bots: the account Hatchabot gave it, the token compared by hash; any other account in its settings.
  if (probe.config) {
    const kinds: ChannelKind[] = ['telegram', 'slack', 'discord'];
    for (const kind of kinds) {
      const cfg = probe.channels[kind];
      const live = cfg && cfg.enabled !== false ? cfg.accounts : {};
      const mine = want.channels.filter((c) => c.kind === kind);
      const subjects = new Set([...mine.map((c) => c.subject), ...Object.keys(live ?? {}), ...priorPresent(kind)]);
      for (const subject of subjects) {
        const acct = live?.[subject];
        const present = !!acct && acct.enabled;
        let detail: string | undefined;
        const ch = mine.find((c) => c.subject === subject);
        if (present && ch && kind === 'telegram' && acct.h) {
          const token = await secrets.get(ch.secretRef).catch(() => null);
          if (token && tokenHash(token) !== acct.h) detail = 'differs';
        }
        store.recordAccessCheck(agent.id, kind, subject, present, detail, at);
        checked++;
      }
    }
  } else skipped.push('chat bots (its OpenClaw settings could not be read)');

  // People: Hatchabot's members against the chat ids OpenClaw admits.
  const admitted = new Map<string, Set<string>>(Object.entries(probe.admitted).map(([k, v]) => [k, new Set((v ?? []).map(String))]));
  const known = new Map<string, Set<string>>();
  // Only the chat apps it is on now: an id kept from a bot it no longer has is nothing to look for.
  const onApps = new Set(want.channels.map((c) => c.kind as string));
  for (const m of store.listMemberships(agent.id)) {
    const ids = (Object.entries(store.memberIdentities(agent.id, m.userId)) as Array<[ChannelKind, string]>).filter(([k]) => onApps.has(k));
    for (const [k, id] of ids) {
      if (!known.has(k)) known.set(k, new Set());
      known.get(k)!.add(id);
    }
    if (!ids.length) continue; // web chat only: Hatchabot's own sign-in decides, nothing to read in the agent
    if (m.status !== 'active' && m.status !== 'revoked') continue;
    // Found admitted anywhere is proof; "not admitted" only when every source on each of their chat apps was read.
    const present = ids.some(([k, id]) => admitted.get(k)?.has(id));
    if (present || ids.every(([k]) => !probe.unread[k]?.length)) { store.recordAccessCheck(agent.id, 'person', m.userId, present, undefined, at); checked++; } else unread('person', m.userId);
  }
  for (const kind of ['telegram', 'slack', 'discord'] as const) {
    const others = onApps.has(kind) ? [...(admitted.get(kind) ?? [])].filter((id) => !known.get(kind)?.has(id)) : [];
    if (onApps.has(kind) && probe.unread[kind].length) {
      skipped.push(`people on ${kind} (${probe.unread[kind].join('; ')})`);
      // Nobody else found in what could be read proves nothing: keep the last finding.
      if (!others.length) { if (prior.some((c) => c.kind === 'person-unknown' && c.subject === kind)) unread('person-unknown', kind); continue; }
    }
    if (others.length || prior.some((c) => c.kind === 'person-unknown' && c.subject === kind)) {
      store.recordAccessCheck(agent.id, 'person-unknown', kind, others.length > 0, String(others.length), at);
    }
  }
  return { status: 'checked', at, checked, ...(skipped.length ? { skipped } : {}) };
}

/**
 * The overview for one agent, from the store alone (no exec): what is
 * intended, the last check of each thing, pending removals, mismatches.
 * Never a secret: names, addresses and times only.
 */
export function accessOverview(store: Store, agent: Agent, now = Date.now()): AgentAccess {
  const want = intent(store, agent);
  const checks = store.listAccessChecks(agent.id);
  const check = (kind: string, subject: string) => checks.find((c) => c.kind === kind && c.subject === subject);
  const used = new Set<string>();
  const verifiedOf = (kind: string, subject: string): Verified => {
    const c = check(kind, subject);
    used.add(`${kind}\u0000${subject}`);
    if (!c || c.present === null) return { status: 'unknown', ...(c ? { at: c.checkedAt } : {}) };
    return { status: c.present ? 'present' : 'absent', at: c.checkedAt, ...(c.detail ? { detail: c.detail } : {}) };
  };
  const leftover = (kind: string) => checks.filter((c) => c.kind === kind && !used.has(`${kind}\u0000${c.subject}`));
  const missingIf = (intended: boolean, v: Verified): Mismatch | undefined => (intended && v.status === 'absent' ? 'missing' : undefined);

  // ---- Google accounts
  const google: AccessRow[] = [];
  const vault = new Set(store.listConnections(agent.ownerId).map((c) => c.email.toLowerCase()));
  for (const at of store.listAgentConnections(agent.id)) {
    const conn = store.getConnection(at.connectionId);
    if (!conn) continue;
    const v = verifiedOf('google', conn.email.toLowerCase());
    google.push({
      kind: 'google', subject: conn.email.toLowerCase(), label: conn.email, intended: true, managed: true, verified: v,
      mismatch: missingIf(true, v),
      note: [conn.services.join(', '), at.gmailNoSend ? 'cannot send mail' : ''].filter(Boolean).join(' · ') || undefined,
    });
  }
  for (const r of store.connectionRemovalsSince(agent.id)) {
    const subject = r.email.toLowerCase();
    if (google.some((g) => g.subject === subject)) continue;
    const v = verifiedOf('google', subject);
    const old = r.since ? now - Date.parse(r.since) > STALE_REMOVAL_MS : false;
    google.push({
      kind: 'google', subject, label: r.email, intended: false, managed: true, verified: v,
      pendingRemoval: { since: r.since }, ...(old ? { mismatch: 'stale-removal' as const } : {}),
      note: 'being removed — it is taken off at its next start, wake or rebuild, or at once while it runs',
    });
  }
  for (const c of leftover('google')) {
    const v = verifiedOf('google', c.subject);
    if (v.status === 'present') {
      const ours = vault.has(c.subject);
      google.push({
        kind: 'google', subject: c.subject, label: c.subject, intended: false, managed: ours, verified: v,
        ...(ours ? { mismatch: 'extra' as const, note: 'one of your connections, not attached to this agent — but it still holds it' }
          : { note: 'added inside the agent (in a chat, by the agent or a person) — not one of your connections, so Hatchabot does not manage it' }),
      });
    } else if (v.status === 'absent' && v.at && now - Date.parse(v.at) < GONE_SHOWN_MS && vault.has(c.subject)) {
      google.push({ kind: 'google', subject: c.subject, label: c.subject, intended: false, managed: true, verified: v, note: 'removed — verified gone' });
    }
  }

  // ---- Chat bots
  const bots: AccessRow[] = [];
  for (const c of want.channels) {
    const v = verifiedOf(c.kind, c.subject);
    bots.push({
      kind: c.kind, subject: c.subject, label: c.label, intended: true, managed: true, verified: v,
      mismatch: v.detail === 'differs' ? 'differs' : missingIf(true, v),
      ...(v.detail === 'differs' ? { note: 'the bot token in the running agent is not the one Hatchabot holds — rebuild it' } : {}),
    });
  }
  for (const kind of ['telegram', 'slack', 'discord'] as const) {
    for (const c of leftover(kind)) {
      const v = verifiedOf(kind, c.subject);
      if (v.status !== 'present') continue;
      bots.push({
        kind, subject: c.subject, label: kind === 'telegram' ? `Telegram @${c.subject}` : kind === 'slack' ? 'Slack' : 'Discord',
        intended: false, managed: true, verified: v, mismatch: 'extra',
        note: 'still in its OpenClaw settings, though Hatchabot no longer gives it this bot — rebuild it',
      });
    }
  }

  // ---- Folders & repos
  const data: AccessRow[] = [];
  for (const f of want.folders) {
    const v = verifiedOf('folder', f.path);
    data.push({ kind: 'folder', subject: f.path, label: `${f.label} (${f.path})`, intended: true, managed: true, verified: v, mismatch: missingIf(true, v), note: f.note + (v.status === 'absent' ? ' · not mounted yet — applies at its next rebuild' : '') });
  }
  for (const r of want.repos) {
    const v = verifiedOf('repo', r.mount);
    data.push({ kind: 'repo', subject: r.mount, label: `${r.mount} (${r.url})`, intended: true, managed: true, verified: v, mismatch: missingIf(true, v), note: v.status === 'absent' ? 'not cloned yet' : undefined });
    if (r.keyed) {
      const k = verifiedOf('repo-key', r.mount);
      data.push({ kind: 'repo-key', subject: r.mount, label: `Deploy key for ${r.mount}`, intended: true, managed: true, verified: k, mismatch: missingIf(true, k) });
    }
  }
  for (const c of leftover('folder')) {
    const v = verifiedOf('folder', c.subject);
    if (v.status === 'present') data.push({ kind: 'folder', subject: c.subject, label: c.subject, intended: false, managed: true, verified: v, mismatch: 'extra', note: 'removed, but still mounted until its next rebuild' });
  }
  for (const c of leftover('repo-key')) {
    const v = verifiedOf('repo-key', c.subject);
    if (v.status === 'present') data.push({ kind: 'repo-key', subject: c.subject, label: `Deploy key for ${c.subject}`, intended: false, managed: true, verified: v, mismatch: 'extra', note: 'the repo was removed, but its key file is still in the agent' });
  }

  // ---- Environment variables (names only)
  const env: AccessRow[] = [];
  for (const n of want.env) {
    const v = verifiedOf('env', n);
    env.push({ kind: 'env', subject: n, label: n, intended: true, managed: true, verified: v, mismatch: missingIf(true, v), ...(v.status === 'absent' ? { note: 'not set in the running agent yet — applies at its next rebuild' } : {}) });
  }
  for (const c of leftover('env')) {
    const v = verifiedOf('env', c.subject);
    if (v.status === 'present') env.push({ kind: 'env', subject: c.subject, label: c.subject, intended: false, managed: true, verified: v, mismatch: 'extra', note: 'removed, but still set until its next rebuild' });
  }

  // ---- AI source: written at every build, not read back.
  const ai: AccessRow[] = [];
  const prof = store.getAIProfile(agent.aiProfileId);
  if (prof) {
    const applied = agent.appliedProfileId && agent.appliedProfileId !== agent.aiProfileId ? store.getAIProfile(agent.appliedProfileId) : undefined;
    ai.push({
      kind: 'ai', subject: prof.id, label: prof.name, intended: true, managed: true, verified: { status: 'unknown' },
      note: applied ? `it still runs on ${applied.name} — switches at its next rebuild` : 'set by Hatchabot at each build; not read back from the agent',
    });
  }

  // ---- Agents it may consult: checked by Hatchabot on every call.
  const peers: AccessRow[] = [];
  const acting = new Set(store.listAgentActionPeers(agent.id));
  for (const id of store.listAgentPeers(agent.id)) {
    const p = store.getAgent(id);
    if (!p || p.state === 'DELETED') continue;
    peers.push({ kind: 'peer', subject: id, label: p.name, intended: true, managed: true, verified: { status: 'enforced' }, note: acting.has(id) ? 'may ask it to act, not only to answer' : 'checked by Hatchabot on every call' });
  }

  // ---- People
  const people: AccessRow[] = [];
  const onApps = new Set(want.channels.map((c) => c.kind as string));
  for (const m of store.listMemberships(agent.id)) {
    if (m.status !== 'active' && m.status !== 'revoked') continue;
    const hasIds = Object.keys(store.memberIdentities(agent.id, m.userId)).some((k) => onApps.has(k));
    const name = m.role === 'owner' ? 'You (owner)' : m.displayName ?? 'Someone';
    const v = hasIds ? verifiedOf('person', m.userId) : { status: 'unknown' as const };
    if (m.status === 'revoked') {
      if (v.status === 'present') people.push({ kind: 'person', subject: m.userId, label: name, intended: false, managed: true, verified: v, mismatch: 'extra', note: 'removed, but the agent still lets them in' });
      continue;
    }
    people.push({
      kind: 'person', subject: m.userId, label: name, intended: true, managed: true, verified: v,
      ...(hasIds ? { mismatch: missingIf(true, v) } : { note: m.webChat ? 'web chat — Hatchabot\'s own sign-in decides' : 'no chat app linked yet' }),
    });
  }
  for (const kind of ['telegram', 'slack', 'discord'] as const) {
    const c = check('person-unknown', kind);
    if (c?.present) {
      const n = Number(c.detail) || 0;
      people.push({
        kind: 'person-unknown', subject: kind, label: `${n} other ${n === 1 ? 'person' : 'people'} on ${kind[0]!.toUpperCase() + kind.slice(1)}`,
        intended: false, managed: false, verified: { status: 'present', at: c.checkedAt },
        note: 'admitted inside OpenClaw (its own console or pairing list) with no member in Hatchabot — Hatchabot does not manage them',
      });
    }
  }

  // ---- Its browser and app: what lives there is the agent's own.
  const own: AccessRow[] = [];
  if (agent.browser) own.push({ kind: 'browser', subject: 'browser', label: 'Its own browser', intended: true, managed: false, verified: { status: 'unknown' }, note: 'what it logs into there is not kept across a restart, and is not checked' });
  const app = store.getAgentApp(agent.id);
  if (app) own.push({ kind: 'app', subject: app.app, label: `App ${app.app}`, intended: true, managed: false, verified: { status: 'unknown' }, note: 'keeps its own settings, which may hold an account or a password — not checked' });

  const groups: AccessGroup[] = [
    { key: 'google', title: 'Google accounts', rows: google },
    { key: 'bots', title: 'Chat apps', rows: bots },
    { key: 'data', title: 'Folders & repos', rows: data },
    { key: 'env', title: 'Environment variables (names only)', rows: env },
    { key: 'ai', title: 'AI source', rows: ai },
    { key: 'peers', title: 'Agents it may consult', rows: peers },
    { key: 'people', title: 'People who can talk to it', rows: people },
    { key: 'own', title: 'Its own browser and app', rows: own },
  ].filter((g) => g.rows.length);
  const all = groups.flatMap((g) => g.rows);
  const times = checks.map((c) => c.checkedAt).sort();
  const notChecked = [
    'Keys, passwords or accounts the agent saved for itself in its workspace — from a chat, a script or its own browser — are not checked.',
    'Accounts added to gog inside the agent show here once Hatchabot sees them, marked "not managed"; Hatchabot never removes them.',
    ...(app ? [`Its app (${app.app}) keeps its own settings, which may hold an account or a password; they are not checked.`] : []),
  ];
  return {
    agentId: agent.id, name: agent.name, state: agent.state,
    checkedAt: times.at(-1) ?? null,
    groups, notChecked,
    summary: {
      mismatches: all.filter((r) => r.mismatch && ALERT_MISMATCHES.includes(r.mismatch)).length,
      missing: all.filter((r) => r.mismatch === 'missing').length,
      pending: all.filter((r) => r.pendingRemoval).length,
      rows: all.length,
    },
  };
}

/** The Alerts line for an agent's access mismatches, keyed so a cleared line comes back for a new one. */
export function accessAlertOf(ov: AgentAccess): { key: string; line: string } | undefined {
  const bad = ov.groups.flatMap((g) => g.rows).filter((r) => r.mismatch && ALERT_MISMATCHES.includes(r.mismatch));
  if (!bad.length) return undefined;
  const say = (r: AccessRow) => r.mismatch === 'stale-removal' ? `${r.label}: removal still pending since ${r.pendingRemoval?.since?.slice(0, 10) ?? 'over a day'}`
    : r.mismatch === 'differs' ? `${r.label}: a different bot token is running`
    : `${r.label}: still there`;
  return {
    key: 'access:' + bad.map((r) => `${r.kind}=${r.subject}:${r.mismatch}`).sort().join(','),
    line: `It can still reach what it should not: ${bad.map(say).join('; ')} (Sharing → Access)`,
  };
}

/** The agents that have anything for an Alerts line, from two fleet-wide reads (the agent list). */
export function agentsWithAccessFindings(store: Store, now = Date.now()): Set<string> {
  const out = new Set(store.presentAccessChecks().map((c) => c.agentId));
  for (const r of store.allConnectionRemovals()) if (r.since && now - Date.parse(r.since) > STALE_REMOVAL_MS) out.add(r.agentId);
  return out;
}
