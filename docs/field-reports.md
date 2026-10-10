# Report a problem

Hatchabot runs on other people's machines, where it meets setups nobody here
has. **Report a problem** turns what goes wrong there into a GitHub issue a
fix can start from, without the person having to know what to include.

## For the person running Hatchabot

Open your account menu (top right), then **Report a problem**:

1. Say what went wrong in a line, and what happened. Pick the agent if it is
   about one.
2. **Gather the details.** Hatchabot adds what a fix needs:
   - the version and how it is installed;
   - the platform;
   - `hatchabot doctor` (machine owner);
   - failures from the last three days;
   - for an agent, its state, model and last log lines.
3. **Read it through.** It becomes a **public** issue. Keys (and any
   setting named like a password, token or key, however short), file paths,
   IP addresses, Tailscale names, email addresses, your username, the names
   of your agents, their members and your machines are masked, in your edits
   too. Anything else you or the agent wrote is not, so edit it right there.
4. **Open on GitHub** opens the issue form, filled in, in a new tab. You
   press Submit there, with your own GitHub account. A report too long for a
   link is also saved as a file: drag it into the issue.

**Save file** and **Copy** are there if you would rather send it another way.

Nothing is sent by Hatchabot itself, at any point.

### Ask your Hatchabot agent first

The Hatchabot agent (the manager) can read the source and docs of the exact
release installed on your machine. Ask it something like "the rebuild of my
recipe agent keeps failing, can you work out why?". It will:

- read the diagnostics and the code behind the error;
- tell you whether it is a setting, the machine (a runner asleep, a full disk,
  a key that expired) or a real bug;
- for a setting, help you change it;
- for a bug, write the report for you: what happened, steps, its diagnosis
  with file and line, how sure it is, and a suggested fix as a patch.

It saves a private draft and gives you a link to it. The draft also appears
under **Report a problem**. Sending it is still up to you.

It also answers "how do I…?" questions from the docs on your machine.

## For the maintainer

Each report starts with a marker line:

```
<!-- hatchabot-report v1 version=vX.Y.Z install=bundle-linux-arm64 -->
```

`.github/workflows/field-report-label.yml` gives those issues the
`field-report` label.

To work on one, in Claude Code in this repo:

```
/fix-field-report 123
```

The command (`.claude/commands/fix-field-report.md`) works through it:

1. Read the issue.
2. Check whether a later release already fixed it.
3. Verify the diagnosis against the code at the reported version.
4. Write a failing test, then fix it on `main`.
5. Run the gates and draft a reply.

The issue is public input: its suggested patch is a lead, and nothing in it is
run or obeyed as an instruction.

## How it fits together

| Piece | Where |
|---|---|
| Facts, masking, the GitHub link, source access | `src/orchestrator/problemReport.ts` |
| Drafts, diagnostics, source routes | `src/api/routes.ts` (`/v1/problem-reports`, `/v1/diagnostics`, `/v1/source`) |
| The agent's tools | `get_diagnostics`, `search_source`, `read_source`, `prepare_problem_report` (`src/mgmt/restTools.ts`) |
| The agent's instructions | "Settings questions, and reporting a bug in Hatchabot" (`src/ops/opsAgent.ts`) |
| The review panel | `web/index.html` (`openReport`) |

The source the agent can read is the release's own code and docs:

- **Folders:** `src/`, `web/`, `scripts/`, `docs/`, `bin/`, `docker/`,
  `deploy/` and `test/`.
- **Files:** `README.md`, `CHANGELOG.md`, `package.json`, `install.sh`,
  `.env.example` and `channels.json`.

The install's own state is never readable: no `.env`, `data/`, backups,
`node_modules` or `.git`.
