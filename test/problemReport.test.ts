import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { boundInput, buildReport, endpointIdentity, issueUrl, knownProblems, matchKnownProblems, newerRelease, readSource, redactForPublic, searchSource, searchesRunning, sourcePath, type ReportFacts } from '../src/orchestrator/problemReport.js';

/**
 * "Report a problem" (docs/field-reports.md): a public GitHub issue made from
 * a home machine — what it masks, what it carries, how the link is cut when it
 * is too long, and what of the install the agent may read. Made-up data only.
 */
const ctx = { home: '/home/pat', user: 'pat', host: 'kitchen-box' };

describe('redactForPublic', () => {
  it('masks what makes a home machine identifiable, and secrets', () => {
    const out = redactForPublic([
      'open /home/pat/hatchabot/data/x.sqlite failed',
      'ssh://pat@laptop.example.org refused',
      'runner laptop.example-tail.ts.net at 192.168.1.40 and 100.88.1.2, gateway 10.0.0.1',
      'user pat on kitchen-box',
      'mail sam@example.org',
      'key sk-abcdefghijklmnopqrstuvwxyz',
    ].join('\n'), ctx);
    expect(out).not.toMatch(/\/home\/pat|pat@|kitchen-box|192\.168|100\.88|10\.0\.0\.1|sam@example|sk-abc|\.ts\.net/);
    expect(out).toContain('~/hatchabot/data/x.sqlite');
    expect(out).toContain('{private-ip}');
    expect(out).toContain('{user} on {host}');
  });

  it('masks a Telegram bot username, but not Hatchabot; a timestamp is not an address', () => {
    expect(redactForPublic('[telegram] [kitchenhelperbot] starting provider (@KitchenHelperBot) for Hatchabot', ctx)).toBe('[telegram] [{bot}] starting provider ({bot}) for Hatchabot');
    expect(redactForPublic('2026-10-01T00:23:10.123+00:00 ok; peer 10.1.2.3', ctx)).toBe('2026-10-01T00:23:10.123+00:00 ok; peer {private-ip}');
  });

  it('masks private IPv6 addresses as it does private IPv4 ones; times, public addresses and code stay (#211)', () => {
    const out = redactForPublic([
      'runner at fd00:1234::5 and http://[fd7a:115c:a1e0::12]:8091/health',
      'link fe80::1c2b:3dff:fe4e:5f60%eth0, loopback ::1, mapped ::ffff:192.168.1.40',
      'full fd12:3456:789a:0001:0000:0000:0000:0005.',
    ].join('\n'), {});
    expect(out).not.toMatch(/fd00|fd7a|fe80|::1\b|::ffff|192\.168|fd12/);
    expect(out).toBe('runner at {private-ip} and http://[{private-ip}]:8091/health\nlink {private-ip}, loopback {private-ip}, mapped {private-ip}\nfull {private-ip}.');
    const keep = 'at 10:00:00 and 2026-10-01T00:23:10.123+00:00; std::vector, a::b::c, a :: b; listening on 0.0.0.0:80, mask 255.255.255.0';
    expect(redactForPublic(keep, {})).toBe(keep);
  });

  it('masks a mapped private address written in hex as it does the dotted one (audit, 2026-10-22)', () => {
    expect(redactForPublic('peer ::ffff:a00:7 and 0:0:0:0:0:ffff:c0a8:128 up', {})).toBe('peer {private-ip} and {private-ip} up');
    expect(redactForPublic('public ::ffff:8c52:7003', {})).toBe('public {ip}');
  });

  it('masks a private address however its zeros are written (HB-0365)', () => {
    for (const a of ['0:0::ffff:c0a8:0102', '0::FFFF:192.168.1.2', '0000:0:0:0::ffff:a00:7', '0:0:0:0:0:ffff:10.0.0.7', '0:0:0:0:0:0:0:1', '0::1', 'fd7a:0:0::5']) {
      expect(redactForPublic(`peer ${a} up`, {}), a).toBe('peer {private-ip} up');
    }
    for (const a of ['0:0::ffff:8c52:7003', '0::ffff:140.82.112.3', '2001:db8:0::ffff:c0a8:102', '::ffff:0:c0a8:102']) {
      expect(redactForPublic(`peer ${a} up`, {}), a).toBe('peer {ip} up');
    }
  });

  it('masks public addresses too, and leaves an image, a version and ordinary words alone (HB-0405)', () => {
    expect(redactForPublic('pulled ghcr.io/hatchabot/runtime:2026.9.6 from 140.82.112.3; patience', ctx)).toBe('pulled ghcr.io/hatchabot/runtime:2026.9.6 from {ip}; patience');
    expect(redactForPublic('public address 203.0.113.7 and 2001:db8::7, Chromium 119.0.6045.105, OpenClaw 2026.9.6', ctx)).toBe('public address {ip} and {ip}, Chromium 119.0.6045.105, OpenClaw 2026.9.6');
  });

  // Each of these went into a public issue as written, under a panel saying they were masked.
  describe('what the panel promises (HB-0405)', () => {
    const c = { ...ctx, hosts: ['studio-laptop', 'studio-laptop.example.org'], users: ['someone'] };
    it("masks a runner's user and host, in docker's and ssh's own words", () => {
      expect(redactForPublic('docker -H ssh://someone@studio-laptop stop x', c)).toBe('docker -H ssh://{user}@{host} stop x');
      expect(redactForPublic('ssh: connect to host studio-laptop port 22: refused', c)).toBe('ssh: connect to host {host} port 22: refused');
      expect(redactForPublic('tcp://studio-laptop:2376 is down', c)).toBe('tcp://{host}:2376 is down');
      expect(redactForPublic('someone is in the wrong group', c)).toBe('{user} is in the wrong group');
    });
    it('masks a machine this app has no record of, by its shape', () => {
      expect(redactForPublic('docker -H ssh://sam@old-nas stop x', ctx)).toBe('docker -H ssh://{user}@{host} stop x');
      expect(redactForPublic('sam@old-nas: Permission denied', ctx)).toBe('{user}@{host}: Permission denied');
      expect(redactForPublic('ssh: Could not resolve hostname old-nas: nope', ctx)).toBe('ssh: Could not resolve hostname {host}: nope');
      expect(redactForPublic('ssh: connect to host old-nas port 22', ctx)).toBe('ssh: connect to host {host} port 22');
      expect(redactForPublic('ssh://[fd7a:115c::1]:22 and tcp://old-nas:2376', ctx)).toBe('ssh://{host}:22 and tcp://{host}:2376');
      expect(redactForPublic('ping old-nas.local and old-nas.lan', ctx)).toBe('ping {host} and {host}');
    });
    it('a package and its version is not a user at a host', () => {
      expect(redactForPublic('npm i openclaw@latest @types/node', ctx)).toBe('npm i openclaw@latest @types/node');
    });
    it('masks every absolute path outside the system folders', () => {
      expect(redactForPublic('open /srv/family-name/hatchabot/data/hatchabot.sqlite failed', ctx)).toBe('open {path} failed');
      expect(redactForPublic('/home/someone/.ssh/config and /Users/someone/x', ctx)).toBe('{path} and {path}');
      expect(redactForPublic('-v /srv/a/b:/mnt/c/d, HOME=/data/e/f, "/srv/g/h"', ctx)).toBe('-v {path}:{path}, HOME={path}, "{path}"');
      expect(redactForPublic('file:///srv/a/b and unix:///home/pat/.docker/run/docker.sock', ctx)).toBe('file://{path} and unix://{path}');
      expect(redactForPublic('in /srv/Family Name/hatchabot and /srv/Family\\ Name/x, then', ctx)).toBe('in {path} and {path}, then');
      expect(redactForPublic("'/srv/Family Name.txt'", ctx)).toBe("'{path}'");
    });
    it('a longer name beginning with the home folder is not inside it', () => {
      expect(redactForPublic('/home/patricia/x and /mnt/home/pat/x', ctx)).toBe('{path} and {path}');
    });
    it('inside home, only this app and the dot-folders are named', () => {
      expect(redactForPublic('/home/pat/hatchabot-data/x, /home/pat/.ssh/config, /home/pat/Documents/family-name/y, ~/Taxes', ctx))
        .toBe('~/hatchabot-data/x, ~/.ssh/config, ~/{path}, ~/{path}');
    });
    it('keeps what a fix needs and says nothing about the person', () => {
      const keep = [
        'at /usr/lib/node_modules/openclaw/dist/x.js:12:3', '--- /dev/null', 'dial unix /var/run/docker.sock', 'POST /v1/hosts/abc',
        'Please run /login', 'see docs/backups.md, ./scripts/x.sh, ../a/b', '--- a/src/x.ts', 'https://github.com/hatchabot/hatchabot/issues/1',
        'and/or TCP/IP', 'a / b / c', '.replace(/\\/+$/, "")', 'ghcr.io/hatchabot/runtime:2026.9.6',
      ].join('\n');
      expect(redactForPublic(keep, ctx)).toBe(keep);
    });
    it('masks a path whole, in any script and past any punctuation: the rest of it went public', () => {
      for (const p of ['/srv/Иванов/семья/taxes.pdf', '/mnt/nas/写真/家族', '/srv/Müller/Familie/taxes.pdf', '/Users/Pat Smith Jr/Docs/x', "/Volumes/Pat's Passport/Backups/x", "/srv/o'brien/taxes/x", '/srv/smith,jones/x/y', '/srv/smith&jones/x/y', '/Volumes/My Passport Drive/Backups/x', '/srv/St. Mary/x', '/srv/Smith (2025)/x', '/srv/Pat’s Stuff/x', '/srv/Tax - 2025/x', '/srv/Pat & Sam/x', '/srv/😀 Photos/x', '/😀/x', '/srv/a«b»/c', '/srv/a\\b/c', '/srv/Smith Family Trust Tax Records For The Year/2025/x', '/srv/a/b.c’d/e']) {
        expect(redactForPublic(`open ${p}`, ctx), p).toBe('open {path}');
      }
      expect(redactForPublic('file:///srv/My Folder/x', ctx)).toBe('file://{path}');
      expect(redactForPublic('/home/pat/Smith Family/taxes/2025.pdf', ctx)).toBe('~/{path}');
      expect(redactForPublic('/home/pat/Tax Return Smith.pdf', ctx)).toBe('~/{path}');
      expect(redactForPublic('~/Family Photos/x/y and ~/Müller/x', ctx)).toBe('~/{path} and ~/{path}');
    });
    it('masks paths in the other ways they are written', () => {
      for (const p of ['//nas/photos/pat', '\\\\nas\\photos\\pat', 'C:\\Users\\Pat\\Documents\\taxes.pdf', 'C:\\Users\\Pat Smith\\My Documents\\x.pdf', 'D:/Family/x', '~other/Documents/x']) {
        expect(redactForPublic(`see ${p}`, ctx), p).toBe('see {path}');
      }
      expect(redactForPublic('$HOME/Documents/Smith-Taxes/x and ${HOME}/Taxes', ctx)).toBe('$HOME/{path} and ${HOME}/{path}');
      expect(redactForPublic('%USERPROFILE%\\Documents\\x', ctx)).toBe('%USERPROFILE%\\{path}');
      expect(redactForPublic('smb://nas/My Photos/pat x/y', ctx)).toBe('smb://{path}');
      expect(redactForPublic('?path=%2Fsrv%2FSmith%20Family%2Fx&y=1', ctx)).toBe('?path={path}&y=1');
      expect(redactForPublic('"~/Family Photos/a b.pdf" and \'/srv/smith/x y.txt\'', ctx)).toBe('"~/{path}" and \'{path}\'');
    });
    it('what comes after a space in a path: more path is masked, a sentence stays', () => {
      expect(redactForPublic('open /srv/a/b failed to read', ctx)).toBe('open {path} failed to read');
      expect(redactForPublic('/srv/a/b: no such file', ctx)).toBe('{path}: no such file');
      expect(redactForPublic('/srv/a/b, see the log', ctx)).toBe('{path}, see the log');
      expect(redactForPublic('the end of /srv/a/bb. Next sentence', ctx)).toBe('the end of {path}. Next sentence');
      expect(redactForPublic('/srv/Smith Family failed', ctx)).toBe('{path} failed');
      expect(redactForPublic('“/srv/a/b” failed…', ctx)).toBe('“{path}” failed…');
      // More words than that, and a word in lowercase with nothing path-like after it, can't be told from a sentence.
      expect(redactForPublic('/srv/smith family failed', ctx)).toBe('{path} family failed');
    });
    it('a system folder keeps only what names nothing of the person\'s', () => {
      for (const p of ['/etc/letsencrypt/live/smith-family.example.org/fullchain.pem', '/etc/wireguard/pat-phone.conf', '/etc/nginx/sites-enabled/smith.conf', '/dev/disk/by-label/SMITH-BACKUP', '/dev/mapper/smith-root', '/usr/lib/../../srv/Smith/x', '/tmp/../srv/smith/x', '/usr/local/share/smith-family/x', '/var/lib/docker/volumes/smith_data/_data/x', '/Library/Application Support/Smith/x']) {
        expect(redactForPublic(`see ${p}`, ctx), p).toBe('see {path}');
      }
      const keep = ['/etc/hosts', '/etc/ssh/sshd_config', '/etc/docker/daemon.json', '/etc/systemd/system/hatchabot.service', '/dev/sda1', '/dev/shm/x', '/usr/local/bin/node', '/usr/lib/x.js failed in y/z', '/var/lib/docker/overlay2/ab/merged', '/run/user/1000/docker.sock', '/Applications/Docker.app/Contents/x'].join('\n');
      expect(redactForPublic(keep, ctx)).toBe(keep);
    });
    it('inside home, only the real app folders and dot-folders with nothing personal in them are named', () => {
      for (const p of ['~/.local/share/Trash/files/Smith Taxes.pdf', '~/hatchabot-smith-family/x/y', '~/hatchabotsmith/x', '~/.config/Smith/x', '~/.config/smith family/x', '~/.Trash/x', '~/.cache/family-photos/x']) {
        expect(redactForPublic(`see ${p}`, ctx), p).toBe('see ~/{path}');
      }
      expect(redactForPublic('see ~/.ssh/pat-at-work.pem', { home: '/home/x' })).toBe('see ~/{path}');
      const keep = ['~/.ssh/config is missing', '~/.ssh/id_ed25519.pub', '~/.ssh/known_hosts:12', '~/.docker/run/docker.sock', '~/.npm/_logs/2026-x.log', '~/hatchabot/docs/README.md', '~/hatchabot-data/x', '~/hatchabot-prod/x'].join('\n');
      expect(redactForPublic(keep, ctx)).toBe(keep);
    });
    it('container paths a fix needs stay, while nothing in them looks personal (finding 5)', () => {
      const keep = ['/home/node/.openclaw/openclaw.json: invalid', '/app/dist/index.js:12:3', '/app/README.md', '/tmp/a/b', '/tmp/hb-xyz/seed.sh: not found'].join('\n');
      expect(redactForPublic(keep, ctx)).toBe(keep);
      for (const p of ['/tmp/Smith/x', '/tmp/smith-family/x', '/tmp/Иванов/x', '/app/Иванов/x', '/home/node/Smith Taxes/x', '/home/node/.openclaw/workspace/tax-2025/x']) {
        expect(redactForPublic(`see ${p}`, ctx), p).toBe('see {path}');
      }
    });
    it('a route pattern in code is not a file path; a real path in the same quotes is', () => {
      const code = "app.get('/join/:code', h); app.post(\"/a/:id/b\", h); fetch(`/join/${code}`); fetch(`/v1/hosts/${id}`);";
      expect(redactForPublic(code, ctx)).toBe(code);
      expect(redactForPublic("read('/srv/Smith/:x')", ctx)).toBe("read('{path}')");
      expect(redactForPublic("read('/join/abc')", ctx)).toBe("read('{path}')");
      expect(redactForPublic('curl /join/:code', ctx)).toBe('curl {path}');
    });
    it("masks the machine in ssh's own errors, whatever the wording (finding 2)", () => {
      for (const [m, want] of [
        ["Warning: Permanently added 'mybox' (ED25519) to the list of known hosts.", "Warning: Permanently added '{host}' (ED25519) to the list of known hosts."],
        ["Warning: Permanently added '[mybox]:2222,203.0.113.9' (ED25519).", "Warning: Permanently added '{host}' (ED25519)."],
        ['Connection closed by mybox port 22', 'Connection closed by {host} port 22'],
        ['Connection reset by mybox port 22', 'Connection reset by {host} port 22'],
        ['Connection closed by authenticating user sam mybox port 22', 'Connection closed by authenticating user {user} {host} port 22'],
        ['Connection to mybox closed.', 'Connection to {host} closed.'],
        ['Connection to mybox port 22 timed out', 'Connection to {host} port 22 timed out'],
        ['Host key for mybox has changed', 'Host key for {host} has changed'],
        ["The authenticity of host 'mybox (203.0.113.9)' can't be established.", "The authenticity of host '{host}' can't be established."],
        ['Unable to negotiate with mybox port 22: no matching', 'Unable to negotiate with {host} port 22: no matching'],
        ['Received disconnect from mybox port 22:11: bye', 'Received disconnect from {host} port 22:11: bye'],
        ['Timeout, server mybox not responding.', 'Timeout, server {host} not responding.'],
        ['Connection closed by 203.0.113.9 port 22', 'Connection closed by {ip} port 22'],
      ]) expect(redactForPublic(m!, ctx), m).toBe(want);
      for (const m of ['Connection closed by remote host', 'Connection reset by peer', 'Connection refused', 'Host key verification failed.', 'Connection timed out']) {
        expect(redactForPublic(m, ctx), m).toBe(m);
      }
    });
    it('masks a folder on a machine that is masked; a route or a lone name after it stays', () => {
      expect(redactForPublic('http://mybox.local/Family/Taxes/x and http://10.0.0.5/Family/Taxes', ctx)).toBe('http://{host}{path} and http://{private-ip}{path}');
      expect(redactForPublic('https://old-nas.lan/v1/hosts/abc and http://10.0.0.5:8091/health and 10.0.0.5/24', ctx)).toBe('https://{host}/v1/hosts/abc and http://{private-ip}:8091/health and {private-ip}/24');
    });
    it("masks the machine behind a URL's password, and a folder on it", () => {
      expect(redactForPublic('ssh://pat:fakepw@mybox:22/x', {})).toBe('ssh://***:***@{host}:22/x');
      expect(redactForPublic('http://pat:fakepw@mybox:2375/_ping', {})).toBe('http://***:***@{host}:2375/_ping');
      expect(redactForPublic('ssh://mybox/srv/smith/x and tcp://mybox:2376/a/b', {})).toBe('ssh://{host}{path} and tcp://{host}:2376{path}');
      expect(redactForPublic('Cannot connect at ssh://mybox. Is it running?', {})).toBe('Cannot connect at ssh://{host}. Is it running?');
    });
    it('masks an email in any script, and URL-encoded (finding 3)', () => {
      expect(redactForPublic('?login_hint=pat%40example.com&x=1', {})).toBe('?login_hint={email}&x=1');
      for (const a of ['josé@example.com', 'müller@example.com', 'PAT@EXAMPLE.COM', 'sam.doe+x@example.org', 'pat@exämple.de']) {
        expect(redactForPublic(`mail ${a}.`, {}), a).toBe('mail {email}.');
      }
      expect(redactForPublic('Sam <sam@example.org>', {})).toBe('Sam <{email}>');
      expect(redactForPublic('pat@10.0.0.5 and pat@1box', {})).toBe('{email} and {user}@{host}');
    });
    it('an @ before a version or a digest is not an address (finding 5)', () => {
      for (const k of ['npm ERR! openclaw@2026.9.8 postinstall', 'runtime@sha256:abc123', 'npm i openclaw@latest @types/node @scope/pkg@1.2.3', 'node@22', 'x@1.2.3-beta.1', 'x@v2', 'x@next', 'x@^1.2.3', '@ts-ignore']) {
        expect(redactForPublic(k, {}), k).toBe(k);
      }
    });
    it('masks a name carrying a public address, a MAC address and a phone number (finding 3)', () => {
      for (const n of ['c-73-1-2-3.hsd1.ca.example.net', 'ec2-203-0-113-5.compute-1.amazonaws.com', '203-0-113-5.isp.example.net', '203.0.113.5.nip.io', 'ip-172-31-5-7', 'MYBOX.EXAMPLE.TS.NET', 'mybox.LOCAL', 'mybox.home.arpa', 'mybox.internal']) {
        expect(redactForPublic(`from ${n}.`, {}), n).toMatch(/^from \{(host|tailnet-host)\}\.$/);
      }
      for (const k of ['host.docker.internal', 'settings.local.json', '.env.local', 'file-1-2-3-4.js', 'foo-1-2-3-4.tar.gz', 'github.com', 'node-22.1.0.tar.gz']) expect(redactForPublic(k, {}), k).toBe(k);
      expect(redactForPublic('mac aa:bb:cc:dd:ee:ff and AA-BB-CC-DD-EE-FF up', {})).toBe('mac {mac} and {mac} up');
      expect(redactForPublic('call +1 555 867 5309, +15558675309, (555) 867-5309 or 555-867-5309.', {})).toBe('call {phone}, {phone}, {phone} or {phone}.');
      expect(redactForPublic(`telegram user 1234567890, ${['chat', 'id'].join('_')}=${7 * 1000003}, "user_id": 7654321`, {})).toBe('telegram user {id}, chat_id={id}, "user_id": {id}');
      const keep = '2026-10-01T00:23:10.123+00:00 at 1.2.3+20261101; took 1234567890 ms; +2026-11-05 added; @@ -1,3 +1,4 @@; port 8080, 10:00:00, sha ab:cd';
      expect(redactForPublic(keep, {})).toBe(keep);
    });
    it('a username is masked in any case, wherever it comes from (finding 3)', () => {
      const u = { ...ctx, user: 'samdoe', home: '/home/samdoe', users: ['robin99'] };
      expect(redactForPublic('Samdoe and SAMDOE and samdoe; Robin99 ran', u)).toBe('{user} and {user} and {user}; {user} ran');
      expect(redactForPublic('PAT ran as pat', ctx)).toBe('{user} ran as {user}');
    });
    it("each part of a person's name is masked, in any case; an everyday word only as written (finding 3)", () => {
      const p = { ...ctx, user: undefined, people: ['Alice Example', 'Bo', 'Li Wei', 'Will Sandoval', 'Sam', 'José García', 'Mary-Jane O\'Brien', 'Rose', '田中太郎', 'Test User', 'The Family'] };
      for (const [a, b] of [
        ['Alice asked it', '{name} asked it'], ['alice asked it', '{name} asked it'], ['ALICE EXAMPLE asked', '{name} asked'], ['Alice Example asked', '{name} asked'], ['alice-example asked', '{name} asked'],
        ['sam and SAM ran', '{name} and {name} ran'], ['Bo said', '{name} said'], ['Wei and Li Wei', '{name} and {name}'], ['Sandoval said', '{name} said'], ['Will Sandoval said', '{name} said'],
        ['Will said it will fail', '{name} said it will fail'], ['Rose saw a rose', '{name} saw a rose'],
        ['Jose and josé and GARCÍA', '{name} and {name} and {name}'], ["Alice's agent, Sam's too", "{name}'s agent, {name}'s too"], ['Jane and Brien', '{name} and {name}'], ['田中太郎さん said', '{name}さん said'],
      ] as const) expect(redactForPublic(a, p), a).toBe(b);
      // What names nobody stays, and so do words that only contain a name.
      const keep = 'bo said to go; the test user in the family; samples and alicetown; an example; dons, do not';
      expect(redactForPublic(keep, p)).toBe(keep);
    });
    it("a chat app's id the app knows is masked exactly, and a number like it stays", () => {
      expect(redactForPublic('from 1234567890 and 12345678901', { ...ctx, ids: ['1234567890', '42'] })).toBe('from {id} and 12345678901');
    });
    it("this machine's name without its .local (finding 3)", () => {
      const m = { home: '/Users/samdoe', user: 'samdoe', host: 'Sams-Notebook.local' };
      expect(redactForPublic('Sams-Notebook.local up; Sams-Notebook up; sams-notebook up', m)).toBe('{host} up; {host} up; {host} up');
      expect(redactForPublic('This machine (Sams-Notebook.local) up', { ...m, hosts: ['This machine (Sams-Notebook.local)'] })).toBe('This machine ({host}) up');
    });
    it('a name matches however its words are joined, and is not cut by a _', () => {
      const n = { ...ctx, names: ['Family Recipes', 'family-recipes'] };
      for (const a of ['Family Recipes', 'family recipes', 'FAMILY RECIPES', 'Family  Recipes', 'Family%20Recipes', 'family_recipes']) expect(redactForPublic(`see ${a} now`, n), a).toBe('see {name} now');
      expect(redactForPublic('volume hatchabot-family-recipes_data', n)).toBe('volume hatchabot-{name}_data');
    });
    it("generic words in a runner's address are not private: the report stays readable (finding 4)", () => {
      const of = (a: string) => { const id = endpointIdentity(a); return { ...ctx, hosts: id.hosts, users: [id.user!] }; };
      const text = 'Docker rebuild on ubuntu runner fails; the runner server says git failed\n⚠ docker is not answering at unix:///var/run/docker.sock → sudo systemctl start docker';
      const runner = ['runner', 'example', 'org'].join('.'), server = ['server', 'example', 'org'].join('.');
      for (const a of [`ssh://docker@${runner}`, 'ssh://ubuntu@10.0.0.5', `ssh://git@${server}:22`, 'ssh://root@node', 'ssh://admin@host']) {
        expect(redactForPublic(text, of(a)), a).toBe(text);
      }
      // The whole address is still masked, and a user or a host that is not generic.
      expect(redactForPublic(`ping ${runner}`, of(`ssh://docker@${runner}`))).toBe('ping {host}');
      expect(redactForPublic('Someone on Studio-Laptop', of('ssh://someone@studio-laptop'))).toBe('{user} on {host}');
      // Nor is this machine's own account or name, when it is one of these.
      expect(redactForPublic('Ubuntu on server', { home: '/home/ubuntu', user: 'ubuntu', host: 'server' })).toBe('Ubuntu on server');
    });
    it('masks credentials written as options, plain words and headers (finding 8)', () => {
      const curl = ['curl', '-u', 'pat:hunter2'].join(' ');
      for (const [a, b] of [
        ['--password hunter2xyz', '--password ***'], ['--token abc123def now', '--token *** now'], ['--api-key "abc def"', '--api-key ***'],
        ['password hunter2', 'password ***'], ['the token is abc123.', 'the token is ***.'], ['pass=hunter2', 'pass=***'], ['DB_PASS=hunter', 'DB_PASS=***'], ['pass: hunter2', 'pass: ***'],
        [`${curl} https://x`, 'curl -u ***:*** https://x'], [['curl', '--user', 'pat:hunter2'].join(' '), 'curl --user ***:***'],
        ['Cookie: hb_session=abc.def; other=2', 'Cookie: ***'], ["-H 'cookie: a=b' x", "-H 'cookie: ***' x"], ['Set-Cookie: hb_session=abc.def; Path=/', 'Set-Cookie: ***'], ['hatchabot_session=abc.def; x', 'hatchabot_session=***; x'],
        ['GARDEN_KEY=pl4nt', 'GARDEN_KEY=***'], ['KEY=abc', 'KEY=***'], ['ssh_key=abc', 'ssh_key=***'], ['mysql -u x -phunter2 db', 'mysql -u x -p*** db'], ['mysql -phunter2', 'mysql -p***'], ['sshpass -p hunter2 ssh', 'sshpass -p *** ssh'],
      ] as const) expect(redactForPublic(a, {}), a).toBe(b);
      const keep = ['--password-stdin', '--password $DB_PASSWORD', '--token --verbose', 'the password is wrong', 'password reset failed', 'token expired', 'max token 4096', 'tests pass=12 fail=0', 'pass: ok', 'pass=true', 'docker run -u 1000:1000 x', ['docker', 'run', '-u', 'node:node', 'x'].join(' '), 'monkey=abc', 'key: name', 'passport=x'].join('\n');
      expect(redactForPublic(keep, {})).toBe(keep);
    });
    it('masks the code in an invite or reset link (finding 8)', () => {
      const host = ['hatch', 'example', 'org'].join('.');
      for (const [a, b] of [
        ['/?claim=AbCdEfGhIjKl', '/?claim={code}'], [`https://${host}/?claim=AbCdEfGhIjKl&x=1`, `https://${host}/?claim={code}&x=1`], ['/v1/invites/AbCdEfGh', '/v1/invites/{code}'], ['GET /v1/invites/AbCdEfGh/accept', 'GET /v1/invites/{code}/accept'],
        [`https://${host}/join/AbCdEfGh ok`, `https://${host}/join/{code} ok`], ['/join/AbCdEfGh', '/join/{code}'], [`https://${host}/signin/link?t=AbCd`, `https://${host}/signin/link?t={code}`], ['/v1/local-accounts/claim?code=AbCd', '/v1/local-accounts/claim?code={code}'], ['https://x.example/api?key=AbCd&y=1', 'https://x.example/api?key={code}&y=1'],
      ] as const) expect(redactForPublic(a, {}), a).toBe(b);
      const keep = "app.get('/join/:code', h); fetch(`/join/${code}`); '/v1/invites/:code'; /join and /v1/invites";
      expect(redactForPublic(keep, {})).toBe(keep);
    });
    it('every mask holds on a second pass: the draft is masked again as it leaves', () => {
      const c2 = { ...ctx, hosts: ['studio-laptop'], users: ['someone'], names: ['Garden Notes'], people: ['Alice Example', 'Bo'], ids: ['1234567890'], paths: ['/mnt/bk'] };
      const all = ['/srv/Иванов/семья/taxes.pdf', '/home/pat/Smith Family/taxes/2025.pdf', '~/Family Photos/x', '$HOME/Documents/x', 'C:\\Users\\Pat\\x', '//nas/photos/pat', 'file:///srv/My Folder/x', 'smb://nas/x', '/mnt/bk/2026-10-22/family/x',
        'pat%40example.com', 'josé@example.com', 'someone@studio-laptop', 'openclaw@2026.9.8', 'runtime@sha256:abc', 'ssh://pat:fakepw@mybox:22/x/y', 'ssh://mybox/srv/x', 'tcp://mybox:2376', "Warning: Permanently added 'mybox' (ED25519)", 'Connection to mybox closed.',
        'c-73-1-2-3.hsd1.example.net', 'aa:bb:cc:dd:ee:ff', '+1 555 867 5309', 'telegram user 1234567890', '203.0.113.7', 'fd00::1', 'mybox.local', 'x.example.ts.net', 'password hunter2', '--token abc123', 'pass=hunter2', ['curl', '--user', 'pat:hunter2'].join(' '), 'Cookie: a=b', '/?claim=AbCd', '/join/AbCd', '/v1/invites/AbCd',
        "Alice's agent", 'Bo said', 'Garden Notes', 'someone', 'studio-laptop', 'https://studio-laptop/a/b', 'http://203.0.113.7:80/a/b', '/home/node/.openclaw/x', "app.get('/join/:code')"];
      for (const a of all) {
        const once = redactForPublic(a, c2);
        expect(redactForPublic(once, c2), a).toBe(once);
      }
      const joined = redactForPublic(all.join('\n'), c2);
      expect(redactForPublic(joined, c2)).toBe(joined);
      // What one mask uncovers is masked in the same call: this path follows a letter until the address is masked.
      expect(redactForPublic('sam@example.org$HOME/Documents/x', c2)).toBe('{email}$HOME/{path}');
      expect(redactForPublic('mybox.local\\\\nas\\photos', c2)).toBe('{host}{path}');
    });
    it('a second pass changes none of it', () => {
      const once = redactForPublic('someone@studio-laptop ssh://x@y tcp://y:1 /srv/a/b ~/Taxes/z /home/pat/x/y 203.0.113.7 {path}/2026-10-20/x', c);
      expect(redactForPublic(once, c)).toBe(once);
    });
  });
});

