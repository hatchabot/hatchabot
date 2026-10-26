// A made-up Hatchabot for the real CLI under test (node --import this-file).
// globalThis.fetch answers from HB_CLI_FIXTURE, a JSON list of
// { path, method?, status?, reply }, prints every request as
// "FIXTURE_REQUEST {...}" for the test to read, and refuses anything else:
// nothing the CLI does reaches a network or a real install.
const routes = JSON.parse(process.env.HB_CLI_FIXTURE || '[]');
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  const method = init.method || 'GET';
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  console.log('FIXTURE_REQUEST ' + JSON.stringify({ path, method, body }));
  const hit = routes.find((r) => r.path === path && r.method === method) ?? routes.find((r) => r.path === path && !r.method);
  if (!hit) throw new Error('Unexpected fixture request: ' + method + ' ' + path);
  return new Response(JSON.stringify(hit.reply ?? {}), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
};
