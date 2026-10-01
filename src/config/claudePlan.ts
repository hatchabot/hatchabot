/**
 * A hosted Hatchabot (managed mode, HATCHABOT_MANAGED_BY) takes Claude only
 * through an API key. A Claude plan source — a `claude setup-token` or this
 * machine's Claude login — would have the provider storing and relaying a
 * customer's Claude.ai credentials, which Anthropic's terms bar third parties
 * from doing (code.claude.com/docs/en/legal-and-compliance, "Authentication
 * and credential use"). HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN=1 turns it back on,
 * for a provider Anthropic has agreed with in writing. Home installs: no change.
 */
export function claudePlanAllowed(env = process.env): boolean {
  return !env.HATCHABOT_MANAGED_BY?.trim() || env.HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN?.trim() === '1';
}
export const CLAUDE_PLAN_HOSTED = 'On a hosted Hatchabot, connect Claude with an API key from console.anthropic.com.';
