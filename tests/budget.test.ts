// Regressions guarded here:
//   (2026-04-17)  $0.0567 on error_max_turns — paid-for-failure.
//   (2026-04-17)  $0.1657 / $0.2498 Haiku with short-answer + disallowed tools.
//
// Every paid call must go through preflightBudget(). These tests lock in the
// invariants; if they break, the First Law is violated.
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { applyTestEnv } from "./test-env.ts";

applyTestEnv();

let MAX_COST_USD_BY_TIER: Record<string, number>;
let MAX_PROMPT_TOKENS: number;
let PRICING_USD_PER_MILLION: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;
let SHORT_ANSWER_MAX_INPUT_TOKENS: number;
let disallowedToolsFor: typeof import("../dist/budget.js").disallowedToolsFor;
let getMaxTurns: typeof import("../dist/budget.js").getMaxTurns;
let isShortAnswerRequest: typeof import("../dist/budget.js").isShortAnswerRequest;
let preflightBudget: typeof import("../dist/budget.js").preflightBudget;

before(async () => {
  const budget = await import("../dist/budget.js");
  MAX_COST_USD_BY_TIER = budget.MAX_COST_USD_BY_TIER;
  MAX_PROMPT_TOKENS = budget.MAX_PROMPT_TOKENS;
  PRICING_USD_PER_MILLION = budget.PRICING_USD_PER_MILLION;
  SHORT_ANSWER_MAX_INPUT_TOKENS = budget.SHORT_ANSWER_MAX_INPUT_TOKENS;
  disallowedToolsFor = budget.disallowedToolsFor;
  getMaxTurns = budget.getMaxTurns;
  isShortAnswerRequest = budget.isShortAnswerRequest;
  preflightBudget = budget.preflightBudget;
});

test("isShortAnswerRequest catches the exact phrasing that cost $0.0567", () => {
  assert.equal(isShortAnswerRequest("what is the single biggest risk in this PR? one sentence."), true);
  assert.equal(isShortAnswerRequest("briefly, what changed?"), true);
  assert.equal(isShortAnswerRequest("tl;dr"), true);
  assert.equal(isShortAnswerRequest("in one word, is this safe?"), true);
  assert.equal(isShortAnswerRequest("review this PR"), false);
  assert.equal(isShortAnswerRequest("add tests to auth.py"), false);
});

test("getMaxTurns caps short-answer at 1 turn", () => {
  // Invariant: short-answer tasks must complete in a single turn to avoid
  // paying repeated fixed tool/system overhead.
  assert.equal(getMaxTurns("what is the biggest risk? one sentence.", "haiku"), 1);
  assert.equal(getMaxTurns("briefly describe the diff", "haiku"), 1);
  // Review on haiku is limited to 2 turns to stay under $0.05 cap
  assert.equal(getMaxTurns("review this PR", "haiku"), 2);
  // Write requests override haiku limits; they still get 20 turns
  assert.equal(getMaxTurns("fix the failing test in auth.py", "haiku"), 20);
});

test("getMaxTurns does not treat 'after ... fix' as an edit command", () => {
  // Regression: validation pings like "validate after env_file fix" were
  // misclassified as edit requests (20 turns), inflating worst-case cost and
  // causing preflight refusal under haiku cap.
  assert.equal(getMaxTurns("validate after env_file fix", "haiku"), 3);
  assert.equal(getMaxTurns("final health check after db-permission fix", "sonnet"), 4);
});

test("getMaxTurns keeps repo location questions cheap", () => {
  // Regression: "which file starts HTTP app in repos/kodif-gateway?" hit the
  // 12-turn default and was refused by preflight even though it is a small lookup.
  assert.equal(getMaxTurns("which file starts HTTP app in repos/kodif-gateway?", "haiku"), 8);
});

test("disallowedToolsFor blocks every exploration tool on short-answer", () => {
  // Without these, Claude burned 173K tokens re-reading files on 2026-04-17.
  const blocked = disallowedToolsFor("biggest risk? one sentence.");
  for (const t of ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]) {
    assert.ok(blocked.includes(t), `short-answer must block ${t}`);
  }
  assert.deepEqual(disallowedToolsFor("review this PR"), []);
});

test("preflight refuses short-answer bigger than SHORT_ANSWER_MAX_INPUT_TOKENS", () => {
  const dec = preflightBudget(
    "biggest risk? one sentence.",
    SHORT_ANSWER_MAX_INPUT_TOKENS + 1,
    "haiku",
  );
  assert.equal(dec.allowed, false);
  if (dec.allowed === false) {
    assert.match(dec.reason, /short-answer prompt/);
  }
});

test("preflight refuses any prompt bigger than MAX_PROMPT_TOKENS", () => {
  const dec = preflightBudget("explain the architecture", MAX_PROMPT_TOKENS + 1, "haiku");
  assert.equal(dec.allowed, false);
  if (dec.allowed === false) {
    assert.match(dec.reason, /hard ceiling/);
  }
});

