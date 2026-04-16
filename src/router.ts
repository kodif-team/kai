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
};

const OFFTOPIC_PATTERNS = [
  /\b(weather|recipe|movie|music|song|joke|dating|sports|football|basketball|crypto price|stock price)\b/i,
  /\b(погода|рецепт|фильм|музыка|песня|шутк|спорт|футбол|баскетбол|крипт|акци[яи])\b/i,
];

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

export function normalizeWhitespace(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}

export function routeEvent(rawMessage: string, modelTier: string): RouterDecision {
  const normalized = normalizeWhitespace(rawMessage);

  const base = (intent: RouterIntent, decision: RouterDecision["decision"], reason: string, confidence = 0.95): RouterDecision => ({
    intent, decision, confidence, modelTier,
    estimatedTokens: estimateTokensFromChars(normalized),
    estimatedCostUsd: 0,
    reason,
    normalizedMessage: normalized,
    maxContextTokens: 10_000,
    commitExpected: false,
  });

  if (!normalized) {
    return { ...base("needs-input", "ask-clarification", "empty mention", 0.99), maxContextTokens: 0 };
  }

  if (/^(stop|cancel|abort|quit)\b/i.test(normalized)) {
    return { ...base("stop", "stop", "global stop command", 1), maxContextTokens: 0 };
  }

  if (isMetaQuestion(normalized)) {
    return { ...base("meta-template", "reply-template", "meta question handled by template", 0.99), maxContextTokens: 0 };
  }

  if (OFFTOPIC_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { ...base("spam-abuse", "reply-template", "off-topic non-development request", 0.9), maxContextTokens: 0 };
  }

  if (/https?:\/\/\S+\s*$/i.test(normalized) && normalized.split(" ").length <= 3) {
    return { ...base("needs-input", "ask-clarification", "link-only request needs task", 0.9), maxContextTokens: 0 };
  }

  if (/^(fix|do|handle|improve|make better|review everything|check everything)$/i.test(normalized)) {
    return { ...base("needs-input", "ask-clarification", "task too vague", 0.86), maxContextTokens: 0 };
  }

  if (/\b(job|super|sudo|su)\b/i.test(normalized)) {
    return { ...base("job-candidate", "call-model", "stateful job candidate", 0.82), maxContextTokens: 20_000 };
  }

  const commitExpected = shouldVerifyCommit(normalized);
  if (commitExpected) {
    const intent: RouterIntent = /\b(commit|push)\b/i.test(normalized) ? "commit-write" : "write-fix";
    return {
      ...base(intent, "call-model", "imperative write task", 0.9),
      estimatedTokens: 20_000,
      estimatedCostUsd: modelTier === "haiku" ? 0.02 : modelTier === "sonnet" ? 0.12 : 0.5,
      maxContextTokens: 30_000,
      commitExpected: true,
    };
  }

  if (/\b(review|risk|security|issue|bug|remaining)\b/i.test(normalized)) {
    return {
      ...base("review", "call-model", "review or analysis request", 0.88),
      estimatedTokens: 40_000,
      estimatedCostUsd: modelTier === "haiku" ? 0.04 : modelTier === "sonnet" ? 0.2 : 0.8,
      maxContextTokens: 60_000,
    };
  }

  return {
    ...base("simple-answer", "call-model", "simple answer request", 0.78),
    estimatedTokens: 12_000,
    estimatedCostUsd: modelTier === "haiku" ? 0.01 : modelTier === "sonnet" ? 0.06 : 0.25,
    maxContextTokens: 15_000,
  };
}
