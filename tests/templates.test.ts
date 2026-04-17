import assert from "node:assert/strict";
import test from "node:test";
import type { RouterDecision } from "../dist/router.js";
import { META_TEMPLATE, OFFTOPIC_TEMPLATE, templateForRoute } from "../dist/templates.js";

function fakeRoute(intent: RouterDecision["intent"], decision: RouterDecision["decision"]): RouterDecision {
  return {
    intent, decision, confidence: 0.9, modelTier: "haiku",
    estimatedTokens: 10, estimatedCostUsd: 0, reason: "test",
    normalizedMessage: "test", maxContextTokens: 0,
    commitExpected: false, source: "local-llm",
  };
}

test("uses identity template for meta-template intent", () => {
  const route = fakeRoute("meta-template", "reply-template");
  assert.equal(templateForRoute(route), META_TEMPLATE);
  assert.match(templateForRoute(route), /I'm Kai/);
  assert.match(templateForRoute(route), /Response by local LLM/i);
  assert.match(templateForRoute(route), /LFM2-350M/);
});

test("uses off-topic template for spam-abuse intent", () => {
  const route = fakeRoute("spam-abuse", "reply-template");
  assert.equal(templateForRoute(route), OFFTOPIC_TEMPLATE);
  assert.match(templateForRoute(route), /Kodif development work/);
  assert.match(templateForRoute(route), /code review|architecture questions|bug fixes/);
});
