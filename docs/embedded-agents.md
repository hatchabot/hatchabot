# Embedding a Hatchabot agent in other software

**Status: design (2026-10-06).** Built so far: Hatchabot's own version — Report a
problem, the manager's source tools, and its knowledge pack
(docs/field-reports.md, docs/troubleshooting.md, docs/architecture-map.md).
This document generalizes that to any tool, with **taxjson** (a local
command-line tax calculator) as the first case.

## What it is for

Software meets bugs and confusing settings on its users' machines. An agent
that ships with the software does two jobs there:

1. **Help the person running it:** explain settings and output, and walk them
   through the tool's own checks. Most "bugs" are settings or input.
2. **Turn a real bug into a report a fix can start from:** what happened, the
   version, a diagnosis citing file and line, a suggested patch, a reproduction.
   It is filed as an issue on the tool's repo; `/fix-field-report` in Claude
   Code works through it on the developer's side.

What it has over a fresh Claude Code session on the user's side:

- **Nothing to set up.** Most users have no Claude Code, and no idea where to
  point it.
- **Knowledge that would take a fresh session hours to rebuild:** the pack below.
- **Live state through narrow, read-only tools**, with masking, instead of a
  full shell.
- **Memory of that machine's earlier problems.**
- **Fixes reach users only through releases.** It never edits the installed
  copy.

## The one principle: the pack belongs to the tool, the host is interchangeable

```
  taxjson repo                                   hosts that can run it
  ┌──────────────────────────────┐
  │ agent/                       │      ┌─ Hatchabot: an always-on agent, phone access,
  │   agent.toml   (manifest)    │──────┤   memory, Report a problem, the feedback loop
  │   AGENT.md     (instructions)│      │
  │   knowledge/   (the pack)    │      ├─ Claude Code / Claude Desktop / any MCP client:
  │   (optional) MCP server      │      │   `tjs agent serve` (also covers Windows,
  └──────────────────────────────┘      │   where Hatchabot does not run)
       versioned with each release      └─ any assistant: `tjs agent context` prints
                                            the instructions + pack index to paste in
```

The tool's author writes **one pack**. It works with Hatchabot for people who
run Hatchabot, and without it for everyone else. Most taxjson users will never
install Hatchabot (it needs Docker; taxjson needs only Python, and runs on
Windows), so the second path matters as much as the first.

## The pack

Everything lives in `agent/` in the tool's repo and ships in each release.
Because it is versioned with the code, the agent always describes the version
it is installed beside.

### `agent/agent.toml` — the manifest

```toml
schema = "hatchabot-agent-pack/1"

[agent]
tool = "taxjson"
name = "taxjson helper"
instructions = "AGENT.md"            # persona and rules, always loaded
knowledge = "knowledge/"             # the pack, searched on demand
version = ["tjs", "--version"]       # how a host learns the installed version
reports = "github:taxjson/taxjson"   # where Report a problem files issues
docs = ["README.md", "docs/", "KNOWN_ISSUES.md", "REFERENCES.md"]  # also readable, read-only

[privacy]
# What may reach a CLOUD model: "none" (versions, errors, settings),
# "summary" (counts, warnings, what is missing; no amounts or account numbers),
# "full" (the person's transactions). See "Privacy" below.
cloud = "summary"
full = "local-model-or-consent"
# Extra masks for reports, beyond the host's own (keys, paths, addresses, names).
mask = [
  { pattern = '\b\d{5,12}\b', as = "<number>" },            # account and slip numbers
  { pattern = '\$?-?\d[\d,]*\.\d{2}\b', as = "<amount>" },  # money
]

# Tools: commands the host may run, with nothing else. {project} is the folder
# the person chose. Each declares its data tier; the host enforces it.
[[tools]]
name = "checklist"
run = ["tjs", "checklist", "--json"]
cwd = "{project}"
tier = "summary"
about = "Where this year's filing stands: each step, done or not, and why."

[[tools]]
name = "find_missing_history"
run = ["tjs", "find-missing-history", "--json"]
cwd = "{project}"
tier = "summary"
about = "Sales with no purchase found: which symbols, which accounts, since when."

[[tools]]
name = "explain"
run = ["tjs", "explain", "{symbol}"]
args = { symbol = '^[A-Z0-9.:-]{1,15}$' }
cwd = "{project}"
tier = "full"
about = "How one symbol's gains were computed, lot by lot."

[[tools]]
name = "synthetic_repro"
run = ["tjs", "redact", "--synthetic", "--symbol", "{symbol}", "--out", "{tmp}"]
args = { symbol = '^[A-Z0-9.:-]{1,15}$' }
cwd = "{project}"
tier = "summary"
about = "A made-up CSV that reproduces the same pattern, for a bug report."
```