describe('the second review: what stayed, and what went too far (HB-0405)', () => {
  const table = (rows: ReadonlyArray<readonly [string, string]>, c: object = ctx) => { for (const [a, b] of rows) expect(redactForPublic(a, c), a).toBe(b); };
  const stays = (rows: readonly string[], c: object = ctx) => { for (const a of rows) expect(redactForPublic(a, c), a).toBe(a); };
  it('what docs/field-reports.md says stays and goes', () => {
    stays(['/bin/smith', '/usr/lib/smith/x', '/etc/cron.d/smith', '/v1/agents/smith/logs', '~/.config/smith/x', '/tmp/smith/x', '~/hatchabot/smith/x', 'pass: word', 'pass=12', 'pass=true', 'pass: ok', 'max token 4096', 'name@1.2.3', 'name@2', 'name@latest', 'name@next', 'name@stable', 'name@edge', 'config.local'], {});
    table([['pass=word', 'pass=***'], ['pass=1234', 'pass=***'], ['pass: x9', 'pass: ***'], ['/srv/smith family', '{path} family']], {});
    stays(['jo logged in', 'Li asked'], { users: ['jo'], people: ['Li Wei'] });
    // Each example the doc gives, as it reads there.
    const doc = { home: '/home/samdoe', user: 'samdoe', hosts: ['mybox'], names: ['Finny', 'Recipe Helper'], users: ['will'], people: ['Will Page', 'Rose Brown', 'Bo Li', 'Alma Rocky', 'Bob Fox', 'Taylor Reed', 'Living Room', 'Kitchen Laptop', 'Telegram User', 'Alicia Key', 'Alex 2026'] };
    table([
      ['will page', '{name}'], ['ROSE BROWN', '{name}'], ['bo li', '{name}'], ['alma rocky', '{name}'], ['Living Room', '{name}'], ['Kitchen Laptop', '{name}'], ['Bob', '{name}'], ['bob', '{name}'], ['TAYLOR', '{name}'], ['reed', '{name}'], ['Will', '{name}'], ['Brown', '{name}'], ['in 2026 Alex', 'in 2026 {name}'], ['Alex 2026', '{name}'],
      ['USER=WILL', 'USER={user}'], ['User will', 'User {user}'], ['author=will', 'author={user}'], ['uid=1000(will)', 'uid=1000({user})'], ['-l will', '-l {user}'], ['for will from', 'for {user} from'], ['sudo: will :', 'sudo: {user} :'], ['chown will:will', 'chown {user}:{user}'], ['su - will', 'su - {user}'], ['whoami: will', 'whoami: {user}'], ['id will', 'id {user}'], ['the user will see', 'the user {user} see'],
      ['/srv/Letters to Jane Roe/a.pdf', '{path}'], ['/srv/data could not be opened by lib/app.js', '{path}'], ['/srv/smith family', '{path} family'], ['/srv/Insurance Denied', '{path} Denied'],
      ['http://recipe-helper:8080/a/b', 'http://{name}:8080{path}'], ['http://mybox:8080/Family', 'http://{host}:8080/Family'], ['/v1/files?path=/srv/a/b', '/v1/files?path={path}'], ['/x/y?file=a.pdf', '{path}'], ['/v1/x?file=a.pdf', '/v1/x?file={path}'],
      ['~/.ssh/pat at work.pem', '~/{path}'], ['/usr/lib/smith/JaneRoe.pdf', '/usr/lib/smith/{path}'], ['/etc/ssl/certs/x.pem', '/etc/ssl/certs/{path}'], ['/usr/share/x', '/usr/share/{path}'], ['/proc/1/root/home/x', '/proc/1/root/{path}'],
      ['\\\\NAS', '{path}'], ['\\Device\\x', '{path}'], ['C%3A%5Cx%5Cy', '{path}'], ['s3://a/b', 's3://{path}'], ['vscode://file/a/b', 'vscode://file{path}'], ['$HOME\\x', '$HOME\\{path}'], ['~\\x', '~\\{path}'], ['$env:USERPROFILE\\x', '$env:USERPROFILE\\{path}'], ['-v$PWD/x', '-v$PWD/{path}'], ['mnt-Smith.mount', '{path}.mount'], ['PWD=/srv/a/b', 'PWD={path}'],
    ], doc);
    stays(['it will fail', 'a brown fox', 'rose', 'jack', 'bill', 'page', 'max', 'mark', 'living room', 'Telegram User', 'telegram user', 'Key', 'http://mybox2:2375', '/v1.41/containers', '/v1/hosts', "'/join/:code'", '~/.ssh/known_hosts.old', '~/.ssh/environment', '~/.ssh/rc', '~/.ssh/id_rsa.pub', '/usr/lib/smith/x', '/srv'], doc);
  });
  it('every new mask holds on a second pass', () => {
    const c = { ...ctx, hosts: ['studio-laptop'], users: ['will'], people: ['Bo Li', "Mary O'Brien"] };
    const all = ['https://studio-laptop:8443/Smith/Taxes/x', 'http://[fd00::1]:8080/a/b', '-v/srv/Smith/x:/data', '\\\\?\\C:\\Users\\Jane Doe\\x', '%APPDATA%\\Smith Family\\x', '$PWD/Smith/x', '/proc/1/root/home/marta/x', '/var/lib/docker/overlay2/a/merged/home/marta/x', '/etc/ssl/certs/smith.pem', '/etc/docker/certs.d/registry.example/ca.crt', '/usr/share/Smith Family/x', '/usr/src/app/Smith/x', '/Library/Logs/Smith Family/x.log', 'unix:///var/run/marta/x.sock', '"/usr/share/Smith Family/x"', '~/hatchabot/Smith/x', '~/hatchabot-data/photos/x.jpg', '$HOME/hatchabot/Smith/x', "O'Brien said", 'Bo Li asked', 'x%20Bo%20Li%20y', 'user=will', `${'-'.repeat(5)}BEGIN X${'-'.repeat(5)}\nabc`, 'pass=123456', '/srv/x ERROR Something'];
    for (const a of all) {
      const once = redactForPublic(a, c);
      expect(redactForPublic(once, c), a).toBe(once);
    }
    const joined = redactForPublic(all.join('\n'), c);
    expect(redactForPublic(joined, c)).toBe(joined);
  });
  describe('a port after a masked machine (P1)', () => {
    it('a folder on a masked machine with a port', () => {
      const c = { ...ctx, hosts: ['studio-laptop'] };
      table([
        ['https://studio-laptop/Smith/Taxes/2025.pdf', 'https://{host}{path}'],
        ['https://studio-laptop:8443/Smith/Taxes/2025.pdf', 'https://{host}:8443{path}'],
        ['http://192.168.1.10:8080/Smith/Taxes/2025.pdf', 'http://{private-ip}:8080{path}'],
        ['http://nas.local:5000/Smith/Taxes/x', 'http://{host}:5000{path}'],
        ['http://box.tail1234.ts.net:8080/Smith/Taxes/x', 'http://{tailnet-host}:8080{path}'],
        ['http://[fd00::1]:8080/Smith/Taxes/x', 'http://[{private-ip}]:8080{path}'],
        ['http://203.0.113.7:80/a/b', 'http://{ip}:80{path}'],
        ['https://old-nas.lan:8443/v1/hosts/abc and http://10.0.0.5:8091/health', 'https://{host}:8443/v1/hosts/abc and http://{private-ip}:8091/health'],
      ], c);
    });
  });
  describe('other ways a path is written (P8)', () => {
    it('path forms', () => {
      table([
        ['-v/srv/Smith/x:/data', '-v{path}:/data'], ['-L/home/marta/lib', '-L{path}'], ['gcc -I/srv/Smith/inc x.c', 'gcc -I{path} x.c'],
        ['\\\\?\\C:\\Users\\Jane Doe\\x', '{path}'], ['\\\\.\\C:\\Users\\Jane\\x', '{path}'], ['\\\\?\\UNC\\nas\\share\\x', '{path}'], ['\\Users\\Jane\\x', '{path}'],
        ['%APPDATA%\\Smith\\x', '%APPDATA%\\{path}'], ['%LOCALAPPDATA%\\Smith\\x', '%LOCALAPPDATA%\\{path}'], ['%HOMEPATH%\\Smith\\x', '%HOMEPATH%\\{path}'], ['%APPDATA%\\Smith Family\\x', '%APPDATA%\\{path}'],
        ['$PWD/Smith/x', '$PWD/{path}'], ['${PWD}/Smith/x', '${PWD}/{path}'], ['$XDG_CONFIG_HOME/Smith/x', '$XDG_CONFIG_HOME/{path}'],
      ]);
      stays(['x-y/foo/bar', 'a -b c/d', '\\n and \\t and "\\nfoo\\nbar"', '$1/x', '50%/60%', '--- a/src/x.ts']);
    });
  });
  describe('a system folder keeps no personal tail (P4)', () => {
    it('kept folders keep no personal tail', () => {
      table([
        ['/var/lib/docker/overlay2/abc/merged/home/marta/x.txt', '/var/lib/docker/overlay2/abc/merged/{path}'],
        ['/proc/1/root/home/marta/x.pdf', '/proc/1/root/{path}'],
        ['/proc/1/cwd/srv/marta/x', '/proc/1/cwd/{path}'],
        ['/etc/ssl/certs/smith-family.example.pem', '/etc/ssl/certs/{path}'],
        ['/etc/ssl/private/smith-family.example.key', '/etc/ssl/private/{path}'],
        ['/etc/docker/certs.d/registry.smith-family.example/ca.crt', '/etc/docker/certs.d/{path}'],
        ['/usr/share/Smith Family/x', '/usr/share/{path}'],
        ['/usr/src/app/Smith/x', '/usr/src/app/{path}'],
        ['/Library/Logs/Smith Family/x.log', '/Library/Logs/{path}'],
        ['/run/systemd/users/marta', '/run/systemd/{path}'],
        ['/usr/lib/home/marta/x', '/usr/lib/{path}'],
        ['/usr/lib/python3/Users/marta/x', '/usr/lib/python3/{path}'],
        ['/usr/share/marta/secrets.txt', '/usr/share/{path}'],
        ['/etc/ssh/marta_key', '/etc/ssh/{path}'],
        ['/etc/default/marta', '/etc/default/{path}'],
        ['/etc/sudoers.d/marta', '/etc/sudoers.d/{path}'],
        ['/etc/systemd/system/marta-backup.service', '/etc/systemd/system/{path}'],
        ['/var/run/marta/x.sock', '/var/run/{path}'],
        ['/run/user/1000/marta/x', '/run/user/1000/{path}'],
        ['/Library/Preferences/com.smith-family.x.plist', '/Library/Preferences/{path}'],
        ['/usr/lib/Иванов/x', '/usr/lib/{path}'],
        ['/usr/lib/%2e%2e/%2e%2e/srv/Smith', '{path}'],
        ['"/usr/share/Smith Family/x"', '"/usr/share/{path}"'],
        ['unix:///var/run/marta/x.sock', 'unix:///var/run/{path}'],
      ]);
      stays([
        '/usr/lib/node_modules/openclaw/dist/x.js:12:3', '/usr/lib/python3/dist-packages/foo/Bar.py', '/usr/lib/x/private/y.js', '/usr/include/linux/fs.h',
        '/usr/share/zoneinfo/America/New_York', '/usr/share/doc/docker/README.md', '/usr/share/ca-certificates/x.crt', '/usr/src/app/dist/index.js:3:1', '/usr/src/app/README.md', '/usr/src/app',
        '/var/lib/docker/overlay2/ab/merged', '/var/lib/docker/containers/abc/abc-json.log', '/proc/1/root', '/proc/self/fd/3', '/proc/1/status', '/proc/meminfo', '/sys/fs/cgroup/user.slice/user-1000.slice/x',
        '/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/certs', '/etc/ssl/openssl.cnf', '/etc/docker/daemon.json', '/etc/docker/certs.d', '/etc/ssh/sshd_config', '/etc/ssh/sshd_config.d/50-cloud-init.conf', '/etc/ssh/ssh_host_ed25519_key.pub',
        '/etc/systemd/system/hatchabot.service', '/etc/systemd/system/docker.service.d/override.conf', '/etc/default/docker', '/etc/apt/sources.list.d/docker.list', '/etc/containerd/config.toml',
        '/run/user/1000/docker.sock', '/run/docker/x.sock', '/run/containerd/containerd.sock', '/run/systemd/users/1000', '/run/systemd/private', '/var/run/docker.sock', '/var/run/docker/x', '/dev/shm/x', '/dev/null', '/dev/sda1',
        '/Library/Logs/DiagnosticReports/x.crash', '/Library/LaunchDaemons/com.docker.vmnetd.plist', '/Library/Frameworks/Python.framework/Versions/3.12/x', '/Applications/Docker.app/Contents/Resources/bin/docker', '/opt/homebrew/Cellar/node/22/bin/node', '/nix/store/abc-node/bin/node',
        '/v1/hosts/abc', '/v1/invites/{code}/accept', '/api/x/y', '/bin/sh', '/usr/bin/env', '/usr/local/bin/node',
      ]);
    });
  });
  describe("this app's folders and /app/ (P5)", () => {
    it('app folders', () => {
      table([
        ['~/hatchabot/Smith/Taxes/2025.pdf', '~/hatchabot/{path}'],
        ['~/hatchabot-data/photos/marta.jpg', '~/hatchabot-data/{path}'],
        ['~/hatchabot-data/marta.jpg', '~/hatchabot-data/{path}'],
        ['~/hatchabot-data/marta/notes', '~/hatchabot-data/{path}'],
        ['~/hatchabot-backups/Smith/x', '~/hatchabot-backups/{path}'],
        ['/home/pat/hatchabot/family/taxes/x', '~/hatchabot/{path}'],
        ['$HOME/hatchabot/Smith/x', '$HOME/hatchabot/{path}'],
        ['/app/Smith/Taxes/2025.pdf', '{path}'],
        ['/app/family/taxes/x', '{path}'],
        ['/app/x/2025.pdf', '{path}'],
      ]);
      stays(['/app/README.md', '/app/LICENSE', '/app/Dockerfile', '/app/dist/index.js:12:3', '/app/dist/Foo.js', '/app/node_modules/Foo/Bar/x.js', '~/hatchabot/docs/README.md', '~/hatchabot/src/x.ts', '~/hatchabot-data/x', '~/hatchabot-prod/x', '~/hatchabot-prod/dist/index.js']);
    });
  });
  describe("only ssh's own key names (P7)", () => {
    it('ssh names', () => {
      table([['~/.ssh/id_marta_smith.pub', '~/{path}'], ['~/.ssh/id_marta', '~/{path}'], ['/home/pat/.ssh/id_marta_smith', '~/{path}']]);
      stays(['~/.ssh/id_rsa', '~/.ssh/id_rsa.pub', '~/.ssh/id_ed25519', '~/.ssh/id_ed25519.pub', '~/.ssh/id_ecdsa', '~/.ssh/id_dsa.pub']);
    });
  });
  describe('a sentence after a path stays (P10)', () => {
    it('sentences after a path', () => {
      table([
        ['/srv/app/x.log ERROR Something Went Wrong In Module Loader Please Check Logs', '{path} ERROR Something Went Wrong In Module Loader Please Check Logs'],
        ['/srv/app/x.log Something Went Wrong In Module Loader Please Check Logs', '{path} Something Went Wrong In Module Loader Please Check Logs'],
        // A sentence that names a second path goes with the first: nothing tells it from "Insurance Denied Claims/x.pdf" (third review).
        ['/srv/data could not be opened by lib/app.js', '{path}'],
        ['Failed to read /srv/app/config.json Status: 500', 'Failed to read {path} Status: 500'],
        ['/srv/data Status: 500', '{path} Status: 500'],
        ['Error at /app/dist/server.js while reading package.json and more text here', 'Error at {path} and more text here'],
        ['/tmp/build.log see config.json please', '{path} please'],
        ['~/hatchabot/x.log then read config.json', '~/hatchabot/{path}'],
        ['/srv/a.txt\tERROR\tFailed\tThing', '{path}\tERROR\tFailed\tThing'],
        ['/srv/app/x.log 500 Internal', '{path} 500 Internal'],
        // The run is capped.
        ['/srv/a/b One Two Three Four Five Six Seven Eight', '{path} Seven Eight'],
        // Leaks stay masked.
        ['/home/samdoe/Smith Family/taxes/2025.pdf', '{path}'], ['/Users/Pat Smith Jr/Docs/x', '{path}'], ['/home/samdoe/Tax Return Smith.pdf', '{path}'],
        ['/srv/Smith and Jones/x', '{path}'], ['/srv/Smith and Jones failed', '{path} failed'], ['/srv/Mom and Dad/taxes.pdf', '{path}'], ['/srv/Smith Jones: denied', '{path}: denied'], ['/srv/SMITH FAMILY/x', '{path}'],
        ['/srv/Mt. Smith/x', '{path}'], ['/srv/Lord of the Rings/x', '{path}'], ['/srv/x Failed Attempts/y', '{path}'],
      ]);
    });
  });
  describe("a member's name in every shape (P2)", () => {
    it('names of 2-letter parts', () => {
      table([['Bo Li, Li Na, Wu Di asked', '{name}, {name}, {name} asked']], { people: ['Bo Li', 'Li Na', 'Wu Di'] });
      // Whole, in any case: only a name that says it is no person goes only as written (third review).
      table([['bo li and li na; to do', '{name} and {name}; to do']], { people: ['Bo Li', 'Li Na', 'Wu Di', 'To Do'] });
    });
    it('apostrophe surname', () => {
      table([["O'Brien said", '{name} said'], ['O’Brien said', '{name} said'], ["o'brien said", '{name} said'], ["Mary O'Brien said", '{name} said'], ["O'Brien's car", "{name}'s car"], ['Brien said', '{name} said']], { people: ["Mary O'Brien"] });
    });
  });
  describe("a name after a URL's escape (P9)", () => {
    it('after %20', () => {
      const c = { user: 'samdoe', names: ['Garden Helper'], people: ['Alice Example'] };
      table([['Hello%20Alice', 'Hello%20{name}'], ['Hello%20Alice%20there', 'Hello%20{name}%20there'], ['x%20Garden%20Helper%20y', 'x%20{name}%20y'], ['x%20samdoe%20y', 'x%20{user}%20y'], ['a%2CAlice', 'a%2C{name}']], c);
    });
  });
  describe('everyday words are not names (P11)', () => {
    it('usernames that are everyday words', () => {
      const c = { users: ['will', 'max', 'page'] };
      stays(['it will fail with max_tokens on this page'], c);
      table([['user=will and USER=max, uid=1000(page) -l will', 'user={user} and USER={user}, uid=1000({user}) -l {user}'], ['/home/will/x and will@box', '{path} and {user}@{host}']], c);
      table([['Will said it will fail', '{user} said it will fail']], { users: ['Will'] });
    });
    it('free-text member names', () => {
      stays(['the telegram bot in the chat group, living room, and account'], { people: ['Telegram User', 'Chat Group', 'Living Room', 'Family Account'] });
      table([['Living Room is cold', '{name} is cold'], ['Telegram bot, Telegram User', 'Telegram bot, Telegram User']], { people: ['Telegram User', 'Living Room'] });
      table([['sam at github.org asked, an org', '{name} at github.org asked, an org']], { people: ['sam@example.org'] });
      table([['Alex at 2026-10-05, v2026.9.8', '{name} at 2026-10-05, v2026.9.8'], ['Alex 2026 asked', '{name} asked']], { people: ['Alex 2026'] });
      stays(['room 101 and 2026-10-05'], { people: ['Room 101'], users: ['2026'] });
    });
  });
  describe('a key goes whole (P3)', () => {
    // Whole-looking blocks, built at run time from a short repeated made-up piece, so nothing in the tree is shaped like a key.
    const line = 'AbC1+dE2/'.repeat(7);
    const dashes = '-'.repeat(5);
    const block = (label: string, body: string, end = true) => `${dashes}BEGIN ${label}${dashes}\n${body}${end ? `\n${dashes}END ${label}${dashes}` : ''}`;
    it('a key block goes whole', () => {
      table([
        [`x\n${block('RSA PRIVATE KEY', `${line}\n${line}`)}\ny`, 'x\n{key}\ny'],
        [`${block('OPENSSH PRIVATE KEY', 'abc\ndef')}`, '{key}'],
        [`${block('CERTIFICATE', line)}`, '{key}'],
        [`${block('RSA PRIVATE KEY', `${line}\n${line}`, false)}`, '{key}'],
        [`${block('RSA PRIVATE KEY', `${line}\nab`, false)}\nthe next line stays`, '{key}\nthe next line stays'],
        [`${block('PRIVATE KEY', 'Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\n' + line, false)}\nnext words`, '{key}\nnext words'],
        [`"${dashes}BEGIN PRIVATE KEY${dashes}\\n${line}\\n${line}\\n${dashes}END PRIVATE KEY${dashes}\\n"`, '"{key}\\n"'],
        [`${dashes}BEGIN PRIVATE KEY${dashes}\\n${line}\\n${line}`, '{key}'],
        [`${dashes}BEGIN PRIVATE KEY${dashes} ${line} ${line}`, '{key}'],
        [`${block('A KEY', line, false)}\n\n${block('B KEY', line)}\nz`, '{key}\n\n{key}\nz'],
      ]);
      stays(['see BEGIN and END', '-----', 'wrong header, want PEM']);
      table([[`expected ${dashes}BEGIN X${dashes} first, then words`, 'expected {key} first, then words']]);
    });
    it('long base64 with + and /', () => {
      table([[`blob ${line} end`, 'blob *** end'], [`blob ${line}== end`, 'blob *** end'], [`x=${line}`, 'x=***']]);
      stays(['/usr/lib/node/modules/openclaw/dist/some/long/plain/path/here/and/more/of/it', 'see src/orchestrator/problemReport/SomeLongerName/AnotherLongName/Thing']);
    });
  });
  describe('credentials as the panel says (P6)', () => {
    it('credentials', () => {
      table([['pass=123456', 'pass=***'], ['DB_PASS=123456', 'DB_PASS=***'], ['MYSQL_PASS=true', 'MYSQL_PASS=***'], ['PASS: secret', 'PASS: ***'], ['db_pass: secret', 'db_pass: ***'], ['password 123456', 'password ***'], ['passwd 9876', 'passwd ***'], ['pass: 123456', 'pass: ***']], {});
      stays(['tests pass=12 fail=0', 'pass: ok', 'pass=true', 'PASS: ok', 'PASS: 12', 'test_pass=12', 'total_pass=12', 'max token 4096', 'password 3', 'pass: secret', 'password swordfish'], {});
    });
  });
  describe('a code fence after a prompt stays', () => {
    it('fence kept', () => { expect(redactForPublic('```\nEnter Password:\n```\n\nnext', {})).toBe('```\nEnter Password:\n```\n\nnext'); });
  });
  describe('what is not a host, a phone or a password (P12)', () => {
    it('false positives', () => {
      stays(['openssl-1.1.1-8.el8.noarch', 'foo-1.2.3-4.fc39.noarch.rpm', 'img-1-2-3-4.example.png', 'config.local', 'settings.lan', 'sizes 512 256 1024 2048', 'mysql is down, try docker run -p3306:3306', 'mysql: docker run -p127.0.0.1:3306:3306 x'], {});
      table([['c-73-1-2-3.hsd1.ca.example.net', '{host}'], ['203.0.113.5.nip.io', '{host}'], ['mybox.local', '{host}'], ['call 555 867 5309 now', 'call {phone} now'], ['1 555 867 5309', '1 {phone}'], ['mysql -p123456 db', 'mysql -p*** db']], {});
    });
  });
  describe('a scheme is not a host (P13)', () => {
    it('endpointIdentity', () => {
      expect(endpointIdentity('tcp://:2375')).toEqual({ hosts: [] });
      expect(endpointIdentity('tcp:///x')).toEqual({ hosts: [] });
      expect(endpointIdentity('ssh://')).toEqual({ hosts: [] });
      expect(endpointIdentity('sam@old-nas:22')).toEqual({ user: 'sam', hosts: ['old-nas'] });
      expect(endpointIdentity('old-nas:2375')).toEqual({ hosts: ['old-nas'] });
      stays(['tcp is fine, ssh too'], { hosts: ['tcp', 'ssh'] });
    });
  });
});

