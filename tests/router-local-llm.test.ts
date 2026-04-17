import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { before } from "node:test";

import { applyTestEnv } from "./test-env.ts";

applyTestEnv();

const routerPromise = import("../dist/router.js");
let LocalRouterUnavailableError: typeof import("../dist/router.js").LocalRouterUnavailableError;
let routeEventWithLocalLLM: typeof import("../dist/router.js").routeEventWithLocalLLM;
const liveRouterTests = process.env.KAI_ENABLE_LIVE_LLM_TESTS === "true";
const liveTest = liveRouterTests ? test : test.skip;

before(async () => {
  const router = await routerPromise;
  LocalRouterUnavailableError = router.LocalRouterUnavailableError;
  routeEventWithLocalLLM = router.routeEventWithLocalLLM;
});

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

liveTest("write-fix intent → call-model + commitExpected derived in code", async () => {
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

liveTest("health check stays read-only even if local LLM says write-fix", async () => {
  const llm = await startFakeLLM(JSON.stringify({ intent: "write-fix" }));
  try {
    const route = await routeEventWithLocalLLM("final health check after db-permission fix", "sonnet", { url: llm.url });
    assert.equal(route.source, "local-llm");
    assert.equal(route.intent, "review");
    assert.equal(route.decision, "call-model");
    assert.equal(route.commitExpected, false);
  } finally {
    await llm.close();
  }
});

liveTest("explicit fix request still allows commit flow", async () => {
  const llm = await startFakeLLM(JSON.stringify({ intent: "write-fix" }));
  try {
    const route = await routeEventWithLocalLLM("fix the db-permission issue and commit", "sonnet", { url: llm.url });
    assert.equal(route.intent, "write-fix");
    assert.equal(route.commitExpected, true);
  } finally {
    await llm.close();
  }
});

liveTest("meta-template intent → reply-template derived in code", async () => {
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

liveTest("meta question is handled deterministically even if LLM misclassifies", async () => {
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

liveTest("fails closed when local LLM is unavailable", async () => {
  await assert.rejects(
    routeEventWithLocalLLM("add README docs", "haiku", { url: "http://127.0.0.1:9", timeoutMs: 100 }),
    LocalRouterUnavailableError,
  );
});

liveTest("fails closed when local LLM returns invalid intent", async () => {
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
