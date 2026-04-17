// Sanity wrapper — all real assertions live in tests/budget.test.ts which
// imports directly from src/budget.ts (single source of truth for money caps).
import assert from "node:assert/strict";
import test, { before } from "node:test";

import { applyTestEnv } from "./test-env.ts";

applyTestEnv();

const budgetPromise = import("../dist/budget.js");
let isShortAnswerRequest: typeof import("../dist/budget.js").isShortAnswerRequest;
let disallowedToolsFor: typeof import("../dist/budget.js").disallowedToolsFor;
let getMaxTurns: typeof import("../dist/budget.js").getMaxTurns;

before(async () => {
  const budget = await budgetPromise;
  isShortAnswerRequest = budget.isShortAnswerRequest;
  disallowedToolsFor = budget.disallowedToolsFor;
  getMaxTurns = budget.getMaxTurns;
});

test("short-answer is detected on the phrases we've seen cost money", () => {
  assert.equal(isShortAnswerRequest("what is the single biggest risk? one sentence."), true);
  assert.equal(isShortAnswerRequest("briefly, does this fix n+1?"), true);
  assert.equal(isShortAnswerRequest("review this PR"), false);
});

test("short-answer requests are capped at 1 turn", () => {
  assert.equal(getMaxTurns("one sentence", "haiku"), 1);
});

test("short-answer gating list blocks every exploration tool", () => {
  const list = disallowedToolsFor("one sentence summary");
  for (const t of ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]) {
    assert.ok(list.includes(t));
  }
});
