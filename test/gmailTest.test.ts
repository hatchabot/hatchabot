import { describe, expect, it } from 'vitest';
import { gmailFailure, isAccountEmail, testGmail } from '../src/orchestrator/googleConnections.js';

// The outputs are gog 0.22.0's own, read from the real binary (made-up accounts, a stand-in Google).
const LABEL = JSON.stringify({ label: { id: 'INBOX', messagesTotal: 1234, messagesUnread: 7, name: 'INBOX', threadsTotal: 900, threadsUnread: 5, type: 'system' } });
const listed = (...a: object[]) => JSON.stringify({ accounts: a });
const GOOD = { email: 'mara@example.org', client: 'default', auth: 'oauth', valid: true };
const out = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr });

type Res = ReturnType<typeof out> | 'throw';
function run(check: Res, read?: Res, opts: { attached?: { gmailNoSend?: boolean; materializedAt?: string | null; createdAt?: string } } = {}) {
  const scripts: string[] = [];
  const answers = [check, read];
  const provider = { execShell: async (_r: string, s: string) => {
    scripts.push(s);
    const a = answers.shift();
    if (!a || a === 'throw') throw new Error('timed out');
    return a;
  } };
  const at = opts.attached;
  const store = {
    listAgentConnections: () => (at ? [{ connectionId: 'c1', gmailNoSend: !!at.gmailNoSend, attachedAt: null, materializedAt: at.materializedAt ?? null }] : []),
    getConnection: () => ({ email: 'Mara@example.org', createdAt: at?.createdAt ?? '2026-10-01T00:00:00Z' }),
  };
  return testGmail({ store, provider } as never, { id: 'a1', runtimeRef: 'docker://a1' }, 'mara@example.org').then((r) => ({ r, scripts }));
}

describe('Test Gmail', () => {
  it('passes only when the sign-in is good and the inbox answers, and says sending was not tried', async () => {
    const { r, scripts } = await run(out(listed(GOOD)), out(LABEL));
    expect(r).toMatchObject({ ok: true, messages: 1234, unread: 7 });
    expect(r.detail).toContain('1,234 messages, 7 unread');
    expect(r.detail).toContain('Sending was not tried');
    expect(scripts[0]).toContain('auth list --check --json --no-input');
    expect(scripts[1]).toContain('gmail labels get INBOX --account "mara@example.org" --json --no-input');
  });

  it('never asks for mail, or to send', async () => {
    const { scripts } = await run(out(listed(GOOD)), out(LABEL));
    expect(scripts.join('\n')).not.toMatch(/send|search|messages|thread|get [^I]/);
  });

  it('says so when sending is switched off for this agent', async () => {
    const { r } = await run(out(listed(GOOD)), out(LABEL), { attached: { gmailNoSend: true } });
    expect(r.detail).toContain('Sending is switched off here');
  });

  it('a revoked sign-in fails at the check, even though a cached token would still read the inbox', async () => {
    const error = 'refresh access token: oauth2: "invalid_grant" "Token has been expired or revoked."';
    const { r, scripts } = await run(out(listed({ ...GOOD, valid: false, error })), out(LABEL));
    expect(r).toMatchObject({ ok: false, why: 'signin' });
    expect(scripts).toHaveLength(1);
  });

  it.each([
    ['attached, never connected again since', { materializedAt: '2026-10-02T00:00:00Z' }, 'Press Connect for the account'],
    ['connected again since this agent got it', { materializedAt: '2026-09-01T00:00:00Z' }, 'Disconnect it here and attach it again'],
    ['signed in from inside the agent', undefined, 'signed in from inside the agent'],
  ])('a dead sign-in names the way back: %s', async (_n, attached, says) => {
    const { r } = await run(out(listed({ ...GOOD, valid: false, error: 'oauth2: "invalid_grant" "x"' })), undefined, attached ? { attached } : {});
    expect(r.detail).toContain(says);
  });

  it('an account the agent does not hold is said, by the list or by gog', async () => {
    expect((await run(out(listed({ ...GOOD, email: 'other@example.org' })))).r.why).toBe('not-held');
    expect((await run(out('', 1), out('', 4, 'No auth for gmail mara@example.org.\n\nOAuth (browser flow):'))).r.why).toBe('not-held');
  });

  it('matches the account whatever its case', async () => {
    expect((await run(out(listed({ ...GOOD, email: 'MARA@example.org' })), out(LABEL))).r.ok).toBe(true);
  });

  it('a list it cannot read does not decide: the read does', async () => {
    expect((await run(out('not json', 2), out(LABEL))).r.ok).toBe(true);
    expect((await run(out('{}'), out(LABEL))).r.ok).toBe(true);
  });

  it('an image with no gog, and an agent that does not answer, are said', async () => {
    expect((await run(out('', 127))).r.why).toBe('not-held');
    expect((await run('throw')).r).toMatchObject({ ok: false, why: 'unknown', detail: expect.stringContaining('did not answer') });
    expect((await run(out(listed(GOOD)), 'throw')).r.why).toBe('unknown');
  });

  it('a success that is not the shape it should be is no pass', async () => {
    expect((await run(out(listed(GOOD)), out('{}'))).r).toMatchObject({ ok: false, why: 'unknown' });
    expect((await run(out(listed(GOOD)), out('nonsense'))).r.ok).toBe(false);
  });

  it('an unknown failure shows gog\'s first line, cut short', async () => {
    const { r } = await run(out(listed(GOOD)), out('', 1, `Something new ${'x'.repeat(400)}\nsecond line`));
    expect(r.detail).toContain('Something new');
    expect(r.detail).not.toContain('second line');
    expect(r.detail.length).toBeLessThan(260);
  });
});