// The reviewer's table: each of these went public after the masks were made less eager to save report text.
describe('the last read before the release (HB-0405)', () => {
  it('a quoted name and a quoted value, as JSON or a hash writes them', () => {
    for (const [a, b] of [
      ['{"DB_PASS":"made-up-1"}', '{"DB_PASS":"***"}'],
      ['"GARDEN_KEY": "made-up-1",', '"GARDEN_KEY": "***",'],
      ['{"auth":{"user":"quincy","pass":"made-up"}}', '{"auth":{"user":"quincy","pass":"***"}}'],
      [String.raw`{\"DB_PASS\":\"made-up-1\"}`, String.raw`{\"DB_PASS\":\"***\"}`],
      [`'pass' => 'made-up'`, `'pass' => '***'`],
    ] as const) expect(redactForPublic(a, {}), a).toBe(b);
    for (const a of ['"test_pass":"12"', '"pass":"true"', '"monkey":"banana"', '"key":"name"']) expect(redactForPublic(a, {}), a).toBe(a);
    expect(redactForPublic('{"DB_PASS":"Made*up9","pass":"{made}9"}', {})).toBe('{"DB_PASS":"***","pass":"***"}');
  });
  it('a run of backslashes or quotes does not stall the server', () => {
    for (const hostile of ['\\'.repeat(60_000), '\\"'.repeat(30_000), '\\\\"'.repeat(20_000), '"\\'.repeat(30_000), `${'\\'.repeat(59_990)}"pass":"x"`, '\\"pass\\":\\"'.repeat(5_000), `'pass'=>'`.repeat(6_000)]) {
      const t = Date.now();
      redactForPublic(hostile, {});
      expect(Date.now() - t, hostile.slice(0, 12)).toBeLessThan(2_000);
    }
  });
  it('a whole name, when a username is one of its parts', () => {
    const x = { users: ['bob', 'rosa'], people: ['Bob Brown', 'Rosa King'] };
    for (const [a, b] of [['bob brown wrote this', '{name} wrote this'], ['BOB BROWN', '{name}'], ['bob-brown', '{name}'], ['rosa king', '{name}'], ['bob wrote this', '{user} wrote this']] as const) {
      expect(redactForPublic(a, x), a).toBe(b);
    }
  });
  it('a banner is not a key that lost its dashes', () => {
    expect(redactForPublic('---BEGIN STACK---\nError: boom\n---END STACK---', {})).toBe('---BEGIN STACK---\nError: boom\n---END STACK---');
    expect(redactForPublic('--BEGIN TRANSACTION', {})).toBe('--BEGIN TRANSACTION');
    expect(redactForPublic('---BEGIN RSA PRIVATE KEY-----', {})).toBe('{key}');
    expect(redactForPublic('--BEGIN AGE ENCRYPTED FILE', {})).toBe('{key}');
  });
});

