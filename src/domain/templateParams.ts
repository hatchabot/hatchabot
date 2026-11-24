/**
 * A template's parameters (orchestrator/transfer/template.ts): the questions a copy
 * asks when it is made, and where each answer lands. The schema every path
 * that accepts parameters checks them with: PATCH parameters, import, and
 * the manager's authoring tool (mgmt/broker.ts).
 */
import { z } from 'zod';
import { reservedEnvProblem } from './envPolicy.js';

/** Placeholder syntax: {{ key }} — keys are snake_case, author-friendly. */
export const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const TemplateParamSchema = z
  .object({
    key: z.string().regex(PARAM_KEY_RE, 'keys are snake_case, ≤32 chars'),
    label: z.string().min(1).max(64),
    help: z.string().max(200).optional(),
    required: z.boolean(),
    type: z.enum(['text', 'longtext', 'choice', 'multichoice', 'boolean']),
    default: z.string().max(2000).optional(),
    // Trimmed: answers are compared trimmed, so " Daily" could never be picked (#169).
    options: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    /** Where the value lands: substituted into a file's {{key}} placeholder,
     *  (Phase 2b) as an agent env var named KEY-uppercased — a write-only
     *  secret, never stored in paramValues — or `datasource`: the value is a
     *  git repo URL that becomes a real git data source on the imported copy
     *  (each derived child brings its own document repo). */
    target: z.enum(['soul', 'agents', 'env', 'datasource']),
  })
  // An option-less choice renders an empty, unfillable <select>; a required
  // one makes the copy unconfigurable. Catch it at declaration, everywhere
  // this schema is enforced (PATCH parameters, import, mgmt authoring).
  .refine((p) => !(p.type === 'choice' || p.type === 'multichoice') || (p.options?.length ?? 0) > 0, {
    message: 'choice/multichoice fields need at least one option',
  })
  // Multichoice values are comma-joined, so a comma INSIDE an option can
  // never round-trip — it splits into picks that fail the subset check.
  .refine((p) => p.type !== 'multichoice' || !(p.options ?? []).some((o) => o.includes(',')), {
    message: 'multichoice options must not contain commas',
  })
  // Env targets are text-typed credentials/config: choices and booleans have
  // no meaning as env material, and — the security boundary — the derived
  // NAME must pass the same reserved-name policy as the env route, or a
  // template could declare {{anthropic_base_url}} and exfiltrate a shared key.
  .refine((p) => p.target !== 'env' || p.type === 'text', {
    message: 'env-target fields must be type "text"',
  })
  .refine((p) => p.target !== 'env' || !reservedEnvProblem(p.key.toUpperCase()), {
    message: 'that key maps to a reserved env variable name',
  })
  // Datasource targets take a pasted git URL — free text is the only shape
  // that fits, and a default URL would silently bind every child to the
  // author's repo, which defeats the per-child binding this exists for.
  .refine((p) => p.target !== 'datasource' || (p.type === 'text' && p.default === undefined), {
    message: 'datasource-target fields must be type "text" with no default',
  });