Rules a host enforces:

- **Only declared commands run.** They run with arguments checked against
  their patterns, in the declared folder, with a time limit and an output cap.
- **No shell.**
- **The tier gate comes before the model sees output.** A `full` tool's output
  never goes to a cloud model unless the person said yes for that question.

### `agent/AGENT.md` — the instructions

Short, always in context:
- what the tool is for;
- the person's likely situation ("filing for a year");
- the order to diagnose in ("checklist first; then sanity; then the
  playbook");
- what it must never do: give tax advice, put the person's numbers in a
  report, or edit their input files.

For Hatchabot this lives in `src/ops/opsAgent.ts`. A pack carries it as a file.

### `agent/knowledge/` — the pack

The same shape as Hatchabot's own:

| File | What | taxjson's source for it |
|---|---|---|
| `overview.md` | The mental model: the pipeline, the files, the words | README, docs/getting-started.md |
| `troubleshooting.md` | Each entry gives the symptom, how to check, the cause, the fix, the release that fixed it, and the code | **KNOWN_ISSUES.md is already most of this**: each entry has Where / Current behavior / Why deferred / Workaround |
| `architecture-map.md` | Where each feature's code is | `src/taxjson/bin/*` (one file per command), `lib/brokerages/*` |
| `domain.md` | The rules the tool implements, with citations (ACB, s.40(2)(g), §1091, T1135, holding periods) | REFERENCES.md, the rule docstrings |
| `settings.md` | Every `taxjson.toml` key: meaning, default, when to change it | the config parser and docs |
| `faq.md` | The questions people actually ask, answered | issues, field reports |

**Checked in the tool's CI**, as Hatchabot's are (test/knowledgePack.test.ts):
- every file and function the pack names still exists;
- every "fixed in" version is a real release;
- the pack contains no personal data.

A stale pack sends the agent the wrong way, so it fails the build.

**How it grows:** when `/fix-field-report` lands a fix, it adds the
symptom → fix entry with "fixed in" set to the next release. The next release
ships the knowledge to every install, so each problem solved once is solved
everywhere. A Claude Code session on the user's side never gets that.

## Loading the pack

### In Hatchabot: `hatchabot attach`

```
hatchabot attach taxjson --project ~/taxes/2025
```

1. **Find the pack.** It is read from the installed tool, for example
   `$(tjs agent path)`, or from a repo URL. The manifest is validated against
   the schema.
2. **Make or reuse the agent.** It gets its own agent ("taxjson helper"), or
   the pack joins an existing one (the manager, for a household with one
   agent).
3. **Load the instructions.** `AGENT.md` becomes a managed section of the
   agent's AGENTS.md. This is the mechanism the manager's notes use
   (`OPS_MANAGED_HEADINGS`): replaced on each sync, never duplicated.
4. **Load the knowledge.** `knowledge/` is copied read-only into the agent's
   workspace under `memory/packs/taxjson/`, where the agent's memory search
   indexes it. Only the overview and the playbook's index go into context; the
   rest is found by search when a question needs it.
5. **Wire the tools.** Each declared tool becomes one tool on a project door,
   the same pattern as the manager's ops door: the agent asks, the door checks,
   runs on the host and masks. The project folder is mounted read-only. Tier
   `full` asks the person the first time in a conversation, unless the
   agent's AI source is a local model.
6. **Keep it current.** The pack records the tool's version. When `version`
   reports a new one (checked daily, and at each rebuild), the pack is synced
   again. "Fixed in" entries compare against the installed version, so the
   answer to an old bug is "upgrade to vX".
7. **Point reports at the tool.** Report a problem from this agent files on
   `reports`, with the marker `<!-- agent-report v1 tool=taxjson version=… -->`,
   the host's masks plus the manifest's, and the tool's facts (`version`,
   `checklist` summary), never Hatchabot's.

