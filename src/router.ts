export type { RouterDecision, RouterIntent } from "./types";
import type { ModelTier, RouterDecision, RouterIntent } from "./types";
import { isRecord, parseJsonObject } from "./json";
import { isReadOnlyValidationRequest } from "./request-kind";

export function normalizeWhitespace(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

// Helpers kept for index.ts — no longer used by the router itself (LLM decides).
export function isMetaQuestion(msg: string): boolean {
  return /^(who are you|what are you|how to use|help|what can you do|кто ты|как пользоваться)/i.test(msg);
}

export function shouldVerifyCommit(message: string): boolean {
  if (isReadOnlyValidationRequest(message)) return false;
  if (/\b(commit|push)\b/i.test(message)) return true;
  const trimmed = message.trim();
  const isQuestion = /\?$/.test(trimmed) || /^(can|could|should|would|is|are|do|does|what|who|why|how)\b/i.test(trimmed);
  if (isQuestion) return false;
  return /\b(fix|add|update|create|patch|refactor|write|change|remove|delete|document|documentation|doc)\b/i.test(trimmed);
}

function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}

// Only deterministic guard: empty message. Everything else is classified by the local LLM.
export function routeEvent(rawMessage: string, modelTier: string): RouterDecision {
  const normalized = normalizeWhitespace(rawMessage);

  if (!normalized) {
    return {
      intent: "needs-input", decision: "ask-clarification", confidence: 0.99,
      modelTier, estimatedTokens: 0, estimatedCostUsd: 0,
      reason: "empty mention", normalizedMessage: normalized,
      maxContextTokens: 0, commitExpected: false, source: "rules",
    };
  }

  if (/^stop$/i.test(normalized) || /^@?kai\s+stop$/i.test(normalized)) {
    return {
      intent: "stop", decision: "stop", confidence: 0.99,
      modelTier, estimatedTokens: 0, estimatedCostUsd: 0,
      reason: "deterministic stop command", normalizedMessage: normalized,
      maxContextTokens: 0, commitExpected: false, source: "rules",
    };
  }

  if (isMetaQuestion(normalized)) {
    return {
      intent: "meta-template", decision: "reply-template", confidence: 0.99,
      modelTier, estimatedTokens: 0, estimatedCostUsd: 0,
      reason: "deterministic meta question", normalizedMessage: normalized,
      maxContextTokens: 0, commitExpected: false, source: "rules",
    };
  }

  if (/\b(weather|music|joke|meme|movie|crypto price|football|soccer)\b/i.test(normalized)) {
    return {
      intent: "spam-abuse", decision: "reply-template", confidence: 0.95,
      modelTier, estimatedTokens: 0, estimatedCostUsd: 0,
      reason: "deterministic off-topic request", normalizedMessage: normalized,
      maxContextTokens: 0, commitExpected: false, source: "rules",
    };
  }

  return {
    intent: "simple-answer", decision: "call-model", confidence: 0.5,
    modelTier, estimatedTokens: estimateTokensFromChars(normalized),
    estimatedCostUsd: 0, reason: "pending local-llm classification",
    normalizedMessage: normalized, maxContextTokens: 10_000,
    commitExpected: false, source: "rules",
  };
}

const ROUTER_INTENTS: RouterIntent[] = [
  "stop", "meta-template", "needs-input", "simple-answer",
  "review", "write-fix", "commit-write",
  "alert", "spam-abuse", "unsupported",
];

// Deterministic mapping intent → decision/commitExpected, so the LLM only outputs the intent.
function decisionForIntent(intent: RouterIntent): RouterDecision["decision"] {
  switch (intent) {
    case "stop": return "stop";
    case "meta-template": case "spam-abuse": return "reply-template";
    case "needs-input": return "ask-clarification";
    default: return "call-model";
  }
}

export function normalizeIntent(intent: RouterIntent, message: string): RouterIntent {
  if ((intent === "write-fix" || intent === "commit-write") && isReadOnlyValidationRequest(message)) {
    return "review";
  }
  if ((intent === "write-fix" || intent === "commit-write") && !shouldVerifyCommit(message)) {
    return "simple-answer";
  }
  return intent;
}

function commitExpectedForIntent(intent: RouterIntent, message: string): boolean {
  return (intent === "write-fix" || intent === "commit-write") && shouldVerifyCommit(message);
}

export class LocalRouterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRouterUnavailableError";
  }
}

function parseIntentOnly(raw: string): RouterIntent | null {
  try {
    const parsed = parseJsonObject(raw);
    if (!isRecord(parsed) || typeof parsed.intent !== "string") return null;
    return ROUTER_INTENTS.includes(parsed.intent as RouterIntent) ? (parsed.intent as RouterIntent) : null;
  } catch {
    return null;
  }
}

export type SuggestedTier = ModelTier;
const TIER_VALUES: readonly SuggestedTier[] = ["haiku", "sonnet", "opus"];

const TIER_RESPONSE_FORMAT = {
  type: "json_object",
  schema: {
    type: "object",
    properties: { tier: { type: "string", enum: TIER_VALUES } },
    required: ["tier"],
  },
};

function chatCompletionsUrl(baseUrl: string): string {
  return new URL("/v1/chat/completions", baseUrl).toString();
}

function responseContent(body: { choices?: Array<{ message?: { content?: string } }> }): string {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return "";
}

