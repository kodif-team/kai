import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { LocalRouterUnavailableError, routeEventWithLocalLLM } from "../src/router";

function startFakeLLM(content: string, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("write-fix intent → call-model + commitExpected derived in code", async () => {
  const llm = await startFakeLLM(JSON.stringify({ intent: "write-fix" }));
  try {
    const route = await routeEventWithLocalLLM("add README docs", "haiku", { url: llm.url });
    assert.equal(route.source, "local-llm");
    assert.equal(route.intent, "write-fix");
    assert.equal(route.decision, "call-model");
    assert.equal(route.commitExpected, true);
  } finally {
    await llm.close();
  }
});

test("meta-template intent → reply-template derived in code", async () => {
  const llm = await startFakeLLM(JSON.stringify({ intent: "meta-template" }));
  try {
    const route = await routeEventWithLocalLLM("who are you", "haiku", { url: llm.url });
    assert.equal(route.intent, "meta-template");
    assert.equal(route.decision, "reply-template");
    assert.equal(route.commitExpected, false);
    assert.equal(route.maxContextTokens, 0);
  } finally {
    await llm.close();
  }
});

test("meta question is handled deterministically even if LLM misclassifies", async () => {
  const llm = await startFakeLLM(JSON.stringify({ intent: "simple-answer" }));
  try {
    const route = await routeEventWithLocalLLM("who are you", "haiku", { url: llm.url });
    assert.equal(route.intent, "meta-template");
    assert.equal(route.decision, "reply-template");
    assert.equal(route.source, "rules");
  } finally {
    await llm.close();
  }
});

test("fails closed when local LLM is unavailable", async () => {
  await assert.rejects(
    routeEventWithLocalLLM("add README docs", "haiku", { url: "http://127.0.0.1:9", timeoutMs: 100 }),
    LocalRouterUnavailableError,
  );
});

test("fails closed when local LLM returns invalid intent", async () => {
  const llm = await startFakeLLM("not json");
  try {
    await assert.rejects(
      routeEventWithLocalLLM("review this PR", "haiku", { url: llm.url }),
      LocalRouterUnavailableError,
    );
  } finally {
    await llm.close();
  }
});

test("empty message is deterministic — no LLM call", async () => {
  const route = await routeEventWithLocalLLM("   ", "haiku");
  assert.equal(route.intent, "needs-input");
  assert.equal(route.source, "rules");
});