describe('what a failure of gog means', () => {
  it.each([
    ['Get "https://gmail.googleapis.com/gmail/v1/users/me/labels?alt=json": round trip: base token source: oauth2: "invalid_grant" "Token has been expired or revoked."', 1, 'signin'],
    ['round trip: base token source: oauth2: "invalid_client" "The OAuth client was not found."', 1, 'client'],
    ['round trip: base token source: oauth2: "unauthorized_client" "Unauthorized"', 1, 'client'],
    ['round trip: base token source: oauth2: "admin_policy_enforced" "Access blocked by your administrator"', 1, 'blocked'],
    ['Google API error (403 insufficientPermissions): Request had insufficient authentication scopes.', 6, 'permission'],
    ['Gmail API is not enabled for this OAuth project. Enable it at: https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=1234', 6, 'api-off'],
    ['Google API error (400 failedPrecondition): Mail service not enabled', 1, 'no-mailbox'],
    ['Google API error (429 userRateLimitExceeded): User-rate limit exceeded.', 7, 'busy'],
    ['Google API error (503): The service is currently unavailable.', 8, 'google-down'],
    ['round trip: base token source: Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com on 10.0.0.1:53: connection refused', 1, 'network'],
    ['gmail options: read credentials: read secret: no TTY available for keyring file backend password prompt; set GOG_KEYRING_PASSWORD', 1, 'keyring'],
    ['No auth for gmail mara@example.org.\n\nOAuth (browser flow):\n  gog auth add mara@example.org --services gmail', 4, 'not-held'],
    ['a thing nobody has seen', 1, 'unknown'],
  ] as Array<[string, number, string]>)('%s', (text, code, why) => {
    expect(gmailFailure(text, code)).toBe(why);
  });
});

describe('the email that goes into the shell line', () => {
  it.each(['a@example.org', 'first.last+tag@example.org'])('takes %s', (e) => expect(isAccountEmail(e)).toBe(true));
  it.each(['-x@example.org', 'a"b@example.org', 'a$(reboot)@example.org', 'a b@example.org', 'noat', `${'a'.repeat(251)}@b.c`])('refuses %s', (e) => expect(isAccountEmail(e)).toBe(false));
});
