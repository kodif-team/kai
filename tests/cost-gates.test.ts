// Proves: (1) short-answer detection is neither too greedy nor too loose, and
// (2) the tool-gating list is applied only to short-answer requests.
//
// These are the runtime gates for the 2026-04-17 cost optimization ($0.057 run).
import assert from "node:assert/strict";
import test from "node:test";

// Re-declare the helpers locally by copy — index.ts isn't importable because it
// starts a side-effecting run() on load. The regexes here MUST track the ones
// in src/index.ts; this test file is intentionally a contract check.

function isShortAnswerRequest(message: string): boolean {
  return /\b(one\s+(?:sentence|line|word|paragraph)|1\s+sentence|single\s+sentence|briefly|tl;?\s*dr|in\s+(?:a\s+)?(?:word|sentence|line)|short\s+answer|yes\/no|quick(?:ly)?)\b/i.test(message);
}

function disallowedToolsFor(userMessage: string): string[] {
  if (!isShortAnswerRequest(userMessage)) return [];
  return ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"];
}

test("short-answer detector catches the expensive phrasing we observed", () => {
  // The exact message that cost $0.057 on 2026-04-17.
  assert.equal(isShortAnswerRequest("what is the single biggest risk in this PR? one sentence."), true);
  assert.equal(isShortAnswerRequest("briefly summarize the diff"), true);
  assert.equal(isShortAnswerRequest("tl;dr please"), true);
  assert.equal(isShortAnswerRequest("in one word, is this safe?"), true);
  assert.equal(isShortAnswerRequest("short answer: yes or no?"), true);
  assert.equal(isShortAnswerRequest("quick: does this introduce N+1?"), true);
});

test("short-answer detector does NOT match tasks that need exploration", () => {
  assert.equal(isShortAnswerRequest("review this PR and suggest improvements"), false);
  assert.equal(isShortAnswerRequest("fix the failing test in auth.py"), false);
  assert.equal(isShortAnswerRequest("add input validation to the login handler"), false);
  assert.equal(isShortAnswerRequest("explain what the new service does"), false);
});

test("tool gating applies only on short-answer intent", () => {
  assert.deepEqual(disallowedToolsFor("review this PR"), []);
  const gated = disallowedToolsFor("biggest risk? one sentence.");
  // With the diff pre-digested in the prompt, short-answer has everything it
  // needs — block every exploration tool so Claude answers from the diff text.
  for (const t of ["Read", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]) {
    assert.ok(gated.includes(t), `short-answer must gate ${t}`);
  }
});
