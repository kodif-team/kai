import assert from "node:assert/strict";
import test from "node:test";
import { isMetaQuestion, normalizeIntent, normalizeWhitespace, routeEvent, shouldVerifyCommit } from "../dist/router.js";

test("normalizes whitespace", () => {
  assert.equal(normalizeWhitespace("  add   README\n sentence\t now  "), "add README sentence now");
});

test("empty message gets deterministic needs-input (no LLM needed)", () => {
  const route = routeEvent("", "haiku");
  assert.equal(route.intent, "needs-input");
  assert.equal(route.decision, "ask-clarification");
  assert.equal(route.source, "rules");
  assert.equal(route.maxContextTokens, 0);
});

test("non-empty message returns pending-llm skeleton with source=rules", () => {
  const route = routeEvent("add README docs", "haiku");
  assert.equal(route.intent, "simple-answer");
  assert.equal(route.decision, "call-model");
  assert.equal(route.source, "rules");
  assert.match(route.reason, /pending local-llm/);
});

test("shouldVerifyCommit helper recognizes imperative write tasks", () => {
  assert.equal(shouldVerifyCommit("add one README sentence"), true);
  assert.equal(shouldVerifyCommit("fix docs, commit and push"), true);
  assert.equal(shouldVerifyCommit("can you add README?"), false);
  assert.equal(shouldVerifyCommit("final health check after db-permission fix"), false);
  assert.equal(shouldVerifyCommit("verify server after db-permission fix"), false);
});

test("health check normalizes write-fix misclassification to read-only review", () => {
  assert.equal(normalizeIntent("write-fix", "final health check after db-permission fix"), "review");
  assert.equal(normalizeIntent("commit-write", "verify server after db-permission fix"), "review");
  assert.equal(normalizeIntent("write-fix", "fix the db-permission issue and commit"), "write-fix");
});

test("isMetaQuestion helper recognizes identity questions", () => {
  assert.equal(isMetaQuestion("who are you"), true);
  assert.equal(isMetaQuestion("кто ты"), true);
  assert.equal(isMetaQuestion("add README"), false);
});
