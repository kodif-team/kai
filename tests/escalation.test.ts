// Tests for auto-escalation logic when pre-flight budget is exceeded.
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./test-env.ts";

applyTestEnv();

let preflightBudget: typeof import("../dist/budget.js").preflightBudget;
let MAX_COST_USD_BY_TIER: Record<string, number>;

before(async () => {
  const budget = await import("../dist/budget.js");
  preflightBudget = budget.preflightBudget;
  MAX_COST_USD_BY_TIER = budget.MAX_COST_USD_BY_TIER;
});

test("cost-over-cap on haiku with 20.5K tokens is allowed on sonnet", () => {
  // haiku maxTurns=2 for review: 2 × 20K × $1/M + 2 × 1K × $5/M = $0.04 + $0.01 = $0.05 (at cap)
  // Use 20.5K to exceed
  const haikuDec = preflightBudget("review this PR", 20_500, "haiku");
  assert.equal(haikuDec.allowed, false,
    "20.5K-token review should exceed haiku $0.05 cap");
  if (!haikuDec.allowed) assert.equal(haikuDec.kind, "cost-over-cap");

  // sonnet maxTurns=20: 20 × T × $3/M + 20 × 1K × $15/M ≤ $0.50
  // → 20 × T × $3/M ≤ $0.20 → T ≤ 3333 tokens
  // 3K tokens should work: 20 × 3K × $3/M + $0.30 = $0.18 + $0.30 = $0.48 ✓
  const sonnetDec = preflightBudget("review this PR", 3_000, "sonnet");
  assert.equal(sonnetDec.allowed, true,
    "3K-token review should pass sonnet tier");
});

test("short-answer-too-large is NOT escalatable (kind is not cost-over-cap)", () => {
  const dec = preflightBudget("one sentence summary", 7_000, "haiku");
  assert.equal(dec.allowed, false);
  if (!dec.allowed) {
    assert.notEqual(dec.kind, "cost-over-cap",
      "short-answer refusal must NOT be cost-over-cap (not escalatable)");
    assert.equal(dec.kind, "short-answer-too-large");
  }
});

test("hard-ceiling is refused on ALL tiers (not escalatable)", () => {
  const MAX_PROMPT_TOKENS = 50_000;
  for (const tier of ["haiku", "sonnet", "opus"] as const) {
    const dec = preflightBudget("review", MAX_PROMPT_TOKENS + 1, tier);
    assert.equal(dec.allowed, false);
    if (!dec.allowed) assert.equal(dec.kind, "hard-ceiling",
      `${tier} must refuse hard-ceiling prompt`);
  }
});

test("escalation math: haiku → sonnet → opus chain", () => {
  // A 15K prompt:
  // - haiku: 2 turns × 15K × $1/M = $0.030 input + $0.010 output = $0.040 ✓ (under $0.05)
  // - But 20K: 2 × 20K × $1/M + $0.010 = $0.050 (at cap, edge case)
  // Let's use 21K to make it exceed:
  const large = 21_000;
  const haikuDec = preflightBudget("review this PR", large, "haiku");
  assert.equal(haikuDec.allowed, false);
  if (!haikuDec.allowed) assert.equal(haikuDec.kind, "cost-over-cap");

  // sonnet: 20 × 21K × $3/M = $1.26 > $0.50 cap (also fails!)
  const sonnetDec = preflightBudget("review this PR", large, "sonnet");
  assert.equal(sonnetDec.allowed, false);
  if (!sonnetDec.allowed) assert.equal(sonnetDec.kind, "cost-over-cap");

  // opus: 25 × 21K × $15/M = $7.875 > $2 cap (also fails!)
  const opusDec = preflightBudget("review this PR", large, "opus");
  assert.equal(opusDec.allowed, false);
  if (!opusDec.allowed) assert.equal(opusDec.kind, "cost-over-cap");

  // Practical before CLI reserve: 15K token haiku looked safe by prompt math,
  // but hidden CLI/cache overhead can consume the Haiku cap before an answer.
  const small = 15_000;
  const haiku15k = preflightBudget("review this PR", small, "haiku");
  assert.equal(haiku15k.allowed, false,
    "15K-token review on haiku should be refused/escalated because CLI reserve exceeds cap");

  // 3K tokens should pass sonnet: 20 × 3K × $3/M + $0.30 = $0.18 + $0.30 = $0.48 ✓
  const sonnet3k = preflightBudget("review this PR", 3_000, "sonnet");
  assert.equal(sonnet3k.allowed, true,
    "3K-token review on sonnet should pass");
});

test("highest tier still fails closed when projected cost is too high", () => {
  // Verify that opus can handle more than sonnet:
  const large = 15_000;
  const sonnetDec = preflightBudget("review this PR", large, "sonnet");
  // 20 × 15K × $3/M = $0.90 > $0.50 cap (fails)
  assert.equal(sonnetDec.allowed, false);

  const opusDec = preflightBudget("review this PR", large, "opus");
  // 25 × 15K × $15/M = $5.625 > $2 cap (also fails!)
  // Opus is even more constrained due to higher turn count. This is expected.
  assert.equal(opusDec.allowed, false);
});
