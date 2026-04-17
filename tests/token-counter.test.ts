import assert from "node:assert/strict";
import test from "node:test";

import { applyTestEnv } from "./test-env.ts";

applyTestEnv();

const { countInputTokens } = await import("../dist/token-counter.js");

test("countInputTokens falls back to heuristic when apiKey is empty", async () => {
  const result = await countInputTokens("", "claude-haiku-4-5", "Hello world this is a test prompt");
  assert.equal(result.source, "heuristic");
  assert.ok(result.tokens > 0);
  // char-ratio heuristic: ceil(len/4)
  assert.equal(result.tokens, Math.ceil("Hello world this is a test prompt".length / 4));
});

test("countInputTokens falls back to heuristic when apiKey is whitespace", async () => {
  const result = await countInputTokens("   ", "claude-haiku-4-5", "short");
  assert.equal(result.source, "heuristic");
});

test("countInputTokens falls back to heuristic on network/auth failure", async () => {
  // Obviously invalid key — Anthropic returns 401, we catch and fallback.
  const result = await countInputTokens("sk-invalid-fake-key-xxx", "claude-haiku-4-5", "hi", 2000);
  assert.equal(result.source, "heuristic");
  assert.ok(result.tokens > 0);
});
