import { expect, it } from 'vitest';
import { allowedPeerAddress } from '../src/api/peerAddress.js';
it.each(['http://[::1]', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:169.254.1.1]', 'http://[fe80::1]', 'http://[febf::1]', 'http://127.1', 'http://2130706433', 'http://localhost.', 'http://name.localhost', 'http://metadata.internal', 'ftp://example.org', 'http://user:pass@example.org'])('refuses a local or unsuitable peer: %s', url => {
  expect(allowedPeerAddress(url)).toBe(false);
});
it.each(['http://192.168.1.2:9999', 'https://fixture.example.org', 'http://[fd00::2]:9999', 'http://[2001:db8::2]', 'http://[::ffff:192.168.1.2]'])('allows another LAN or remote server: %s', url => {
  expect(allowedPeerAddress(url)).toBe(true);
});
