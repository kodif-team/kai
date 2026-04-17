// Regressions guarded here:
//   (2026-04-17)  $0.0567 on error_max_turns — paid-for-failure.
//   (2026-04-17)  $0.1657 / $0.2498 Haiku with short-answer + disallowed tools.
//
// Every paid call must go through preflightBudget(). These tests lock in the
// invariants; if they break, the First Law is violated.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COST_USD_BY_TIER,
  MAX_PROMPT_TOKENS,
  PRICING_USD_PER_MILLION,
  SHORT_ANSWER_MAX_INPUT_TOKENS,
  disallowedToolsFor,
  getMaxTurns,
  isShortAnswerRequest,
  preflightBudget,
} from "../src/budget";

test("isShortAnswerRequest catches the exact phrasing that cost $0.0567", () => {
  assert.equal(isShortAnswerRequest("what is the single biggest risk in this PR? one sentence."), true);
  assert.equal(isShortAnswerRequest("briefly, what changed?"), true);
  assert.equal(isShortAnswerRequest("tl;dr"), true);
  assert.equal(isShortAnswerRequest("in one word, is this safe?"), true);
  assert.equal(isShortAnswerRequest("review this PR"), false);
  assert.equal(isShortAnswerRequest("add tests to auth.py"), false);
});

test("getMaxTurns caps short-answer at 2 turns", () => {
  // Invariant: max 2 turns × (tool-blocked call attempts) keeps cost bounded.
  assert.equal(getMaxTurns("what is the biggest risk? one sentence.", "haiku"), 2);
  assert.equal(getMaxTurns("briefly describe the diff", "haiku"), 2);
  // Non-short-answer keeps its higher budget.
  assert.equal(getMaxTurns("review this PR", "haiku"), 12);
  assert.equal(getMaxTurns("fix the failing test in auth.py", "haiku"), 20);
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
  const maxTurns = 2;
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