export async function suggestTierWithLocalLLM(
  message: string,
  options: { url: string; model?: string; timeoutMs?: number },
): Promise<SuggestedTier | null> {
  if (!options.model) throw new Error("local router model is required");
  if (options.timeoutMs == null) throw new Error("KAI_ROUTER_TIMEOUT_MS is required");
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    const res = await fetch(chatCompletionsUrl(options.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: [{
          role: "user",
          content: `Pick model tier for this task. haiku=simple Q/A, small edits. sonnet=multi-file refactor, code review, bug fix requiring reasoning. opus=architecture decisions, complex cross-service changes.\nTask: ${JSON.stringify(message)}\nReturn {"tier":"haiku"} or {"tier":"sonnet"} or {"tier":"opus"}.`,
        }],
        stream: false,
        temperature: 0,
        max_tokens: 20,
        response_format: TIER_RESPONSE_FORMAT,
      }),
      signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = responseContent(body);
    try {
      const parsed = parseJsonObject(content);
      if (!isRecord(parsed) || typeof parsed.tier !== "string") return null;
      if (TIER_VALUES.includes(parsed.tier as SuggestedTier)) {
        return parsed.tier as SuggestedTier;
      }
      return null;
    } catch { return null; }
  } catch {
    return null;
  }
}

// FIRST filter layer before rtk + paid LLM. Keep tight; downstream handles nuance.
// Tested on Qwen 2.5 0.5B: few-shot and multi-line system rules both regressed
// (60% and 10% accuracy). Compact inline rules in a single user message scored best.
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function localRouterMessages(message: string): ChatMessage[] {
  return [{
    role: "user",
    content: `Route one GitHub PR comment. Return only JSON: {"intent":"..."}.
Intents:
simple-answer = asks for a fact, location, file path, brief explanation, or "which file/where".
review = asks to assess code, PR changes, bugs, risks, security, correctness, or vulnerabilities.
write-fix = asks to change code, edit files, patch, fix, add, refactor, commit, or push.
meta-template = asks who Kai is, help, usage, or capabilities.
spam-abuse = unrelated or abusive. needs-input = too vague to act. stop = asks to stop.
Health checks, log checks, status checks, validate, verify, and smoke tests are review unless the user explicitly asks to change/commit/push.
If a comment mentions PR code, bugs, security, risk, or vulnerabilities, never use meta-template.
If "start/starts" means where an app begins/runs, use simple-answer unless the user asks to change code.
Comment: ${JSON.stringify(message)}`,
  }];
}

// llama.cpp server's OpenAI-compat way to constrain output (2026): response_format
// with a JSON schema. Works across models regardless of jinja template quirks.
// Ref: llama.cpp server README — /v1/chat/completions response_format.
const ROUTER_RESPONSE_FORMAT = {
  type: "json_object",
  schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ROUTER_INTENTS,
      },
    },
    required: ["intent"],
  },
};

async function callRouterOnce(
  url: string, model: string, messages: ChatMessage[], timeoutMs: number,
): Promise<RouterIntent> {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(chatCompletionsUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, messages, stream: false, temperature: 0, max_tokens: 40,
      response_format: ROUTER_RESPONSE_FORMAT,
    }),
    signal,
  });
  if (!res.ok) throw new LocalRouterUnavailableError(`HTTP ${res.status}`);
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = responseContent(body);
  const intent = parseIntentOnly(content);
  if (!intent) throw new LocalRouterUnavailableError("invalid intent payload");
  return intent;
}

export async function routeEventWithLocalLLM(
  rawMessage: string,
  modelTier: string,
  options: { url: string; model?: string; timeoutMs?: number },
): Promise<RouterDecision> {
  const rules = routeEvent(rawMessage, modelTier);

  // Deterministic rule-only paths skip the LLM entirely.
  if (rules.decision !== "call-model") return rules;

  const url = options.url;
  if (!url) throw new LocalRouterUnavailableError("local router URL is required before paid model calls");
  const model = options.model;
  if (!model) throw new LocalRouterUnavailableError("local router model is required");
  if (options.timeoutMs == null) throw new Error("router timeout is required");
  const timeoutMs = options.timeoutMs;
  const messages = localRouterMessages(rules.normalizedMessage);
  const started = Date.now();

  // Retry with small backoff — llama.cpp server with --parallel 1 occasionally
  // rejects the next connection while it's still flushing the previous one
  // (e.g. after a back-to-back tier-suggest call). Two extra tries add ≤1s in
  // the worst case and fix the observed intermittent "fetch failed".
  const delaysMs = [0, 400, 1200];
  let lastErr: unknown;
  for (const delay of delaysMs) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    try {
      const intent = await callRouterOnce(url, model, messages, timeoutMs);
      const elapsedMs = Date.now() - started;
      const normalizedIntent = normalizeIntent(intent, rules.normalizedMessage);
      const decision = decisionForIntent(normalizedIntent);
      return {
        ...rules,
        intent: normalizedIntent,
        decision,
        confidence: 0.8,
        reason: `local-llm (${elapsedMs}ms)`,
        commitExpected: commitExpectedForIntent(normalizedIntent, rules.normalizedMessage),
        maxContextTokens: decision === "call-model" ? rules.maxContextTokens : 0,
        source: "local-llm",
      };
    } catch (error) {
      lastErr = error;
      // Don't retry on explicit "invalid intent" — that's deterministic payload
      // noise, not a transient socket issue.
      if (error instanceof LocalRouterUnavailableError && /invalid intent/.test(error.message)) break;
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new LocalRouterUnavailableError(`local router request failed: ${message}`);
}
