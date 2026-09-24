#!/usr/bin/env node
// Works out what a runtime image for a given OpenClaw version must be built on.
// OpenClaw raises its Node.js floor over time (2026.9 needs Node 24.16+), and
// its embedding plugin is published in step with it, so a candidate for a newer
// OpenClaw can't reuse the pins of the proven one.
//
//   node scripts/runtime-pins.mjs node-ok  <range> <version>      exit 0 if the Node version fits
//   node scripts/runtime-pins.mjs plugin   <openclawVersion> <json list of plugin versions>
//   node scripts/runtime-pins.mjs embed-engine <openclawVersion>   prints baked or none
//
// No dependencies: it runs on a host that has only what Hatchabot itself needs.

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
};
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i] < b.n[i] ? -1 : 1;
  return 0;
};

/** Does `version` fit an npm "engines" range such as ">=24.16.0 <25 || >=26.1.0"? */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  const pad = (s) => parse(s.split('.').concat(['0', '0']).slice(0, 3).join('.'));
  return String(range).split('||').some((clause) => {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => {
      const m = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(p);
      if (!m) return false; // a form we don't read: never claim a fit we can't prove
      const c = cmp(v, pad(m[2]));
      return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[m[1] ?? '='];
    });
  });
}

/**
 * The embedding plugin to bake for an OpenClaw version: the newest full release
 * that is not newer than that OpenClaw. (Hatchabot's own "-2" style revisions
 * count as their base version.)
 */
export function pickPlugin(openclawVersion, pluginVersions) {
  const want = parse(openclawVersion);
  if (!want) return undefined;
  return pluginVersions
    .map((s) => ({ s, p: parse(s) }))
    .filter((x) => x.p && !x.p.pre && cmp(x.p, want) <= 0)
    .sort((a, b) => cmp(a.p, b.p))
    .pop()?.s;
}

/**
 * Whether a runtime image for this OpenClaw can bake its own embedding engine.
 * From 2026.8 the plugin downloads a separate llama-server later instead of
 * carrying one, so nothing can be baked: such images are built `none`, and
 * their agents use the shared memory search service (src/embedder).
 */
export function embedEngine(openclawVersion) {
  const v = parse(openclawVersion);
  if (!v) return 'baked';
  return cmp(v, parse('2026.8.0')) >= 0 ? 'none' : 'baked';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , verb, a, b] = process.argv;
  if (verb === 'node-ok') process.exit(satisfies(b, a) ? 0 : 1);
  if (verb === 'embed-engine') { console.log(embedEngine(a)); process.exit(0); }
  if (verb === 'plugin') {
    const got = pickPlugin(a, JSON.parse(b || '[]'));
    if (!got) process.exit(1);
    console.log(got);
  } else process.exit(2);
}
