import type { Agent } from '../../domain/types.js';
import type { Store } from '../../store/store.js';
import { pickIcons, suggestIcons, type IconCompleter } from './agentIcons.js';
import { refused, said, type Answer } from '../consult/answers.js';

/** A line to the request's log: its detail, then its words. */
export type IconLog = (detail: object, msg: string) => void;
/** An agent's icon as picked: its emoji and palette colour. */
export interface IconPick { id: string; icon: string; color: string }
/** What the icon dialog's ideas say (agentIcons.ts's `suggestIcons`, without why the AI gave none). */
export type IconIdeas = Omit<Awaited<ReturnType<typeof suggestIcons>>, 'error' | 'reply'>;

/**
 * Home-screen icons (HB-0808 step 15, part C): icons picked for the
 * caller's agents that have none (or, with `redo`, the named ones), and
 * ideas for one agent's icon. One call to the owner's management AI covers
 * the batch; without one (or if it fails) a keyword table picks
 * (agentIcons.ts). One of each at a time per owner (`iconRuns`,
 * `iconIdeaRuns`: locks). Nothing here knows HTTP or the management AI: its
 * completer is handed in.
 */
export interface HomeIcons {
  /** Pick icons for the owner's agents (ids and redo checked by the route). */
  auto(ownerId: string, b: { ids?: string[]; redo?: unknown }, warn: IconLog): Promise<Answer<{ assigned: number; via: 'ai' | 'keywords' | 'none'; icons: IconPick[] }>>;
  /** Ideas for one agent's icon, none of those already shown. Nothing is saved. */
  suggest(agent: Agent, ownerId: string, b: { exclude?: string[]; want?: string }, warn: IconLog): Promise<Answer<IconIdeas>>;
}

export interface HomeIconsDeps {
  store: Store;
  /** The owner's management AI as an icon completer, with this many tokens, or none (routes.ts's `iconCompleter`). */
  completer: (ownerId: string, maxTokens: number) => IconCompleter | undefined;
}

export function createHomeIcons(deps: HomeIconsDeps): HomeIcons {
  const { store, completer } = deps;
  const iconRuns = new Set<string>();

  // Pick home-screen icons (ui v2) for the caller's agents that have none —
  // or, with `redo`, for the named ones. Either way the result is validated
  // to one emoji and a palette colour.
  const auto: HomeIcons['auto'] = async (ownerId, b, warn) => {
    const ids = b.ids ? new Set(b.ids) : undefined;
    const targets = store
      .listAgents(ownerId)
      .filter((a) => a.ownerId === ownerId && a.state !== 'DELETED')
      .filter((a) => (ids ? ids.has(a.id) : true))
      .filter((a) => (b.redo === true ? true : !a.icon))
      .slice(0, 80);
    if (!targets.length) return said({ assigned: 0, via: 'none' as const, icons: [] });
    if (iconRuns.has(ownerId)) return refused(429, 'Already picking icons — give it a moment.');
    iconRuns.add(ownerId);
    try {
      // The icon and colour each had as the run began. A pick is written only
      // where they are still those, checked at the write itself (nothing is
      // awaited between the two): an icon the owner chose while the AI was
      // answering stands, a redo's too, where a redo wrote over it (HB-1007).
      const had = new Map(targets.map((a) => [a.id, { icon: a.icon, color: a.iconColor }]));
      const picks = await pickIcons(targets.map((a) => ({ id: a.id, name: a.name, persona: a.persona })), completer(ownerId, 4000),
        (why) => warn(why, 'agent icons: the management AI left some to the keyword table'));
      const written: typeof picks = [];
      for (const p of picks) {
        const now = store.getAgent(p.id), was = had.get(p.id);
        if (!now || !was || now.icon !== was.icon || now.iconColor !== was.color) continue;
        store.setAgentIcon(p.id, p.icon, p.color);
        written.push(p);
      }
      // Only what was written is said to be: a pick passed over was counted too.
      const via = picks.some((p) => p.via === 'ai') ? 'ai' : 'keywords';
      return said({ assigned: written.length, via, icons: written.map(({ id, icon, color }) => ({ id, icon, color })) });
    } finally {
      iconRuns.delete(ownerId);
    }
  };

  // Ideas for one agent's icon (the icon dialog's ✨ button): one AI call for a
  // handful of different emoji, none of those the dialog has already shown.
  // Nothing is saved: the person picks one, and the dialog's Save sets it.
  const iconIdeaRuns = new Set<string>();
  const suggest: HomeIcons['suggest'] = async (agent, ownerId, b, warn) => {
    if (iconIdeaRuns.has(ownerId)) return refused(429, 'Already thinking of icons — give it a moment.');
    iconIdeaRuns.add(ownerId);
    try {
      const r = await suggestIcons({ name: agent.name, persona: agent.persona }, {
        exclude: b.exclude ?? [],
        complete: completer(ownerId, 1000),
        want: b.want,
      });
      // Why the AI gave no ideas goes to the log, not the page: its text can name the account.
      // Of a reply with none, the log gets only its shape: the reply's text can hold anything.
      if (r.error) warn({ agent: agent.id, error: r.error, ...(r.reply ? { reply: r.reply } : {}) }, 'icon ideas: the management AI gave none');
      const { error: _error, reply: _reply, ...out } = r;
      return said(out);
    } finally {
      iconIdeaRuns.delete(ownerId);
    }
  };

  return { auto, suggest };
}
