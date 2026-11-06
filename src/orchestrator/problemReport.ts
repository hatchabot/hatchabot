import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { hostname, homedir, userInfo } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { looksLikeCode, maskKeyMaterial, OTHER_QUOTED, maskKnownValues, quotedFieldMasker, redactSecrets } from '../domain/redact.js';

/**
 * "Report a problem" (docs/field-reports.md): the manager agent — or the
 * person, from ⚙ — writes what happened and, when it can, a diagnosis and a
 * patch against the release installed here; Hatchabot adds the facts (version,
 * doctor, recent failures, an agent's log tail), strips what must not be
 * public, and keeps it as a private draft. Only the person sends it: a GitHub
 * issue they open themselves, pre-filled, or a file. Nothing here posts.
 */

export const REPORT_SLUG = 'hatchabot/hatchabot';
export const REPORT_FORMAT = 'hatchabot-report v1';

/**
 * What makes a home machine identifiable, for a PUBLIC issue: on top of redactSecrets.
 * `names` (agents' names and slugs), `people`, `ids`, `users`, `hosts` (machine names,
 * the addresses it is reached at), `paths` (folders outside home, as the backup one)
 * and `secrets` (known credential values) are what the app knows is private: the
 * patterns alone let an agent's name in a log line through (security audit,
 * 2026-10-09). Held for one call, never stored or logged.
 */
export interface PublicRedactContext {
  home?: string; user?: string; host?: string;
  names?: Iterable<string>; hosts?: Iterable<string>; paths?: Iterable<string>; secrets?: Iterable<string>;
  /** User names other than this machine's: the ones in the runners' addresses, and account usernames. */
  users?: Iterable<string>;
  /** People's names (members, accounts): each part of one is masked too, not only the whole. */
  people?: Iterable<string>;
  /** A chat app's user ids: a number means nothing to a pattern, so only this list can catch one. */
  ids?: Iterable<string>;
}

/**
 * What a runner's address gives away: `ssh://someone@studio-laptop:22` has a
 * user and a host; the first label of a longer name is how people often write
 * it; and a literal IP is masked as one anyway.
 */
