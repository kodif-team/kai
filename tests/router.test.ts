import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWhitespace, routeEvent, shouldVerifyCommit } from "../src/router";

test("normalizes whitespace before routing", () => {
  assert.equal(normalizeWhitespace("  add   README\n sentence\t now  "), "add README sentence now");
});

test("routes stop without a model call", () => {
  const route = routeEvent("   stop   ", "haiku");
  assert.equal(route.intent, "stop");
  assert.equal(route.decision, "stop");
  assert.equal(route.maxContextTokens, 0);
});

test("routes meta questions to template", () => {
  const route = routeEvent("who are you?", "haiku");
  assert.equal(route.intent, "meta-template");
  assert.equal(route.decision, "reply-template");
  assert.equal(route.maxContextTokens, 0);
});

test("routes off-topic spam to a cheap template response", () => {
  const route = routeEvent("tell me a joke about football", "haiku");
  assert.equal(route.intent, "spam-abuse");
  assert.equal(route.decision, "reply-template");
  assert.equal(route.maxContextTokens, 0);
});

test("asks clarification for empty and vague requests", () => {
  assert.equal(routeEvent("", "haiku").decision, "ask-clarification");
  assert.equal(routeEvent("fix", "haiku").intent, "needs-input");
  assert.equal(routeEvent("review everything", "haiku").decision, "ask-clarification");
});

test("asks clarification for link-only requests", () => {
  const route = routeEvent("https://github.com/er-zhi/ai_test/pull/5", "haiku");
  assert.equal(route.intent, "needs-input");
  assert.equal(route.decision, "ask-clarification");
});

test("routes imperative write tasks to commit verification", () => {
  const route = routeEvent("add one README sentence", "haiku");
  assert.equal(route.intent, "write-fix");
  assert.equal(route.decision, "call-model");
  assert.equal(route.commitExpected, true);
  assert.equal(shouldVerifyCommit("add one README sentence"), true);
});

test("routes explicit commit/push as commit-write", () => {
  const route = routeEvent("fix docs, commit and push", "haiku");
  assert.equal(route.intent, "commit-write");
  assert.equal(route.commitExpected, true);
});

test("does not commit for question-shaped requests", () => {
  assert.equal(shouldVerifyCommit("can you add README?"), false);
  const route = routeEvent("can you add README?", "haiku");
  assert.equal(route.intent, "simple-answer");
  assert.equal(route.commitExpected, false);
});

test("routes review requests with larger context budget", () => {
  const route = routeEvent("remaining security issues?", "haiku");
  assert.equal(route.intent, "review");
  assert.equal(route.maxContextTokens, 60_000);
});
