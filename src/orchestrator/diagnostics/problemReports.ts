import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialValuesFromEnv, redactSecrets } from '../../domain/redact.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { backupsDir } from '../backups/backupFiles.js';
import {
  boundInput, buildReport, endpointIdentity, issueUrl, knownProblems, localContext, matchKnownProblems, readSource, redactForPublic, searchSource,
  type PublicRedactContext, type ReportFacts, type ReportInput,
} from './problemReport.js';

/**
 * Who is asking, as a report needs it: their account, whether they set this
 * machine up (read when it is asked, as each step asked it), and their own
 * agent by an id (`ownedAgent`: the agent, when it exists and is theirs).
 */
export interface ReportCaller {
  ownerId: string;
  ownsMachine: () => boolean;
  owned: (agentId: string) => Agent | undefined;
}

/** A stored draft as the store keeps it. */
export interface ReportRow { id: string; title: string; body: string; createdAt: string; by: string; agentId?: string; sentAt?: string }

/** A draft as it leaves: masked again, with its GitHub link, its file name and the playbook entries it most likely is. */
export type ReportView = ReturnType<ProblemReports['reportView']>;

/**
 * The Report a problem service (HB-0808, docs/field-reports.md): the facts a
 * report carries, what a public report must not carry, a private draft per
 * person, the playbook entries a symptom most likely is, and the installed
 * source, read-only. Nothing here sends anything: the person opens the GitHub
 * issue themselves from the draft.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.problemReports`). Nothing
 * here knows about HTTP: who is asking comes in as a `ReportCaller`, and the
 * reply's words are the route file's (src/api/ops/problemReportRoutes.ts). The
 * masking itself and the source search are problemReport.ts's. No state of
 * its own (a search's slots are problemReport.ts's) and no timer.
 */