describe('the third review: a leak is worse than a lost word (HB-0405)', () => {
  const c = { home: '/home/samdoe', user: 'samdoe', host: 'spark-box', users: ['pat'], hosts: ['mybox', 'studio-laptop', 'studio'], names: ['Recipe Helper', 'Finny'], people: ['Jane Doe'] };
  const table = (rows: ReadonlyArray<readonly [string, string]>, x: object = c) => { for (const [a, b] of rows) expect(redactForPublic(a, x), a).toBe(b); };
  const stays = (rows: readonly string[], x: object = c) => { for (const a of rows) expect(redactForPublic(a, x), a).toBe(a); };
  describe('M2, m11, m13: a whole name goes in any case, whatever its parts', () => {
    const p = { ...c, people: ['Will Page', 'Rose Brown', 'Bob Fox', 'Jack Hall', 'Mary Page', 'Taylor Reed', 'Living Room', 'Alicia Key', 'Alma Rocky', 'Mac Box', 'Ned Slack', 'Kitchen Laptop'] };
    it('every part on the everyday list', () => {
      table([
        ['will page asked', '{name} asked'], ['WILL PAGE asked', '{name} asked'], ['Will Page asked', '{name} asked'], ['will-page', '{name}'], ['will.page', '{name}'], ['Will+Page', '{name}'], ['will_page', '{name}'], ['Will%20Page', '{name}'],
        ['rose brown', '{name}'], ['ROSE BROWN', '{name}'], ['bob fox', '{name}'], ['BOB FOX', '{name}'], ['jack hall', '{name}'], ['mary page', '{name}'],
      ], p);
    });
    it('a part alone: only a really everyday word stays in lowercase', () => {
      table([['Bob', '{name}'], ['bob wrote', '{name} wrote'], ['BOB', '{name}'], ['Taylor', '{name}'], ['taylor', '{name}'], ['TAYLOR', '{name}'], ['reed', '{name}'], ['Rose', '{name}'], ['Jack', '{name}'], ['Will', '{name}'], ['Page', '{name}'], ['Fox', '{name}']], p);
      stays(['rose', 'jack', 'it will fail', 'page not found', 'a brown fox in the hall', 'ROSE', 'JACK'], p);
    });
    it('a default name, and nothing else, goes only as written', () => {
      table([['Living Room is cold', '{name} is cold'], ['Kitchen Laptop is off', '{name} is off']], p);
      stays(['the living room is cold', 'LIVING ROOM', 'telegram user', 'Telegram User'], { ...p, people: [...p.people, 'Telegram User'] });
    });
    it('both parts generic: the whole is masked, each alone stays', () => {
      table([['Alma Rocky wrote', '{name} wrote'], ['alma rocky', '{name}'], ['Mac Box', '{name}'], ['mac box', '{name}'], ['Ned Slack', '{name}']], p);
      stays(['Alma', 'Rocky', 'Mac', 'Box', 'Slack'], p);
    });
    it('a mask is never a name', () => {
      const dashes = '-'.repeat(5);
      table([[`${dashes}BEGIN RSA PRIVATE KEY${dashes}\nabc\n${dashes}END RSA PRIVATE KEY${dashes}`, '{key}'], ['Alicia Key', '{name}']], p);
      stays(['{key}', 'key', 'Key'], p);
      stays(['{key}'], { names: ['Key'] });
    });
  });
  describe('M3: a username that is also a first name, or a common word', () => {
    const bob = { home: '/home/bob', user: 'bob', host: 'box2' };
    const will = { home: '/home/will', user: 'will', host: 'box2' };
    it('only a truly common word gets the careful treatment: any other goes in any case', () => {
      table([
        ['Failed password for bob from 203.0.113.9 port 22 ssh2', 'Failed password for {user} from {ip} port 22 ssh2'],
        ['Accepted publickey for bob from 203.0.113.9', 'Accepted publickey for {user} from {ip}'],
        ['sudo: bob : TTY=pts/0 ; COMMAND=/bin/ls', 'sudo: {user} : TTY=pts/0 ; COMMAND=/bin/ls'],
        ['-rw------- 1 bob bob 12 Nov 5 x.txt', '-rw------- 1 {user} {user} 12 Nov 5 x.txt'],
        ['chown bob:bob /srv/x', 'chown {user}:{user} {path}'],
        ['su - bob', 'su - {user}'], ['whoami: bob', 'whoami: {user}'], ['Bob', '{user}'], ['BOB', '{user}'], ['bob', '{user}'],
      ], bob);
    });
    it('a common word is masked on every line that says it is a user, in any case', () => {
      table([
        ['Failed password for will from 203.0.113.9 port 22 ssh2', 'Failed password for {user} from {ip} port 22 ssh2'],
        ['Accepted publickey for WILL from 203.0.113.9', 'Accepted publickey for {user} from {ip}'],
        ['session opened for user will(uid=1000) by (uid=0)', 'session opened for user {user}(uid=1000) by (uid=0)'],
        ['session opened for user root(uid=0) by will(uid=1000)', 'session opened for user root(uid=0) by {user}(uid=1000)'],
        ['sudo: will : TTY=pts/0 ; PWD=/home/will/x ; USER=root ; COMMAND=/bin/ls', 'sudo: {user} : TTY=pts/0 ; PWD=~/{path} ; USER=root ; COMMAND=/bin/ls'],
        ['Nov 05 12:01:02 box2 sudo[12]: will : TTY=pts/0', 'Nov 05 12:01:02 {host} sudo[12]: {user} : TTY=pts/0'],
        ['-rw------- 1 will will 12 Nov 5 x.txt', '-rw------- 1 {user} {user} 12 Nov 5 x.txt'],
        ['drwxr-xr-x 2 root will 4096 Nov 5 x', 'drwxr-xr-x 2 root {user} 4096 Nov 5 x'],
        ['chown will:will /srv/x/y', 'chown {user}:{user} {path}'], ['chown -R WILL /srv/x/y', 'chown -R {user} {path}'], ['chgrp will x', 'chgrp {user} x'],
        ['su - will', 'su - {user}'], ['su will', 'su {user}'], ['su -l will', 'su -l {user}'],
        ['whoami: will', 'whoami: {user}'], ['author=will', 'author={user}'], ['Author: will', 'Author: {user}'],
        ['id will', 'id {user}'], ['$ id -u will', '$ id -u {user}'], ['id: ‘will’: no such user', 'id: ‘{user}’: no such user'],
        ['USER=will', 'USER={user}'], ['USER=WILL', 'USER={user}'], ['SUDO_USER=will', 'SUDO_USER={user}'], ['User will', 'User {user}'], ['user will', 'user {user}'], ['USER WILL', 'USER {user}'],
        ['uid=1000(will) gid=1000(will)', 'uid=1000({user}) gid=1000({user})'], ['ssh -l will x', 'ssh -l {user} x'], ['docker exec -u will x', 'docker exec -u {user} x'], ['sudo -iu will x', 'sudo -iu {user} x'],
        ['usermod -aG docker will', 'usermod -aG docker {user}'], ['will pts/0 2026-11-05', '{user} pts/0 2026-11-05'],
      ], will);
      stays(['it will fail', 'Will said', 'WILL', 'the id will change', 'files for will be here'], will);
    });
    it('a common word with a capital goes as written too', () => {
      table([['Will said it will fail', '{user} said it will fail'], ['USER=will', 'USER={user}']], { home: '/home/Will', user: 'Will' });
    });
  });
  describe('M4: PWD= holds a folder, with or without a space', () => {
    it('the whole path is masked and the rest of the line stays readable', () => {
      table([
        ['sudo[1]: samdoe : TTY=pts/0 ; PWD=/home/samdoe/Smith Family/taxes ; USER=root ; COMMAND=/bin/ls', 'sudo[1]: {user} : TTY=pts/0 ; PWD=~/{path} ; USER=root ; COMMAND=/bin/ls'],
        ['Nov 05 12:01:02 spark-box sudo[123]: samdoe : TTY=pts/0 ; PWD=/home/samdoe/Tax Docs ; USER=root ; COMMAND=/usr/bin/ls /srv/Smith Family/x', 'Nov 05 12:01:02 {host} sudo[123]: {user} : TTY=pts/0 ; PWD=~/{path} ; USER=root ; COMMAND=/usr/bin/ls {path}'],
        ['PWD=/srv/Smith Family/Jane Roe.pdf', 'PWD={path}'],
        ['OLDPWD=/srv/Smith Family/x', 'OLDPWD={path}'],
        ['PWD=~/Smith Family/x', 'PWD=~/{path}'],
        ['PWD="/srv/Smith Family/x"', 'PWD="{path}"'],
        ['"PWD": "/srv/Smith Family/x"', '"PWD": "***"'],
      ]);
    });
    it('anything else named pwd is still a password', () => {
      table([['pwd=hunter2', 'pwd=***'], ['PWD=hunter2', 'PWD=***'], ['DB_PWD=hunter2', 'DB_PWD=***'], ['DB_PWD=/hunter2', 'DB_PWD=***'], ['pwd=/hunter2', 'pwd=***'], ['Pwd=/hunter2;', 'Pwd=***;'], ['PASSWORD=/srv/x', 'PASSWORD=***']]);
    });
  });
  describe('m1, m12: a kept folder keeps nothing that looks personal', () => {
    it('in a folder of libraries and shared files', () => {
      table([
        ['/usr/share/nginx/html/Family/Taxes/2025.pdf', '/usr/share/nginx/html/{path}'],
        ['/usr/share/doc/Jane-Roe-Taxes/2025.pdf', '/usr/share/doc/{path}'],
        ['/usr/share/doc/JaneRoe/x.txt', '/usr/share/doc/{path}'],
        ['/usr/share/fonts/Jane Roe.ttf', '/usr/share/fonts/{path}'],
        ['/usr/lib/smith/JaneRoe.pdf', '/usr/lib/smith/{path}'],
        ['/usr/local/lib/foo/JaneRoe/x.txt', '/usr/local/lib/foo/{path}'],
        ['/usr/lib/foo/photo.jpg', '/usr/lib/foo/{path}'],
        ['/etc/cron.d/x.pdf', '/etc/cron.d/{path}'],
        ['/opt/homebrew/Cellar/Jane Roe/x', '/opt/homebrew/Cellar/{path}'],
        ['/usr/lib/.%2e/srv/Smith', '{path}'],
      ]);
      stays(['/usr/share/zoneinfo/America/New_York', '/usr/share/fonts/truetype/DejaVu/DejaVuSans.ttf', '/usr/share/doc/docker/README.md', '/usr/lib/python3/dist-packages/PIL/Image.py', '/usr/lib/node_modules/Foo/Bar/x.js', '/usr/lib/x86_64-linux-gnu/libGL.so.1', '/usr/lib/foo/Bar.py', '/usr/local/lib/python3.12/site-packages/Foo/x.txt']);
    });
    it('m12: a dotted API version is a route, and a path of CamelCase words is not base64', () => {
      table([['http://10.0.0.5:2375/v1.41/containers/json', 'http://{private-ip}:2375/v1.41/containers/json']]);
      stays(['/v1.41/containers/json', '/v1/agents/AbCd/logs', 'src/Components/SomeVeryLongComponentName/AnotherVeryLongFileName2/Index3.tsx']);
    });
  });
  describe('m2: a path or a file in a query', () => {
    it('on a kept route, the route stays and the value goes', () => {
      table([
        ['GET /v1/agents/abc/fs/file?path=/workspace/Smith/RoeTaxes.pdf 500', 'GET /v1/agents/abc/fs/file?path={path} 500'],
        ['GET /v1/agents/abc/fs?path=/workspace/Smith%20Family/x 500', 'GET /v1/agents/abc/fs?path={path} 500'],
        ['GET /v1/agents/abc/fs/file?path=Taxes%2FJane%20Roe.pdf 500', 'GET /v1/agents/abc/fs/file?path={path} 500'],
        ['GET /api/download?file=/mnt/Smith/Taxes.pdf&user=jane HTTP/1.1', 'GET /api/download?file={path} HTTP/1.1'],
        ['GET /v1/files?path=/srv/Smith Family/x.pdf HTTP/1.1', 'GET /v1/files?path={path} HTTP/1.1'],
        ['"/v1/files?path=/srv/Smith/x.pdf"', '"/v1/files?path={path}"'],
        ['http://mybox:3000/v1/agents/abc/fs?path=/workspace/Smith/Roe.pdf', 'http://{host}:3000/v1/agents/abc/fs?path={path}'],
        ['GET /v1/agents/abc/fs/file?path=Smith%20Family%2FTaxes%2FJane%20Roe.pdf 500', 'GET /v1/agents/abc/fs/file?path={path} 500'],
        ['/v1/x?file=Taxes.pdf&y=1', '/v1/x?file={path}&y=1'],
        ['/v1/x?next=/login', '/v1/x?next={path}'],
        ['https://example.org/x?path=/home/samdoe/Smith%20Family/x', 'https://example.org/x?path=~/{path}'],
        ['https://example.org/x?file=a%5Cb&y=1', 'https://example.org/x?file={path}&y=1'],
      ]);
      stays(['/v1/x?limit=5&all=1', '/v1/x?format=json', '/v1/x?v=1.2.3', 'https://github.com/hatchabot/hatchabot/issues/new?labels=field-report']);
    });
  });
  describe('m5: a folder on a masked machine, with or without a port', () => {
    it('whatever mask the machine has', () => {
      table([
        ['http://recipe-helper:8080/Family/Taxes', 'http://{name}:8080{path}'],
        ['http://recipe-helper/Family/Taxes', 'http://{name}{path}'],
        ['http://pat:8080/Family/Taxes', 'http://{user}:8080{path}'],
        ['https://studio-laptop.example.org:8443/Family/Taxes', 'https://{host}.example.org:8443{path}'],
        ['https://studio-laptop.example.org/Family/Taxes', 'https://{host}.example.org{path}'],
        ['http://spark-box:3000/Family/Taxes?x=1', 'http://{host}:3000{path}'],
        ['http://mybox:8080/Family', 'http://{host}:8080/Family'],
        ['https://mybox:8443/v1/x/y', 'https://{host}:8443/v1/x/y'],
      ]);
    });
  });
  describe('m9, m10: a cut-off key goes to its last line, and no further', () => {
    const D = '-'.repeat(5);
    const begin = (label: string) => `${D}BEGIN ${label}${D}`, end = (label: string) => `${D}END ${label}${D}`;
    // Made-up pieces, built here so nothing in the tree is shaped like a key.
    const B = 'QUJD'.repeat(16), P = 'aB3+cD4/'.repeat(8), short = 'abc' + 'DEF' + '1234' + 'ghi';
    const J = 'Nov 05 x app[1]: ';
    it('m9: every line of it, whatever it was written in', () => {
      table([
        [`${J}${begin('PRIVATE KEY')}\n${J}${P}\n${J}${short}\n`, `${J}{key}\n`],
        [`${J}${begin('PRIVATE KEY')}\n${J}aB3+cD4/eF5+gH6/iJ7+\n${J}kL8/mN9+oP0/qR1+sT2/\n${J}uV3+wX4/yZ5+aB6/cD7+\n${J}Retrying now\n`, `${J}{key}\n${J}Retrying now\n`],
        [`Nov 05 12:00:01 x app[1]: ${begin('PRIVATE KEY')}\nNov 05 12:00:02 x app[1]: ${short}\nNov 05 12:00:03 x app[1]: Done\n`, `Nov 05 12:00:01 x app[1]: {key}\nNov 05 12:00:03 x app[1]: Done\n`],
        [`> ${begin('PRIVATE KEY')}\n> ${P}\n> ${short}\n> quoted words\n`, `> {key}\n> quoted words\n`],
        [`  ${begin('PRIVATE KEY')}\n  ${P}\n  ${short}\n`, `  {key}\n`],
        [`${D.slice(2)}BEGIN RSA PRIVATE KEY${D}\n${P}\n${short}\n`, `{key}\n`],
        [`${begin('PRIVATE KEY')}\n${B}\nabc${'DEF'}1234 [truncated]\nmore`, `{key}\nmore`],
        [`${begin('PRIVATE KEY')}\n${B}\nabc-_${'DEF'}1234\nmore`, `{key}\nmore`],
        [`${begin('PRIVATE KEY')}\n${B}\nabc\nRetrying`, `{key}\nRetrying`],
        [`"${begin('PRIVATE KEY')}\\n" +\n"${P}\\n" +\n"${short}\\n"`, `"{key}\\n"`],
        [`{"k":"${begin('PRIVATE KEY')}\\n${B}\\n${short}\\n","next":"value"}`, `{"k":"{key}\\n","next":"value"}`],
        [`key: |\n  ${begin('PRIVATE KEY')}\n  aB3cD4eF5gH6\n  iJ7kL8mN9oP0\n  rest of the yaml: value\n`, `key: |\n  {key}\n  rest of the yaml: value\n`],
        [`${begin('RSA PRIVATE KEY')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\n${B}\nabc\nnext words`, `{key}\nnext words`],
        [`${begin('X')}\nComment: "rsa-key"\n${B}\nnext words`, `{key}\nnext words`],
      ], {});
    });
    it('m10: normal text after a first line stays, and another kind of last line is no end of it', () => {
      table([
        [`${begin('RSA PRIVATE KEY')}\nError: load failed: x\nStatus: 500\nHint: run ssh-keygen\n\nDone\nnext line of words`, `{key}\nError: load failed: x\nStatus: 500\nHint: run ssh-keygen\n\nDone\nnext line of words`],
        [`${begin('OPENSSH PRIVATE KEY')}\n${B}\nabc\nRetrying\n\nDone\n/usr/bin/docker\n200\nnext line of words`, `{key}\nRetrying\n\nDone\n/usr/bin/docker\n200\nnext line of words`],
        [`Load key: expected ${begin('CERTIFICATE')}\nFailed\n\nStopped\nnext line of words`, `Load key: expected {key}\nFailed\n\nStopped\nnext line of words`],
        [`${begin('CERTIFICATE')}\nfree text in the middle\n/srv/a/b\n${end('PRIVATE KEY')}\nnext`, `{key}\nfree text in the middle\n{path}\n${end('PRIVATE KEY')}\nnext`],
        [`${begin('A')}\n${B}\n${end('A')}\nmiddle\n${begin('B')}\n${B}\nabc\nnext words here`, `{key}\nmiddle\n{key}\nnext words here`],
        [`${begin('A')}\n${B}\n${begin('B')}\n${B}\n${end('B')}\nkept`, `{key}\n{key}\nkept`],
      ], {});
      stays([`The file has no ${D}BEGIN line here and later has no ${D}END line, sorry.`, `not a key\n${end('RSA PRIVATE KEY')}\nabc`], {});
    });
  });
  describe('m3, m4, m6, m7: other ways a path or a machine is written', () => {
    it('m3: Windows', () => {
      table([
        ['$HOME\\Documents\\Taxes\\Jane.pdf', '$HOME\\{path}'],
        ['~\\Documents\\Taxes\\Jane.pdf', '~\\{path}'],
        ['$env:USERPROFILE\\Documents\\Taxes\\Jane.pdf', '$env:USERPROFILE\\{path}'],
        ['\\users\\Sam Doe\\x.pdf', '{path}'],
        ['\\Device\\HarddiskVolume3\\Users\\Sam Doe\\x.pdf', '{path}'],
        ['C%3A%5CUsers%5CSam%20Doe%5Cx.pdf', '{path}'],
        ['\\\\NAS-SMITH', '{path}'],
      ]);
      stays(['\\n and \\t and "\\nfoo\\nbar"', 'a \\\\nas b', '$FOO\\nbar']);
    });
    it('m4: a systemd unit made from a path', () => {
      table([
        ['home-samdoe-Smith\\x20Family.mount: Failed', '{path}.mount: Failed'],
        ['mnt-Smith\\x20Family.mount', '{path}.mount'],
        ['mnt-Smith.mount', '{path}.mount'],
        ['dev-disk-by\\x2dlabel-SMITH.device', '{path}.device'],
        ['backup-Smith\\x20Family.service', '{path}.service'],
      ]);
      stays(['docker.service', 'var-lib-docker-overlay2-abc-merged.mount', 'hatchabot.service failed', 'multi-user.target']);
    });
    it("m6: ssh's own lines", () => {
      table([
        ["Warning: the ECDSA host key for 'nobox2' differs from the key for the IP address '10.0.0.5'", "Warning: the ECDSA host key for '{host}' differs from the key for the IP address '{private-ip}'"],
        ['debug1: Connecting to nobox2 [10.0.0.5] port 22.', 'debug1: Connecting to {host} [{private-ip}] port 22.'],
        ["debug1: Authenticating to nobox2:22 as 'samuel'", "debug1: Authenticating to {host}:22 as '{user}'"],
      ]);
      stays(['Connecting to the database failed']);
    });
    it('m7: stuck to an option, a bucket, an editor link', () => {
      table([
        ['docker run -v$PWD/Family/x:/y img', 'docker run -v$PWD/{path}:/y img'],
        ['docker run -v~/Smith/x:/y img', 'docker run -v~/{path}:/y img'],
        ['"-v$HOME/Smith/x:/y"', '"-v$HOME/{path}:/y"'],
        ['s3://smith-family-backups/taxes/2025.pdf', 's3://{path}'],
        ['vscode://file/home/samuel/Jane Doe/taxes.pdf', 'vscode://file{path}'],
        ['/usr/lib/.%2e/srv/Smith', '{path}'],
      ]);
    });
    it('second pass', () => {
      for (const a of ['$HOME\\Documents\\x', '~\\Documents\\x', '$env:USERPROFILE\\x\\y', '\\\\NAS-SMITH', 'home-samdoe-Smith\\x20Family.mount', 'docker run -v$PWD/Family/x:/y img', 'vscode://file/home/samuel/Jane Doe/taxes.pdf', "debug1: Authenticating to nobox2:22 as 'samuel'"]) {
        const once = redactForPublic(a, c);
        expect(redactForPublic(once, c), a).toBe(once);
      }
    });
  });
  describe('M1, m8: a later word with a / or a file ending outweighs any stop', () => {
    it('a personal folder and file name are masked whole', () => {
      table([
        ['/home/samdoe/Insurance Denied Claims/Jane Roe 2025.pdf', '~/{path}'],
        ['/srv/Letters to Jane Roe/a.pdf', '{path}'],
        ['/srv/Letters from Jane Roe/a.pdf', '{path}'],
        ['/home/samdoe/Trip to Paris/IMG_0001.jpg', '~/{path}'],
        ['/home/samdoe/Notes for Jane Roe/x.txt', '~/{path}'],
        ['/home/samdoe/School Info Packets/Jane Roe.pdf', '~/{path}'],
        ['/home/samdoe/Legal Notice Drafts/Jane Roe.pdf', '~/{path}'],
        ['/mnt/Medical/Roe Critical Care/x.pdf', '{path}'],
        ['/home/samdoe/team status reports/jane roe.pdf', '~/{path}'],
        ['/srv/a b c d e f/g.txt', '{path}'],
        ['/srv/taxes for the kids/jane roe.pdf', '{path}'],
        // The look-ahead: eleven words, and the one that holds the /.
        [`/srv/a ${'w '.repeat(11)}b/c.pdf`, '{path}'],
        [`/srv/a/d ${'w '.repeat(12)}b/c.pdf`, `{path} ${'w '.repeat(12)}b/c.pdf`],
      ]);
    });
    it('other words that used to end a path: a stop, a colon, an @ and an =', () => {
      table([
        ['/home/samdoe/Jane Q. Public/taxes.pdf', '~/{path}'],
        ['/srv/J. Roe/taxes.pdf', '{path}'],
        ['/srv/Project: Roe Family/x.pdf', '{path}'],
        ['/home/samdoe/Smith @ Home/x.pdf', '~/{path}'],
        ['/home/samdoe/A B=C/x.pdf', '~/{path}'],
        ['~/.ssh/pat at work.pem', '~/{path}'],
        ['open /srv/Smith Family/taxes.pdf failed', 'open {path} failed'],
        ["/srv/Rock 'n Roll/x.pdf", '{path}'], ['/srv/Cost $5/x.pdf', '{path}'], ['/srv/Foo {2025}/x.pdf', '{path}'], ['/srv/Smith -Jones/x.pdf', '{path}'], ['/srv/Smith@Home Stuff/x.pdf', '{path}'],
      ]);
    });
    it('with nothing later like a path or file, the sentence after a path stays', () => {
      table([
        ['/srv/app/x.log ERROR Something Went Wrong In Module Loader Please Check Logs', '{path} ERROR Something Went Wrong In Module Loader Please Check Logs'],
        ['Failed to read /srv/app/config.json Status: 500', 'Failed to read {path} Status: 500'],
        ['/srv/data: Input/output error', '{path}: Input/output error'],
        ['GET /srv/a/b HTTP/1.1', 'GET {path} HTTP/1.1'],
        ['/srv/a/b: no such file', '{path}: no such file'],
        ['the end of /srv/a/bb. Next sentence', 'the end of {path}. Next sentence'],
      ]);
    });
    it('another path, an option or a setting ends the look-ahead', () => {
      table([
        ['/srv/a/b failed /srv/c/d', '{path} failed {path}'],
        ['/srv/a/b --out c/d', '{path} --out c/d'],
        ['/srv/a/b HOME=/srv/c/d', '{path} HOME={path}'],
        ['/srv/a/b ; x/y', '{path} ; x/y'],
        ['/srv/a/b ssh pat@mybox:/x/y', '{path} ssh {user}@{host}:{path}'],
      ]);
    });
    it('a kept library folder with a space in the name; a program and a file stay with their sentence', () => {
      table([['/usr/lib/foo Jane Roe/x.pdf', '/usr/lib/{path}'], ['/opt/homebrew/Cellar/Jane Roe/x', '/opt/homebrew/Cellar/{path}']]);
      stays(['/usr/lib/x.js failed in y/z', '/usr/bin/docker pull ghcr.io/hatchabot/x', '/usr/lib/x/libc.so.6 failed in y/z']);
    });
    it('a port and a folder in a path stay in it', () => {
      table([['/srv/Smith:5000/Family/Taxes/Jane.pdf', '{path}'], ['/etc/docker/certs.d/registry.smith.example:5000/ca.crt', '/etc/docker/certs.d/{path}']]);
    });
  });
});

