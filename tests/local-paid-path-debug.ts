// Local reproduction of the exact sequence the GitHub Action runs for a paid
// request. Hits the real local LFM2 router + compressor, exercises retries,
// and shows where/when each call succeeds or fails. No GitHub, no Anthropic.
//
// Usage:
//   KAI_ROUTER_URL=http://localhost:21434 \
//   KAI_COMPRESSOR_URL=http://localhost:21435 \
//   node /tmp/kai-local-paid-debug.cjs

import { routeEventWithLocalLLM, suggestTierWithLocalLLM } from "../src/router";
import { compressPromptWithQwen } from "../src/compressor";
import { selectRelevantFiles } from "../src/file-focus";

const routerUrl = process.env.KAI_ROUTER_URL!;
const compressorUrl = process.env.KAI_COMPRESSOR_URL!;
if (!routerUrl || !compressorUrl) {
  console.error("set KAI_ROUTER_URL and KAI_COMPRESSOR_URL");
  process.exit(1);
}

const userMessage = "what is the single biggest risk in this PR? one sentence.";
const filesList = "src/auth.py +30/-5\ntests/test_auth.py +10/-0";

function step(n: number, label: string) { console.log(`\n[${n}] ${label}`); }

(async () => {
  const t0 = Date.now();

  step(1, "suggestTierWithLocalLLM (router call #1)");
  const tierStart = Date.now();
  try {
    const tier = await suggestTierWithLocalLLM(userMessage, {
      url: routerUrl, model: "LFM2-350M", timeoutMs: 2500,
    });
    console.log(`  → tier=${tier} in ${Date.now() - tierStart}ms`);
  } catch (e) {
    console.log(`  → ERROR ${e instanceof Error ? e.message : e}`);
  }

  step(2, "routeEventWithLocalLLM (router call #2, MUST succeed, has retry 0/400/1200ms)");
  const routeStart = Date.now();
  try {
    const route = await routeEventWithLocalLLM(userMessage, "haiku", {
      url: routerUrl, model: "LFM2-350M", timeoutMs: 3000,
    });
    console.log(`  → intent=${route.intent} decision=${route.decision} in ${Date.now() - routeStart}ms`);
    console.log(`  → reason=${route.reason}`);
  } catch (e) {
    console.log(`  → ERROR ${e instanceof Error ? e.message : e}`);
  }

  step(3, "selectRelevantFiles (compressor call, file focus)");
  const ffStart = Date.now();
  try {
    const files = await selectRelevantFiles(userMessage, filesList, {
      url: compressorUrl, model: "LFM2-350M", timeoutMs: 5000, maxFiles: 5,
    });
    console.log(`  → ${files.length} files in ${Date.now() - ffStart}ms: ${files.join(", ")}`);
  } catch (e) {
    console.log(`  → ERROR ${e instanceof Error ? e.message : e}`);
  }

  step(4, "compressPromptWithQwen (compressor call, prompt compression)");
  const cmpStart = Date.now();
  const bigPrompt = [
    "Kai, AI code reviewer. PR: refactor auth",
    "Files:\n" + Array.from({ length: 40 }, (_, i) => `f${i}.py +1/-0`).join("\n"),
    "Task: " + userMessage,
  ].join("\n\n");
  try {
    const res = await compressPromptWithQwen(bigPrompt, userMessage, "haiku", {
      url: compressorUrl, model: "LFM2-350M", timeoutMs: 15000,
      budgetByTier: { haiku: 50 }, minPromptTokens: 100,
    });
    console.log(`  → usedModel=${res.metrics.usedModel} cmpPct=${res.metrics.cmpPct}% in ${Date.now() - cmpStart}ms`);
  } catch (e) {
    console.log(`  → ERROR ${e instanceof Error ? e.message : e}`);
  }

  step(5, "Back-to-back router calls stress test (mimics tier-suggest → route)");
  for (let i = 1; i <= 5; i++) {
    const s = Date.now();
    try {
      await routeEventWithLocalLLM(`quick test ${i} — is this safe?`, "haiku", {
        url: routerUrl, model: "LFM2-350M", timeoutMs: 3000,
      });
      console.log(`  iter ${i}: ok in ${Date.now() - s}ms`);
    } catch (e) {
      console.log(`  iter ${i}: FAIL ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`\nTotal wall: ${Date.now() - t0}ms`);
})().catch((e) => { console.error(e); process.exit(1); });
