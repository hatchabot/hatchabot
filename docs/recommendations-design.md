# Design: one recommendations view

Status: **proposal, for review** (2026-10-09). From an outside review:
"consolidate model steward, token steward, spend alerts and budget advice into
one prioritized recommendations view; keep their specialized checks
internally; show one understandable decision with evidence and expected
effect; do not remove budget enforcement."

## What exists today

Seven features give cost, model or token advice. Each has its own check, its
own messages and its own limits, and none knows about the others:

| Concern | Where you see it now | What you can do from there | Changes anything by itself? |
|---|---|---|---|
| A loop burning tokens (retries, failing tasks, consult ping-pong, tool loops, failing model) | Alerts 🔁, the tile ("Stuck in a loop"), one Telegram message | read the fix text; the Hatchabot agent may file a card | no |
| A spike (≥3× its usual day and ≥20M tokens) | one Telegram message, the Usage panel | dismiss | no |
| Budget at 80% / 100% | Alerts 💵, one Telegram message, the tooltip, Usage, Budgets | raise the budget | **pause** or **cheaper model** at 100%, if you chose it |
| "Tell me every $X" | Alerts 🔔, a Telegram message per step, the tooltip, Usage, Budgets | change the step | no |
| A cheaper model would do (scorecard: the agent's own token mix, priced) | only through the Hatchabot agent's weekly review, as a card | Confirm / Cancel | no |
| A switch that went worse (the quality guard) | a card, a push | switch back / Cancel | no |
| The conversation is too big (≥150K median, ≥250K now) | the Hatchabot agent only (cards); one note in the Usage tab | Confirm a compact / cap card | no |
| An AI source is rate-limited | up to nine places, on **every** agent of that source | none | no |
| Savings so far ("Saved by cheaper models") | Usage, the weekly review | — | no |

What that adds up to for you:

- **The same concern in several places.** A runaway agent can raise a loop
  line, a spike message, a step message and a budget message about one cause.
- **No ranking by money.** Under Alerts, an agent's lines follow the order of
  the code: a loop burning $40 a day sits below "rebuild recommended", memory
  and disk.
- **Advice without a button.** Nothing in the app compacts a conversation,
  sets a context cap, or shows a model's evidence before you switch; those
  come only as the Hatchabot agent's cards.
- **Spikes never reach Alerts**, and every message needs Telegram linked.

Two of these **enforce** — a budget's **pause** and **cheaper model** at
100% — and stay exactly as they are.

## Proposal

### One list: Recommended

A **Recommended** section at the top of the **Usage** panel (where money
already lives), and the same items on each agent's Usage tab. Each item is one
decision:

> **Recipe Box is stuck in a loop** — its scheduled task failed 9 times since
> 08:19 (≈ $6 so far today).
> *Expected effect:* stops ≈ $40/day. **[Pause the task]** [Details]

> **Stock Watcher could use a cheaper model** — 412 turns this month, few
> tools, no errors; claude-haiku-5 would cost ≈ $31/month less on its own mix.
> **[Switch and watch it]** [Not now]

> **Budget Tracker's conversation is 310K tokens** — every call carries it.
> *Expected effect:* ≈ 60% fewer tokens per call. **[Compact it now]** [Set a cap]

Each item carries: the agent, the concern in a sentence, the **evidence**
(counts, dates, the scorecard's evidence level — "thin" is said), the
**expected effect** in dollars a month (or tokens when on a plan, said as an
equivalent), and one button that does it — through the same confirmed routes
the Hatchabot agent's cards use today, so the guard and the ledger see it.

### Ranking

By money at stake, then urgency:

1. A loop happening now (per-day burn).
2. A budget at 100% (paused or moved: what it costs to leave it so).
3. A spike today.
4. A budget past 80% before mid-month.
5. A switch that went worse (switch back).
6. A cheaper model (monthly saving), a big conversation (saving per call ×
   calls), a missing budget on an agent over ~$20/month.

**One cause, one item.** A loop item absorbs that agent's spike and the step
or budget lines it caused ("…which is also why it passed $200"). A rate limit
is one item for the source, not one per agent.

### What stays as it is

- **Budgets and "Tell me every $X" stay controls** (Usage tab, Budgets),
  with their messages. Your step alerts are information you asked for; they
  show in the list only as context on an item, never as a recommendation.
- **Pause and cheaper-model enforcement**: unchanged.
- **Cost badges**: unchanged (a glance, not advice).
- **The Hatchabot agent's weekly review** reads the same list and sends its
  digest from it; its cards become the list's items rather than a second
  inbox (an item it proposed says so).
- **Each check's thresholds and code** (`tokenHealth`, `modelScorecard`,
  `modelLedger`, `budgets`, `usageAlerts`) stay; the list is built from them.

### Alerts

Alerts keeps what needs you now: a loop, a budget at 100%, a spike today — as
one line each, linking to the item. The rest of the advice moves out of
Alerts into Recommended. Within an agent, Alerts lines are ordered by
severity, not code position.

### Messages

Unchanged in what triggers them; one shared rule added: about one cause, one
message a day (a loop's message covers its spike). The step and budget
messages you set keep coming.

## Questions for review

1. **Where:** Recommended at the top of **Usage** (proposed), or as its own
   view under **View by**, or under Alerts?
2. **Buttons:** act at once on your click (your click is the confirmation),
   or keep every change as a card you confirm, as now?
3. **Messages:** keep each feature's Telegram messages (with "one cause, one
   message a day"), or one morning summary of the list instead?
4. **Cheaper-model items:** offer them only when the evidence is "ok" (≥10
   turns over ≥3 days), or also when "thin", marked as such?