describe('endpointIdentity (HB-0405)', () => {
  it("reads a runner's user and host, and never throws", () => {
    const fqdn = ['studio-laptop', 'example', 'org'].join('.');
    expect(endpointIdentity(`ssh://someone@${fqdn}:22`)).toEqual({ user: 'someone', hosts: [fqdn, 'studio-laptop'] });
    expect(endpointIdentity('tcp://a%ZZ@studio-laptop:2376')).toEqual({ user: 'a%ZZ', hosts: ['studio-laptop'] });
    expect(endpointIdentity('ssh://pat%20x@old-nas')).toEqual({ user: 'pat x', hosts: ['old-nas'] });
    // What the URL parser refuses or finds no host in is still read for its shape.
    expect(endpointIdentity('sam@old-nas:22')).toEqual({ user: 'sam', hosts: ['old-nas'] });
    expect(endpointIdentity('old-nas:2375')).toEqual({ hosts: ['old-nas'] });
    expect(endpointIdentity('ssh://sam@old%ZZnas')).toEqual({ user: 'sam', hosts: ['old%ZZnas'] });
    expect(endpointIdentity('ssh://sam@10.0.0.7')).toEqual({ user: 'sam', hosts: [] });
    expect(endpointIdentity('unix:///var/run/docker.sock')).toEqual({ hosts: [] });
    expect(endpointIdentity(undefined)).toEqual({ hosts: [] });
  });
});

const facts: ReportFacts = {
  version: 'v9.9.9', install: 'bundle linux-arm64', platform: 'linux-arm64', node: 'v22.0.0', openclaw: '2026.9.6',
  doctor: [{ level: 'ok', text: 'Docker 29' }, { level: 'fail', text: 'Backups: none', fix: 'run scripts/backup-volumes.sh' }],
  failures: [{ at: '2026-10-06T10:00:00Z', event: 'provision.failed', agent: 'Recipe Box', detail: '{"error":"disk full in /home/pat"}' }],
  agent: { name: 'Recipe Box', state: 'FAILED', reason: 'disk full', model: 'claude-sonnet-5', logs: 'line 1\nline 2' },
};

describe('buildReport', () => {
  it('starts with the marker, carries the facts, masked, and leaves agent names out', () => {
    const r = buildReport({ title: 'Rebuild fails at kitchen-box', whatHappened: 'It failed.', steps: '1. Rebuild', diagnosis: 'The disk check is wrong (src/x.ts:12).', confidence: 'medium', suggestedPatch: '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b', by: 'agent' }, facts, ctx);
    expect(r.body.split('\n')[0]).toBe('<!-- hatchabot-report v1 version=v9.9.9 install=bundle-linux-arm64 -->');
    expect(r.title).toBe('Rebuild fails at {host}');
    for (const h of ['### What happened', '### Steps to reproduce', '### Diagnosis (by the Hatchabot agent on this machine — confidence: medium)', '### Suggested fix (against v9.9.9)', '### Environment', '### hatchabot doctor', '### Recent failures', '### Agent log']) expect(r.body).toContain(h);
    expect(r.body).toContain('```diff\n--- a/src/x.ts');
    expect(r.body).toContain('✗ Backups: none\n    → run scripts/backup-volumes.sh');
    expect(r.body).toContain('disk full in ~');
    expect(r.body).not.toContain('Recipe Box');
  });

  it("a person's report has no agent section and no diagnosis heading", () => {
    const r = buildReport({ title: 'x', whatHappened: 'y', by: 'person' }, { version: 'v1.0.0', install: 'git checkout', platform: 'darwin-arm64', node: 'v22' }, ctx);
    expect(r.body).not.toContain('### Diagnosis');
    expect(r.body).not.toContain('### Suggested fix');
    expect(r.body).toContain('Hatchabot v1.0.0 (git checkout) · darwin-arm64 · Node v22');
  });
});

