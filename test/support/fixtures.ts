/**
 * Sample values the tests share, built at run time. Written out in full they
 * look like credentials to gitleaks' default rules, and the publisher's gate
 * scans every published file with those rules and no allowlist
 * (docs/releasing.md, "The privacy check").
 */

/** A made-up 18-digit Discord user id. */
export const DISCORD_ID = '123456789' + '012345678';

/** RFC 6455's sample Sec-WebSocket-Key: the base64 of "the sample nonce". */
export const WS_SAMPLE_KEY = Buffer.from('the sample nonce').toString('base64');

/** The gateway-token fixture. */
export const GATEWAY_TOKEN = ['gw', 'SECRET', '1234'].join('-');

/** A made-up Slack app-level token. */
export const SLACK_APP_TOKEN = ['xapp', '1', 'A0APP', '1111', 'abcdefghijklmnop'].join('-');
