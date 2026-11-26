import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The VM test beds run on throwaway machines and are not run here; what they
 * write and where is read from the scripts themselves (HB-0042).
 */
describe('the test beds keep the test credential out of /tmp (HB-0042)', () => {
  const clean = readFileSync('scripts/clean-install-test.sh', 'utf8');
  const shared = readFileSync('scripts/shared-host-test.sh', 'utf8');

  it('clean-install-test.sh writes the AI-source body and the session cookie under $HOME, mode 600', () => {
    expect(clean).not.toMatch(/\/tmp\/(body\.json|ck)\b/);
    const aisetup = /cat >"\$OUT\/aisetup\.sh" <<EOF\n([\s\S]*?)\nEOF\n/.exec(clean)?.[1] ?? '';
    const umask = aisetup.indexOf('umask 077');
    expect(umask).toBeGreaterThan(-1);
    expect(aisetup).toContain('BODY="\\$HOME/');
    expect(umask).toBeLessThan(aisetup.indexOf('> "\\$BODY"'));
    expect(aisetup).toMatch(/rm -f "\\\$BODY"/);
  });

  it('shared-host-test.sh gives each tenant its own listener for a proxy, closes it to the others, and probes that (HB-1239)', () => {
    expect(shared).toContain('PROXY[$u]=$((8700 + i))');
    expect(shared).toContain('HATCHABOT_PROXY_PORT=${PROXY[$u]}');
    // In the tenant's own rule, with the app's port: only its user, the router and root reach it.
    expect(shared).toContain('nft add rule inet hb out oif lo tcp dport { ${PORT[$u]}, ${PROXY[$u]}, ${OPS[$u]}, ${EMBED_RULE}${GWBASE[$u]}-$((GWBASE[$u] + 99)) } meta skuid != { ${UIDOF[$u]}, \\$(id -u caddy), 0 } reject with tcp reset');
    for (const probe of ['code $a "http://127.0.0.1:${PROXY[$b]}/v1/config"); [ "$x" = 000 ]', 'probe "${PROXY[$b]}"); [ "$x" = no ]', 'code caddy "http://127.0.0.1:${PROXY[$b]}/v1/config")']) {
      expect(shared).toContain(probe);
    }
  });

  it('shared-host-test.sh sums the memory of every tenant it made, not two named ones', () => {
    expect(shared).not.toMatch(/for u in t1 t2/);
    expect(shared).toContain(`$(seq -f 't%g' 1 "$TENANTS")`);
  });
});