export interface ProblemReports {
  /** What a report carries: version, install kind, platform, doctor's lines (the machine's owner only), recent failures, the agent's state and log tail. */
  reportFacts(caller: ReportCaller, agentRef?: string): Promise<ReportFacts>;
  /** The private names and known credentials a public report is masked with. Built for one report and dropped. */
  reportRedaction(caller: ReportCaller, agentRef?: string): Promise<PublicRedactContext>;
  /** A draft masked again as it leaves, with its link, file name and known problems. */
  reportView(raw: ReportRow, ctx: PublicRedactContext): ReportRow & { issueUrl: string; trimmed: boolean; fileName: string; reviewPath: string; known: Array<{ title: string; fixedIn?: string }> };
  /** The playbook entries a symptom most likely is, in full. */
  knownFor(symptom: string): ReturnType<typeof matchKnownProblems>;
  /** A file or folder of the installed source. Throws with the words for a 400. */
  read(path: string, from: number, to: number | undefined): ReturnType<typeof readSource>;
  /** A search of the installed source, bounded in a worker. Throws with the words for a 400. */
  search(query: string, under: string | undefined, regex: boolean, callerId: string): ReturnType<typeof searchSource>;
  /** The caller's drafts, without their bodies. */
  list(ownerId: string): Array<Omit<ReportRow, 'body'>>;
  /** One of the caller's drafts, masked as it leaves; undefined when there is none. */
  get(caller: ReportCaller, id: string): Promise<ReportView | undefined>;
  /** A new draft from what the person (or their agent) wrote and the facts, masked before it is kept. */
  create(caller: ReportCaller, input: ReportInput, agentId: string | undefined): Promise<ReportView>;
  /** A person's edit of their draft, masked like the rest before it is kept; undefined when there is none. */
  edit(caller: ReportCaller, id: string, change: { title?: string | null; body?: string | null }): Promise<ReportView | undefined>;
  /** The person opened the issue. False when there is no such draft. */
  markSent(ownerId: string, id: string): boolean;
  /** A draft thrown away. False when there is no such draft. */
  remove(ownerId: string, id: string): boolean;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface ProblemReportsDeps {
  store: Store;
  /** The credentials of the agents a report may mention, to mask them. */
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** Where the installed release is: its source, docs, BUNDLE.json and bin/hatchabot.mjs. */
  appDir: string;
  /** This release, as `v1.2.3`. */
  version: string;
  /** Doctor's lines, instead of running `hatchabot doctor --json` (tests). */
  reportDoctor?: () => Promise<ReportFacts['doctor'] | undefined>;
  /** The hosts of the addresses this install is reached at (its public URL, the public address's): doctor's lines name them. */
  addressHosts: () => string[];
}

/** Everything either masking context knows (the same machine's: home, user and host are the first's). */
function bothContexts(a: PublicRedactContext, b: PublicRedactContext): PublicRedactContext {
  const all = (x: Iterable<string> | undefined, y: Iterable<string> | undefined) => [...new Set([...(x ?? []), ...(y ?? [])])];
  return {
    ...a,
    names: all(a.names, b.names), hosts: all(a.hosts, b.hosts), paths: all(a.paths, b.paths), secrets: all(a.secrets, b.secrets),
    users: all(a.users, b.users), people: all(a.people, b.people), ids: all(a.ids, b.ids),
  };
}

export function createProblemReports(deps: ProblemReportsDeps): ProblemReports {
  const { store, secrets, providerFor, appDir } = deps;
  const installKind = (): string => {
    try { const b = JSON.parse(readFileSync(join(appDir, 'BUNDLE.json'), 'utf8')) as { platform?: string }; return `bundle ${b.platform ?? ''}`.trim(); } catch { /* not a bundle */ }
    return existsSync(join(appDir, '.git')) ? 'git checkout' : 'files';
  };
  // What went wrong — not a guest refused by design (console.guest_refused), which is the guard working.
  const FAILURE_EVENT = /fail|error|crash|unreachable|interrupt|kill|timed?_?out|missing|stuck/i;
  // The same words for the store, which picks them before its limit (HB-1100):
  // each a LIKE that every name FAILURE_EVENT takes passes (`_` is any one letter).
  const FAILURE_LIKE = ['fail', 'error', 'crash', 'unreachable', 'interrupt', 'kill', 'timeout', 'timedout', 'time_out', 'timed_out', 'missing', 'stuck'].map((w) => `%${w}%`);
  const PERSON_KEYS = new Set(['userId', 'user', 'email', 'by', 'from', 'fromUserId', 'chatId']);
  // The agents a report's facts may mention, and so whose names and credentials its masking must know: one list for both (#204).
  const reportAgents = (caller: ReportCaller) => (caller.ownsMachine() ? store.listAllActiveAgents() : store.listAgents(caller.ownerId));
  const reportFacts = async (caller: ReportCaller, agentRef?: string): Promise<ReportFacts> => {
    const owner = caller.ownsMachine();
    const facts: ReportFacts = {
      version: deps.version,
      install: installKind(), platform: `${process.platform}-${process.arch}`, node: process.version,
    };
    const local = store.listHosts(caller.ownerId).find((h) => h.kind === 'local');
    if (local) { try { facts.openclaw = (await providerFor(local.id).currentImageInfo()).openclawVersion; } catch { /* unknown */ } }
    if (owner && deps.reportDoctor) facts.doctor = await deps.reportDoctor().catch(() => undefined);
    else if (owner) {
      // `hatchabot doctor --json`, as the person would run it here: exit 1 on a ✗ still prints the report.
      const out = await new Promise<string>((done) => {
        const child = spawn(process.execPath, [join(appDir, 'bin', 'hatchabot.mjs'), 'doctor', '--json'], { cwd: appDir, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
        let buf = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.stdout.on('data', (d: Buffer) => { if (buf.length < 200_000) buf += d.toString(); });
        child.on('close', () => { clearTimeout(timer); done(buf); });
        child.on('error', () => { clearTimeout(timer); done(''); });
      });
      try { facts.doctor = (JSON.parse(out) as { lines?: ReportFacts['doctor'] }).lines; } catch { /* doctor did not answer */ }
    }
    const agents = reportAgents(caller);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    const since = Date.now() - 3 * 86_400_000;
    // The same failure again and again is one line with a count, not fifteen.
    const seen = new Map<string, NonNullable<ReportFacts['failures']>[number] & { n: number }>();
    for (const e of store.listEvents(agents.map((a) => a.id), 400, { eventLike: FAILURE_LIKE })) {
      if (!FAILURE_EVENT.test(e.event) || Date.parse(e.at) < since) continue;
      const detail = e.detail ? Object.fromEntries(Object.entries(e.detail).filter(([k]) => !PERSON_KEYS.has(k))) : undefined;
      // Bounded, not clipped to show: a report masks it whole, then clips it (#210).
      const text = detail && Object.keys(detail).length ? boundInput(redactSecrets(JSON.stringify(detail)), 1000) : undefined;
      const key = `${e.agentId} ${e.event} ${text ?? ''}`;
      const had = seen.get(key);
      if (had) { had.n++; continue; }
      if (seen.size >= 15) continue;
      seen.set(key, { at: e.at, event: e.event, agent: names.get(e.agentId), ...(text ? { detail: text } : {}), n: 1 });
    }
    facts.failures = [...seen.values()].map(({ n, ...f }) => (n > 1 ? { ...f, event: `${f.event} ×${n}` } : f));
    if (agentRef) {
      const a = caller.owned(agentRef) ?? (owner ? store.getAgent(agentRef) : undefined);
      if (a && a.state !== 'DELETED') {
        const host = store.getHost(a.hostId);
        let logs: string | undefined;
        if (a.runtimeRef && a.state !== 'ARCHIVED') {
          try { logs = await Promise.race([providerFor(a.hostId).logs(a.runtimeRef, 60), new Promise<string>((_r, no) => setTimeout(() => no(new Error('slow')), 15_000))]); } catch { /* no logs */ }
        }
        facts.agent = { name: a.name, state: a.state, ...(a.stateReason ? { reason: a.stateReason } : {}), ...(a.model ? { model: a.model } : {}),
          ...(a.image ? { image: a.image } : {}), ...(host && host.kind !== 'local' ? { onRunner: true } : {}), ...(logs ? { logs: redactSecrets(logs) } : {}) };
      }
    }
    return facts;
  };
  /**
   * What a public report must not carry, as this app knows it (security audit, 2026-10-09):
   * the names and slugs of the agents it could mention, their members' names and chat
   * ids, the account usernames, the machines' names, and the credentials of every agent whose failures it may
   * carry (its bot token, its own settings, its AI key) plus the credential
   * settings of this server. Only the selected agent's were loaded, so a general
   * report kept another agent's key from a failure's detail (#204).
   * Built for one report and dropped: never stored, never logged.
   */
  const reportRedaction = async (caller: ReportCaller, agentRef?: string): Promise<PublicRedactContext> => {
    const owner = caller.ownsMachine();
    const agents = reportAgents(caller);
    const names: string[] = [], people: string[] = [], ids: string[] = [];
    for (const a of agents) {
      names.push(a.name, a.slug);
      for (const m of store.listMemberships(a.id)) {
        if (m.displayName) people.push(m.displayName);
        if (m.channelUserId) ids.push(m.channelUserId);
      }
    }
    // Each machine a report may mention: its name, and the user and host in its address (HB-0405).
    // The agents' too: the owner's report carries failures from agents on anyone's runner.
    const hostRows = new Map(store.listHosts(caller.ownerId).map((h) => [h.id, h]));
    for (const a of agents) { const h = store.getHost(a.hostId); if (h) hostRows.set(h.id, h); }
    const hosts: string[] = [];
    const users: string[] = [];
    // Everyone's for the machine owner, one's own for anyone else: a member can't test a name against the list.
    for (const acc of store.listLocalAccounts()) {
      if (!owner && acc.id !== caller.ownerId) continue;
      users.push(acc.username, acc.username.split('@')[0]!);
      if (acc.displayName) people.push(acc.displayName);
    }
    for (const h of hostRows.values()) {
      hosts.push(h.name);
      const id = endpointIdentity(h.settings?.dockerHost);
      hosts.push(...id.hosts);
      if (id.user) users.push(id.user);
    }
    // The addresses this install is reached at, and where its backups go: doctor's lines name them.
    hosts.push(...deps.addressHosts());
    const paths = [backupsDir()];
    const secretValues = credentialValuesFromEnv(process.env);
    const a = agentRef ? caller.owned(agentRef) ?? (owner ? store.getAgent(agentRef) : undefined) : undefined;
    if (a) names.push(a.name, a.slug);
    const refs = new Set<string>();
    for (const x of a ? [...agents, a] : agents) {
      for (const ref of [...store.listChannelsForAgent(x.id).map((c) => c.secretRef), ...store.listAgentEnv(x.id).map((v) => v.secretRef), store.getAIProfile(x.aiProfileId)?.secretRef]) if (ref) refs.add(ref);
    }
    for (const v of await Promise.all([...refs].map((ref) => secrets.get(ref).catch(() => undefined)))) if (v) secretValues.push(v);
    return { ...localContext(), names, hosts, users, people, ids, paths, secrets: secretValues };
  };
  // Masked again as it leaves — the link, the file, a person's edit — so a draft made before a rule, or an edit, is held to it too.
  const reportView = (raw: ReportRow, ctx: PublicRedactContext) => {
    const r = { ...raw, title: redactForPublic(raw.title, ctx), body: redactForPublic(raw.body, ctx) };
    const fileName = `hatchabot-report-${r.createdAt.slice(0, 10)}-${r.id.slice(0, 6)}.md`;
    const link = issueUrl(r.title, r.body, { file: fileName });
    // What the person (or agent) wrote, not the facts below it: doctor's lines would match entries by accident.
    const words = `${r.title}\n${r.body.split('\n### Environment')[0]}`;
    return { ...r, issueUrl: link.url, trimmed: link.trimmed, fileName, reviewPath: `/#report=${r.id}`, known: knownProblems(appDir, words) };
  };

  return {
    reportFacts,
    reportRedaction,
    reportView,
    knownFor: (symptom) => matchKnownProblems(appDir, symptom, deps.version),
    read: (path, from, to) => readSource(appDir, path, from, to),
    // Plain text unless regex=1; bounded in a worker either way (problemReport.ts SEARCH_LIMITS, 2026-10-09).
    search: (query, under, regex, callerId) => searchSource(appDir, query, under, 40, 15, { regex, caller: callerId }),
    list: (ownerId) => store.listProblemReports(ownerId).map(({ body: _b, ...r }) => r),
    get: async (caller, id) => {
      const r = store.getProblemReport(caller.ownerId, id);
      return r ? reportView(r, await reportRedaction(caller, r.agentId)) : undefined;
    },
    create: async (caller, input, agentId) => {
      // Read again once the facts are in, and both kept: a credential changed
      // while they were gathered (doctor alone may take half a minute) is in
      // what was recorded since under its new value, and in what was recorded
      // before under the old. Read only first, the new one went out unmasked
      // in the kept draft and its link (HB-0920).
      const before = await reportRedaction(caller, agentId);
      const facts = await reportFacts(caller, agentId);
      const ctx = bothContexts(before, await reportRedaction(caller, agentId));
      const built = buildReport(input, facts, ctx);
      const row = { id: randomUUID(), ownerId: caller.ownerId, createdAt: new Date().toISOString(), by: input.by, title: built.title, body: built.body, ...(agentId ? { agentId } : {}) };
      store.addProblemReport(row);
      return reportView(row, ctx);
    },
    edit: async (caller, id, b) => {
      const had = store.getProblemReport(caller.ownerId, id);
      if (!had) return undefined;
      // A person's edit is masked like the rest before it is kept (2026-10-09); what comes back is what goes out, for them to read.
      const ctx = await reportRedaction(caller, had.agentId);
      const patch = { ...(typeof b.title === 'string' && b.title.trim() ? { title: redactForPublic(boundInput(b.title, 200), ctx) } : {}), ...(typeof b.body === 'string' ? { body: redactForPublic(boundInput(b.body, 60_000), ctx) } : {}) };
      if (!store.updateProblemReport(caller.ownerId, id, patch)) return undefined;
      return reportView(store.getProblemReport(caller.ownerId, id)!, ctx);
    },
    markSent: (ownerId, id) => store.updateProblemReport(ownerId, id, { sentAt: new Date().toISOString() }),
    remove: (ownerId, id) => store.deleteProblemReport(ownerId, id),
  };
}