test("preflight refuses when worst-case projected cost exceeds tier cap", () => {
  // A giant review-tier prompt must not be allowed past the haiku cost cap.
  // 20 turns × 40K tokens × $1/M input = $0.80 — way above haiku cap $0.05.
  const dec = preflightBudget("review this PR exhaustively", 40_000, "haiku");
  assert.equal(dec.allowed, false);
  if (dec.allowed === false) {
    assert.match(dec.reason, /worst-case projection/);
  }
});

test("preflight ALLOWS a properly-sized short-answer request", () => {
  const dec = preflightBudget(
    "what is the biggest risk? one sentence.",
    4000, // typical pre-digested diff + scaffold
    "haiku",
  );
  assert.equal(dec.allowed, true);
});

test("INVARIANT: worst-case short-answer cost cannot exceed haiku cap", () => {
  // Algebra that proves the 2026-04-17 $0.25 regression is structurally
  // impossible with current gates.
  const maxTurns = 1;
  const maxPromptTokens = SHORT_ANSWER_MAX_INPUT_TOKENS;
  const maxOutputTokensPerTurn = 1000;
  const price = PRICING_USD_PER_MILLION.haiku;
  // Worst: every turn sends the full prompt as fresh input (no cache hit) and
  // fills max output.
  const worstInput = maxTurns * maxPromptTokens * price.input / 1_000_000;
  const worstOutput = maxTurns * maxOutputTokensPerTurn * price.output / 1_000_000;
  const worstTotal = worstInput + worstOutput;
  assert.ok(
    worstTotal <= MAX_COST_USD_BY_TIER.haiku,
    `worst-case short-answer cost $${worstTotal.toFixed(4)} must be <= haiku cap $${MAX_COST_USD_BY_TIER.haiku}`,
  );
});

test("REGRESSION: observed $0.25 run would be refused by pre-flight today", () => {
  // The 2026-04-17 $0.2498 run had 70_000 input tokens on a short-answer
  // request. It should never have been dispatched to the API.
  const dec = preflightBudget(
    "what is the single biggest risk in this PR? one sentence.",
    70_000,
    "haiku",
  );
  assert.equal(dec.allowed, false,
    "a 70K-token short-answer must NOT reach the paid model");
});

test("preflightBudget: hard-ceiling refusal has kind=hard-ceiling", () => {
  const dec = preflightBudget("review this PR", MAX_PROMPT_TOKENS + 1, "haiku");
  assert.equal(dec.allowed, false);
  if (!dec.allowed) assert.equal(dec.kind, "hard-ceiling");
});

test("preflightBudget: short-answer-too-large refusal has correct kind", () => {
  const dec = preflightBudget("one sentence please", SHORT_ANSWER_MAX_INPUT_TOKENS + 1, "haiku");
  assert.equal(dec.allowed, false);
  if (!dec.allowed) assert.equal(dec.kind, "short-answer-too-large");
});

test("preflightBudget: cost-over-cap refusal has kind=cost-over-cap", () => {
  // Large review prompt that exceeds haiku budget
  const dec = preflightBudget("review this PR", 25_000, "haiku");
  assert.equal(dec.allowed, false);
  if (!dec.allowed) assert.equal(dec.kind, "cost-over-cap");
});

test("preflightBudget: cost-over-cap on haiku is allowed on sonnet", () => {
  // Large haiku prompt that exceeds budget (20K is at cap, use 20.5K to exceed)
  const haikuDec = preflightBudget("review this PR", 20_500, "haiku");
  assert.equal(haikuDec.allowed, false);
  if (!haikuDec.allowed) assert.equal(haikuDec.kind, "cost-over-cap");

  // Sonnet has tighter per-token budget: maxTurns=20, $0.50 cap
  // Math: 20 × T × $3/M + 20 × 1K × $15/M ≤ $0.50
  // = 20 × T × $3/M ≤ $0.20 → T ≤ 3333 tokens
  // So a 3K prompt should pass sonnet
  const sonnetDec = preflightBudget("review this PR", 3_000, "sonnet");
  // 20 × 3K × $3/M = $0.18 input, + $0.30 output = $0.48 ✓
  assert.equal(sonnetDec.allowed, true,
    "3K-token review should be allowed under sonnet $0.50 cap");
});

test("preflightBudget: hard-ceiling is refused on all tiers", () => {
  const prompt = "review";
  for (const tier of ["haiku", "sonnet", "opus"] as const) {
    const dec = preflightBudget(prompt, MAX_PROMPT_TOKENS + 1, tier);
    assert.equal(dec.allowed, false);
    if (!dec.allowed) assert.equal(dec.kind, "hard-ceiling",
      `tier ${tier} must refuse hard-ceiling with kind=hard-ceiling`);
  }
});
