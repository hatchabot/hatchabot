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
3. **Read every line.** It becomes a **public** issue, and it stays public.
   Hatchabot masks what it can recognize, but no automatic masking can make
   free text fully safe. You are the last check.

   Masked, in your edits too, shown as `{path}`, `{name}` and so on:
   - keys: a whole block (`{key}`), from `-----BEGIN …` to the last line with the
     same label or, when it is cut off, to the end of its base64, in a journal's or a
     quote's lines too. Only real PEM headers (`Proc-Type:`, `DEK-Info:`, `Comment:`)
     and lines that look like base64 by their mix of characters or their length count,
     so a line of words ends it. Also any long run of letters and digits or of base64
     (`***`);
   - settings named like a password, token or key, however short the value, quoted, escaped inside a string (`\"password\":\"…\"`) or written as a hash (`'password' => '…'`):
     `PASSWORD=…`, `DB_PASS=…`, `PASS: …`, `GARDEN_KEY=…`, `"apiKey": "…"`, the
     options `--password …` and `--token …`, curl's `-u` with a password, and
     `Cookie:` lines. A bare lowercase `pass` can be a test run's count, so
     `pass=12`, `pass=true`, `pass: ok` and `pass: word` stay; `pass=word`,
     `pass=1234` and `pass: x9` go;
   - a password after the bare word: `password hunter2` or `password 123456`, when
     it has a letter and a digit or is 4 digits or more. `password swordfish`
     can't be told from a sentence, so it stays. After a bare `token` or `api key`,
     only with a letter and a digit (`max token 4096` stays);
   - the code in an invite or reset link: `/?claim=…`, `/join/…`, `/v1/invites/…`;
   - file paths, in any script and however they are written, including `C:\…`,
     `\\nas\…`, `\\NAS`, `\\?\C:\…`, `\Users\…`, `\Device\…`, `C%3A%5C…`, `//nas/…`,
     `smb://…`, `s3://…`, `vscode://file/…`, `$HOME/…`, `$HOME\…`, `~\…`, `$PWD/…`,
     `$env:USERPROFILE\…`, `%APPDATA%\…`, `~other/…`, stuck to an option (`-v/srv/…`,
     `-v$PWD/…`), after `PWD=` and in a mount's unit name (`mnt-Smith.mount`):
     - your home folder shows as `~`, and anything in it as `~/{path}`, except
       dot-folders (`~/.docker/…`) with nothing that looks personal in them, and this
       app's folders;
     - this app's folders (`~/hatchabot/…`) stay while nothing in them looks
       personal: no capital in a folder's name, no word like `family` or `taxes`, no
       PDF or photo. Otherwise they show as `~/hatchabot/{path}`. The data and
       backup folders hold real data, so past one plain name or one of the app's own
       files they show as `~/hatchabot-data/{path}`;
     - in `~/.ssh`, only ssh's own names stay: `config`, `known_hosts`,
       `known_hosts.old`, `authorized_keys`, `environment`, `rc`, `id_rsa`, `id_ed25519`,
       `id_ecdsa` and `id_dsa`, with `.pub` on those four;
     - any other absolute path with two or more names shows as `{path}`;
     - a lone `/name` stays: it is more often a chat command than a folder;
     - these stay, because they name nothing of yours and a fix needs them: the
       system's own folders, named one by one (`/usr/lib`, `/var/run`, `/dev/null`,
       `/etc/docker`, but not `/etc/letsencrypt/…` or `/dev/disk/…`), API routes
       (`/v1/hosts`, `/v1.41/containers`), and a route pattern in quoted code
       (`'/join/:code'`). What follows the folder stays only when it is a name that
       folder is known to hold, or reads as code: no word like `family` or `taxes`, no
       PDF or photo, and in a folder of code no capital, except in a source file or
       inside a package's own folder (`node_modules`). Otherwise what is left of the
       folder stays and the rest goes: `/etc/ssl/certs/{path}`, `/usr/share/{path}`,
       `/usr/lib/smith/{path}`. Any `/home/` or `/Users/` inside such a path is masked
       from there: `/proc/1/root/{path}`;
     - a query's value that looks like a path or a file, on any address or route:
       `/v1/files?path={path}`, `?file={path}`;
     - `/app/`, `/tmp/` and `/home/node/` stay while nothing in them looks personal.
       In `/app/`, a file every project has (`README.md`) or a source file may have
       capitals;
   - IP addresses, public and private (`{ip}`, `{private-ip}`). Only `0.0.0.0`,
     netmasks and multicast addresses stay. Also a name with an address in it
     (`c-73-1-2-3.isp.example.net`), and MAC addresses;
   - Tailscale names, and `.local`, `.lan`, `.internal` and `.home.arpa` names,
     except a settings file's (`config.local`);
   - email addresses (also `name%40example.com`) and `user@host`. What follows an @
     that reads as a version or a release channel stays, as a package's or image's
     does: `name@1.2.3`, `name@2`, `name@sha256:…`, `name@latest`, `name@next`,
     `name@stable`, `name@edge`, and so a person written `sam@edge` stays too;
   - phone numbers in the usual shapes, and a chat app's user id: the ones Hatchabot
     knows, or a number straight after `telegram user`, `chat_id` or `user_id`;
   - `ssh://` and `tcp://` addresses, and the machine named in ssh's own errors;
   - your username and, in any case, the accounts' usernames of 3 letters or more:
     all of them when you own the machine, and only your own in a member's report, so
     a member can't test a name against the list. Only a username on a short list of
     very common words (will, may, max, page, mark and a few more) can't be told from
     the word. It goes as written when it has a capital, and otherwise wherever the
     line says it is a user, in any case: `USER=WILL`, `User will`, `author=will`,
     `uid=1000(will)`, `-l will`, `for will from`, `sudo: will :`, the owner and group
     in `ls -l`, `chown will:will`, `su - will`, `whoami: will`, `id will`. So
     "the user will see" loses a word on such a machine, and "it will fail" stays;
   - the names of your agents and your machines, with the user and host in each
     runner's address, from 3 letters. From 6 letters in any case, and shorter ones
     as written;
   - your members' names. A whole name of two words or more goes in any case and
     whatever its parts: `will page`, `ROSE BROWN`, `bo li`, `alma rocky`. The one
     exception is a default name, where no word says it is a person: a room or a device
     (`Living Room`, `Kitchen Laptop`) goes only as written, and one made only of generic
     words (`Telegram User`) not at all. Each part of 3 letters or more also goes alone,
     in any case: `Bob`, `bob`, `TAYLOR`. Only as written: a part that is really an
     everyday word, so "it will fail" and "a brown fox" stay while `Will` and `Brown` go.
     That covers names as well as rooms: `will`, `rose`, `jack`, `bill`, `page`, `max`,
     `mark`, `brown`, `fox`, `hall`, but never a name that only happens to be a word too
     (`bob`, `taylor`, `reed`). Also only as written: a one-word name of 2 letters. An
     email's domain and a number in a name are not masked: `in 2026 Alex` leaves the
     2026, though `Alex 2026` written together goes whole.

   Words that say nothing about whose it is are never treated as names on their own,
   even when a runner's user or host is one: `docker`, `ubuntu`, `git`, `server`,
   `node`, `runner`, `root`, `admin`, `telegram`, `gmail` and the like. So the `Key` of
   member Alicia Key stays when it stands alone.

   **Not masked. Look for these and edit them right there:**
   - a person, place or company Hatchabot has no record of, including an `@handle`;
   - a machine it has no record of, named in passing (`mybox`) or in a web address
     (`http://mybox:2375`, `mybox.example.org`). A web address and its path stay,
     unless the machine is one that is masked, however it is masked and with or
     without a port: `http://{name}:8080{path}`. A lone name after it stays;
   - a relative path (`Documents/taxes/x`);
   - the end of a path with spaces, when nothing later on its line looks like a path
     or a file. A space can't be told from the end of a path, and a leak is worse than
     a lost word, so a later word holding a `/` or ending like a file name (up to eleven
     words on, and that word) means all of it was the path, whatever the words between:
     `/srv/Letters to Jane Roe/a.pdf` goes whole, and so does a sentence that names
     a second path. `/srv/data could not be opened by lib/app.js` is just `{path}`. Only
     another path, an option, a setting's path or a `;` ends the look. With nothing like
     that on the line, up to six capitalized words go with the path, and a log word
     (`ERROR`), a label (`Status:`) or a common word in lowercase ends it, so the sentence
     after it stays: `/srv/smith family` leaves "family", `/srv/Insurance Denied` leaves
     "Denied";
   - a folder name that looks like an app's inside a dot-folder
     (`~/.config/smith/x`), `/tmp/` (`/tmp/smith/x`) or this app's folder, and a
     program's name or a lowercase folder in a system folder that holds code or
     system files (`/bin/smith`, `/usr/lib/smith/x`, `/etc/cron.d/smith`,
     `/v1/agents/smith/logs`);
   - a password in plain words, or under a name like `auth:` or `pin:`;
   - an agent's name or a username of 2 letters, a 2-letter part of a longer name
     when it stands alone (the `Li` of Li Wei), and a long number with no words around
     it saying what it is;
   - anything in a screenshot or file you attach yourself.
4. **Open on GitHub** opens the issue form, filled in, in a new tab. You
   press Submit there, with your own GitHub account. A report too long for a
   link is also saved as a file: drag it into the issue. Hatchabot cannot see
   whether you pressed Submit, so the report stays under Drafts, marked "opened
   on GitHub", until you discard it.

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
