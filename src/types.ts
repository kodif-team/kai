export type ModelTier = "haiku" | "sonnet" | "opus";

export type RouterIntent =
  | "stop"
  | "meta-template"
  | "needs-input"
  | "simple-answer"
  | "review"
  | "write-fix"
  | "commit-write"
  | "alert"
  | "spam-abuse"
  | "unsupported";

export type RouteBase = {
  intent: RouterIntent;
  confidence: number;
  modelTier: string;
  estimatedTokens: number;
  estimatedCostUsd: number;
  reason: string;
  normalizedMessage?: string;
  maxContextTokens?: number;
  commitExpected?: boolean;
  source?: "rules" | "local-llm";
};

export type RouterDecision = RouteBase & {
  decision: "stop" | "reply-template" | "ask-clarification" | "call-model";
  normalizedMessage: string;
  maxContextTokens: number;
  commitExpected: boolean;
};

export type StatusErrorLike = {
  status?: number;
};

export type LoggerMeta = Record<string, unknown>;