export function endpointIdentity(dockerHost: unknown): { user?: string; hosts: string[] } {
  const raw = String(dockerHost ?? '').trim();
  let user: string | undefined, host = '';
  try { const u = new URL(raw); user = u.username || undefined; host = u.hostname; } catch { /* read below */ }
  // Not an address the URL parser takes, or one with no host for it (mybox:2375): still masked, by its shape.
  // After the scheme, or none: tcp://:2375 has no host, and "tcp" is not one.
  if (!host) {
    const m = /^(?:([^@/\s]+)@)?([^:/\s[\]@]+)/.exec(raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
    if (m && !/^unix(?::|$)/i.test(raw)) { user ??= m[1]; host = m[2]!; }
  }
  // A malformed %-escape in the user threw here, and every report route answered 500 until the row went (HB-0405).
  if (user) { try { user = decodeURIComponent(user); } catch { /* masked as written */ } }
  const named = user ? { user } : {};
  if (!host || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return { hosts: [], ...named };
  return { hosts: [...new Set([host, host.split('.')[0]!])], ...named };
}

export function localContext(): PublicRedactContext {
  let user: string | undefined;
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  return { home: homedir(), user, host: hostname() };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPrivateV4 = (a: number, b: number) =>
  a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
/**
 * A private IPv6 address: unique local (fc00::/7, a tailnet's fd7a:…), link-
 * or site-local (fe80::/9), loopback, or a private IPv4 mapped (::ffff:10.0.0.7).
 * Only IPv4 was masked, so a runner's fd00:… address went public (#211).
 * Judged on its eight groups, not its spelling: 0:0::ffff:c0a8:102 is
 * ::ffff:192.168.1.2 too, and went public (HB-0365).
 */
const isPrivateV6 = (addr: string) => {
  const ip = addr.replace(/%.*$/, '');
  if (!isIPv6(ip)) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateV4(g[6]! >> 8, g[6]! & 0xff);
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xff80) === 0xfe80;
};
/** A valid IPv6 address (isIPv6) as its eight 16-bit groups: `::` filled in, a dotted IPv4 tail as two groups. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  const part = (h: string) => (h ? h.split(':').map((x) => parseInt(x, 16)) : []);
  const head = part(halves[0]!);
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = part(halves[1]!);
  const fill = 8 - head.length - tail.length;
  return halves.length === 2 && fill >= 0 ? [...head, ...Array<number>(fill).fill(0), ...tail] : undefined;
}
/**
 * The masks are {path}, not <path>: outside a code fence GitHub's markdown takes
 * <path> for an HTML tag and drops it, so "open <path> failed" read "open failed".
 * A draft kept before this, masked again as it leaves, moves to the new form.
 */
const OLD_MASK = /<(path|user|host|email|name|ip|private-ip|tailnet-host|bot)>/g;
// Never masked as a private name: the manager's own names, and the words the masks and headings are made of.
const NOT_PRIVATE = /^(hatchabot([ -](agent|manager))?|private-ip|tailnet-host)$/i;
/**
 * Words that say nothing about whose machine it is, and are all over a report.
 * A runner reached as user docker at a host named runner made every "docker" and
 * "runner" a masked word, and "rebuild on ubuntu fails" came out as "{user}
 * rebuild on {user} fails"; the person's edit couldn't bring them back.
 */
const GENERIC_WORDS = new Set(`
  root admin administrator sudo docker dockerd podman containerd ubuntu debian centos fedora alpine rocky alma arch amazon suse
  linux unix macos mac macbook windows raspberrypi raspberry pi git github gitlab server servers node nodes runner runners
  host hosts hostname localhost local user users username name names email path ip id code phone bot agent agents hatchabot openclaw
  manager machine computer laptop desktop workstation vm box nas gateway router default guest test tester demo example owner member
  ops dev deploy deployer ansible vagrant core opc ec2-user www-data nobody daemon system service services worker build ci runtime
  app apps web api private public tailnet the and van von der den del della dos das mrs miss family team group home house household key
  telegram whatsapp discord slack imessage gmail google icloud outlook hotmail yahoo ssh tcp http https
`.trim().split(/\s+/));
const isGeneric = (w: string) => NOT_PRIVATE.test(w) || GENERIC_WORDS.has(w.toLowerCase());
/**
 * A part of a person's name that is really an everyday word is masked only as it is
 * written in the name: "Will", never "it will fail". Words a log or a sentence uses in
 * lowercase with no person meant. A first or last name that only happens to be a word
 * as well (bob, taylor, reed) is not here: alone it goes in any case.
 */
const EVERYDAY_NAMES = new Set(`
  will mark bill rose grace may june april august hope faith joy dawn art max jack frank chase hunter page penny
  summer autumn winter spring sky rain star sunny young white black brown green gray grey king long short hill wood woods stone rice
  baker cook hall bell fox wolf bird river rivers lake field fields park parks price rich love day best good bright moon sun snow
  west east north south case cash rock lane major guy clay amber ruby olive crystal justice little small pool book link list note garden
`.trim().split(/\s+/));
/**
 * Words that name a room, a device or a kind of thing, never a first or last name.
 * Used with the words a sentence is made of (below) for a part alone, and on their own
 * to tell a default name (Living Room, Kitchen Laptop) from a person's: the only kind of
 * whole name that goes only as written.
 */
const EVERYDAY_WORDS = new Set(`
  living room rooms kitchen bedroom bathroom dining lounge garage basement attic office school work study yard lab main new old big
  first last next back front side top bottom left right up down one two three mom mum dad grandma grandpa nana papa baby sister brother
  son daughter wife husband friend friends neighbor neighbour chat account accounts pages books notes shared everyone do
`.trim().split(/\s+/));
const isEveryday = (w: string) => {
  const x = w.toLowerCase();
  return EVERYDAY_NAMES.has(x) || EVERYDAY_WORDS.has(x) || SENTENCE_WORDS.has(x) || LOG_WORDS.has(x) || NAME_JOINS.has(x) || TITLE_JOINS.has(x);
};
// In the list of generic words because of what else they are (a distro, a brand, a particle), but someone can be called them.
const GENERIC_BUT_A_NAME = new Set('alma rocky arch amazon mac box van von der den del della dos das miss mrs'.split(' '));
/** No part of this says it is a person: "Telegram User", "Chat Group", "To Do", "Living Room". */
const isDefaultName = (parts: readonly string[]) => parts.every((p) => {
  const x = p.toLowerCase();
  return EVERYDAY_WORDS.has(x) || NAME_JOINS.has(x) || TITLE_JOINS.has(x) || (isGeneric(p) && !GENERIC_BUT_A_NAME.has(x));
});
// Scripts written without spaces between words: no word boundary to look for, so a name there is found inside the text.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

// What a name is made of, in any script. \w is ASCII: a path was cut at its first "ü" or "И", and the rest went public.
const LETTERS = String.raw`\p{L}\p{M}\p{N}`;

/** Words that make a path look like someone's life, in the folders below where they are not expected. In code, "private" and "personal" say nothing. */
const LIFE_WORDS = 'family|tax|taxes|photos?|pictures|documents|medical|bank|banking|finances?|passports?|wedding|kids';
const LIFE_WORD = new RegExp(`(?:^|[/._-])(?:${LIFE_WORDS}|personal|private)(?:$|[/._-])`, 'i');
const LIFE_WORD_IN_CODE = new RegExp(`(?:^|[/._-])(?:${LIFE_WORDS})(?:$|[/._-])`, 'i');
const PERSONAL_FILE = /\.(?:pdf|jpe?g|heic|docx?|xlsx?|pptx?|odt|ods|mov|mp[34])$/i;
// Capitals say a folder is someone's, except in a name every project has, or a source file in a folder of code.
const WELL_KNOWN_FILE = /(?:^|\/)(?:README|LICEN[CS]E|NOTICE|CHANGELOG|CONTRIBUTING|AUTHORS|COPYING|INSTALL|SECURITY|Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Jenkinsfile|Vagrantfile)(?:\.[a-z]+)?$/;
const CODE_FILE = /(?:^|\/)[\w.-]+\.(?:[cm]?[jt]sx?|json|map|py|rb|go|rs|java|cc|cpp|hpp|[ch]|sh|wasm|node|lock|ya?ml|toml|css|html?|sql)$/;
/** `code`: a folder that holds code (this app, /app/), where a package's own folders and a source file's capitals mean nothing. */
function looksPersonal(p: string, code = false): boolean {
  if (/[^\x21-\x7e]|'/.test(p)) return true;
  const own = code ? p.split(/(?:^|\/)node_modules\//)[0]! : p;
  if ((code ? LIFE_WORD_IN_CODE : LIFE_WORD).test(own) || PERSONAL_FILE.test(p)) return true;
  return /[A-Z]/.test(own.replace(WELL_KNOWN_FILE, '').replace(code ? CODE_FILE : /$^/, ''));
}

/**
 * Absolute paths that say nothing about whose machine it is, and are what a fix
 * needs: programs and libraries (a stack trace's /usr/lib/…), a device a patch
 * names, /var/run/docker.sock, Docker's own folders, API routes. Named folder by
 * folder, not by top level: /etc/letsencrypt/live/<their domain>/…,
 * /dev/disk/by-label/<their label> and /var/lib/docker/volumes/<their volume>/…
 * say who it is. Every other path is masked whole: /srv/family-name/…, another
 * user's /home/someone/… (HB-0405).
 *
 * Only the folder is known, so what follows it is judged too: /etc/ssl/certs/<their
 * domain>.pem shows as /etc/ssl/certs/{path}. By what the folder holds:
 *  - `code`: programs and libraries, stays unless it is plainly no code: another
 *    script, a word of someone's life, a PDF or a photo, a capital in a folder's name
 *    or in a file's that is no source file, except inside a package's own folder;
 *  - `mixed`: the same, where capitals are usual (a Mac's frameworks, fonts);
 *  - `route`: an API route, whose ids can have capitals: only the first name below it is held to that;
 *  - `plain`: the system's own files, which are in lowercase;
 *  - `app`: an app's own folder, as /app/ below;
 *  - a pattern: what the folder is known to hold, and nothing else. A person names
 *    things here (/etc/sudoers.d/<them>, a registry's address), and no word tells it.
 * Where a mask starts is stable: the mask itself is never a known name.
 */
type SystemTail = 'code' | 'mixed' | 'route' | 'plain' | 'app' | RegExp;
const NOTHING = /(?!)/;
const SYSTEM_UNIT = String.raw`(?:hatchabot|agentclaw|docker|containerd|ssh|sshd|ollama|tailscaled|nvidia|getty|multi-user|default|network|systemd|snap|cloud|apt|unattended)[\w@.:-]*`;
const MAC_PLIST = /^\/(?:com\.(?:apple|docker|hatchabot|agentclaw|openclaw|tailscale|ollama|github|google)|org\.nix|homebrew|hatchabot|io\.tailscale)[\w.-]*$/;
const MAC_LOGS = /^\/(?:DiagnosticReports|CrashReporter|Homebrew|Docker[\w.-]*|com\.(?:apple|docker)[\w.-]*|hatchabot[\w.-]*|openclaw[\w.-]*)(?:\/[^\s']*)?$/;
const SYSTEM_FOLDERS = ([
  // A container's or another process's view of the whole machine: nothing below it says what it holds.
  [String.raw`proc/(?:\d+|self|thread-self)/(?:root|cwd)`, NOTHING],
  [String.raw`var/lib/docker/overlay2/[^/]+/(?:merged|diff|work)`, NOTHING],
  [String.raw`etc/docker/certs\.d`, NOTHING],
  [String.raw`etc/ssl/certs`, /^\/(?:ca-certificates\.crt|ca-bundle(?:\.trust)?\.crt|ssl-cert-snakeoil\.pem)$/],
  [String.raw`etc/ssl/private`, /^\/ssl-cert-snakeoil\.key$/],
  [String.raw`etc/ssl`, /^\/(?:openssl\.cnf|cert\.pem)$/],
  [String.raw`etc/docker`, /^\/(?:daemon\.json|key\.json|seccomp[\w.-]*\.json)$/],
  [String.raw`etc/ssh`, /^\/(?:sshd?_config(?:\.d(?:\/\d\d-[a-z0-9-]+\.conf)?)?|ssh_host_(?:rsa|ecdsa|ed25519|dsa)_key(?:\.pub)?|moduli|ssh_known_hosts)$/],
  [String.raw`etc/systemd/system`, new RegExp(String.raw`^/${SYSTEM_UNIT}(?:/(?:${SYSTEM_UNIT}|override\.conf|\d\d-[\w.-]+\.conf))?$`)],
  [String.raw`etc/systemd`, /^\/(?:user|network|[a-z]+\.conf)$/],
  [String.raw`etc/default`, /^\/(?:docker|grub|locale|keyboard|ssh|useradd|cron|ufw|motd-news|apport|nvidia[\w-]*)$/],
  [String.raw`etc/sudoers\.d`, /^\/(?:README|\d\d-[a-z0-9-]+|hatchabot|docker)$/],
  [String.raw`etc/(?:apt|ca-certificates|cron\.\w+|containerd|logrotate\.d|pam\.d|profile\.d|security|sysctl\.d|udev|alternatives)`, 'plain'],
  [String.raw`etc/(?:hosts|hostname|passwd|group|shadow|gshadow|sudoers|fstab|mtab|os-release|lsb-release|resolv\.conf|nsswitch\.conf|timezone|localtime|environment|crontab|profile|machine-id|subuid|subgid)$`, NOTHING],
  [String.raw`usr/share/(?:zoneinfo|locale|i18n|icons|fonts|perl5?|python3?|git-core|bash-completion|zsh|dbus-1|applications|mime|terminfo|X11|misc|java|vim)`, 'mixed'],
  [String.raw`usr/share/(?:doc|man|info|ca-certificates|nginx|nodejs|node|npm|openclaw|hatchabot|docker|containerd|nvidia|tailscale|ollama)`, 'code'],
  [String.raw`usr/share`, NOTHING],
  [String.raw`usr/src/app`, 'app'],
  [String.raw`run/user/\d+`, /^\/(?:docker(?:\.sock|\.pid)?|bus|(?:containerd|systemd|podman|gnupg|pulse|keyring)(?:\/[\w.-]+)*)$/],
  [String.raw`run/systemd`, /^\/(?!(?:users|sessions?)\/\D)[a-z0-9_.@:/-]+$/],
  [String.raw`run/(?:docker|containerd)`, 'plain'],
  [String.raw`var/run`, /^\/(?:docker(?:\.sock|\.pid)?|(?:docker|containerd|systemd|secrets\/kubernetes\.io)\/[\w./-]+|containerd|sshd\.pid|crond?\.pid|utmp|nvidia[\w./-]*)$/],
  [String.raw`var/lib/docker/(?:overlay2|containers|image|network|plugins|tmp|buildkit|runtimes|swarm)`, 'plain'],
  [String.raw`dev/(?:null|zero|full|random|urandom|tty\w*|console|ptmx|stdin|stdout|stderr|shm|pts|fd|net|kvm|fuse|dri|loop\d+|sd[a-z]\d*|vd[a-z]\d*|xvd[a-z]\d*|nvme\w*|mmcblk\w*|nvidia\w*)`, 'plain'],
  [String.raw`Library/(?:LaunchDaemons|LaunchAgents|Preferences)`, MAC_PLIST],
  [String.raw`Library/(?:Logs|Caches)`, MAC_LOGS],
  [String.raw`Library/(?:Frameworks|Developer|Apple)|Applications/[^/\s]+\.app|opt/homebrew`, 'mixed'],
  [String.raw`v\d+(?:\.\d+)*|api`, 'route'],
  [String.raw`bin|sbin|lib|lib64|nix/store|usr/(?:bin|sbin|lib|lib64|libexec|include)|usr/local/(?:bin|sbin|lib|lib64|libexec|include)`, 'code'],
  [String.raw`proc|sys`, 'plain'],
  [String.raw`join/\{code\}$`, NOTHING],
] as ReadonlyArray<readonly [string, SystemTail]>).map(([folder, tail]) => [new RegExp(`^/(?:${folder})(?=/|$)`), tail] as const);

// In a package's own folder its capitals are its own: /usr/lib/python3/dist-packages/PIL/x.
const PACKAGE_FOLDER = /^(?:node_modules|dist-packages|site-packages|vendor|gems)$/;
const LIBRARY_NAME = /\.(?:so(?:\.\d+)*|a|o|ko|dylib|jar|class|pyc|pm)$/;
/** How much of a path in a system folder stays: all of it, or up to where its tail stops being known. */
function systemKeep(p: string, rootLen: number, tail: SystemTail): number {
  let keep = p.length;
  const rest = p.slice(rootLen);
  if (rest.length > 1) {
    if (tail instanceof RegExp) { if (!tail.test(rest)) keep = rootLen + 1; }
    else if (tail === 'app') { if (looksPersonal(rest, true)) keep = rootLen + 1; }
    else {
      let at = rootLen + 1, first = true, inPackage = false;
      const names = rest.slice(1).split('/');
      for (const [i, name] of names.entries()) {
        const asCode = tail === 'code' && !inPackage && /[A-Z]/.test(name) && (i < names.length - 1 || !(CODE_FILE.test(name) || LIBRARY_NAME.test(name) || WELL_KNOWN_FILE.test(name)));
        const bad = name.includes('{path}') || /[^\x21-\x7e]|'/.test(name) || PERSONAL_FILE.test(name)
          || (tail === 'plain' ? /[A-Z]/.test(name) || LIFE_WORD.test(name) : LIFE_WORD_IN_CODE.test(name) || asCode || (tail === 'route' && first && /^[A-Z]/.test(name)));
        if (bad) { keep = at; break; }
        at += name.length + 1;
        first = false;
        inPackage ||= PACKAGE_FOLDER.test(name);
      }
    }
  }
  // Someone's home inside a system folder, however it got there: /proc/1/root/home/…, a layer's merged/home/….
  const home = p.search(/\/(?:home|Users)\//);
  return home >= 0 ? Math.min(keep, home + 1) : keep;
}

const APP_FOLDER = /^~\/(?:hatchabot|agentclaw)(?:-(?:(data|backups?)|prod|wt|bundle|logs))?(?=\/|$)/;
// The real data of the app's data and backup folders: what a report can name there is one plain name, or a file of the app's own.
const DATA_TAIL = /^\/(?:[a-z0-9_-]+|[a-z0-9_.-]+\.(?:sqlite3?|db|log|json|sock|pid|lock))$/;
// In ~/.ssh a key's name is often the person's or the machine's (~/.ssh/pat-at-work.pem, id_pat_smith): only ssh's own names stay.
const SSH_FILE = /^~\/\.ssh(?:\/(?:config|known_hosts(?:\.old)?|authorized_keys|environment|rc|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?))?\/?$/;

/**
 * What of a path stays, and how sure that is: `kept` "system" names nothing of
 * the person's; "soft" is a folder that holds code or scratch files, which stays
 * only while nothing in it looks personal. A word after a space is taken into a
 * soft path when it reads as more of one. Not kept: masked, after `folder` when
 * the start of it is a folder that names nothing, or whole.
 */
function judgePath(p: string): { kept?: 'system' | 'soft'; folder?: string } {
  if (/(?:^|\/)(?:\.|%2e){2}(?:\/|$)/i.test(p)) return {}; // /usr/lib/../../srv/Smith and /usr/lib/.%2e/srv/Smith are not in /usr/lib
  if (p.startsWith('~/')) {
    const app = APP_FOLDER.exec(p);
    if (app) {
      const tail = p.slice(app[0].length);
      const fine = tail.length <= 1 || (app[1] ? DATA_TAIL.test(tail) : !looksPersonal(tail, true));
      return fine ? { kept: 'soft' } : { folder: `${app[0]}/` };
    }
    if (p.startsWith('~/.ssh') && !SSH_FILE.test(p)) return {};
    return p.startsWith('~/.') && !looksPersonal(p) ? { kept: 'soft' } : {};
  }
  for (const [folder, tail] of SYSTEM_FOLDERS) {
    const m = folder.exec(p);
    if (!m) continue;
    const keep = systemKeep(p, m[0].length, tail);
    return keep >= p.length ? { kept: 'system' } : { folder: p.slice(0, keep) };
  }
  if (p.startsWith('/app/')) return looksPersonal(p.slice(5), true) ? {} : { kept: 'soft' };
  return (p.startsWith('/tmp/') || p.startsWith('/home/node/')) && !looksPersonal(p) ? { kept: 'soft' } : {};
}

// Where a path starts: a scheme that introduces one, a home folder however it is written, a setting that holds a
// folder ($PWD/…, %APPDATA%\…), a Windows drive, share or device, //nas/…, or one slash and a name. Not inside a word,
// a relative path or a URL (the // of https://). After a machine's mask it can start, with or without a port or the rest of its
// name: https://{host}.example.org:8443/Family/Taxes and http://{name}:8080/Family/Taxes were a machine of theirs, and so is what is on it.
// And right after a one-letter option (-v/srv/x, -v$PWD/x, -v~/x), and in an editor's link (vscode://file/…).
const SLASH_NAME = String.raw`/(?=[${LETTERS}_.@%+~-]|[^\x00-\x7f])`;
const SETTING_LEAD = String.raw`\$[A-Z_][A-Z0-9_]*(?=/)|\$\{[A-Z_][A-Z0-9_]*\}(?=/)|\$HOME(?=\\)|\$\{HOME\}(?=\\)|~(?=[/\\])`;
const PATH_START = new RegExp(String.raw`(?<![${LETTERS}_.~/\\-])(?:(?:file|unix)://(?=/)|(?:file|smb|nfs|afp|cifs|sftp|ftps?|s3|gs|az|abfss?|wasbs?|hdfs|scp|rsync|davs?|webdavs?)://(?=[^\s/])|~[${LETTERS}_.-]*(?=/)|${SETTING_LEAD}|\$env:[A-Za-z_][A-Za-z0-9_]*(?=[\\/])|%[A-Za-z_][A-Za-z0-9_]*%(?=[\\/])|[A-Za-z]:(?=[\\/])|\\\\[?.]\\(?:[A-Za-z]:)?(?=\S)|\\\\(?=[${LETTERS}_]{2})|\\(?:[Uu]sers|[Hh]ome|Documents and Settings|Device)(?=\\)|(?<!:)//(?=[${LETTERS}_])|${SLASH_NAME})|(?=\/)(?<=\{(?:host|tailnet-host|ip|private-ip|name|user)\}(?:\.[\w.-]+)?\]?(?::\d{1,5})?|(?:vscode|vscode-insiders|cursor)://file|(?<![\w-])-[A-Za-z])${SLASH_NAME}|(?<=(?<![\w-])-[A-Za-z])(?:${SETTING_LEAD})`, 'gu');
// A path runs on until something that can't be in one: naming what may be in it missed a ’ or an emoji, and the rest
// went public. What ends one in a sentence is cut off after (trimEnd). A : goes on only before a letter or a port and a folder, not :12:3 or :/mnt.
const POSIX_RUN = /(?:\\ |[^\s"`<>|;*:\\]+|\\|:(?=[\p{L}_]|\d+\/))+/uy;
const WINDOWS_RUN = /[^\s"`<>|;*:]+/uy;
const FILE_END = new RegExp(String.raw`\.(?=[${LETTERS}]*\p{L})[${LETTERS}]{2,8}$`, 'u');
// Kept folders that hold libraries and data, where a folder can have a space in it and a word after one can be more of it:
// /opt/homebrew/Cellar/Jane Roe/x. Not bin or a route: `/usr/bin/docker pull a/b` and `POST /v1/x from y/z` are a command and a route.
const FOLDER_WITH_SPACES = /^\/(?:usr\/(?:local\/)?(?:lib|lib64|libexec|include|share)|lib|lib64|opt\/homebrew|Library|Applications|nix\/store)\/./;
const LIBRARY_FILE = /\.(?:[a-z][a-z0-9]{0,7}|so(?:\.\d+)*)$/;
const NAME_LIKE = new RegExp(String.raw`^(?:\(?\p{Lu}|\(?\p{Lo}|\(?\d+\)?$|[^\s]*[^\x00-\x7f])`, 'u');
const FOLDER_ABBREVIATION = /(?:^|[/\\\s])(?:St|Mt|Ft|Mr|Mrs|Ms|Dr|Jr|Sr|Inc|Ltd|Co)\.$/;
/** Where a run of path characters really ends: what ends a sentence or closes a bracket opened before the path stays outside the mask. */
function trimEnd(text: string, start: number, end: number): number {
  const open: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const depth: Record<string, number> = {};
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') depth[c] = (depth[c] ?? 0) + 1;
    else if (open[c]) depth[open[c]!] = (depth[open[c]!] ?? 0) - 1;
  }
  let e = end;
  while (e > start) {
    const c = text[e - 1]!;
    if (".,'&=?#!:+~-".includes(c) || (c > '\x7f' && /[\p{P}\p{S}]/u.test(c))) { e--; continue; }
    if (!open[c] || (depth[open[c]!] ?? 0) >= 0) break;
    depth[open[c]!]!++;
    e--;
  }
  return e;
}
/** Words of a sentence, not of a folder: a path ends before one written in lowercase, and a run of capitalized ones stops growing at one. */
const SENTENCE_WORDS = new Set(`
  is are was were be been being am do does did done has have had having can cannot could would should shall must might may will wont
  not no nor but if then than else when while where which who whom whose what why how because since until unless although though so as
  this that these those it its there here they them their we our you your he she his her him i
  with without from by into onto over under after before during about against between through to in on at for or a an
  see try tried retry check checked read reading reads write writing writes wrote open opening opened opens close closing closed
  run running ran runs start starting started stop stopping stopped load loading loaded loads exit exited exits exist exists found missing
  refused invalid unable went wrong something nothing anything everything please again still also only just now more most some any all
  each every both other others another got get gets getting set sets use used uses using need needs needed want wants make makes made
  take takes took give gives gave go goes going come comes came ok okay yes file files folder directory path line lines status code
  message reason result response output input
`.trim().split(/\s+/));
/** A log's own words end a path in any case: /srv/app/x.log ERROR …. */
const LOG_WORDS = new Set('error errors err warn warning warnings info debug trace fatal critical notice fail failed failure panic severe exception denied'.split(' '));
/** Small words inside a folder's name (Smith and Jones, Lord of the Rings): they neither end a run of names nor make one. */
const NAME_JOINS = new Set('and of the de del van von'.split(' '));
const TITLE_JOINS = new Set('for in on at to or a an'.split(' '));
/** `Status: 500` after a path: a label, not the end of the folder's name, which `Jones: denied` can be. */
const LABEL_WORDS = new Set('status error code message reason cause details detail path file line result response exit warning hint note info type name time host port stack output input expected actual got version'.split(' '));
const ENDS_IN_FILE = /\.[a-z][a-z0-9]{0,7}$/;
/** Words with a slash in them that say nothing of a folder: `/srv/x: Input/output error`. */
const SLASH_WORD = /^(?:i\/o|input\/output|read\/write|and\/or|n\/a|tcp\/ip|udp\/ip|http\/\d(?:\.\d)?)$/i;
/** Another path, an option or a setting begins at this word, so nothing from here on is more of the one before it. */
function beginsAnother(word: string): boolean {
  // Not any $, ' or { : /srv/Cost $5/x.pdf, /srv/Rock 'n Roll/x.pdf and /srv/Foo {2025}/x.pdf are one folder.
  if (/^(?:[/"`<]|~[\w.-]*\/|\$[A-Za-z_{]|'[/~$]|\{[a-z-]+\})/.test(word) || word.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(word) || /:\/\//.test(word)) return true;
  // An option, unless it is a word and a folder: -Jones/x.pdf. -v/srv/x is an option, and so is --out=a/b.
  if (/^--?\p{L}/u.test(word) && !/^-\p{L}{2,}[^=]*\//u.test(word)) return true;
  // HOME=/x starts a path; B=C/x.pdf can be one. pat@mybox and pat@mybox:/x are an address; Smith@Home/x.pdf can be a folder.
  if (/=(?:[/~$"'`\\]|[A-Za-z]:[\\/])/.test(word)) return true;
  const at = word.indexOf('@');
  if (at <= 0 || !/^[\p{L}\p{N}]$/u.test(word[at - 1]!) || !/^[\p{L}\p{N}]$/u.test(word[at + 1] ?? '')) return false;
  const slash = word.indexOf('/', at);
  return slash < 0 || word[slash - 1] === ':';
}
/**
 * A space in a path can't be told from the end of it, and a leak is worse than a
 * lost word. So what comes after is judged on the same line, in two steps:
 *
 * 1. Up to twelve words on, a word that holds a separator or ends like a file name
 *    means everything up to it was the path, whatever the words between: "Insurance
 *    Denied Claims/x.pdf", "Letters to Jane/a.pdf". Only another path, an option, a
 *    setting's path or a character no path run takes ends the look (beginsAnother).
 *    A sentence that names a second path goes with it: the price of the rule.
 * 2. With nothing like that later on the line, up to six capitalized or foreign words
 *    right after a path that is masked anyway (`names`) are its name (/srv/Smith Family).
 *    A log's word, a label or a common word in lowercase ends it there, so the sentence
 *    after a path stays.
 *
 * Answers where the path goes on from (`at`, with a run to read there) or ends.
 */
function afterSpace(text: string, end: number, sep: RegExp, names: boolean): { at?: number; end: number } {
  const fileBefore = ENDS_IN_FILE.test(text.slice(Math.max(0, end - 9), end));
  // `/srv/Project: Roe Family/x.pdf`: a colon ends the run, but only a word after it can say it ended the path.
  const colon = text[end] === ':' && (text[end + 1] === ' ' || text[end + 1] === '\t');
  const from = colon ? end + 1 : end;
  let i = from;
  for (let n = 0; n < 12; n++) {
    let w = i;
    while (text[w] === ' ' || text[w] === '\t') w++;
    if (w === i || w >= text.length) break;
    let e = w;
    while (e < text.length && !/\s/.test(text[e]!)) e++;
    const word = text.slice(w, e);
    if (beginsAnother(word)) break;
    // A character no run of a path takes: what is before it can still be the end of the path.
    const cut = word.search(/["`<>|;*]/);
    const piece = cut < 0 ? word : word.slice(0, cut);
    const core = piece.slice(0, trimEnd(piece, 0, piece.length));
    if (!SLASH_WORD.test(core)) {
      if (sep.test(core)) return { at: w, end: w };
      if (FILE_END.test(core)) return { end: w + core.length };
    }
    if (cut >= 0) break;
    i = e;
  }
  if (colon || !names || fileBefore) return { end };
  // Nothing later reads as a path: only capitalized words go with it.
  let best = end, taken = 0;
  i = end;
  for (let n = 0; n < 12; n++) {
    let w = i;
    while (text[w] === ' ' || text[w] === '\t') w++;
    if (w === i || w >= text.length) break;
    let e = w;
    while (e < text.length && !/\s/.test(text[e]!)) e++;
    const word = text.slice(w, e);
    if (/^(?:[/~"'`<{$]|--?\p{L})/u.test(word) || /:\/\/|[=@]/.test(word) || word.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(word)) break;
    const cut = word.search(/["`<>|;*]/);
    const piece = cut < 0 ? word : word.slice(0, cut);
    const core = piece.slice(0, trimEnd(piece, 0, piece.length));
    const bare = core.toLowerCase();
    if (sep.test(core) || LOG_WORDS.has(bare) || (/^\p{Lu}[\p{L}-]*:$/u.test(word) && LABEL_WORDS.has(bare))) break;
    if (core === bare && SENTENCE_WORDS.has(bare)) break;
    // Small words and numbers are taken only when a name comes after them.
    if (core && !NAME_JOINS.has(bare) && !TITLE_JOINS.has(bare) && !/^\(?\d+\)?$/.test(core)) {
      if (SENTENCE_WORDS.has(bare) || taken >= 6 || !NAME_LIKE.test(core)) break;
      best = w + core.length;
      taken++;
    }
    if (cut >= 0 || (/[.;:!?]$/.test(word) && !FOLDER_ABBREVIATION.test(word))) break;
    i = e;
  }
  return { end: best };
}

// A mount's unit is its path with - for /: home-samdoe-Smith\x20Family.mount, mnt-Smith.mount. Any other unit only with an escape in it.
const SYSTEMD_ESCAPED = /(?<![\w\\.:@-])(?:(?:home|mnt|media|srv|Users|Volumes|run-media)-[\w.:@\\-]*(\.(?:mount|automount))|[\w.:@-]*(?:\\x[0-9a-f]{2}[\w.:@-]*)+(\.(?:mount|automount|service|path|scope|slice|socket|target|timer|device|swap)))\b/g;
const QUERY_START = /\?[\w.%-]{1,40}=/;
const QUERY_VALUE = /([?&][\w.%-]{1,40}=)(?![{*])([^\s&#"'<>)]+)/g;
/**
 * A query's value that looks like a path or a file goes, whatever the route: ?path=Taxes%2FJane%20Roe.pdf,
 * ?file=x.pdf, ?next=/login. One that starts like a whole path is left to maskPaths, which reads
 * past a space in it.
 */
function maskQueryValue(m: string, lead: string, value: string): string {
  if (/@|%40/i.test(value) || /^(?:\/[^/]*\/|~|\$)/.test(value)) return m;
  return /[/\\]|%2F|%5C/i.test(value) || FILE_END.test(value) ? `${lead}{path}` : m;
}

const ROUTE_PATTERN = /^(?:\/(?:[a-z0-9._-]+|:[A-Za-z_][\w-]*\??|\$\{[\w.]+\}))+\/?$/;
/** app.get('/join/:code') and `/join/${code}`: between quotes, code rather than a folder. */
const isRoutePattern = (p: string, quote: string) => ROUTE_PATTERN.test(p) && /\/(?::|\$\{)/.test(p) && (quote === '`' || !p.includes('${'));

const HOME_LEADS = new Set(['~', '$HOME', '${HOME}']);
const pathView = (lead: string, body: string) => (lead === '/' || lead === 'file://' || lead === 'unix://' ? judgePath(body) : HOME_LEADS.has(lead) ? judgePath(`~${body}`) : {});

/** What a path shows in the report, given how it was written. */
function maskedPath(lead: string, body: string): string {
  const view = pathView(lead, body);
  if (view.kept) return lead === '/' ? body : lead + body;
  if (view.folder) return `${lead === '/' ? '' : lead}${HOME_LEADS.has(lead) ? view.folder.slice(1) : view.folder}{path}`;
  if (lead === '/' || lead === '//') return '{path}';
  if (lead === '~' || lead.startsWith('$')) return `${lead}${body.startsWith('\\') ? '\\' : '/'}{path}`;
  if (lead.startsWith('%')) return `${lead}\\{path}`;
  return lead.endsWith('://') ? `${lead}{path}` : '{path}'; // smb://…, or ~other/…, a drive, a share
}

/** Every path in the text masked, as a scan: one pass, however the text is made. */
function maskPaths(text: string): string {
  let out = '', last = 0, m: RegExpExecArray | null;
  PATH_START.lastIndex = 0;
  while ((m = PATH_START.exec(text))) {
    const start = m.index, lead = m[0];
    const slashLead = lead === '/' || lead === '//';
    const quote = text[start - 1] ?? '';
    if (lead === '/' && (quote === "'" || quote === '"' || quote === '`')) {
      const close = text.indexOf(quote, start);
      if (close > 0 && isRoutePattern(text.slice(start, close), quote)) { PATH_START.lastIndex = close; continue; }
    }
    const windows = lead.startsWith('\\') || /^[A-Za-z]:$/.test(lead) || lead.startsWith('%') || text[start + lead.length] === '\\';
    const run = windows ? WINDOWS_RUN : POSIX_RUN;
    const sep = windows ? /[\\/]/ : /\//;
    const bodyAt = slashLead ? start : start + lead.length;
    let end = bodyAt, stop = bodyAt, first = true;
    for (;;) {
      run.lastIndex = end;
      const runAt = end;
      end += run.exec(text)?.[0].length ?? 0;
      stop = trimEnd(text, runAt, end);
      // Judged once, before any space is taken in: what is kept takes nothing from a sentence but more path.
      const seen = text.slice(bodyAt, stop);
      // A query on a kept route is its own: the route stays, and each value is judged where it starts (below).
      const query = first ? seen.search(QUERY_START) : -1;
      if (query >= 0 && pathView(lead, seen.slice(0, query)).kept) { end = stop = bodyAt + query; break; }
      const kept = first ? pathView(lead, seen).kept : undefined;
      first = false;
      if (kept === 'system' && (!FOLDER_WITH_SPACES.test(seen) || LIBRARY_FILE.test(seen) || text[end] !== ' ')) break;
      // A stop at the end of a name ends the sentence, unless the name is "St." or "Jr.", or a later word holds a separator.
      const sentence = /[.!?]/.test(text.slice(stop, end)) && !FOLDER_ABBREVIATION.test(text.slice(Math.max(bodyAt, end - 6), end));
      const next = afterSpace(text, end, sep, !kept && !sentence);
      if (next.at === undefined) { if (next.end > end) stop = next.end; break; }
      end = next.at;
    }
    const body = text.slice(bodyAt, stop);
    // \\NAS-SMITH alone is a machine; \\nas could be an escape, so only with capitals.
    const named = /[^\\/]/.test(body) && (!slashLead || body.slice(lead.length).includes('/')) && (lead !== '\\\\' || sep.test(body) || /[A-Z]/.test(body));
    // Two names at least from a bare slash: a lone "/login" is more often a chat command than a folder.
    if (!named) { PATH_START.lastIndex = start + lead.length; continue; }
    out += text.slice(last, start) + maskedPath(lead, body);
    last = stop;
    PATH_START.lastIndex = stop;
  }
  return out + text.slice(last);
}

// Between quotes the whole of it is the path, whatever is in it ('/srv/Family Name.txt').
const QUOTED_PATH = /(["'`])((?:\/[^"'`\n/\\$*^|(){}[\]+?]|~[^\s"'`/]*\/|\$HOME\/|\$\{HOME\}\/|[A-Za-z]:[\\/]|\\\\)[^"'`\n]*)\1/g;
function maskQuotedPath(m: string, q: string, p: string): string {
  if (p.startsWith('/')) {
    if (!/^\/[^/]+\/./.test(p)) return m;                          // one name: a command, a route
    if (isRoutePattern(p, q)) return m;
    const query = p.search(QUERY_START);
    if (query >= 0 && pathView('/', p.slice(0, query)).kept) return m; // the query's values are judged after, by maskPaths
    return `${q}${maskedPath('/', p)}${q}`;
  }
  if (/^[A-Za-z]:|^\\\\/.test(p)) return `${q}{path}${q}`;
  const home = /^(~|\$HOME|\$\{HOME\})\//.exec(p);
  if (!home) return `${q}{path}${q}`;                              // ~other/…
  if (p.length === home[0].length) return m;
  return `${q}${maskedPath(home[1]!, p.slice(home[1]!.length))}${q}`;
}

// The rest of the masks go a whole run of a name's characters at a time, judged once. Regexes that started
// again at every "." or "-" of a run took 17 s on 60,000 characters of "a.a.a…", on the server's one thread.
const trailingAt = (s: string, chars: string) => { let e = s.length; while (e > 0 && chars.includes(s[e - 1]!)) e--; return e; };

/** A package's or image's version after an @ is not an address: openclaw@2026.9.8, runtime@sha256:…. Four numbers are one (pat@10.0.0.5). */
const VERSION_SIDE = /^(?:v?\d+(?:\.\d+){0,2}(?:[-+][\p{L}\p{N}.+-]*)?|latest|next|beta|alpha|canary|stable|rc|lts|edge|nightly|sha\d+)$/iu;
const ADDRESS_RUN = new RegExp(String.raw`[${LETTERS}_.+%@-]+`, 'gu');
function maskAddress(run: string): string {
  const at = /@|%40/i.exec(run);
  if (!at) return run;
  const left = run.slice(0, at.index);
  const end = trailingAt(run, '._+%-');
  const right = run.slice(at.index + at[0].length, end);
  // No name before the @ (@types/node), or none after it.
  if (!/[\p{L}\p{N}]/u.test(left) || !right) return run;
  if (VERSION_SIDE.test(right)) return run;
  let lead = 0;
  while (lead < left.length && '._+%-'.includes(left[lead]!)) lead++;
  return `${left.slice(0, lead)}${right.includes('.') || right.includes('@') ? '{email}' : '{user}@{host}'}${run.slice(end)}`;
}

const NAME_RUN = new RegExp(String.raw`[${LETTERS}_.-]+`, 'gu');
const LAN_SUFFIX = ['.local', '.lan', '.localdomain', '.internal', '.intranet', '.home.arpa', '.corp'];
// The numbers of an address inside a name: c-73-1-2-3.isp.example.net, 203.0.113.5.nip.io.
// One separator all through, as a real one is written: 1.1.1-8 is a version.
const OCTETS = /(?:^|[-.])(\d{1,3})([-.])(\d{1,3})\2(\d{1,3})\2(\d{1,3})(?=[-.]|$)/;
// What ends a package's or a file's name, not a machine's: openssl-1.2.3.4.el8.noarch, img-1-2-3-4.example.png.
const FILE_LABEL = /^(?:noarch|rpm|deb|apk|tgz|gz|xz|zip|whl|jar|gem|png|jpe?g|gif|svg|js|ts|json|log|txt|md|html?|css|ya?ml|toml|conf|pem)$/;
// A settings file next to the real one (config.local), not a machine.
const FILE_BEFORE_LAN_SUFFIX = /^(?:configs?|settings|env|environment|compose|docker-compose|values|vars|overrides?|secrets|credentials|application|appsettings|tsconfig|package)\.[a-z.]+$/;
function maskName(run: string): string {
  if (run.startsWith('.')) return run;                                           // .env.local, ~/.local: a file
  const end = trailingAt(run, '.-_');
  const name = run.slice(0, end).toLowerCase();
  if (!name.includes('.')) return /^ip(?:-\d{1,3}){4}$/.test(name) ? `{host}${run.slice(end)}` : run;
  if (name.endsWith('.docker.internal') || name === 'localhost.localdomain') return run;
  if (name.endsWith('.ts.net')) return `{tailnet-host}${run.slice(end)}`;
  if (LAN_SUFFIX.some((x) => name.endsWith(x))) return FILE_BEFORE_LAN_SUFFIX.test(name) ? run : `{host}${run.slice(end)}`;
  const m = OCTETS.exec(name);
  if (m && [m[1], m[3], m[4], m[5]].every((x) => +x! <= 255) && !name.endsWith('.tar.gz') && !name.endsWith('.tar.xz')) {
    // Two labels after the numbers at least, the last of them a word: not file-1-2-3-4.js, nor a version.
    const after = name.slice(m.index + m[0].length).split('.').filter(Boolean);
    if (after.length >= 2 && /^[a-z]{2,}$/.test(after.at(-1)!) && !FILE_LABEL.test(after.at(-1)!)) return `{host}${run.slice(end)}`;
  }
  return run;
}

const SSH_HOST = String.raw`(\[[^\]\s]+\](?::\d+)?|[^\s'"(),:;{}]+)`;
const SSH_USER = String.raw`(?: (?:(?:authenticating|invalid) )?user [^\s]+)?`;
/** The hosts in ssh's own errors, for a machine this app may have no record of. A phrase with no host in it stays ("closed by remote host"). */
function maskSshWords(text: string): string {
  return text
    .replace(new RegExp(String.raw`\b(connect to host|resolve hostname) (?!\{)${SSH_HOST}`, 'gi'), '$1 {host}')
    .replace(new RegExp(String.raw`\b(Connection to|Connection (?:closed|reset|refused) by|Unable to negotiate with|Received disconnect from|Disconnected from)(${SSH_USER}) (?!\{)${SSH_HOST}(?= port \d| \d+ port| closed\b)`, 'gi'),
      (_m, lead: string, user: string) => `${lead}${user ? user.replace(/[^\s]+$/, '{user}') : ''} {host}`)
    .replace(new RegExp(String.raw`\b(Host key for|Timeout, server) (?!\{)${SSH_HOST}(?= has changed| not responding)`, 'gi'), '$1 {host}')
    .replace(/\b(Permanently added|authenticity of host|IP address for|host key for) '[^'\n]*'/gi, "$1 '{host}'")
    .replace(new RegExp(String.raw`\b(debug\d: Connecting to|Connecting to(?= \S+ \[)) (?!\{)${SSH_HOST}`, 'gi'), '$1 {host}')
    .replace(new RegExp(String.raw`\b(Authenticating to) (?!\{)${SSH_HOST}((?::\d+)? as )'[^'\n]*'`, 'gi'), "$1 {host}$3'{user}'");
}

const WORD_RUN = new RegExp(String.raw`[${LETTERS}]+`, 'gu');
const wordPattern = (w: string) => w.split(/[\s_.+-]+/).filter(Boolean).map(esc).join(String.raw`(?:[\s_.+-]|%20)+`);

/** Where a word may start: not inside a word, but after a URL's escape (Hello%20Alice), whose digits are no part of the name. */
const WORD_START = String.raw`(?:(?<![${LETTERS}])|(?<=%[0-9A-Fa-f]{2}))`;
/**
 * Private words masked as whole words, longest first. In any case from 6
 * characters, or always with "any"; a shorter name ("To Do") only as written, or
 * every "to do" in the prose would go too, and always only as written with
 * "exact". A name matches however its words are joined (Family Recipes,
 * family-recipes, Family%20Recipes). Under 3 characters, or only digits (a date's
 * 2026), it is not looked for. Only the names whose words are all in the text go
 * into the pattern, so it stays small however many the install has.
 */
function maskWords(text: string, words: Iterable<string> | undefined, as: string, rule: 'any' | 'long' | 'exact' = 'long'): string {
  const all = [...new Set([...(words ?? [])].map((w) => String(w ?? '').trim()).filter((w) => w.length >= 2 && !isGeneric(w) && !/^\p{N}+$/u.test(w)))];
  if (!all.length) return text;
  let out = text;
  for (const w of all) if (UNSPACED_SCRIPT.test(w) && out.includes(w)) out = out.split(w).join(as);
  const seen = new Set([...(out.toLowerCase().match(WORD_RUN) ?? []), ...(out.replace(/%[0-9a-f]{2}/gi, ' ').toLowerCase().match(WORD_RUN) ?? [])]);
  const list = all.filter((w) => w.length >= 3 && !UNSPACED_SCRIPT.test(w) && /[\p{L}\p{N}]/u.test(w) && (w.toLowerCase().match(WORD_RUN) ?? []).every((x) => seen.has(x)))
    .sort((a, b) => b.length - a.length).slice(0, 2000);
  const loose = (w: string) => rule === 'any' || (rule === 'long' && w.length >= 6);
  for (const [group, flags] of [[list.filter(loose), 'giu'], [list.filter((w) => !loose(w)), 'gu']] as const) {
    // A few hundred at a time: V8 stops optimizing a pattern this size, and 2,000 names in one took 4 s where 300 take 15 ms.
    for (let i = 0; i < group.length; i += 200) {
      out = out.replace(new RegExp(String.raw`${WORD_START}(?:${group.slice(i, i + 200).map(wordPattern).join('|')})(?![${LETTERS}])`, flags), as);
    }
  }
  return out;
}

/** Usernames that are words a sentence uses all the time, and nothing else: only these can't be masked wherever they turn up. */
const COMMON_WORD_USERS = new Set('will may might max min page mark bill rose jack grace hope joy art dawn frank june april august'.split(' '));
/**
 * Usernames, in any case: Samdoe is samdoe. Only one of COMMON_WORD_USERS can't be told
 * from the word: as written when it has a capital in it, and otherwise, in any case,
 * wherever the line says it is a user: `USER=WILL`, `User will`, `author=will`,
 * uid=1000(will), `-l will`, sshd's `for will from`, sudo's `will :`, ls -l's owner and
 * group, `chown will:will`, `su - will`, `whoami: will`, `id will`, `usermod -aG x will`,
 * `who`'s `will pts/0`. Its paths and addresses are masked by their shape.
 */
function maskUsers(text: string, users: readonly string[]): string {
  const clean = [...new Set(users.map((u) => String(u ?? '').trim()))];
  const common = clean.filter((u) => COMMON_WORD_USERS.has(u.toLowerCase()));
  let out = maskWords(maskWords(text, clean.filter((u) => !COMMON_WORD_USERS.has(u.toLowerCase())), '{user}', 'any'), common.filter((u) => /\p{Lu}/u.test(u)), '{user}', 'exact');
  const names = new Set(common.map((u) => u.toLowerCase()));
  if (!names.size) return out;
  const name = `(${[...names].map(esc).join('|')})(?![${LETTERS}_-])`;
  const isUser = (w: string) => names.has(w.toLowerCase());
  return out
    .replace(new RegExp(String.raw`(?<![A-Za-z0-9-])((?:user(?:name)?|login|logname|owner|author|committer|whoami)[ \t]*[:=][ \t]*["']?|user[ \t]+["']?|(?:-[a-z]*[lu]|--user|--login)[ =]?["']?|[ug]id=\d+\(|sudo(?:\[\d+\])?:[ \t]+|su(?:[ \t]+-\S*)*[ \t]+|id:[ \t]+['‘]|(?:usermod|useradd|userdel|adduser|deluser|passwd|groups|getent[ \t]+passwd)(?:[ \t]+\S+){0,3}?[ \t]+)${name}`, 'giu'), '$1{user}')
    // A command at the start of a line or after a shell's separator, not "the id will change".
    .replace(new RegExp(String.raw`((?:^|[;&|$#])[ \t]*(?:sudo[ \t]+)?id(?:[ \t]+-\S+)*[ \t]+)${name}`, 'gimu'), '$1{user}')
    .replace(new RegExp(String.raw`(?<![A-Za-z0-9-])(for[ \t]+)${name}(?=[ \t]+from\b)`, 'giu'), '$1{user}')
    .replace(new RegExp(String.raw`(?<![A-Za-z0-9-])${name}(?=\(uid=\d|[ \t]+:[ \t]+TTY=)`, 'giu'), '{user}')
    .replace(new RegExp(String.raw`^([ \t]*)${name}(?=[ \t]+(?:pts|tty)\b)`, 'gimu'), '$1{user}')
    // ls -l's owner and group.
    .replace(/(?<![\w-])([-dlcbps][-rwxsStT]{9}[.+@]?[ \t]+\d+[ \t]+)(\S+)([ \t]+)(\S+)/g, (_m, lead: string, a: string, gap: string, b: string) => `${lead}${isUser(a) ? '{user}' : a}${gap}${isUser(b) ? '{user}' : b}`)
    .replace(/(?<![\w-])((?:chown|chgrp)(?:[ \t]+-\S+)*[ \t]+)(\S+)/gi, (_m, lead: string, spec: string) => lead + spec.replace(/[^:.]+/g, (w) => (isUser(w) ? '{user}' : w)));
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/’/g, "'");
const APOSTROPHE_WORD = new RegExp(String.raw`[${LETTERS}]+['’]\p{L}+`, 'gu');
// In the text, a URL's escape comes off the front: %20Alice is Alice.
const TEXT_WORD = new RegExp(String.raw`((?<=%)[0-9A-Fa-f]{2})?([${LETTERS}]+(?:['’]\p{L}+)?)`, 'gu');
/**
 * People's names. The whole of a name of two words or more, in any case and whatever
 * its parts (will page, BOB FOX, Alma Rocky), unless no part of it says it is a person
 * (isDefaultName): Living Room goes only as written, and Telegram User, with nothing but
 * generic words in it, not at all. Then each part of 3 letters or more in any case, so
 * "Alice asked" goes for member Alice Example. O'Brien counts as one part too, for a
 * surname written alone. A part that is really an everyday word, and a one-word name of
 * 2 letters: only as written. A 2-letter part of a longer name alone stays. Generic
 * words alone (Slack, family, van) and digits (Alex 2026, a date's 2026) are not masked,
 * nor an email's domain (a display name can be an address: sam@example.org is only "sam").
 * Then the ids. One pass over the words, whatever the number of people.
 */
const personName = (raw: unknown) => String(raw ?? '').replace(/<[^>]*>/g, ' ').replace(/(?:@|%40)[^\s>)]*/gi, '').trim();
const partsOf = (name: string) => (name.match(WORD_RUN) ?? []).filter((x) => !/^\p{N}+$/u.test(x));
function wholeNames(people: Iterable<string> | undefined): string[] {
  return [...(people ?? [])].map(personName).filter((name) => (name.match(WORD_RUN) ?? []).length > 1 && partsOf(name).length > 0 && !isDefaultName(partsOf(name)));
}
function maskPeople(text: string, people: Iterable<string> | undefined, ids: Iterable<string> | undefined): string {
  const asWritten = new Set<string>(), anyCase = new Set<string>(), phrases: string[] = [], exactPhrases: string[] = [], unspaced: string[] = [];
  for (const raw of people ?? []) {
    const name = personName(raw);
    const words = name.match(WORD_RUN) ?? [];
    const parts = partsOf(name);
    if (words.length > 1 && parts.length) {
      if (!isDefaultName(parts)) phrases.push(name);
      else if (parts.some((x) => !isGeneric(x))) exactPhrases.push(name);
    }
    for (const part of parts) {
      if (isGeneric(part)) continue;
      if (UNSPACED_SCRIPT.test(part)) { if (part.length >= 2) unspaced.push(part); continue; }
      const letters = [...part].length;
      if (letters >= 3 && !isEveryday(part)) anyCase.add(fold(part));
      else if (letters >= 3 || parts.length === 1 && letters === 2) asWritten.add(part);
    }
    for (const word of name.match(APOSTROPHE_WORD) ?? []) anyCase.add(fold(word));
  }
  const known = new Set([...(ids ?? [])].map((x) => String(x ?? '').trim()).filter((x) => x.length >= 5));
  let out = maskWords(maskWords(text, phrases, '{name}', 'any'), exactPhrases, '{name}', 'exact');
  for (const w of unspaced) if (out.includes(w)) out = out.split(w).join('{name}');
  if (!asWritten.size && !anyCase.size && !known.size) return out;
  const isName = (w: string) => asWritten.has(w) || anyCase.has(fold(w));
  const judged = (w: string) => {
    if (known.has(w)) return '{id}';
    if (isName(w)) return '{name}';
    // Pat's is Pat's; don't is not Don's.
    const stem = /^(.+)(['’]s)$/su.exec(w);
    return stem && isName(stem[1]!) ? `{name}${stem[2]}` : w;
  };
  return out.replace(TEXT_WORD, (m: string, escape: string | undefined, w: string) => {
    if (!escape) return judged(w);
    const whole = judged(m);
    return whole !== m ? whole : `${escape}${judged(w)}`;
  });
}

// A bare value: stops where redactCredentialFields' does. Keeps a reference to a setting, which is not a value.
// Curly, guillemet, CJK and fullwidth quotes as quotes: DB_PASS: “a b c” left "b c”".
const FIELD_VALUE = String.raw`"[^"\n]*"|'[^'\n]*'|${OTHER_QUOTED}|(?![\u201C\u2018\u00AB\u201E\u300C\uFF02])[^\s,;&"'}\])]+`;
const isSettingRef = (v: string) => /^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Za-z_]\w*\})$/.test(v);
const hasLetterAndDigit = (v: string) => /\p{L}/u.test(v) && /\d/.test(v);
const manyDigits = (v: string) => /^\d{4,}$/.test(v);
// Already masked: the whole value, quotes and a closing mark aside. A mask inside one is not the value masked:
// DB_PASS=hunter2?token=*** kept its hunter2 when any * or { in it counted (HB-0501 review).
// A template's reference is code too, as when any { counted: --token ${t.json.token}, data-key="${esc(key)}".
// Not one with a shell default in it (${PASS:-x}), and not one holding a quote.
const isMask = (v: string) => /^["'\u201C\u2018]?(?:\*+|\{[a-z-]+\})["'\u201D\u2019]?[.,;:!?)\]}>]*$/.test(v)
  || (/^["']?\$\{[\w.?$()[\], ]*(?:\}|$)/.test(v) && !/:[-=?+]/.test(v));
const PLAIN_VALUE = /^(?:\d{1,3}|true|false|yes|no|ok|null|none|on|off)$/i;
const TEST_PASS = /^(?:tests?|num|total|n)[_.-]?pass$/i;
// camelCase, which needs no separator: dbPass, mqttPass, sshKey, appKey. Never bypass or monkey: the end has its capital.
const CAMEL = String.raw`[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*`;
// A pass name may be PascalCase or end in capitals or Pw too: DbPass, WifiPass, adminPASS, routerPw. A key name may not
// (SortKey, PrimaryKey are code).
const CAMEL_PASS = String.raw`[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*(?:Pass|PASS|Pw)`;
// A pass or key name in any case after a separator (Db_Pass, garden_KEY, Garden_Key, db_pw), all capitals, or camelCase.
const PASS_OR_KEY = String.raw`(?:[\w.-]*[_.-])?(?:pass|PASS|Pass|pw|PW|Pw)|${CAMEL_PASS}|(?:[A-Z0-9_]*_)?KEY|[A-Za-z0-9_-]*[A-Za-z0-9][_-](?:key|Key|KEY)|${CAMEL}Key`;
/**
 * "DB_PASS": "x", {"pass":"x"}, \\"GARDEN_KEY\\":\\"x\\", {"pass":123456}, {"dbPass":"x"}: a quoted name and its value, as JSON or a
 * hash writes them, read the way quotedFieldMasker reads them (HB-0501: a quote inside the value cut it). Not "test_pass":"12" or "pass":"true".
 */
// A ternary's `? 'session-key' : rt?.source` is kept by quotedFieldMasker itself; any other unquoted value goes.
const maskQuotedPassAndKey = quotedFieldMasker(PASS_OR_KEY, 'g',
  (v, key) => isSettingRef(v) || /^\*+$|^\{[a-z-]+\}$/.test(v) || TEST_PASS.test(key) || PLAIN_VALUE.test(v));
/**
 * Docker's config.json: "auth":"<base64 of user:password>", too short for the long-key rule. Only a value that
 * decodes to a name and a colon: "auth": "oauth" or "auth": true stays.
 */
const maskDockerAuth = quotedFieldMasker('auths?', 'g', (v, _key, quoted) => !quoted || !/^[A-Za-z0-9+/]{4,}={0,2}$/.test(v)
  || !/^[^:\s]{1,256}:/.test(Buffer.from(v, 'base64').toString('latin1')));
// "credentials": "bob:x", "db_creds": "…". Not fetch's credentials: 'include', 'same-origin' or 'omit'.
const maskCredentialsField = quotedFieldMasker(String.raw`(?:[\w.-]*[_.-])?(?:credentials?|Credentials?|CREDENTIALS?|creds|Creds|CREDS)|${CAMEL}Credentials?`, 'g',
  (v, _key, quoted) => !quoted || /^\*+$|^\{[a-z-]+\}$/.test(v) || isSettingRef(v) || PLAIN_VALUE.test(v) || /^(?:include|same-origin|omit)$/.test(v));
/**
 * Credentials written the ways redactSecrets leaves alone, for a public report
 * only (redact.ts is shared with logs and errors, where "pass=12" and a word
 * after "password" matter more): options, plain words, curl's -u, cookies, and
 * the codes in an invite or reset link. A value in plain words can't be told
 * from a sentence, so one after a bare "password" goes only if it has a letter and a
 * digit in it, or is 4 digits or more. After a bare "token" digits alone stay (max token 4096).
 */
function maskCredentialForms(text: string): string {
  const first = text
    // --password hunter2xyz, --token abc123def. Not --password-stdin, or the next option.
    .replace(/(^|[\s'"(])(--?[A-Za-z0-9_-]*(?:password|passwd|passphrase|pass|pwd|token|secret|api-?key))[ \t]+(?!-)("[^"\n]*"|'[^'\n]*'|[^\s'"]+)/gim,
      (m, at: string, flag: string, v: string) => (isSettingRef(v) || isMask(v) ? m : `${at}${flag} ***`))
    // password hunter2, the token is abc123.
    .replace(/(?<![\w-])(password|passwd|passphrase|token|secret|api[ _-]?key)((?:[ \t]+is)?[ \t]+)(\S+)/gi,
      (m, word: string, gap: string, v: string) => {
        const end = trailingAt(v, '.,;:!?)\'"');
        const value = v.slice(0, end);
        const secret = hasLetterAndDigit(value) || (manyDigits(value) && !/^(?:token|api)/i.test(word));
        return secret && !isMask(v) ? `${word}${gap}***${v.slice(end)}` : m;
      })
    // pass=hunter2, pass=123456, db_pass: x, PASS: x. Not a test run's pass=12, pass: ok or test_pass=12, nor pass: x in a sentence.
    // db_pw=x and pw=x the same way; a fullwidth colon is a colon.
    .replace(new RegExp(String.raw`(?<![\w.-])((?:[\w.-]*[_.-])?(?:pass|pw))(=(?![=>])|[:\uFF1A][ \t]*)(${FIELD_VALUE})`, 'gi'), (m, key: string, sep: string, v: string) => {
      if (isSettingRef(v) || isMask(v)) return m;
      const plain = /^(?:\d{1,3}|true|false|yes|no|ok|null|none|on|off)$/i.test(v);
      const named = key.length > 4 && !/^(?:tests?|num|total|n)[_.-]pass$/i.test(key);
      if (named) return `${key}${sep}***`;
      if (plain) return m;
      return sep === '=' || key === 'PASS' || hasLetterAndDigit(v) || manyDigits(v) ? `${key}${sep}***` : m;
    })
    // got bearer abc123def, basic dXNlcjpw: a value after the word, as a header writes it (HB-0499). Only a token's
    // characters (RFC 6750's), 8 or more, with a letter and a digit, base64's padding or a capital inside, or 20 not all
    // letters. Not "a bearer token", "basic read-only access", "basic v2.173.1", "Basic Information</i>" or "bearer (x)".
    .replace(/(?<![\w-])(bearer|basic)([ \t]+)([^\s'"`,;)\]}]+)/gi, (m, word: string, gap: string, v: string) => {
      const end = trailingAt(v, '.:!?');
      const value = v.slice(0, end);
      // The 8 count base64's padding (basic Ym9iOmE=); a phrase is lowercase words (P-aZpirnuXNeavY is no phrase); digits alone are a token.
      const tokenLike = /^(?=.{8,}$)[A-Za-z0-9._~+/-]+=*$/.test(value) && !/^[a-z]+(?:-[a-z]+)+$/.test(value) && !/^v?\d+(?:\.\d+)+(?:-[\w.]+)?$/.test(value);
      // Both cases and a - or _ (base64url: CDQh-rmc), unless it is words: Step-By-Step.
      const mixedUrl = /[A-Z]/.test(value) && /[a-z]/.test(value) && /[-_]/.test(value) && !/^[A-Z]?[a-z]+(?:[-_][A-Z]?[a-z]+)+$/.test(value);
      const secret = tokenLike && (/^\d+$/.test(value) || (/\d/.test(value) && /[A-Za-z]/.test(value)) || /=$/.test(value) || /[a-z][A-Z]/.test(value) || mixedUrl
        || (value.length >= 20 && !/^[A-Za-z]+$/.test(value)));
      return secret && !isMask(value) && !isSettingRef(value) ? `${word}${gap}***${v.slice(end)}` : m;
    });
  return maskCredentialsField(maskDockerAuth(maskQuotedPassAndKey(first)))
    // GARDEN_KEY=x, ssh_key=x, Garden_Key=x. Not monkey=x, or a key: in code, which is most often a word.
    .replace(new RegExp(String.raw`(?<![\w.-])((?:[A-Z0-9_]*_)?KEY|[A-Za-z0-9_-]*[A-Za-z0-9][_-](?:key|Key|KEY))(=(?![=>])|[:\uFF1A][ \t]+(?=[^\s]*\d))(${FIELD_VALUE})`, 'g'),
      (m, key: string, sep: string, v: string) => (isSettingRef(v) || isMask(v) ? m : `${key}${sep}***`))
    // dbPass=x, mqttPass: x, DbPass=x, routerPw=x, sshKey=x. A camelCase key: in code only with a digit in the value, as above; code itself stays.
    .replace(new RegExp(String.raw`(?<![\w.-])(${CAMEL_PASS}|${CAMEL}Key)(=(?![=>])|[:\uFF1A][ \t]*)(${FIELD_VALUE})`, 'g'), (m, key: string, sep: string, v: string) => {
      if (isSettingRef(v) || isMask(v) || PLAIN_VALUE.test(v) || TEST_PASS.test(key) || looksLikeCode(v)) return m;
      return key.endsWith('Key') && sep !== '=' && !/\d/.test(v) ? m : `${key}${sep}***`;
    })
    // curl's -u with a password. Not docker's user and group: -u 1000:1000, or the same name twice.
    .replace(/(^|\s)(-u[ \t]*|--user[ =])(["']?)([^\s:'"]+):([^\s'"]+)/gm, (m, at: string, flag: string, q: string, a: string, b: string) => {
      if ((/^\d+$/.test(a) && /^\d+$/.test(b)) || a === b || isMask(b)) return m;
      return `${at}${flag}${q}***:***`;
    })
    .replace(/\b((?:Set-)?Cookie:)[ \t]*[^\n'"]+/gi, '$1 ***')
    .replace(/(?<![\w-])([\w-]*_session=)(?!\*)[^\s;,&'"]+/gi, '$1***')
    // A password stuck to -p. Not a port mapped in a docker line that happens to follow the word: -p3306:3306.
    // The whole shell word, its quoted and escaped pieces too: -p'made up' left "up'", -p'it'\''s-x' left "\''s-x'" (HB-0499).
    // A quote with no end goes to the end of the line.
    .replace(/\b((?:mysql|mysqldump|mariadb|mariadb-dump)(?:\s[^\n]{0,200}?)?\s-p)(?![\s*])(?!(?:\d{1,3}(?:\.\d{1,3}){3}:)?\d+:\d+(?:\/\w+)?(?:\s|$))(?:\\.|'[^'\n]*'?|"(?:\\.|[^"\\\n])*"?|[^\s'"\\]+)+/gm, '$1***')
    .replace(/\b(sshpass\s+-p\s*)(?![\s*])(?:\\.|'[^'\n]*'?|"(?:\\.|[^"\\\n])*"?|[^\s'"\\]+)+/g, '$1***')
    // The codes in a link, which sign someone in or take an account: /?claim=…, /join/…, /v1/invites/….
    .replace(/([?&#](?:claim|code|invite|reset|recovery|key|sig|signature)=)(?!\{)[^\s&#"'<>)]+/gi, '$1{code}')
    .replace(/(\/signin\/link\?t=)(?!\{)[^\s&#"'<>)]+/g, '$1{code}')
    .replace(/(\/(?:join|v1\/invites)\/)[A-Za-z0-9_-]{4,}(?![\w.-]*\.\w)/g, '$1{code}');
}

/**
 * Blunt on purpose, like redactSecrets: an issue is public and permanent, so a
 * harmless path masked is the right side to err on. Free text can never be made
 * fully safe by patterns, so the person still reads every line before it goes
 * anywhere; docs/field-reports.md says what is masked and what is not. Each mask
 * holds on a second pass: the draft is masked again as it leaves. Runs in one
 * pass over the text on the server's one thread, so nothing here may start again
 * at every character of a run (test: "how long masking takes").
 */
export function redactForPublic(text: string, ctx: PublicRedactContext = localContext()): string {
  // Again until nothing changes: one mask can uncover what another is looking for. In sam@example.org$HOME/x the
  // path follows a letter, so it is no path until the address before it is masked.
  let out = maskOnce(text, ctx);
  for (let i = 0; i < 3; i++) {
    const again = maskOnce(out, ctx);
    if (again === out) break;
    out = again;
  }
  return out;
}

function maskOnce(text: string, ctx: PublicRedactContext): string {
  // Key material first: a known value or a shorter rule cutting a block's lines would leave the rest of it behind.
  let out = maskCredentialForms(redactSecrets(maskKnownValues(maskKeyMaterial(String(text ?? '').replace(OLD_MASK, '{$1}')), ctx.secrets)));
  // A URL's credentials are masked above; ssh://pat:pw@mybox kept the machine after them.
  out = out.replace(/\/\/\*\*\*:\*\*\*@(?!\{)[^\s/:?#'"<>()]+/g, '//***:***@{host}');
  // Longest first, and before home: a folder inside home keeps its "~/…" form.
  for (const p of [...new Set([...(ctx.paths ?? [])].map((x) => String(x ?? '').replace(/\/+$/, '')))].sort((a, b) => b.length - a.length)) {
    if (p.length < 3 || (ctx.home && (p === ctx.home || p.startsWith(`${ctx.home}/`)))) continue;
    // Whole paths only: "/backups" is masked in "/backups/2026-10-22", never inside
    // "docs/backups.md", "/v1/backups" or "/backups-old" (regression audit, 2026-10-22).
    out = out.replace(new RegExp(`(?<![\\w.~/-])${esc(p)}(?=/|[^\\w.-]|\\.(?!\\w)|$)`, 'g'), '{path}');
  }
  // The whole name: /home/patricia is not inside /home/pat. It was "~ricia".
  if (ctx.home && ctx.home.length > 1) out = out.replace(new RegExp(String.raw`(?<![${LETTERS}_./~-])${esc(ctx.home)}(?![${LETTERS}_.-])`, 'gu'), '~');
  out = maskPaths(out.replace(QUOTED_PATH, maskQuotedPath).replace(/(?<![\w.~%-])[\w.~%-]*%(?:2F|5C)[^\s&"'<>]*%(?:2F|5C)[^\s&"'<>]*/gi, '{path}').replace(SYSTEMD_ESCAPED, (_m, a?: string, b?: string) => `{path}${a ?? b}`).replace(QUERY_VALUE, maskQueryValue));
  out = out
    .replace(/(?:\{path\})+/g, '{path}')
    .replace(ADDRESS_RUN, maskAddress)     // an email, in any script or as %40; ssh's user@host with no dot in the name
    .replace(NAME_RUN, maskName)           // Tailscale and LAN names, and a name carrying an address
    // A machine a runner's address names, whether or not this app still knows it, and any folder after it.
    .replace(/\b(ssh|tcp):\/\/(?![{*])(?:\[[^\]\s]*\]|[^\s/:@'"<>(){}[\]]*[^\s/:@'"<>(){}[\].,;!?])/g, '$1://{host}')
    .replace(/\b((?:ssh|tcp):\/\/(?:\*\*\*:\*\*\*@|\{[\w-]+\}@)?\{[\w-]+\}(?::\d+)?)(\/[^\s'"`<>)]*)/g, (m, at: string, p: string) => (/^\/[^/]+\/./.test(p) ? `${at}{path}` : m))
    .replace(/(?<![\w:-])[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}(?![\w:-])/gi, '{mac}')
    // Whole addresses only ("00:23:10.123" in a timestamp is not one). A home's public
    // address finds it as well as a private one maps it, so both go; only what no
    // machine has stays (0.0.0.0, a netmask), and "::".
    // IPv6 before IPv4, so a mapped ::ffff:10.0.0.7 is judged whole. Only what parses as an address: "10:00:00" is a time.
    .replace(/(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?:%[\w.-]+)?(?![\w:])/gi, (m) => {
      if (isPrivateV6(m)) return '{private-ip}';
      const ip = m.replace(/%.*$/, '');
      return isIPv6(ip) && ip !== '::' ? '{ip}' : m;
    })
    .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a: string, b: string, c: string, d: string) => {
      if ([a, b, c, d].some((x) => +x > 255)) return m;
      if (isPrivateV4(+a, +b)) return '{private-ip}';
      return +a === 0 || +a >= 224 ? m : '{ip}';
    })
    // A Telegram bot's username (they all end in "bot"): public, so anyone could write to it. Not our own name.
    .replace(/@?\b(?!hatchabot\b)[A-Za-z][A-Za-z0-9_]{2,}bot\b/gi, '{bot}');
  out = maskSshWords(out);
  // A person's numbers: a phone, and a chat app's id where the words around it say it is one.
  out = out
    .replace(/(?<![\w+.])\+\d[\d ().-]{6,}\d(?!\w)/g, (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 8 && digits <= 15 && !/^\+\d{4}-\d{2}-\d{2}/.test(m) ? '{phone}' : m;
    })
    .replace(/(?<![\w.:/-])(?:\(\d{3}\) ?\d{3}[ .-]|\d{3}[.-]\d{3}[ .-]|\d{3} \d{3}[.-])\d{4}(?![\w-]|\.\d|:\d)/g, '{phone}')
    // With only spaces, not inside a list of numbers (sizes 512 256 1024 2048).
    .replace(/(?<![\w.:/-]|\d\d )\d{3} \d{3} \d{4}(?![\w-]|\.\d|:\d| \d)/g, '{phone}')
    .replace(/\b(telegram(?:[ _-]?(?:user|chat))?(?:[ _-]?id)?|(?:chat|user|sender|from)[ _-]?id)(["']?[ \t]{0,3}[:=]?[ \t]{0,3}["']?)(\d{5,})\b/gi, '$1$2{id}');
  // A whole name first: a username that is one of its parts would split it, and an everyday surname would stay.
  out = maskWords(out, wholeNames(ctx.people), '{name}', 'any');
  out = maskUsers(out, [...(ctx.user ? [ctx.user] : []), ...(ctx.users ?? [])]);
  // This machine as a runner is: a Mac's Sams-Notebook.local is often written without the .local.
  out = maskWords(out, [...(ctx.host ? [ctx.host, ctx.host.split('.')[0]!] : []), ...(ctx.hosts ?? [])].filter((h) => h !== 'localhost'), '{host}');
  out = maskWords(out, ctx.names, '{name}');
  return maskPeople(out, ctx.people, ctx.ids);
}

export interface ReportInput {
  title: string;
  whatHappened: string;
  steps?: string;
  diagnosis?: string;
  confidence?: 'low' | 'medium' | 'high';
  /** A unified diff against the installed release, paths from the repo root. */
  suggestedPatch?: string;
  /** Who wrote the words: the person, or the manager agent on their behalf. */
  by: 'person' | 'agent';
}

export interface ReportFacts {
  version: string;
  /** "bundle linux-arm64", "git", … */
  install: string;
  platform: string;
  node: string;
  openclaw?: string;
  doctor?: Array<{ level: string; text: string; fix?: string }>;
  /** `agent` is for the manager agent (diagnostics); a public report leaves names out. */
  failures?: Array<{ at: string; event: string; agent?: string; detail?: string }>;
  agent?: { name: string; state: string; reason?: string; model?: string; image?: string; onRunner?: boolean; logs?: string };
}

/** The first `n` UTF-16 units of `s`, one fewer when the cut would split an emoji's surrogate pair (#159). */
const cut = (s: string, n: number) => {
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
};
const clip = (s: string, n: number) => (s.length > n ? `${cut(s, n - 1)}…` : s);
/**
 * Input held to `max` before it is masked: past the bound, the cut word goes
 * too. A credential cut in two no longer matches the value it is masked by,
 * so its first half would stay (#210). Masking comes first everywhere else;
 * this is for where text must be bounded before it can be masked.
 */
export function boundInput(s: string, max: number): string {
  return s.length > max ? cut(s, max).replace(/\S*$/, '') : s;
}
/** A lone surrogate (pasted text can carry one) made U+FFFD: encodeURIComponent throws on one. */
const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
const fence = (s: string, lang = '') => `\`\`\`${lang}\n${s.replace(/```/g, "'''")}\n\`\`\``;

/** The issue body: the person's (or agent's) words, then the facts. Redacted for public use. */
export function buildReport(input: ReportInput, facts: ReportFacts, ctx: PublicRedactContext = localContext()): { title: string; body: string } {
  // The agent it is about is private wherever it turns up — its log, the prose, the patch — not only in the facts.
  const own = { ...ctx, names: [...(ctx.names ?? []), ...(facts.agent?.name ? [facts.agent.name] : [])] };
  // Masked whole, then clipped: a value cut at the clip no longer matches what masks it (#210).
  const r = (s: string) => redactForPublic(s, own);
  const parts: string[] = [];
  parts.push(`<!-- ${REPORT_FORMAT} version=${facts.version} install=${facts.install.replace(/\s+/g, '-')} -->`);
  parts.push('### What happened', clip(r(input.whatHappened.trim()), 4000));
  if (input.steps?.trim()) parts.push('### Steps to reproduce', clip(r(input.steps.trim()), 2000));
  if (input.diagnosis?.trim()) {
    parts.push(`### Diagnosis${input.by === 'agent' ? ' (by the Hatchabot agent on this machine' + (input.confidence ? ` — confidence: ${input.confidence}` : '') + ')' : ''}`, clip(r(input.diagnosis.trim()), 5000));
  }
  if (input.suggestedPatch?.trim()) {
    parts.push(`### Suggested fix (against ${facts.version})`, fence(clip(r(input.suggestedPatch.trim()), 12000), 'diff'));
  }
  const env = [`- Hatchabot ${facts.version} (${facts.install}) · ${facts.platform} · Node ${facts.node}${facts.openclaw ? ` · OpenClaw ${facts.openclaw}` : ''}`];
  if (facts.agent) {
    const a = facts.agent;
    env.push(`- Agent: ${a.state}${a.reason ? ` — ${clip(r(a.reason), 300)}` : ''}${a.model ? ` · ${a.model}` : ''}${a.image ? ` · image ${a.image}` : ''}${a.onRunner ? ' · on a runner' : ''}`);
  }
  parts.push('### Environment', r(env.join('\n')));
  if (facts.doctor?.length) {
    const mark = (l: string) => (l === 'ok' ? '✓' : l === 'warn' ? '⚠' : l === 'fail' ? '✗' : '·');
    parts.push('### hatchabot doctor', fence(r(facts.doctor.map((d) => `${mark(d.level)} ${d.text}${d.fix && d.level !== 'ok' ? `\n    → ${d.fix}` : ''}`).join('\n'))));
  }
  if (facts.failures?.length) {
    parts.push('### Recent failures (last 3 days)', fence(r(facts.failures.slice(0, 15).map((f) => `${f.at.slice(0, 16).replace('T', ' ')}  ${f.event}${f.detail ? `  ${clip(r(f.detail), 200)}` : ''}`).join('\n'))));
  }
  if (facts.agent?.logs?.trim()) parts.push('### Agent log (last lines)', fence(clip(r(facts.agent.logs.trim()), 6000)));
  parts.push(`<sub>Prepared with Hatchabot's Report a problem${input.by === 'agent' ? ' by the Hatchabot agent' : ''}, and reviewed by the person who sent it.</sub>`);
  return { title: clip(r(input.title.trim()), 120), body: parts.join('\n\n') };
}

/**
 * The pre-filled "new issue" link. GitHub refuses very long URLs, so past
 * `max` the long sections are cut from the LINK (never from the draft) and a
 * line asks for the saved file to be attached.
 */
export function issueUrl(title: string, body: string, opts: { slug?: string; max?: number; file?: string } = {}): { url: string; trimmed: boolean } {
  const base = `https://github.com/${opts.slug ?? REPORT_SLUG}/issues/new?labels=field-report`;
  const make = (b: string) => `${base}&title=${encodeURIComponent(wellFormed(title))}&body=${encodeURIComponent(wellFormed(b))}`;
  const max = opts.max ?? 7500;
  if (make(body).length <= max) return { url: make(body), trimmed: false };
  const note = `\n\n> **The full report is in the attached file** (\`${opts.file ?? 'hatchabot-report.md'}\`) — this link was too long for GitHub. Drag the file into this box to attach it.`;
  // Drop the bulkiest sections first, then cut what is left.
  let b = body;
  for (const h of ['### Agent log (last lines)', '### Recent failures (last 3 days)', '### hatchabot doctor', '### Suggested fix']) {
    if (make(b + note).length <= max) break;
    const i = b.indexOf(h);
    if (i < 0) continue;
    const j = b.indexOf('\n### ', i + h.length);
    const sub = b.lastIndexOf('\n\n<sub>');
    b = b.slice(0, i) + `${h} — in the attached file` + (j >= 0 ? b.slice(j) : sub > i ? b.slice(sub) : '');
  }
  while (make(b + note).length > max && b.length > 200) b = cut(b, Math.floor(b.length * 0.85));
  return { url: make(b + note), trimmed: true };
}

// ---- the installed source, read-only -------------------------------------
// The code and docs of the release on this machine, so the agent can diagnose
// against what actually runs and answer settings questions from the docs.
// Never the install's own state: .env, data, backups, node_modules, .git.

const SOURCE_ROOTS = ['src', 'web', 'scripts', 'docs', 'bin', 'docker', 'deploy', 'test'];
const SOURCE_FILES = ['README.md', 'CHANGELOG.md', 'package.json', 'install.sh', '.env.example', 'channels.json'];
const MAX_FILE = 2 * 1024 * 1024;

const inReadableSet = (rel: string) => SOURCE_ROOTS.includes(rel.split(sep)[0]!) || SOURCE_FILES.includes(rel);

/** The lexical check: a repo-relative path naming the readable set. */
function lexicalPath(appDir: string, path: string): string {
  const rel = normalize(String(path ?? '').replace(/^\.?\/+/, ''));
  if (!rel || rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || rel.startsWith(sep)) throw new Error('A path inside the Hatchabot source, like src/api/routes.ts.');
  if (!inReadableSet(rel)) {
    throw new Error(`Only the source and docs: ${[...SOURCE_ROOTS.map((r) => `${r}/`), ...SOURCE_FILES].join(', ')}.`);
  }
  const abs = resolve(appDir, rel);
  if (relative(resolve(appDir), abs).startsWith('..')) throw new Error('Outside the source.');
  return abs;
}

/**
 * The real file or folder behind a path, when THAT is in the readable set.
 * A link is followed and its target checked, not its name: a link under src/
 * to .env or outside the install read what it pointed at (security audit,
 * 2026-10-09). A link to somewhere else in the source is fine. undefined: not
 * there, a loop, or outside.
 */
function realInside(realRoot: string, abs: string): string | undefined {
  let real: string;
  try { real = realpathSync(abs); } catch { return undefined; }
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return inReadableSet(rel) ? real : undefined;
}
const realRootOf = (appDir: string): string => { try { return realpathSync(appDir); } catch { return resolve(appDir); } };

/** A path inside the readable set — as resolved, links followed — or an Error saying why not. */
export function sourcePath(appDir: string, path: string): string {
  const abs = lexicalPath(appDir, path);
  let real: string;
  try { real = realpathSync(abs); } catch {
    // Not there (readSource says so) — or a link that leads nowhere or round in a loop: refused.
    let link = false;
    try { link = lstatSync(abs).isSymbolicLink(); } catch { /* not there */ }
    if (link) throw new Error('Outside the source.');
    return abs;
  }
  if (!realInside(realRootOf(appDir), real)) throw new Error('Outside the source.');
  return real;
}

export function readSource(appDir: string, path: string, from = 1, to?: number): { path: string; from: number; to: number; lines: number; text: string } {
  const abs = sourcePath(appDir, path);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) throw new Error(`No file ${path} in this release.`);
  if (st.isDirectory()) {
    // A link in the folder that leads out of the source is not listed either.
    const realRoot = realRootOf(appDir);
    const names = readdirSync(abs, { withFileTypes: true }).filter((d) => !d.isSymbolicLink() || realInside(realRoot, join(abs, d.name)))
      .map((d) => (d.isDirectory() || (d.isSymbolicLink() && statSync(join(abs, d.name), { throwIfNoEntry: false })?.isDirectory()) ? `${d.name}/` : d.name)).sort();
    return { path, from: 1, to: names.length, lines: names.length, text: names.join('\n') };
  }
  if (!st.isFile()) throw new Error(`${path} is not a file.`);
  if (st.size > MAX_FILE) throw new Error(`${path} is too big to read here.`);
  const all = readFileSync(abs, 'utf8').split('\n');
  const a = Math.max(1, Math.floor(from) || 1);
  const b = Math.min(all.length, to && to >= a ? Math.floor(to) : a + 399, a + 399);
  return { path, from: a, to: b, lines: all.length, text: all.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n') };
}

/** The knowledge pack: searched before anything else (AGENTS.md). */
export const PLAYBOOK = 'docs/troubleshooting.md';
const PACK = [PLAYBOOK, 'docs/architecture-map.md'];

/**
 * The bounds of one search (security audit, 2026-10-09): a pattern that
 * backtracks without end held the server's one thread, for every account.
 * The scan runs in a worker thread that is stopped at `ms`, over at most
 * `files` files and `bytes` bytes; a query is at most `query` characters, and
 * only so many searches run at once, per caller and in all.
 */
export const SEARCH_LIMITS = { query: 300, files: 5000, bytes: 48 * 1024 * 1024, line: 4000, ms: 3000, perCaller: 2, total: 6 };
let running = 0;
const runningFor = new Map<string, number>();
/** Searches running now (their workers alive): for tests. */
export const searchesRunning = (): number => running;

// The scan itself, run in the worker: plain JavaScript, no imports from the app.
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { files, query, regex, limit, packLimit, line: maxLine, playbook, truncated } = workerData;
const re = regex ? new RegExp(query, 'i') : null;
const lower = query.toLowerCase();
const hit = re ? (l) => re.test(l.length > maxLine ? l.slice(0, maxLine) : l) : (l) => l.toLowerCase().includes(lower);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\\u2026' : s);
const matches = [];
let more = false, fromPack = 0;
for (const f of files) {
  if (!f.pack && more) break;
  let text;
  try { text = readFileSync(f.real, 'utf8'); } catch { continue; }
  const lines = text.split('\\n');
  let entry, n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) entry = lines[i].slice(4).trim();
    if (!hit(lines[i])) continue;
    if (f.pack ? n++ >= packLimit : matches.length - fromPack >= limit) { if (!f.pack) more = true; break; }
    matches.push(Object.assign({ path: f.rel, line: i + 1, text: clip(lines[i].trim(), 200) }, entry && f.rel === playbook ? { entry: clip(entry, 160) } : {}));
  }
  if (f.pack) fromPack = matches.length;
}
parentPort.postMessage({ matches, more: more || truncated });
`;

/**
 * Lines containing the query (case-insensitive), across the readable set or
 * under one folder; `regex` for a regular expression. The knowledge pack
 * comes first, with its own room (`packLimit`): a broad search ("400", a model
 * id) filled the 40 lines with code before it reached docs/, and the
 * Hatchabot agent never saw the playbook entry that answered the question
 * (2026-10-07). A playbook line carries the entry it belongs to.
 *
 * Plain text by default, a regular expression only when asked, and either way
 * in a worker stopped at the time limit (SEARCH_LIMITS, 2026-10-09).
 */
export async function searchSource(appDir: string, query: string, under?: string, limit = 40, packLimit = 15,
  opts: { regex?: boolean; caller?: string; ms?: number } = {}): Promise<{
  matches: Array<{ path: string; line: number; text: string; entry?: string }>; more: boolean;
}> {
  const q = String(query ?? '');
  if (!q.trim()) throw new Error('Say what to look for.');
  if (q.length > SEARCH_LIMITS.query) throw new Error(`At most ${SEARCH_LIMITS.query} characters to look for.`);
  let regex = !!opts.regex;
  if (regex) { try { new RegExp(q, 'i'); } catch { regex = false; } } // not a valid expression: looked for as written
  const files = sourceFiles(appDir, under);
  const caller = opts.caller ?? '';
  if (running >= SEARCH_LIMITS.total || (runningFor.get(caller) ?? 0) >= SEARCH_LIMITS.perCaller) {
    throw new Error('Other searches are running: try again in a few seconds.');
  }
  running++;
  runningFor.set(caller, (runningFor.get(caller) ?? 0) + 1);
  const done = () => {
    running--;
    const n = (runningFor.get(caller) ?? 1) - 1;
    if (n > 0) runningFor.set(caller, n); else runningFor.delete(caller);
  };
  let worker: Worker;
  try {
    worker = new Worker(SEARCH_WORKER, {
      eval: true,
      workerData: { files: files.list, query: q, regex, limit, packLimit, line: SEARCH_LIMITS.line, playbook: PLAYBOOK, truncated: files.truncated },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
  } catch (e) { done(); throw e; }
  return new Promise((ok, no) => {
    let settled = false;
    const finish = (err?: Error, value?: { matches: Array<{ path: string; line: number; text: string; entry?: string }>; more: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) no(err); else ok(value!);
    };
    // Stopped, not abandoned: terminate() ends the thread mid-match, so the work ends with the request.
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new Error(`The search took longer than ${Math.round((opts.ms ?? SEARCH_LIMITS.ms) / 1000)} s and was stopped: look for plain text, or a simpler expression.`));
    }, opts.ms ?? SEARCH_LIMITS.ms);
    worker.once('message', (m) => { finish(undefined, m); void worker.terminate(); });
    worker.once('error', (e: Error) => finish(new Error(`The search failed: ${e.message}`)));
    worker.once('exit', () => { done(); finish(new Error('The search stopped.')); });
  });
}

/**
 * The files a search reads, in order: the knowledge pack, then the rest.
 * Each one as resolved — a link counts as where it leads, and a folder
 * reached twice (a link loop, or a link to a folder already searched) is
 * searched once (2026-10-09). Bounded in files and bytes.
 */
function sourceFiles(appDir: string, under?: string): { list: Array<{ real: string; rel: string; pack: boolean }>; truncated: boolean } {
  const realRoot = realRootOf(appDir);
  const rest = under ? [lexicalPath(appDir, under)] : ['docs', 'README.md', ...SOURCE_ROOTS.filter((r) => r !== 'docs'), ...SOURCE_FILES.filter((f) => f !== 'README.md')].map((p) => join(appDir, p));
  if (under && statSync(rest[0]!, { throwIfNoEntry: false }) && !realInside(realRoot, rest[0]!)) throw new Error('Outside the source.');
  const pack = PACK.map((p) => join(appDir, p)).filter((abs) => !under || abs === rest[0] || abs.startsWith(rest[0] + sep));
  const list: Array<{ real: string; rel: string; pack: boolean }> = [];
  const seen = new Set<string>();
  let bytes = 0, truncated = false;
  const visit = (abs: string, isPack: boolean): void => {
    if (truncated) return;
    const real = realInside(realRoot, abs);
    if (!real || seen.has(real)) return;
    seen.add(real);
    const st = statSync(real, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const d of readdirSync(real).sort()) { if (d !== 'node_modules' && !d.startsWith('.')) visit(join(abs, d), false); if (truncated) return; }
      return;
    }
    // Only regular files: a pipe or a device would block the read.
    if (!st.isFile() || st.size > MAX_FILE || !/\.(ts|mjs|cjs|js|sh|md|html|json|yml|yaml|txt|example|service|timer|plist|conf)$|\/[A-Za-z]+file[^/]*$|\.runtime$/.test(abs) && !SOURCE_FILES.some((f) => abs.endsWith(f))) return;
    if (list.length >= SEARCH_LIMITS.files || bytes + st.size > SEARCH_LIMITS.bytes) { truncated = true; return; }
    bytes += st.size;
    list.push({ real, rel: relative(appDir, abs), pack: isPack });
  };
  for (const abs of pack) visit(abs, true);
  for (const s of rest) visit(s, false);
  return { list, truncated };
}

/**
 * Known problems this report may be: playbook entries sharing a quoted phrase
 * (an error message, a log line) with the report, either way round. The
 * Hatchabot agent drafted a public bug report — with a wrong diagnosis — for a
 * problem the playbook already explained (2026-10-07); now the draft says so,
 * to the agent and in the review panel.
 */
export function knownProblems(appDir: string, text: string, max = 3): Array<{ title: string; fixedIn?: string }> {
  let doc = '';
  try { doc = readFileSync(join(appDir, PLAYBOOK), 'utf8'); } catch { return []; }
  const norm = (v: string) => v.toLowerCase().replace(/[“”‘’]/g, "'").replace(/\s+/g, ' ').replace(/^[\s.,;:]+|[\s.,;:]+$/g, '');
  const quoted = (v: string) => [...v.matchAll(/"([^"\n]{10,240})"|'([^'\n]{10,240})'|`([^`\n]{10,240})`|“([^”\n]{10,240})”/g)]
    .map((m) => norm(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')).filter((q) => q.length >= 10);
  // At most so many: a draft of nothing but quoted phrases compared each with every entry, on each GET of it.
  const mine = norm(text), myPhrases = quoted(text).slice(0, 100);
  const out: Array<{ title: string; fixedIn?: string }> = [];
  for (const block of doc.split(/^### /m).slice(1)) {
    const title = block.split('\n')[0]!.trim();
    const body = norm(block);
    const hit = quoted(title).some((q) => mine.includes(q)) || myPhrases.some((q) => body.includes(q));
    if (!hit) continue;
    const fixed = /^- \*\*Fixed in:\*\*\s*`?(v[\d.]+)`?/m.exec(block)?.[1];
    out.push({ title, ...(fixed ? { fixedIn: fixed } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

const STOP = new Set(('about after again agent agents also because before being could every from have into just more most only other over same some such than that their them then there these they this those through when where which while with would your yours what does still after hatchabot').split(' '));
const versionParts = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
/** a > b, as release versions. */
export function newerRelease(a: string, b: string): boolean {
  const x = versionParts(a), y = versionParts(b);
  if (x.length < 3 || y.length < 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

const matchNorm = (v: string) => v.toLowerCase().replace(/[“”‘’]/g, "'").replace(/[^a-z0-9.'"`/:_ -]+/g, ' ').replace(/\s+/g, ' ').trim();
const matchQuoted = (v: string) => [...v.matchAll(/"([^"\n]{8,240})"|'([^'\n]{8,240})'|`([^`\n]{8,240})`|“([^”\n]{8,240})”/g)]
  .map((m) => matchNorm(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')).filter((q) => q.length >= 8);
const matchWords = (v: string) => matchNorm(v).replace(/['"`]/g, ' ').split(' ').filter(Boolean);

interface PlaybookEntry { title: string; titleQuoted: string[]; titleKeys: Set<string>; body: string; bodyPlain: string; fixedIn?: string; text: string }
/** The playbook split and normalized once per version of the file: a query only compares. */
let playbookCache: { path: string; mtimeMs: number; size: number; entries: PlaybookEntry[] } | undefined;
function playbookEntries(path: string): PlaybookEntry[] | undefined {
  let st;
  try { st = statSync(path); } catch { return undefined; }
  if (playbookCache?.path === path && playbookCache.mtimeMs === st.mtimeMs && playbookCache.size === st.size) return playbookCache.entries;
  let doc: string;
  try { doc = readFileSync(path, 'utf8'); } catch { return undefined; }
  const entries = doc.split(/^### /m).slice(1).map((block) => {
    const title = block.split('\n')[0]!.trim();
    const fixedIn = /^- \*\*Fixed in:\*\*\s*`?(v[\d.]+)`?/m.exec(block)?.[1];
    return {
      title,
      titleQuoted: matchQuoted(title),
      titleKeys: new Set(matchWords(title).filter((x) => x.length >= 4 && !STOP.has(x))),
      body: matchNorm(block),
      bodyPlain: matchWords(block).join(' '),
      ...(fixedIn ? { fixedIn } : {}),
      text: `### ${block.trim()}`,
    };
  });
  playbookCache = { path, mtimeMs: st.mtimeMs, size: st.size, entries };
  return entries;
}

/**
 * The playbook entries a symptom most likely is, best first, each in full (the
 * Hatchabot agent's check_known_problem). Scored on what a person or a log
 * actually shows: a quoted message shared either way (strongest), runs of
 * three words in common, then the distinctive words of the entry's title. A
 * weak overlap is not returned: no entry is better than a wrong one.
 */
export function matchKnownProblems(appDir: string, symptom: string, installed: string, max = 3): {
  installed: string;
  matches: Array<{ title: string; score: number; fixedIn?: string; fixedInNewerRelease?: boolean; text: string }>;
} {
  const entries = playbookEntries(join(appDir, PLAYBOOK));
  if (!entries) return { installed, matches: [] };
  const sym = matchNorm(symptom), symWords = matchWords(symptom), symQuoted = matchQuoted(symptom);
  const shingles = new Set(symWords.slice(0, -2).map((_, i) => symWords.slice(i, i + 3).join(' ')).filter((g) => g.replace(/ /g, '').length >= 9));
  const symKeys = new Set(symWords.filter((w) => w.length >= 4 && !STOP.has(w)));
  const scored: Array<{ title: string; score: number; fixedIn?: string; fixedInNewerRelease?: boolean; text: string }> = [];
  for (const e of entries) {
    let score = 0;
    for (const q of e.titleQuoted) if (sym.includes(q)) score += 12;
    for (const q of symQuoted) if (e.body.includes(q)) score += 12;
    for (const g of shingles) if (e.bodyPlain.includes(g)) score += 2;
    for (const w of e.titleKeys) if (symKeys.has(w)) score += 1;
    if (score < 5) continue;
    scored.push({ title: e.title, score, ...(e.fixedIn ? { fixedIn: e.fixedIn, fixedInNewerRelease: newerRelease(e.fixedIn, installed) } : {}), text: e.text });
  }
  scored.sort((a, b) => b.score - a.score);
  return { installed, matches: scored.slice(0, max) };
}

