import assert from "node:assert/strict";
import test from "node:test";
import { buildFooter, buildRouterFooter } from "../dist/footer.js";

test("router footer explicitly marks local LLM", () => {
  const footer = buildRouterFooter("LFM2-350M", 1);
  assert.match(footer, /local LLM/i);
  assert.match(footer, /LFM2-350M/);
});

test("paid footer includes CMP savings", () => {
  const footer = buildFooter("Sonnet", "41%", "38%", 18000, 1200, 0.0234, 4, 12, 7000);
  assert.match(footer, /RTK.*41%/i);
  assert.match(footer, /CMP 38%/i);
  assert.match(footer, /18K in \/ 1K out/);
});

test("paid footer shows <1K for small non-zero output", () => {
  const footer = buildFooter("Haiku", "8.0%", "0%", 46959, 485, 0.1640, 3, 35, 23479);
  assert.match(footer, /47K in \/ <1K out/);
});
