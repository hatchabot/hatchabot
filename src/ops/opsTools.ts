import { createHash } from 'node:crypto';
import { MANIFEST } from '../mgmt/tools.js';
import { OPS_WEB_TOOLS } from './opsWeb.js';

/**
 * The tool list the ops door answers `tools/list` with — one definition, so
 * the fingerprint below is of exactly what a management agent reads.
 * Change tools take one extra argument here: the agent's reason, shown to the
 * owner on the card, labelled as the agent's words.
 */
export function opsDoorTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return [
    ...MANIFEST.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.tier === 'mutate'
        ? { ...t.input_schema, properties: { ...t.input_schema.properties, why: { type: 'string', maxLength: 400, description: 'One or two sentences for the owner: why you propose this.' } } }
        : t.input_schema,
    })),
    ...OPS_WEB_TOOLS,
  ];
}

/**
 * A management agent reads its tool list once, at start-up. Its restart used
 * to be keyed on the app version, so every release restarted it (194 times in
 * a week, each cutting off whatever turn was running) though the tools changed
 * in about 11 of them. The key is now a hash of the served list itself
 * (review, 2026-09-29). Stored in the column the applied app version lived in.
 */
export function opsToolsFingerprint(): string {
  return `tools:${createHash('sha256').update(JSON.stringify(opsDoorTools())).digest('hex').slice(0, 16)}`;
}
