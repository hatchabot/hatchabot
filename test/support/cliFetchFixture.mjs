// A made-up Hatchabot for the real CLI under test (node --import this-file).
// globalThis.fetch answers from HB_CLI_FIXTURE, a JSON list of
// { path, method?, status?, reply } — or { path, method?, replies: [...] },
// answered in turn, the last one again once they run out; an answer
// { reject: 'ECONNRESET' } is a connection that failed, as Node's fetch
// rejects then (TypeError "fetch failed", the code on its cause) — prints every
// request as "FIXTURE_REQUEST {...}" for the test to read, and refuses
// anything else: nothing the CLI does reaches a network or a real install.
const routes = JSON.parse(process.env.HB_CLI_FIXTURE || '[]');
globalThis.fetch = async (url, init = {}) => {
  const { origin, pathname: path } = new URL(String(url));
  const method = init.method || 'GET';
  let body;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  const authorization = init.headers?.authorization;
  console.log('FIXTURE_REQUEST ' + JSON.stringify({ path, method, body, origin, ...(authorization ? { authorization } : {}) }));
  const hit = routes.find((r) => r.path === path && r.method === method) ?? routes.find((r) => r.path === path && !r.method);
  if (!hit) throw new Error('Unexpected fixture request: ' + method + ' ' + path);
  const answer = hit.replies ? (hit.replies.length > 1 ? hit.replies.shift() : hit.replies[0]) : hit;
  if (answer.reject) throw new TypeError('fetch failed', { cause: Object.assign(new Error(`made-up ${answer.reject}`), { code: answer.reject }) });
  return new Response(JSON.stringify(answer.reply ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
};
