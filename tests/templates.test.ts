import assert from "node:assert/strict";
import test from "node:test";
import { routeEvent } from "../src/router";
import { META_TEMPLATE, OFFTOPIC_TEMPLATE, templateForRoute } from "../src/templates";

test("uses identity template for who-are-you questions", () => {
  const route = routeEvent("who are you?", "haiku");
  assert.equal(templateForRoute(route), META_TEMPLATE);
  assert.match(templateForRoute(route), /I'm Kai/);
});

test("uses off-topic template for non-development requests", () => {
  const route = routeEvent("tell me a joke about football", "haiku");
  assert.equal(templateForRoute(route), OFFTOPIC_TEMPLATE);
  assert.match(templateForRoute(route), /development work related to our platform/);
});