### Without Hatchabot

- **`tjs agent context`** prints `AGENT.md` and an index of the pack. Pasted
  into Claude Code or any assistant, or saved as CLAUDE.md, it gives that
  assistant the head start. It can then read the knowledge files directly,
  since they are on disk with the install.
- **`tjs agent serve`** is an MCP server over stdio, exposing:
  - the knowledge files as resources;
  - the declared tools, with the same tiers;
  - a `report_problem` prompt.

  Claude Code and Claude Desktop connect to it on Linux, macOS and Windows. A
  small Python module that reads `agent.toml` covers it, about a few hundred
  lines.

## Privacy, for a tool like taxjson

taxjson's promise is that transaction data never leaves the computer. An agent
must not quietly break that:

- **Tiers.** `none` and `summary` are what a cloud model sees by default:
  versions, errors, settings, counts, which steps are not done, which symbols
  lack history. `full` (amounts, lots, the person's rows) needs one of two
  things:
  - a **local model** (Hatchabot's local AI source, Ollama), so nothing
    leaves the machine;
  - or the person's **explicit yes** for that question, with the tool's output
    shown first.
- **Reports never carry data.** A bug that depends on the person's rows is
  reproduced with `synthetic_repro`: a made-up CSV with the same pattern.
  taxjson already has `taxjson_redact.py` and demo CSVs per broker to build
  on. The person reviews the report as in Hatchabot's Report a problem.
- **No tax advice.** The agent explains what the tool computed and why, with
  citations from the pack. It does not say what to file.

## What each side builds

**taxjson** (mostly writing; the knowledge already exists in another shape):
1. `agent/agent.toml`, `agent/AGENT.md`, and `agent/knowledge/`, derived from
   README, getting-started, KNOWN_ISSUES and REFERENCES.
2. `--json` on the commands the manifest declares, where they lack it. Several
   commands already have it, and `checklist` reads sub-commands' JSON
   internally.
3. `tjs redact --synthetic` (or similar) for reproductions.
4. A CI test for the pack, the Python twin of test/knowledgePack.test.ts.
5. `tjs agent context` and `tjs agent path`, then later `tjs agent serve`
   (MCP).
6. The label workflow and `/fix-field-report`, copied from Hatchabot.

**Hatchabot:**
1. The pack schema (`hatchabot-agent-pack/1`) and a validator.
2. `hatchabot attach` and its app button.
3. The project door:
   - declared commands only, argument patterns, folder, time limit and output
     cap;
   - the tier gate, plus consent cards for `full`;
   - masking.
4. Pack sync on the tool's version change.
5. Report a problem per tool: target repo, marker, the manifest's masks.
6. Its own pack in the same layout (today: docs/troubleshooting.md and
   docs/architecture-map.md), so Hatchabot is the reference pack.

## Order of work, and how to know it helps

1. **Hatchabot's own pack (done in v2.136.0).** Measure it before building
   more. Take 10–15 real support questions from the incidents behind the
   playbook and ask them three ways:
   - a fresh Claude Code session with no pack;
   - the same session with the pack;
   - the Hatchabot agent.

   For each, record whether the answer was right, how many steps it took, its
   tokens and its time. If the pack does not clearly win, fix the pack before
   building hosts.
2. **taxjson's pack plus `tjs agent context`.** This needs no Hatchabot work,
   helps every taxjson user who has any assistant, and gets the same eval on
   taxjson questions.
3. **`hatchabot attach` and the project door,** for people who run both.
4. **`tjs agent serve` (MCP),** once the tools and tiers have settled.

## Decisions for the owner

- **taxjson's default:** may a cloud model see `summary` data (counts, symbols
  lacking history, steps not done), with `full` only on consent or a local
  model? The alternative is `none` by default.
- **The manifest in TOML,** which matches `taxjson.toml`. JSON would be easier
  for Hatchabot to read, and TOML easier for Python tool authors to write.
- **Which first:** the Claude Code path (`tjs agent context`, reaches every
  taxjson user) or `hatchabot attach` (the full experience, for Hatchabot
  users).
