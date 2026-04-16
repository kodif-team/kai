export type RouterIntent =
  | "ignore" | "stop" | "meta-template" | "needs-input" | "simple-answer"
  | "review" | "write-fix" | "commit-write" | "job-candidate"
  | "alert" | "spam-abuse" | "unsupported";

export type RouterDecision = {
  intent: RouterIntent;
  decision: "ignore" | "stop" | "reply-template" | "ask-clarification" | "call-model";
  confidence: number;
  modelTier: string;
  estimatedTokens: number;
  estimatedCostUsd: number;
  reason: string;
  normalizedMessage: string;
  maxContextTokens: number;
  commitExpected: boolean;
  source?: "rules" | "local-llm";
};

export function normalizeWhitespace(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

// Helpers kept for index.ts — no longer used by the router itself (LLM decides).
export function isMetaQuestion(msg: string): boolean {
  return /^(who are you|what are you|how to use|help|what can you do|кто ты|как пользоваться)/i.test(msg);
}

export function shouldVerifyCommit(message: string): boolean {
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

  return {
    intent: "simple-answer", decision: "call-model", confidence: 0.5,
    modelTier, estimatedTokens: estimateTokensFromChars(normalized),
    estimatedCostUsd: 0, reason: "pending local-llm classification",
    normalizedMessage: normalized, maxContextTokens: 10_000,
    commitExpected: false, source: "rules",
  };
}

const ROUTER_INTENTS: RouterIntent[] = [
  "ignore", "stop", "meta-template", "needs-input", "simple-answer",
  "review", "write-fix", "commit-write", "job-candidate",
  "alert", "spam-abuse", "unsupported",
];

// Deterministic mapping intent → decision/commitExpected, so the LLM only outputs the intent.
function decisionForIntent(intent: RouterIntent): RouterDecision["decision"] {
  switch (intent) {
    case "stop": return "stop";
    case "ignore": case "unsupported": return "ignore";
    case "meta-template": case "spam-abuse": return "reply-template";
    case "needs-input": return "ask-clarification";
    default: return "call-model";
  }
}

function commitExpectedForIntent(intent: RouterIntent): boolean {
  return intent === "write-fix" || intent === "commit-write";
}

export class LocalRouterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRouterUnavailableError";
  }
}

function parseIntentOnly(raw: string): RouterIntent | null {
  try {
    const parsed = JSON.parse(raw) as { intent?: string };
    return ROUTER_INTENTS.includes(parsed.intent as RouterIntent) ? (parsed.intent as RouterIntent) : null;
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
    content: `Classify PR comment. Intents: simple-answer|review|write-fix|commit-write|job-candidate|meta-template|spam-abuse|needs-input|stop|alert|unsupported|ignore.
Rules: "stop"→stop; "who are you"/help→meta-template; weather/music/jokes→spam-abuse; empty/vague→needs-input; "commit"/"push"→commit-write; imperative add/fix/update→write-fix; review/bug/risk→review; question→simple-answer.
Return {"intent":"..."}.
Comment: ${JSON.stringify(message)}`,
  }];
}

// GBNF grammar: constrain output to a single enum value wrapped in the smallest JSON we need.
const ROUTER_GRAMMAR = 'root ::= "{\\"intent\\":\\"" intent "\\"}"\n'
  + 'intent ::= "simple-answer" | "review" | "write-fix" | "commit-write" | "job-candidate" | "meta-template" | "spam-abuse" | "needs-input" | "stop" | "alert" | "unsupported" | "ignore"';

export async function routeEventWithLocalLLM(
  rawMessage: string,
  modelTier: string,
  options?: { url?: string; model?: string; timeoutMs?: number; allowRulesOnly?: boolean },
): Promise<RouterDecision> {
  const rules = routeEvent(rawMessage, modelTier);

  // Empty messages skip the LLM — nothing to classify.
  if (rules.intent === "needs-input" && !rules.normalizedMessage) return rules;

  const url = options?.url ?? process.env.KAI_ROUTER_URL;
  if (!url) {
    if (options?.allowRulesOnly) return rules;
    throw new LocalRouterUnavailableError("local router URL is required before paid model calls");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 3000);
  const started = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: options?.model ?? process.env.KAI_ROUTER_MODEL ?? "qwen2.5-0.5b-instruct",
        messages: localRouterMessages(rules.normalizedMessage),
        stream: false,
        temperature: 0,
        max_tokens: 20,
        grammar: ROUTER_GRAMMAR,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new LocalRouterUnavailableError(`local router returned HTTP ${res.status}`);
    }
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content ?? "";
    const intent = parseIntentOnly(content);
    if (!intent) {
      throw new LocalRouterUnavailableError("local router returned invalid intent");
    }

    const elapsedMs = Date.now() - started;
    const decision = decisionForIntent(intent);
    return {
      ...rules,
      intent,
      decision,
      confidence: 0.8,
      reason: `local-llm (${elapsedMs}ms)`,
      commitExpected: commitExpectedForIntent(intent),
      maxContextTokens: decision === "call-model" ? rules.maxContextTokens : 0,
      source: "local-llm",
    };
  } catch (error) {
    if (error instanceof LocalRouterUnavailableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new LocalRouterUnavailableError(`local router request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
