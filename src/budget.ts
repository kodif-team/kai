// Centralized cost-budget rules. Every decision that affects the upper bound
// on a paid call MUST live here so tests can exercise the exact algebra.
//
// FIRST LAW: we must not spend real money on a call we already expect to fail.

export const PRICING_USD_PER_MILLION: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // Claude Haiku 4.5 (ballpark — tune as Anthropic publishes updates).
  haiku: { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.10 },
  sonnet: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  opus: { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
};

// Per-tier ceiling: any run projected above this must be refused pre-flight.
export const MAX_COST_USD_BY_TIER: Record<string, number> = {
  haiku: Number(process.env.KAI_MAX_COST_USD_HAIKU || 0.05),
  sonnet: Number(process.env.KAI_MAX_COST_USD_SONNET || 0.50),
  opus: Number(process.env.KAI_MAX_COST_USD_OPUS || 2.00),
};

export function isShortAnswerRequest(message: string): boolean {
  return /\b(one\s+(?:sentence|line|word|paragraph)|1\s+sentence|single\s+sentence|briefly|tl;?\s*dr|in\s+(?:a\s+)?(?:word|sentence|line)|short\s+answer|yes\/no|quick(?:ly)?)\b/i.test(message);
}

export function getMaxTurns(message: string, modelTier: string): number {
  if (modelTier === "opus") return 25;
  if (modelTier === "sonnet") return 20;
  if (/fix|commit|push|apply|create|patch|refactor|document/i.test(message)) return 20;
  if (isShortAnswerRequest(message)) return 2;
  const isTrulySimple = message.length < 50
    && /^(top|list|one-liner|quick|summarize|how many|which file)/i.test(message);
  return isTrulySimple ? 8 : 12;
}

// Short-answer requests ship the full PR diff inside the prompt. Block every
// exploration tool so Claude cannot burn turns re-exploring — it must answer
// from the embedded diff text.
export function disallowedToolsFor(userMessage: string): string[] {
  if (!isShortAnswerRequest(userMessage)) return [];
  return ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"];
}

// Hard prompt ceilings. Per-tier AND short-answer-specific.
export const MAX_PROMPT_TOKENS = Number(process.env.KAI_MAX_PROMPT_TOKENS || 50_000);
export const SHORT_ANSWER_MAX_INPUT_TOKENS = Number(process.env.KAI_SHORT_ANSWER_MAX_INPUT_TOKENS || 6000);

export type PreflightDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function preflightBudget(
  userMessage: string, promptTokens: number, tier: string,
): PreflightDecision {
  if (promptTokens > MAX_PROMPT_TOKENS) {
    return { allowed: false, reason: `prompt ${promptTokens} tokens > hard ceiling ${MAX_PROMPT_TOKENS}` };
  }
  if (isShortAnswerRequest(userMessage) && promptTokens > SHORT_ANSWER_MAX_INPUT_TOKENS) {
    return {
      allowed: false,
      reason: `short-answer prompt ${promptTokens} tokens > cap ${SHORT_ANSWER_MAX_INPUT_TOKENS}`,
    };
  }
  // Projected worst-case: max_turns × prompt × fresh-input rate, plus a 1K
  // output allowance. Per-tier hard cap must not be exceeded.
  const maxTurns = getMaxTurns(userMessage, tier);
  const price = PRICING_USD_PER_MILLION[tier] ?? PRICING_USD_PER_MILLION.haiku;
  const worstInputCost = maxTurns * promptTokens * price.input / 1_000_000;
  const worstOutputCost = maxTurns * 1_000 * price.output / 1_000_000;
  const worstTotal = worstInputCost + worstOutputCost;
  const cap = MAX_COST_USD_BY_TIER[tier] ?? MAX_COST_USD_BY_TIER.haiku;
  if (worstTotal > cap) {
    return {
      allowed: false,
      reason: `worst-case projection $${worstTotal.toFixed(4)} > tier cap $${cap} (${maxTurns}t × ${promptTokens}tok)`,
    };
  }
  return { allowed: true };
}
