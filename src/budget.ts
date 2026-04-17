// Centralized cost-budget rules. Every decision that affects the upper bound
// on a paid call MUST live here so tests can exercise the exact algebra.
//
// FIRST LAW: we must not spend real money on a call we already expect to fail.
import { isReadOnlyValidationRequest } from "./request-kind";

export const PRICING_USD_PER_MILLION: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // Claude Haiku 4.5 (ballpark — tune as Anthropic publishes updates).
  haiku: { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.10 },
  sonnet: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  opus: { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
};

export type PricingTier = "haiku" | "sonnet" | "opus";

export type UsageForCost = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
};

// Per-tier ceiling: any run projected above this must be refused pre-flight.
export const MAX_COST_USD_BY_TIER: Record<string, number> = {
  haiku: 0.05,
  sonnet: 0.5,
  opus: 2,
};

export function isShortAnswerRequest(message: string): boolean {
  return /\b(one\s+(?:sentence|line|word|paragraph)|1\s+sentence|single\s+sentence|briefly|tl;?\s*dr|in\s+(?:a\s+)?(?:word|sentence|line)|short\s+answer|yes\/no|quick(?:ly)?)\b/i.test(message);
}

function isImperativeWriteRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  // Keep this narrow: we only want expensive write-flow turns for explicit
  // imperative editing intent, not for status phrases like
  // "validate after env_file fix".
  return /^(fix|commit|push|apply|create|patch|refactor|document)\b/.test(normalized);
}

export function getMaxTurns(message: string, modelTier: string): number {
  if (isShortAnswerRequest(message)) return 1;
  if (isReadOnlyValidationRequest(message)) return 2;
  if (modelTier === "opus") return 10;
  if (modelTier === "sonnet") return 20;
  if (isImperativeWriteRequest(message)) return 20;
  // Haiku is budget-constrained — review/refactor tasks use 2 turns to stay under $0.05 cap
  if (modelTier === "haiku" && /\b(review|refactor)\b/i.test(message)) return 2;
  const isTrulySimple = message.length < 80
    && /^(top|list|one-liner|quick|summarize|how many|which file)/i.test(message);
  return isTrulySimple ? 8 : 12;
}

export function resolvePricingTier(modelIdOrTier: string): PricingTier {
  const v = modelIdOrTier.toLowerCase();
  if (v.includes("opus")) return "opus";
  if (v.includes("sonnet")) return "sonnet";
  return "haiku";
}

export function calculateAnthropicUsageCostUsd(
  modelIdOrTier: string,
  usage: UsageForCost,
): number {
  const tier = resolvePricingTier(modelIdOrTier);
  const price = PRICING_USD_PER_MILLION[tier] ?? PRICING_USD_PER_MILLION.haiku;
  const cacheCreation5m = usage.cacheCreation5mInputTokens ?? usage.cacheCreationInputTokens;
  const cacheCreation1h = usage.cacheCreation1hInputTokens ?? 0;
  const inputCost = usage.inputTokens * price.input / 1_000_000;
  const outputCost = usage.outputTokens * price.output / 1_000_000;
  const cacheReadCost = usage.cacheReadInputTokens * price.cacheRead / 1_000_000;
  // Anthropic docs: 5m cache write = 1.25x base input (price.cacheWrite),
  // 1h cache write = 2x base input (derive from input price).
  const cacheWrite5mCost = cacheCreation5m * price.cacheWrite / 1_000_000;
  const cacheWrite1hCost = cacheCreation1h * (price.input * 2) / 1_000_000;
  return inputCost + outputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost;
}

// Short-answer and read-only validation requests ship the needed PR context
// inside the prompt. Block exploration tools so Claude cannot burn turns
// re-exploring or mutate files.
export function disallowedToolsFor(userMessage: string): string[] {
  if (!isShortAnswerRequest(userMessage) && !isReadOnlyValidationRequest(userMessage)) return [];
  return ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"];
}

// Hard prompt ceilings. Per-tier AND short-answer-specific.
export const MAX_PROMPT_TOKENS = 50_000;
export const SHORT_ANSWER_MAX_INPUT_TOKENS = 6_000;

export type PreflightRefusalKind = "cost-over-cap" | "short-answer-too-large" | "hard-ceiling";

export type PreflightDecision =
  | { allowed: true }
  | { allowed: false; reason: string; kind: PreflightRefusalKind };

export function preflightBudget(
  userMessage: string, promptTokens: number, tier: string,
): PreflightDecision {
  if (promptTokens > MAX_PROMPT_TOKENS) {
    return { allowed: false, reason: `prompt ${promptTokens} tokens > hard ceiling ${MAX_PROMPT_TOKENS}`, kind: "hard-ceiling" };
  }
  if (isShortAnswerRequest(userMessage) && promptTokens > SHORT_ANSWER_MAX_INPUT_TOKENS) {
    return {
      allowed: false,
      reason: `short-answer prompt ${promptTokens} tokens > cap ${SHORT_ANSWER_MAX_INPUT_TOKENS}`,
      kind: "short-answer-too-large",
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
      kind: "cost-over-cap",
    };
  }
  return { allowed: true };
}
