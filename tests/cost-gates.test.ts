// Sanity wrapper — all real assertions live in tests/budget.test.ts which
// imports directly from src/budget.ts (single source of truth for money caps).
import assert from "node:assert/strict";
import test from "node:test";
import { isShortAnswerRequest, disallowedToolsFor, getMaxTurns } from "../src/budget";

test("short-answer is detected on the phrases we've seen cost money", () => {
  assert.equal(isShortAnswerRequest("what is the single biggest risk? one sentence."), true);
  assert.equal(isShortAnswerRequest("briefly, does this fix n+1?"), true);
  assert.equal(isShortAnswerRequest("review this PR"), false);
});

test("short-answer requests are capped at 2 turns", () => {
  assert.equal(getMaxTurns("one sentence", "haiku"), 2);
});

test("short-answer gating list blocks every exploration tool", () => {
  const list = disallowedToolsFor("one sentence summary");
  for (const t of ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]) {
    assert.ok(list.includes(t));
  }
});