describe('how long masking takes (HB-0405)', () => {
  // On the server's one thread, and PATCH bounds a body at 60,000 characters and masks it twice: it took 17 s before.
  const big = { home: '/home/pat', user: 'pat', host: 'kitchen-box', names: Array.from({ length: 500 }, (_, i) => `Garden Notes ${i}`), people: Array.from({ length: 500 }, (_, i) => `Robin Example${i}`), hosts: ['studio-laptop'], users: ['someone'], paths: ['/mnt/pantry-nas'], secrets: ['seedling-42-compost'] };
  for (const [what, unit] of [['a.', 'a.'], ['a@', 'a@'], ['/a', '/a'], ['a-', 'a-'], ['a-.', 'a-.'], ['a:', 'a:'], ['~/a ', '~/a '], ['a+', 'a+'], ['--token a ', '--token a '], ['password a1 ', 'password a1 '], ['pass=a ', 'pass=a '], ['-u a:b ', '-u a:b '], ['mysql ', 'mysql '], ['/a/b c ', '/a/b c '], ['/a b/ ', '/a b/ '], ['/a/b A ', '/a/b A '], ['/a\\', '/a\\'], ['/a…', '/a…'], ['😀', '😀'], ['/😀', '/😀'], ['/tmp/a b/', '/tmp/a b/'], ['/a)', '/a)'], [')', ')'], ['+1 ', '+1 '], ['1.', '1.'], ['1-', '1-'], ['token ', 'token '], ['"/a', '"/a'], ["'", "'"], ['%40', '%40'], ['C:\\a ', 'C:\\a '], ['a', 'a'], ['aB1 ', 'aB1 '], ['aB1+', 'aB1+'], ['aB1/', 'aB1/'], ['-----BEGIN ', '-----BEGIN '], ['-----BEGIN a-----\n', '-----BEGIN a-----\n'], ['-----END a-----', '-----END a-----'], ['-----BEGIN a-----\naB1\n', '-----BEGIN a-----\naB1\n'], ['/usr/share/A ', '/usr/share/A '], ['/etc/ssl/certs/a ', '/etc/ssl/certs/a '], ['/proc/1/root/a/', '/proc/1/root/a/'], ['~/hatchabot/A ', '~/hatchabot/A '], ['/app/A/', '/app/A/'], ['%20a', '%20a'], ['%2', '%2'], ['$A/b ', '$A/b '], ['%A%\\a ', '%A%\\a '], ['-v/a/b ', '-v/a/b '], ['\\\\?\\a ', '\\\\?\\a '], ['{host}:1/a/b ', '{host}:1/a/b '], ['/a/b Word ', '/a/b Word '], ['/a/b and ', '/a/b and '], ['/a/b Word: ', '/a/b Word: '], ["O'Brien ", "O'Brien "], ['512 256 ', '512 256 ']] as const) {
    it(`60,000 characters of "${what}" take well under a second`, () => {
      const text = unit.repeat(Math.ceil(60_000 / unit.length)).slice(0, 60_000);
      const t0 = performance.now();
      redactForPublic(text, big);
      // Generous: a busy machine. The bug it guards against took 9 to 17 s.
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
});

describe('how long masking takes on what the third review added (HB-0405)', () => {
  const c = { home: '/home/pat', user: 'will', users: ['max', 'page'], people: ['Will Page', 'Rose Brown'] };
  for (const unit of ['-', '---BEGIN ', '---BEGIN A---\n', '---BEGIN A---\nabcDEF12\n', '---BEGIN A---\\n', 'a@', 'a@/', '/a a@a@', '{host}.a', '{host}.a/', '/a?b=', '/v1/a?b=c ', '?a=b/c&', 'home-', 'home-a.service', 'x\\x20', 'a\\x20.mount ', 'for will ', 'user will ', 'chown ', 'su -a ', '-rw-r--r-- 1 a b ', 'usermod a ', '$HOME\\', '~\\a ', '-v$A/', '%2Fa', 'a%5C', '/a/b c ', '/a/b. c ', '/a/b: c ', '/usr/lib/a b ', 'Aa1/']) {
    it(`60,000 characters of ${JSON.stringify(unit)} take well under a second`, () => {
      const text = unit.repeat(Math.ceil(60_000 / unit.length)).slice(0, 60_000);
      const t0 = performance.now();
      redactForPublic(text, c);
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
});

describe('how long masking takes with many names (HB-0405)', () => {
  it('2,000 names, all of them in 60,000 characters of text, take well under a second', () => {
    const names = Array.from({ length: 2000 }, (_, i) => `Word${i} Other${i}`);
    const text = names.join(' ').repeat(2).slice(0, 60_000);
    const t0 = performance.now();
    const out = redactForPublic(text, { names });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(out.startsWith('{name} {name}')).toBe(true);
  });
});

// What the last check before v2.173.0 found still going public (HB-0501), and the credential shapes of HB-0497 and HB-0499.
describe('credential shapes in JSON, hashes and key files (HB-0501, HB-0499, HB-0497)', () => {
  const table = (rows: ReadonlyArray<readonly [string, string]>) => { for (const [a, b] of rows) expect(redactForPublic(a, {}), a).toBe(b); };
  const stays = (rows: readonly string[]) => { for (const a of rows) expect(redactForPublic(a, {}), a).toBe(a); };
  it('a quote inside a quoted value does not cut it', () => {
    table([
      [String.raw`{"pass":"a\"b-made-up"}`, '{"pass":"***"}'],
      [String.raw`\"pass\":\"a\\\"b-made-up\"`, String.raw`\"pass\":\"***\"`],
      [String.raw`'pass': 'it\'s-made-up'`, `'pass': '***'`],
      [String.raw`"GARDEN_KEY":"a\"b-made-up"`, '"GARDEN_KEY":"***"'],
      [String.raw`{"x":"{\"token\":\"a\\\"b-made-up\"}"}`, String.raw`{"x":"{\"token\":\"***\"}"}`],
    ]);
  });
  it('a cut-off value, an unquoted one, and Ruby hashes', () => {
    table([
      [String.raw`\"password\":\"made-up`, String.raw`\"password\":\"***`],
      [String.raw`\"token\":123456`, String.raw`\"token\":***`],
      ['{"pass":123456}', '{"pass":***}'],
      [':password => "made-up"', ':password => "***"'],
      ['password => made-up', 'password => ***'],
    ]);
  });
  it('mixed quoting that proper escaping does not make', () => {
    table([
      [String.raw`\\"password\":\"made-up\"`, String.raw`\\"password\":\"***\"`],
      [String.raw`\"pass":"made-up"`, String.raw`\"pass":"***"`],
      [String.raw`"pass\":\"made-up\"`, String.raw`"pass\":\"***\"`],
    ]);
    stays(['{"test_pass":12}', '{"pass":true}', String.raw`\"pass\":\"ok\"`, '"monkey":"banana"', 'token => token.trim()']);
  });
  it('a number after the name, a bearer value, known prefixes, and a quoted -p (HB-0499)', () => {
    table([
      ['TOKEN2=abc', 'TOKEN2=***'], ['PASSWORD1=abc', 'PASSWORD1=***'], ['API_KEY_2=abc', 'API_KEY_2=***'], ['SECRET_KEY_BASE=abc', 'SECRET_KEY_BASE=***'],
      ['got bearer abc123def', 'got bearer ***'], ['sent Basic bWFkZTp1cA==.', 'sent Basic ***.'],
      ['glpat-made-up-12', '***'], ['hf_MadeUp1234', '***'],
      [`mysql -p'hunter 22'`, 'mysql -p***'], ['mysql -p"made up" db', 'mysql -p*** db'], ["mysql -p'made up", 'mysql -p***'], ["sshpass -p 'made up' ssh x", 'sshpass -p *** ssh x'],
    ]);
    stays(['send a bearer token in the header', 'use basic auth', 'basic v2 API', 'Bearer Token missing', 'Bearer $GARDEN_TOKEN', 'pip install hf_transfer', 'mysql is down, try docker run -p3306:3306']);
  });
  it('a PuTTY key file goes whole, with no BEGIN line (HB-0497)', () => {
    const ppk = ['PuTTY-User-Key-File-3: ssh-ed25519', 'Encryption: none', 'Comment: made-up-key', 'Public-Lines: 2', 'AAAAC3MadeUpMadeUpMadeUpMadeUpMadeUp+MadeUp/MadeUp', 'MadeUpMadeUp',
      'Private-Lines: 1', 'AAAAIMadeUpPrivateMadeUpMadeUpMadeUp+Xyz=', 'Private-MAC: 0123456789abcdef0123456789abcdef'];
    table([
      [`key:\n${ppk.join('\n')}\nDone`, 'key:\n{key}\nDone'],
      [`"${ppk.join('\\n')}"`, '"{key}"'],
      // Cut off: to the last line of base64.
      [`${ppk.slice(0, 8).join('\n')}\nError: x`, '{key}\nError: x'],
      // Pasted from the private half.
      [`${ppk.slice(6).join('\n')}\nDone`, '{key}\nDone'],
    ]);
  });
});

// The review of the first fix (HB-0501): two of its changes let a credential through, and some masks went too far.
describe('the review of the HB-0501 fix: a leak is worse than a lost word', () => {
  const table = (rows: ReadonlyArray<readonly [string, string]>) => { for (const [a, b] of rows) expect(redactForPublic(a, {}), a).toBe(b); };
  const stays = (rows: readonly string[]) => { for (const a of rows) expect(redactForPublic(a, {}), a).toBe(a); };
  it('a pass or key value ending in a backslash does not take the next field with it', () => {
    let text = JSON.stringify({ db_pass: 'Made-up\\', GARDEN_KEY: 'made-up-2', other_pass: 'made-up-3' });
    for (let level = 0; level < 3; level++) {
      const out = redactForPublic(`log: ${text}`, {});
      for (const v of ['Made-up', 'made-up-2', 'made-up-3']) expect(out, `level ${level}: ${text}`).not.toContain(v);
      text = JSON.stringify(text);
    }
    table([[String.raw`{'pass': 'a\\', 'other_pass': 'Made-up9'}`, `{'pass': '***', 'other_pass': '***'}`]]);
  });
  it('a password stuck to -p is the whole shell word', () => {
    table([[String.raw`mysql -u root -p'it'\''s-Made9' mydb`, 'mysql -u root -p*** mydb'], ["mysqldump -u root -p'ab'cd123 db", 'mysqldump -u root -p*** db'], ['mysql -p"$X"Made9 db', 'mysql -p*** db'],
      [String.raw`sshpass -p 'it'\''s-Made9' ssh x`, 'sshpass -p *** ssh x'], ["sshpass -p'ab'Made9 ssh x", 'sshpass -p*** ssh x']]);
  });
  it('camelCase and mixed-case pass and key names', () => {
    table([['{"dbPass":"made-up"}', '{"dbPass":"***"}'], ['{"mqttPass":"made9"}', '{"mqttPass":"***"}'], ['{"sshKey":"made-up"}', '{"sshKey":"***"}'], ['{"authKey":"made9"}', '{"authKey":"***"}'],
      ['{"appKey":"made9"}', '{"appKey":"***"}'], ['dbPass=made9', 'dbPass=***'], ['"Garden_Key":"abc1"', '"Garden_Key":"***"'], ['"garden_KEY":"abc1"', '"garden_KEY":"***"'], ['Garden_Key=abc', 'Garden_Key=***']]);
    stays(['bypass=on', 'compass=north', 'monkey=x', 'sortKey: name', 'testPass=12', "const p = ok ? 'dbPass' : cfg.pass;", "typeof rt === 'string' ? 'session-key' : rt?.source;"]);
  });
  it('bearer and basic: a token, not a word', () => {
    table([['basic YWJjZGVm here', 'basic *** here'], ['bearer Made.Up9.Token', 'bearer ***'], ['got bearer abc123def', 'got bearer ***']]);
    stays(['a basic step-by-step guide', 'basic read-only access', 'Use basic v2.173.1 or later', '<i>Basic Information</i>', 'bearer (ownerForCliToken rejects it)', "'Bearer hatchabot_'"]);
  });
  describe('a PuTTY key file with a prefix on every line', () => {
    const line = (n: number) => `AAAA${`MadeUp${n}+Key/`.repeat(8)}`.slice(0, 64);
    const ppk = ['PuTTY-User-Key-File-2: ssh-rsa', 'Encryption: none', 'Comment: made-up-key', 'Public-Lines: 2', line(1), line(2), 'Private-Lines: 3', line(3), line(4), 'TailMadeUp5=', 'Private-MAC: 0123456789abcdef'];
    const forms: Array<[string, (l: string, i: number) => string]> = [
      ['an indent', (l) => `    ${l}`], ["a quote's >", (l) => `> ${l}`], ['spaces at the end', (l) => `${l}  `],
      ["a journal's prefix, its time changing", (l, i) => `Nov 06 10:00:${String(i).padStart(2, '0')} box app[12]: ${l}`], ["cat -n's numbers", (l, i) => `${String(i + 1).padStart(6)}\t${l}`],
    ];
    for (const [what, wrap] of forms) {
      it(what, () => {
        const out = redactForPublic(`${ppk.map(wrap).join('\n')}\nDone`, {});
        expect(out).toContain('{key}');
        expect(out).not.toContain('MadeUp');
        expect(out.endsWith('Done')).toBe(true);
      });
    }
    it('a cut-off key keeps the word after it; a header named in a sentence, or headers with no key, stay', () => {
      table([[`Key contents:\nPrivate-Lines: 1\n${line(1)}\nok\nnext`, 'Key contents:\n{key}\nok\nnext']]);
      stays(['the header Private-Lines: says how many lines follow, then the MAC', 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nok']);
    });
  });
});

// The second review of the HB-0501 fix: what still went through, or newly did.
describe('the second review of the HB-0501 fix', () => {
  const table = (rows: ReadonlyArray<readonly [string, string]>) => { for (const [a, b] of rows) expect(redactForPublic(a, {}), a).toBe(b); };
  const stays = (rows: readonly string[]) => { for (const a of rows) expect(redactForPublic(a, {}), a).toBe(a); };
  it('an unquoted value after a quoted pass or key name goes, whatever it looks like', () => {
    table([['"DB_PASS": Correct.Horse.Battery', '"DB_PASS": ***'], ['- "SMTP_PASS": Spring.Time', '- "SMTP_PASS": ***'], ["'db_pass' => Hunter.Two", "'db_pass' => ***"], ['"DB_PASS": (made2up)', '"DB_PASS": ***)']]);
    stays(["const p = ok ? 'dbPass' : cfg.pass;"]);
  });
  it('curly and fullwidth forms after a bare pass name, and a mask inside a value', () => {
    table([['DB_PASS: “a b c”', 'DB_PASS: ***'], ['DB_PASS：made2up', 'DB_PASS：***'], ['DB_PASS=made2up?token=abc', 'DB_PASS=***'], ['DB_PASS:made2up=token：x', 'DB_PASS:***']]);
    stays(['--token ${t.json.token} --url x', 'data-key="${esc(key)}"']);
  });
  it('bearer and basic: mixed-case tokens with dashes, padding in the length, digits alone', () => {
    table([['got bearer P-aZpirnuXNeavY', 'got bearer ***'], ['bearer AbCd-EfGh-IjKl', 'bearer ***'], ['basic Ym9iOmE=', 'basic ***'], ['basic YWI6Y2Q=', 'basic ***'], ['bearer 40805404', 'bearer ***'], ['bearer CDQh-rmc', 'bearer ***']]);
    stays(['a basic step-by-step guide', 'a basic Step-By-Step guide', 'basic read-only access', 'Use basic v2.173.1 or later', 'bearer Abc-Def']);
  });
  it("docker's auth, PascalCase and pw names, and credentials", () => {
    const auth = Buffer.from('sam:made-up').toString('base64');
    table([[`{"auths":{"registry.example":{"auth":"${auth}"}}}`, '{"auths":{"registry.example":{"auth":"***"}}}'], ['DbPass=made2up', 'DbPass=***'], ['WifiPass: madeup', 'WifiPass: ***'],
      ['adminPASS=x9', 'adminPASS=***'], ['routerPw=made2up', 'routerPw=***'], ['pw=made2up', 'pw=***'], ['"pw": "made2up"', '"pw": "***"'], ['"credentials": "sam:made-up"', '"credentials": "***"']]);
    stays(['"auth": "oauth"', '"auth": true', "fetch(u, { credentials: 'include' })", 'bypass=on', 'SortKey: name']);
  });
  describe('a PuTTY key file wrapped again, or behind a timestamp or grep -n', () => {
    const b64 = Array.from({ length: 14 }, (_, i) => `AAAA${`MadeUp${i}+Key/`.repeat(8)}`.slice(0, 64)).join('');
    const ppk = (width: number) => ['PuTTY-User-Key-File-2: ssh-rsa', 'Encryption: none', 'Comment: made-up-key', 'Public-Lines: 1', 'AAAAB3NzaC1yc2EAAAAMadeUp', 'Private-Lines: 14',
      ...(b64.match(new RegExp(`.{1,${width}}`, 'g')) ?? []), 'Private-MAC: 0123456789abcdef'];
    for (const width of [32, 30]) {
      it(`wrapped at ${width}`, () => {
        const out = redactForPublic(`${ppk(width).join('\n')}\nDone`, {});
        expect(out).toBe('{key}\nDone');
      });
    }
    it('docker logs --timestamps and grep -n', () => {
      const lines = ppk(64);
      for (const wrap of [(l: string, i: number) => `2026-11-06T10:00:${String(i).padStart(2, '0')}.123456789Z ${l}`, (l: string, i: number) => `${i + 1}:${l}`, (l: string, i: number) => `key.ppk:${i + 1}:${l}`]) {
        const out = redactForPublic(`${lines.map(wrap).join('\n')}\nDone`, {});
        expect(out).not.toContain('MadeUp');
        expect(out.endsWith('Done')).toBe(true);
      }
    });
  });
});

describe('the final review of the HB-0501 fix', () => {
  it("a curly closer ends a value only before a separator, so an apostrophe inside it does not leave the rest", () => {
    const cases: Array<[string, string]> = [
      ['DB_PASSWORD=‘O’Brien2024’ next=1', 'Brien2024'], ['password: ‘Bob’s-fake-dog’', 's-fake-dog'], ['api_key: ‘k’3yValue’', '3yValue'],
      ['token=“abc”def123', 'def123'], ['password: «abc»def', 'abc'], ['"password": ‘Bob’s-fake-dog’', 's-fake-dog'], ['“password”: ‘Bob’s-fake-dog’', 's-fake-dog'],
      ['"dbPass": ‘Bob’s-fake-dog’', 's-fake-dog'], ["password='it's-Secret9'", 'Secret9'], ['password="abc"def123', 'def123'],
    ];
    for (const [text, rest] of cases) expect(redactForPublic(text, {}), text).not.toContain(rest);
    expect(redactForPublic('DB_PASSWORD=‘O’Brien2024’ next=1', {})).toBe('DB_PASSWORD=‘***’ next=1');
    expect(redactForPublic('‘token’: ‘O’Brien2024’, ‘next’: 1', {})).toBe('‘token’: ‘***’, ‘next’: 1');
  });

  it('a quoted value that does end at its quote keeps what follows it', () => {
    expect(redactForPublic('error: invalid token: ‘expired’ (code 401)', {})).toBe('error: invalid token: ‘***’ (code 401)');
    expect(redactForPublic('token=«abc» other=1', {})).toBe('token=«***» other=1');
    expect(redactForPublic('The password “must” be 8 chars', {})).toBe('The password “must” be 8 chars');
    expect(redactForPublic('Its "apiKey": "seed1".', {})).toBe('Its "apiKey": "***".');
    expect(redactForPublic("set `HATCHABOT_PASSWORD='p@ss'`. Then", {})).toBe("set `HATCHABOT_PASSWORD='***'`. Then");
  });

  it('a backslash-escaped double quote in logfmt stays in the value, unless the next setting follows the quote', () => {
    expect(redactForPublic('level=info user=bob token="abc\\" def" next=1', {})).toBe('level=info user=bob token="***" next=1');
    expect(redactForPublic('password="a\\" b"', {})).toBe('password="***"');
    expect(redactForPublic('password="p@ss\\" token="x"', {})).toBe('password="***" token="***"');
    expect(redactForPublic('docker run -e DB_PASSWORD="a b" -e USER=x img', {})).toBe('docker run -e DB_PASSWORD="***" -e USER=x img');
    expect(redactForPublic("password='it\\'s' user=bob", {})).toBe("password='***' user=bob");
  });

  it('an arrow function that builds an object, calls a constant or fills a template is code, and a value after => still goes', () => {
    for (const code of ['tokens.map(token => ({ id: token.id }))', 'token => JSON.parse(token)', 'password => PASSWORD_RE.test(password)', 'token => [token]', 'token => `Bearer ${token}`']) {
      expect(redactForPublic(code, {}), code).toBe(code);
    }
    expect(redactForPublic('token => `s3cret`', {})).toBe('token => ***');
    expect(redactForPublic('password => [hunter22]', {})).not.toContain('hunter22');
  });
});

describe('how long masking takes on what the final review of HB-0501 added', () => {
  // A prefix of numbers read each space as [ \t]*, so a line of digits could be split every way: 8 numbers took 1.7 s,
  // 10 took 19 s. Journal lines of digits were quadratic.
  for (const k of [8, 10, 20, 90, 100]) {
    it(`a PuTTY key line after ${k} numbers, then a line of digits, is fast`, () => {
      const text = `${Array(k).fill('1').join(' ')} x PuTTY-User-Key-File-3: ssh-ed25519\n${'1'.repeat(40)}y\n`;
      const t0 = performance.now();
      redactForPublic(text, {});
      expect(performance.now() - t0).toBeLessThan(250);
    });
  }
  it('journal-prefixed PuTTY key lines, each then a line of digits after the date, are fast', () => {
    // Each line is read up to 8,192 characters, so the old cost was about 80 ms a line: 50 of them took 4 s.
    const text = `Nov 06 10:22:33 box app[12]: PuTTY-User-Key-File-3: ssh-ed25519\n${`Nov 06${'1'.repeat(8000)}\n`}`.repeat(50);
    const t0 = performance.now();
    redactForPublic(text, {});
    expect(performance.now() - t0).toBeLessThan(250);
  });
  const units = ['password="', 'password="a"b', "password='a'b", 'password=‘a’b', '"password": ‘', '"password": ‘a’b', 'token=«a»b', '’', 'password="x" ', 'pw="a"x ', 'KEY="a"b',
    'token => `', 'token => `${', 'token => ({', 'token => JSON.parse('];
  for (const u of units) {
    const text = u.repeat(Math.ceil(60_000 / u.length)).slice(0, 60_000);
    it(`60,000 characters of ${JSON.stringify(u)} take well under a second`, () => {
      const t0 = performance.now();
      redactForPublic(text, {});
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
  it('lines of an opening quote then 4,100 characters with no end are fast', () => {
    const text = `password=“${'x'.repeat(4100)}\n"password": ‘${'x'.repeat(4100)}\n`.repeat(30);
    const t0 = performance.now();
    redactForPublic(text, {});
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('how long masking takes on what the second review of HB-0501 added', () => {
  const units = ["a='b\\' ", "token='a\\' ", "'\\'", '"a\\" ', 'password="a\\" ', '“', '«', '„', '「', '＂', 'password: “', 'DB_PASS: “', 'DB_PASS：', 'a_pass=“', 'Abc', 'AbcPASS=', 'aBcPw=', 'DbPass=', '"auth":"',
    '"auth":"QUJD', '"credentials":"', 'pw=', 'x ? ', "x ? 'password' : a.b", 'password => q(', 'bearer Ab-', 'basic Ym9=', 'bearer 1234', '${a}', '${', 'DB_PASS=${', 'DB_PASS=a?token=***',
    '1:Private-Lines: 1\n', '2026-11-06T10:00:01Z Private-Lines: 1\n', 'Private-Lines: 1\nAAAA\nAAAA\n', 'Private-Lines: 1\nAAAAAAAAAAAAAAAAAAAAAAAA1\n', 'AAAA\n'];
  const singles: Array<[string, string]> = [
    ['Private-Lines: 1 then base64 lines with no MAC', `Private-Lines: 1\n${'AAAA\n'.repeat(12_000)}`],
    ['Private-Lines: 1 then 30-wide base64 lines', `Private-Lines: 1\n${`${'Ab1+'.repeat(7)}Ab\n`.repeat(2_000)}`],
    ['a 200-character numbered prefix', `${'1 '.repeat(100)}Private-Lines: 1\n${`${'2 '.repeat(100)}AAAA\n`.repeat(250)}`],
    ['a quote then 60,000 capitals', `"${'A'.repeat(60_000)}`],
    ['a name then 60,000 capitals and PASS', `a${'A'.repeat(60_000)}PAS=`],
  ];
  for (const [what, text] of [...units.map((u) => [JSON.stringify(u), u.repeat(Math.ceil(60_000 / u.length)).slice(0, 60_000)] as [string, string]), ...singles]) {
    it(`60,000 characters of ${what} take well under a second`, () => {
      const t0 = performance.now();
      redactForPublic(text, {});
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
});

describe('how long masking takes on what the review of HB-0501 added', () => {
  const units = ['“', '“password”: “', '‘token’：', '：', 'password：', '"password"：“a', '? ', "? 'api-key' : ", "? 'pass' : a.b ", '?\t', 'aB', '"aB', 'dbPass=', '"dbPass":', 'a_Key=', '"a_KEY":', 'Garden_Key=',
    'token => ', 'token => token && ', 'password => !', 'password => (', 'x => x.y ', "mysql -p'a'\\''", 'mysql -p"\\', 'mysql -p\\', "sshpass -p 'a'", 'bearer a1', 'basic a-b-', 'Bearer v1.2.', '> ',
    '> PuTTY-User-Key-File-3: x\n', '> Private-Lines: 1\n> AAAA\n', 'Nov 06 box app[12]: Private-Lines: 1\n', '     1\tPrivate-Lines: 1\n', 'Private-Lines: 0\n', 'Private-Lines: 9999\nAAAA\n', 'Private-Lines: 1\n\n',
    'Private-Lines: 1\nok\n', 'PuTTY-User-Key-File-3: x\nComment: x\n', 'Private-Lines: 1\\nAAAA\\n', '\\\\\\\\\\\\\\"', '\\\\\\"pass\\\\\\":\\\\\\"a\\\\\\\\\\\\\\"', "'it\\'", "password='a\\"];
  const singles: Array<[string, string]> = [
    ['a quote then aB… with no end', `"${'aB'.repeat(30_000)}`],
    ['aB… then =', `${'aB'.repeat(30_000)}=`],
    ['? then 60,000 spaces and a name', `?${' '.repeat(60_000)}'api-key' : a.b`],
    ['token => token then 60,000 spaces', `token => token${' '.repeat(60_000)}&&`],
    ['Private-Lines: 1 then one 60,000-character line', `Private-Lines: 1\n${'A'.repeat(60_000)}`],
    ['a PuTTY line then 9,000-character lines', `PuTTY-User-Key-File-3: x\n${`${'A'.repeat(9000)}\n`.repeat(7)}`],
    ['a 200-character prefix then header lines', `${'x '.repeat(100)}Private-Lines: 1\n${`${'x '.repeat(100)}Comment: y\n`.repeat(250)}`],
    ['\\"token\\":\\" then runs of 15 backslashes', `\\"token\\":\\"${'abc\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"'.repeat(3000)}`],
    ['mysql -p then 60,000 characters of shell pieces', `mysql -p${"'a'\\x\"b\"".repeat(6000)}`],
  ];
  for (const [what, text] of [...units.map((u) => [JSON.stringify(u), u.repeat(Math.ceil(60_000 / u.length)).slice(0, 60_000)] as [string, string]), ...singles]) {
    it(`60,000 characters of ${what} take well under a second`, () => {
      const t0 = performance.now();
      redactForPublic(text, {});
      // Generous: a busy machine. Each takes under 0.1 s here.
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
});

describe('how long masking takes on what HB-0501 added', () => {
  const units = ['\\', '\\"', '\\\\"', '"\\', '\\"token\\":', '\\"token\\":\\"', '\\\\\\"token\\\\\\":\\\\\\"', '"pass":"', '"pass":"\\', '"pass":"a\\"', '\\"pass\\":\\"a\\\\\\"', '\\\\"pass\\":"', "'token' => ", 'password => ', 'password =>', ':token=>', '=>', '= ', ' ', '"', "'", '\\\\\\"',
    'bearer ', 'bearer a1 ', 'Basic ', 'basic a', "mysql -p'", 'mysql -p"a ', "sshpass -p '", 'PuTTY-User-Key-File-1:', 'PuTTY-User-Key-File-1:\n', 'PuTTY-User-Key-File-1:\nAAAA\n', 'Private-Lines: 1\n', 'Private-Lines: 1\\n', 'Comment: x\n', 'Private-Lines:',
    'glpat-', 'glpat-aaaaaaaa', 'hf_', 'hf_a', 'ghp_', 'github_pat_', 'TOKEN2=', 'API_KEY_2=', 'a_', 'token_', 'secret_key_base', '"a_', '"KEY":', '"x_key":"'];
  const singles: Array<[string, string]> = [
    ['"token": then 60,000 backslashes', `"token":${'\\'.repeat(60_000)}`],
    ['"token": " then 60,000 backslashes', `"token": "${'\\'.repeat(60_000)}`],
    ['\\"token\\":\\" then 60,000 backslashes', `\\"token\\":\\"${'\\'.repeat(60_000)}`],
    ['\\"token\\":\\" then escaped quotes', `\\"token\\":\\"${'\\\\\\"'.repeat(15_000)}`],
    ['password then 60,000 spaces and =>', `password${' '.repeat(60_000)}=>`],
    ['"pass" then 60,000 spaces', `"pass"${' '.repeat(60_000)}`],
    ['hf_ then 60,000 letters', `hf_${'a'.repeat(60_000)}`],
    ['a quote then 60,000 name characters', `"${'a_'.repeat(30_000)}"`],
    ['a PuTTY line then 60,000 letters', `PuTTY-User-Key-File-1:\n${'A'.repeat(60_000)}`],
    ['a PuTTY line then lines too long for base64', `PuTTY-User-Key-File-1:\n${`${'A'.repeat(129)}\n`.repeat(460)}`],
  ];
  for (const [what, text] of [...units.map((u) => [JSON.stringify(u), u.repeat(Math.ceil(60_000 / u.length)).slice(0, 60_000)] as [string, string]), ...singles]) {
    it(`60,000 characters of ${what} take well under a second`, () => {
      const t0 = performance.now();
      redactForPublic(text, {});
      // Generous: a busy machine. Each takes under 0.1 s here.
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
});

describe('the masks and GitHub markdown (HB-0405)', () => {
  it('a mask outside a code fence is not shaped like an HTML tag, which GitHub would drop', () => {
    const r = buildReport({ title: 'Fails on kitchen-box', whatHappened: 'open /srv/a/b failed for sam@example.org at 203.0.113.7 on old-nas.local', by: 'person' },
      { version: 'v1.0.0', install: 'git checkout', platform: 'linux-x64', node: 'v22' }, ctx);
    expect(r.title).toBe('Fails on {host}');
    expect(r.body).toContain('open {path} failed for {email} at {ip} on {host}');
    // The report's own first-line comment cut by position, not a tag regexp (CodeQL
    // js/bad-tag-filter, HB-0620); a `<!--` anywhere else stays and is judged.
    const head = r.body.startsWith('<!--') ? r.body.indexOf('-->') : -1;
    const prose = (head < 0 ? r.body : r.body.slice(head + 3)).replace(/<\/?sub>/g, '');
    expect(prose).not.toMatch(/<[a-z-]+>/);
  });
  it('a draft kept with the old masks moves to the new ones as it leaves', () => {
    expect(redactForPublic('open <path> for <user>@<host> at <private-ip>, ~/<path>', ctx)).toBe('open {path} for {user}@{host} at {private-ip}, ~/{path}');
  });
});

describe('issueUrl', () => {
  it('a short report goes whole into the link, with the label', () => {
    const { url, trimmed } = issueUrl('T', 'short body');
    expect(trimmed).toBe(false);
    expect(url).toBe('https://github.com/hatchabot/hatchabot/issues/new?labels=field-report&title=T&body=short%20body');
  });

  it('a long one is cut to fit, bulky sections first, and asks for the file', () => {
    const r = buildReport({ title: 'x', whatHappened: 'what', diagnosis: 'why', by: 'agent' }, { ...facts, agent: { ...facts.agent!, logs: 'log line\n'.repeat(2000) } }, ctx);
    const { url, trimmed } = issueUrl(r.title, r.body, { file: 'hatchabot-report-a.md', max: 7500 });
    expect(trimmed).toBe(true);
    expect(url.length).toBeLessThanOrEqual(7500);
    const body = decodeURIComponent(url.split('&body=')[1]!);
    expect(body).toContain('### Agent log (last lines) — in the attached file');
    expect(body).toContain('### Diagnosis');
    expect(body).toContain('hatchabot-report-a.md');
  });

  it('a cut that falls inside an emoji still makes a link (#159)', () => {
    // The title's clip at 120 units lands between the halves of a pair.
    const words = 'ab '.repeat(39) + 'a'; // 118 units
    const r = buildReport({ title: words + '🙂🙂', whatHappened: '🙂'.repeat(3000), by: 'person' }, { version: 'v1.0.0', install: 'git checkout', platform: 'linux-x64', node: 'v22' }, ctx);
    expect(r.title).toBe(words + '…');
    // Every shrink step of a body of emoji, an odd number of units long.
    for (const extra of ['', 'a']) {
      const { url, trimmed } = issueUrl(r.title, extra + r.body, { max: 3000 });
      expect(trimmed).toBe(true);
      expect(decodeURIComponent(url.split('&body=')[1]!)).toContain('🙂');
    }
    // A lone half pasted in is shown as a replacement character, not an error.
    expect(decodeURIComponent(issueUrl('T', 'broken \uD83D here').url.split('&body=')[1]!)).toBe('broken � here');
  });
});

describe('the installed source, read-only', () => {
  it('refuses the install\'s own state and anything outside', () => {
    for (const p of ['.env', 'data/hatchabot.sqlite', 'node_modules/x/index.js', '.git/config', '../etc/passwd', '/etc/passwd', 'src/../.env', '']) {
      expect(() => sourcePath(process.cwd(), p), p).toThrow();
    }
    expect(sourcePath(process.cwd(), 'src/api/routes.ts')).toMatch(/src\/api\/routes\.ts$/);
  });

  it('reads with line numbers, at most 400 lines; a folder lists its files', () => {
    const r = readSource(process.cwd(), 'src/orchestrator/problemReport.ts', 1, 5000);
    expect(r.to - r.from).toBe(399 < r.lines ? 399 : r.lines - 1);
    expect(r.text.split('\n')[0]).toMatch(/^1\t/);
    expect(readSource(process.cwd(), 'docs').text).toContain('field-reports.md');
    expect(() => readSource(process.cwd(), 'docs/no-such-file.md')).toThrow(/No file/);
  });

  it('the knowledge pack comes first and is never crowded out by code (a broad "400" missed the playbook, 2026-10-07)', async () => {
    const hit = await searchSource(process.cwd(), '400');
    expect(hit.matches[0]!.path).toBe('docs/troubleshooting.md');
    const entry = hit.matches.find((m) => m.path === 'docs/troubleshooting.md' && /request format rejected/.test(m.text));
    expect(entry?.entry).toMatch(/^Every message fails with "LLM request failed/);
    expect(hit.matches.filter((m) => !m.path.startsWith('docs/troubleshooting.md') && !m.path.startsWith('docs/architecture-map.md')).length).toBeLessThanOrEqual(40);
  });

  it('a draft that quotes a known error names the playbook entry (the real draft, 2026-10-07)', () => {
    const real = "HTTP 400 'request format rejected' on every request when model = claude-opus-5-5\n### What happened\nWhen the chat was switched to claude-opus-5-5, every message failed with 'LLM request failed (request format rejected, HTTP 400).'";
    expect(knownProblems(process.cwd(), real).map((k) => k.title)[0]).toMatch(/request format rejected, HTTP 400/);
    expect(knownProblems(process.cwd(), 'The garden agent planted tomatoes in "the wrong raised bed again" today.')).toEqual([]);
  });

  it('searches the code and docs, capped', async () => {
    const hit = await searchSource(process.cwd(), 'export function redactForPublic');
    expect(hit.matches.some((m) => m.path === 'src/orchestrator/problemReport.ts')).toBe(true);
    const many = await searchSource(process.cwd(), 'import', 'src', 5);
    expect(many.matches).toHaveLength(5);
    expect(many.more).toBe(true);
    expect((await searchSource(process.cwd(), 'HATCHABOT_SECRET_KEY', 'docs')).matches.every((m) => m.path.startsWith('docs/'))).toBe(true);
  });
});

describe('check_known_problem (matchKnownProblems)', () => {
  const titles = readFileSync('docs/troubleshooting.md', 'utf8').split(/^### /m).slice(1).map((b) => b.split('\n')[0]!.trim());
  it('every playbook entry is found first from its own symptom line', () => {
    const missed = titles.filter((t) => matchKnownProblems(process.cwd(), t, 'v2.138.0').matches[0]?.title !== t);
    expect(missed).toEqual([]);
  }, 30_000); // each entry against all of them: grows with the playbook (703 entries: 3 s with it parsed once, 19–33 s before)
  it('the incident the Hatchabot agent got wrong is found from how it was described (2026-10-07), with the whole entry', () => {
    const r = matchKnownProblems(process.cwd(), "taxkit QA: every message failed with 'LLM request failed (request format rejected, HTTP 400)' when the chat was switched to Claude Opus 5.5", 'v2.138.0');
    expect(r.matches[0]!.title).toMatch(/request format rejected, HTTP 400/);
    expect(r.matches[0]!.text).toMatch(/\*\*Check:\*\*[\s\S]*\*\*Cause:\*\*[\s\S]*\*\*Fix:\*\*/);
  });
  it('says nothing rather than something wrong', () => {
    for (const q of ['how do I invite my partner to an agent', 'the agent is slow to answer', 'can I rename an agent', 'my agent gives wrong answers about recipes']) {
      expect(matchKnownProblems(process.cwd(), q, 'v2.138.0').matches, q).toEqual([]);
    }
  });
  it('a fix in a newer release than the one installed says so', () => {
    const stale = matchKnownProblems(process.cwd(), 'A runner agent shows as running although its container stopped or is gone', 'v2.133.0').matches[0]!;
    expect(stale).toMatchObject({ fixedIn: 'v2.134.0', fixedInNewerRelease: true });
    expect(matchKnownProblems(process.cwd(), 'A runner agent shows as running although its container stopped or is gone', 'v2.138.0').matches[0]!.fixedInNewerRelease).toBe(false);
    expect(newerRelease('v2.10.0', 'v2.9.9')).toBe(true);
  });
});

describe('the routes', () => {
  const as = (who: string) => ({ 'x-hatchabot-owner': who });
  async function app() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, reportDoctor: async () => [{ level: 'ok', text: 'Docker 29 (made up)' }],
    } as never);
    return { f, store };
  }

  it('a draft is private to who made it, carries the facts, and only changes when edited', async () => {
    const { f } = await app();
    const r = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: as('owner-1'), payload: { title: 'Backups stop', whatHappened: 'Nothing since Monday.', by: 'agent', diagnosis: 'x' } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json() as { id: string; body: string; issueUrl: string; reviewPath: string; by: string };
    expect(d.by).toBe('agent');
    expect(d.body).toContain('✓ Docker 29 (made up)');
    expect(d.issueUrl).toMatch(/^https:\/\/github\.com\/hatchabot\/hatchabot\/issues\/new\?/);
    expect(d.reviewPath).toBe(`/#report=${d.id}`);
    expect((await f.inject({ method: 'GET', url: `/v1/problem-reports/${d.id}`, headers: as('someone-else') })).statusCode).toBe(404);
    expect((await f.inject({ method: 'GET', url: '/v1/problem-reports', headers: as('someone-else') })).json()).toEqual([]);
    const e = await f.inject({ method: 'PATCH', url: `/v1/problem-reports/${d.id}`, headers: as('owner-1'), payload: { body: 'my own words' } });
    expect((e.json() as { body: string }).body).toBe('my own words');
    expect((await f.inject({ method: 'POST', url: `/v1/problem-reports/${d.id}/sent`, headers: as('owner-1') })).statusCode).toBe(200);
    expect(((await f.inject({ method: 'GET', url: '/v1/problem-reports', headers: as('owner-1') })).json() as Array<{ sentAt?: string; body?: string }>)[0]).toMatchObject({ sentAt: expect.any(String) });
    expect((await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: as('owner-1'), payload: { title: 'x' } })).statusCode).toBe(400);
  });

  it('someone who is not the machine owner gets no doctor', async () => {
    const { f } = await app();
    const d = (await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: as('member-2'), payload: { title: 't', whatHappened: 'w' } })).json() as { body: string };
    expect(d.body).not.toContain('### hatchabot doctor');
  });

  it('GET /v1/known-problems answers with the installed version and the matches', async () => {
    const { f } = await app();
    expect((await f.inject({ method: 'GET', url: '/v1/known-problems?symptom=x', headers: as('owner-1') })).statusCode).toBe(400);
    const r = await f.inject({ method: 'GET', url: '/v1/known-problems?symptom=' + encodeURIComponent('every message fails: "LLM request failed (request format rejected, HTTP 400)"'), headers: as('owner-1') });
    expect(r.statusCode).toBe(200);
    expect(r.json().installed).toMatch(/^v\d+\.\d+\.\d+/);
    expect(r.json().matches[0].title).toMatch(/request format rejected/);
  });

  it('the source routes read the code and refuse .env', async () => {
    const { f } = await app();
    expect((await f.inject({ method: 'GET', url: '/v1/source?path=.env', headers: as('owner-1') })).statusCode).toBe(400);
    const ok = await f.inject({ method: 'GET', url: '/v1/source?path=package.json&from=1&to=3', headers: as('owner-1') });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { text: string }).text).toContain('"name"');
    const s = await f.inject({ method: 'GET', url: '/v1/source/search?q=field-report&under=docs', headers: as('owner-1') });
    expect((s.json() as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });
});

/**
 * Security audit fixes (2026-10-09): private words in a report, a search that
 * cannot hold the server, and links that lead out of the source. All in a
 * temp folder of invented files.
 */
describe('a report masks what the app knows is private', () => {
  it("the agent's name in its log, the prose and the patch, and a short credential", () => {
    const r = buildReport({
      title: 'Garden Notes stops after a restart',
      whatHappened: 'garden-notes went quiet; Meal Planner too. Robin Example saw it on pantry-box.',
      diagnosis: 'Its config has password: rose9 and "apiKey": "seed1".',
      suggestedPatch: '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-// Garden Notes\n+GARDEN_TOKEN=pl4nt',
      by: 'agent',
    }, { ...facts, agent: { name: 'Garden Notes', state: 'FAILED', logs: '[gateway] Garden Notes ready\nlogin with seedling-42 failed' } },
    { ...ctx, names: ['garden-notes', 'Meal Planner', 'Robin Example'], hosts: ['pantry-box'], secrets: ['seedling-42'] });
    const all = `${r.title}\n${r.body}`;
    for (const s of ['Garden Notes', 'garden-notes', 'Meal Planner', 'Robin Example', 'pantry-box', 'rose9', 'seed1', 'pl4nt', 'seedling-42']) expect(all, s).not.toContain(s);
    expect(r.title).toBe('{name} stops after a restart');
    expect(r.body).toContain('[gateway] {name} ready');
    expect(r.body).toContain('password: ***');
    expect(r.body).toContain('### hatchabot doctor');
  });

  it('a known credential across a clip boundary is masked whole, not cut to a prefix that stays (#210)', () => {
    const c = { ...ctx, secrets: ['seedling-42-compost'] };
    const at = (n: number) => `${'w '.repeat(Math.floor((n - 6) / 2))}`;
    const r = buildReport({
      title: `${at(120)}seedling-42-compost`,
      whatHappened: `${at(4000)}seedling-42-compost and more`,
      diagnosis: `${at(5000)}seedling-42-compost`,
      by: 'person',
    }, { ...facts, failures: [{ at: '2026-10-06T10:00:00Z', event: 'runtime.failed', detail: `${at(200)}seedling-42-compost` }], agent: { name: 'Recipe Box', state: 'FAILED', reason: `${at(300)}seedling-42-compost` } }, c);
    for (const s of ['seedl', 'seedling']) expect(`${r.title}\n${r.body}`, s).not.toContain(s);
    // Input bounded before it can be masked loses the cut word, not keeps half of it.
    expect(boundInput('a b seedling-42-compost', 10)).toBe('a b ');
    expect(boundInput('short', 10)).toBe('short');
  });

  it('a folder outside home is masked whole; one inside home keeps its ~ form', () => {
    expect(redactForPublic('sets in /mnt/pantry-nas/hatchabot/2026-10-20 and /home/pat/hatchabot-backups', { ...ctx, paths: ['/mnt/pantry-nas/hatchabot/', '/home/pat/hatchabot-backups'] }))
      .toBe('sets in {path}/2026-10-20 and ~/hatchabot-backups');
  });

  it('a short backup folder is masked as a whole path only, never inside other paths or routes (regression audit, 2026-10-22)', () => {
    expect(redactForPublic('See docs/backups.md, GET /v1/backups; sets in /backups/2026-10-22 and in /backups.', { ...ctx, paths: ['/backups'] }))
      .toBe('See docs/backups.md, GET /v1/backups; sets in {path}/2026-10-22 and in {path}.');
    expect(redactForPublic('--- a/src/orchestrator/backups.ts\n+++ b/src/orchestrator/backups.ts', { ...ctx, paths: ['/backups'] }))
      .toBe('--- a/src/orchestrator/backups.ts\n+++ b/src/orchestrator/backups.ts');
  });

  it('a second pass changes nothing (the draft is masked again as it leaves)', () => {
    const c = { ...ctx, names: ['Garden Notes'], hosts: ['pantry-box'], secrets: ['seedling-42'] };
    const once = redactForPublic('Garden Notes on pantry-box: TOKEN=pl4nt, seedling-42, /home/pat/x, sam@example.org', c);
    expect(redactForPublic(once, c)).toBe(once);
  });

  it('the manager is not a private name, and ordinary text stays', () => {
    expect(redactForPublic('Hatchabot agent: ok; the garden is fine', { ...ctx, names: ['Hatchabot', 'Hatchabot agent', 'Garden Notes'] })).toBe('Hatchabot agent: ok; the garden is fine');
    // A short name only as written: "To Do" is private, "what to do" is not.
    expect(redactForPublic('To Do failed; not sure what to do', { ...ctx, names: ['To Do'] })).toBe('{name} failed; not sure what to do');
  });
});

describe('the installed source: links and bounds', () => {
  let root: string, app: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hb-source-'));
    app = join(root, 'app');
    mkdirSync(join(app, 'src'), { recursive: true });
    mkdirSync(join(app, 'docs'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(app, 'docs', 'troubleshooting.md'), '# Playbook\n\n### The garden sync stops\n- **Check:** the sprinkler log\n');
    writeFileSync(join(app, 'docs', 'guide.md'), 'How to plant tulips in the garden.\n');
    writeFileSync(join(app, 'src', 'ok.ts'), 'export const sprinkler = "on"; // foo(bar | baz\n');
    writeFileSync(join(app, 'src', 'slow.ts'), `${'a'.repeat(30)}!\n`);
    writeFileSync(join(app, '.env'), 'GARDEN_SECRET=compost\n');
    writeFileSync(join(root, 'elsewhere', 'notes.md'), 'marigold outside the source\n');
    symlinkSync(join(root, 'elsewhere', 'notes.md'), join(app, 'src', 'out.md'));     // a file outside
    symlinkSync(join(app, '.env'), join(app, 'src', 'env.ts'));                       // the install's own state
    symlinkSync(join(root, 'elsewhere'), join(app, 'src', 'ext'));                    // a folder outside
    symlinkSync(join(app, 'docs'), join(app, 'src', 'alias'));                        // a folder inside the source
    symlinkSync(join(app, 'src'), join(app, 'src', 'loop'));                          // a cycle
    symlinkSync(join(app, 'src', 'self'), join(app, 'src', 'self'));                  // a link to itself
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads a regular file, and refuses a link whose target is outside the readable set', () => {
    expect(readSource(app, 'src/ok.ts').text).toContain('sprinkler');
    for (const p of ['src/out.md', 'src/env.ts', 'src/ext/notes.md', 'src/self']) expect(() => readSource(app, p), p).toThrow(/Outside the source/);
    // A link to elsewhere in the source is read as what it leads to.
    expect(readSource(app, 'src/alias/guide.md').text).toContain('tulips');
    const listing = readSource(app, 'src').text.split('\n');
    expect(listing).toContain('alias/');
    expect(listing).not.toContain('out.md');
    expect(listing).not.toContain('ext/');
  });

  it('a search never reads past a link out, reads each folder once, and ends on a cycle', async () => {
    expect((await searchSource(app, 'marigold')).matches).toEqual([]);
    const tulips = await searchSource(app, 'tulips');
    expect(tulips.matches).toHaveLength(1);
    expect(tulips.matches[0]!.path).toBe('docs/guide.md');
    expect((await searchSource(app, 'compost')).matches).toEqual([]);
    await expect(searchSource(app, 'x', 'src/ext')).rejects.toThrow(/Outside the source/);
  });

  it('looks for plain text by default; a regular expression only when asked', async () => {
    expect((await searchSource(app, 'FOO(BAR | baz')).matches.map((m) => m.path)).toEqual(['src/ok.ts']);
    expect((await searchSource(app, 'tulips|sprinkler')).matches).toEqual([]);
    const both = await searchSource(app, 'tulips|sprinkler', undefined, 40, 15, { regex: true });
    expect(both.matches.map((m) => m.path).sort()).toEqual(['docs/guide.md', 'docs/troubleshooting.md', 'src/ok.ts']);
    expect(both.matches.find((m) => m.path === 'docs/troubleshooting.md')?.entry).toBe('The garden sync stops');
    await expect(searchSource(app, 'x'.repeat(301))).rejects.toThrow(/At most 300/);
  });

  it('a runaway expression is stopped at the time limit, and other searches answer meanwhile', async () => {
    const t0 = Date.now();
    const bad = searchSource(app, '^(a+)+$', 'src', 40, 15, { regex: true, ms: 1500, caller: 'one' });
    const settled = bad.then(() => 'answered', (e: Error) => e.message);
    // The server's thread is free: a plain search from someone else answers while the bad one runs.
    const good = await searchSource(app, 'tulips', undefined, 40, 15, { caller: 'two' });
    expect(good.matches).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await settled).toMatch(/stopped/);
    expect(Date.now() - t0).toBeLessThan(4000);
    // Stopped, not left running.
    await vi.waitFor(() => expect(searchesRunning()).toBe(0), { timeout: 2000 });
  });

  it('one caller cannot take every search slot', async () => {
    const slow = [1, 2].map(() => searchSource(app, '^(a+)+$', 'src', 40, 15, { regex: true, ms: 800, caller: 'one' }).catch((e: Error) => e.message));
    await expect(searchSource(app, 'tulips', undefined, 40, 15, { caller: 'one' })).rejects.toThrow(/Other searches are running/);
    expect((await searchSource(app, 'tulips', undefined, 40, 15, { caller: 'two' })).matches).toHaveLength(1);
    await Promise.all(slow);
    await vi.waitFor(() => expect(searchesRunning()).toBe(0), { timeout: 2000 });
  });
});

describe('the report routes mask private names and known credentials, on every way out', () => {
  it('a draft about an agent, and a later edit, carry neither its name nor its key', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'pantry-box', settings: {}, createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: 'owner-1', name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertAgent({ id: 'a2', ownerId: 'owner-1', name: 'Meal Planner', slug: 'meal-planner', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'GARDEN_KEY', secretRef: 'ref-garden', createdAt: 'now' });
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async (ref: string) => (ref === 'ref-garden' ? 'seedling-42' : 'x'), delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, reportDoctor: async () => [{ level: 'ok', text: 'Docker 29 (made up)' }],
    } as never);
    const h = { 'x-hatchabot-owner': 'owner-1' };
    const r = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: h, payload: { title: 'Garden Notes is stuck', whatHappened: 'garden-notes logged seedling-42 and TOKEN=ab1 on pantry-box.', agent: 'a1' } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json() as { id: string; title: string; body: string; issueUrl: string };
    const out = `${d.title}\n${d.body}\n${decodeURIComponent(d.issueUrl)}`;
    for (const s of ['Garden Notes', 'garden-notes', 'seedling-42', 'ab1', 'pantry-box']) expect(out, s).not.toContain(s);
    // The person's own edit is held to the same rules, and what comes back is what goes out.
    const e = await f.inject({ method: 'PATCH', url: `/v1/problem-reports/${d.id}`, headers: h, payload: { body: 'Also Meal Planner. password: rose9' } });
    const edited = e.json() as { body: string; issueUrl: string };
    expect(edited.body).toBe('Also {name}. password: ***');
    expect(decodeURIComponent(edited.issueUrl)).not.toMatch(/Meal Planner|rose9/);
    expect((await f.inject({ method: 'GET', url: `/v1/problem-reports/${d.id}`, headers: h })).json().body).toBe('Also {name}. password: ***');
  });

  it("a runner's user and host are masked wherever they turn up, as the route builds its context (HB-0405)", async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertHost({ id: 'h2', ownerId: 'owner-1', kind: 'cloud', provider: 'remote-docker', name: 'Studio', settings: { dockerHost: `ssh://someone@${['studio-laptop', 'example', 'org'].join('.')}` }, createdAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } },
      reportDoctor: async () => [{ level: 'fail', text: 'studio-laptop did not answer; someone was asked' }],
    } as never);
    const r = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: { 'x-hatchabot-owner': 'owner-1' }, payload: { title: 'Drain fails', whatHappened: 'docker stop on studio-laptop.example.org failed for someone in /srv/family-name/x.' } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json() as { body: string; issueUrl: string };
    for (const s of ['studio-laptop', 'someone', 'family-name']) {
      expect(d.body, s).not.toContain(s);
      expect(decodeURIComponent(d.issueUrl), s).not.toContain(s);
    }
  });

  it('account usernames, and members\' names in part and their chat ids, are masked as the route builds its context (HB-0405)', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'pantry', settings: {}, createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: 'owner-1', name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    const chatId = `22334${45566}`;
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'user', displayName: 'Alice Example', channelUserId: chatId, status: 'active' } as never);
    store.insertLocalAccount({ id: 'owner-1', username: 'robinexample', displayName: 'Robin Sample', pwHash: 'x', pwSalt: 'x', hostOwner: true, disabled: false, createdAt: 'now' } as never);
    store.insertLocalAccount({ id: 'acct-2', username: 'kimexample', pwHash: 'x', pwSalt: 'x', hostOwner: false, disabled: false, createdAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, reportDoctor: async () => [],
    } as never);
    const made = async (who: string) => (await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: { 'x-hatchabot-owner': who }, payload: { title: 'x', whatHappened: 'Alice saw it. ROBINEXAMPLE and Robin too, and KimExample; id ' + chatId + '.' } })).json() as { body: string };
    expect((await made('owner-1')).body).toContain('{name} saw it. {user} and {name} too, and {user}; id {id}.');
    // A member's report is held to their own account, not the whole list of them.
    const other = await made('acct-2');
    expect(other.body).toContain('{user}');
    expect(other.body).toContain('ROBINEXAMPLE');
  });

  it('a runner address with a malformed %-escape breaks no report route, and is still masked (HB-0405)', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertHost({ id: 'h2', ownerId: 'owner-1', kind: 'cloud', provider: 'remote-docker', name: 'Studio', settings: { dockerHost: 'tcp://sam%ZZ@studio-laptop:2376' }, createdAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, reportDoctor: async () => [],
    } as never);
    const h = { 'x-hatchabot-owner': 'owner-1' };
    const made = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: h, payload: { title: 'Drain fails', whatHappened: 'sam%ZZ on studio-laptop could not stop it.' } });
    expect(made.statusCode, made.body).toBe(200);
    const d = made.json() as { id: string; body: string };
    expect(d.body).toContain('{user} on {host} could not stop it.');
    expect((await f.inject({ method: 'GET', url: `/v1/problem-reports/${d.id}`, headers: h })).statusCode).toBe(200);
    const e = await f.inject({ method: 'PATCH', url: `/v1/problem-reports/${d.id}`, headers: h, payload: { body: 'again on studio-laptop' } });
    expect(e.statusCode, e.body).toBe(200);
    expect((e.json() as { body: string }).body).toBe('again on {host}');
  });

  it("doctor's lines carry neither the install's own address nor a backup folder outside home (audit, 2026-10-20)", async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'pantry-box', settings: {}, createdAt: 'now' } as never);
    const was = process.env.HATCHABOT_BACKUP_DIR;
    process.env.HATCHABOT_BACKUP_DIR = '/mnt/pantry-nas/hatchabot';
    try {
      const f = Fastify();
      await registerRoutes(f, {
        store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
        channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, publicUrl: 'https://hatchabot.garden-example.net',
        reportDoctor: async () => [{ level: 'ok', text: 'Public URL https://hatchabot.garden-example.net' }, { level: 'warn', text: 'No backup set in /mnt/pantry-nas/hatchabot yet' }],
      } as never);
      const r = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: { 'x-hatchabot-owner': 'owner-1' }, payload: { title: 'Backups stopped', whatHappened: 'No backup since Monday.' } });
      expect(r.statusCode, r.body).toBe(200);
      const d = r.json() as { body: string; issueUrl: string };
      expect(d.body).toContain('Public URL https://{host}');
      expect(d.body).toContain('No backup set in {path} yet');
      expect(`${d.body}\n${decodeURIComponent(d.issueUrl)}`).not.toMatch(/garden-example|pantry-nas/);
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_BACKUP_DIR; else process.env.HATCHABOT_BACKUP_DIR = was;
    }
  });

  it('a general report masks the key of every agent whose failure it carries, not only a selected one (#204)', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner-1', kind: 'local', provider: 'mock', name: 'pantry-box', settings: {}, createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: 'owner-1', name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'GARDEN_KEY', secretRef: 'ref-garden', createdAt: 'now' });
    // Free text, no credential-shaped field name: only the known value can catch it.
    store.recordEvent('a1', 'runtime.failed', { message: 'login refused for seedling-42 at the gate' });
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async (ref: string) => (ref === 'ref-garden' ? 'seedling-42' : 'x'), delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, reportDoctor: async () => [],
    } as never);
    const r = await f.inject({ method: 'POST', url: '/v1/problem-reports', headers: { 'x-hatchabot-owner': 'owner-1' }, payload: { title: 'Things fail', whatHappened: 'Several agents fail.' } });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json() as { body: string; issueUrl: string };
    expect(d.body).toContain('runtime.failed');
    expect(d.body).toContain('login refused for *** at the gate');
    expect(`${d.body}\n${decodeURIComponent(d.issueUrl)}`).not.toContain('seedling');
  });
});
