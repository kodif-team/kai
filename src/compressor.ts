export type CompressionTier = "haiku" | "sonnet" | "opus";

export type CompressionConfig = {
  url?: string;
  model?: string;
  timeoutMs?: number;
  disabled?: boolean;
  minPromptTokens?: number;
  minQueryTokens?: number;
  budgetByTier?: Partial<Record<CompressionTier, number>>;
};

export type CompressionMetrics = {
  rawTokens: number;
  compressedTokens: number;
  cmpPct: number;
  durationMs: number;
  usedModel: boolean;
};

export type CompressionResult = {
  prompt: string;
  metrics: CompressionMetrics;
};

type PromptChunk = {
  id: number;
  text: string;
  pinned: boolean;
};

type CompressorPayload = {
  keep_ids: number[];
  summaries?: Array<{ id: number; text: string }>;
};

// Lower than before: old budgets (6k/24k/80k) meant compression almost never
// triggered for typical PR comments. New budgets force compression much earlier
// so the Qwen3 layer actually pays off. Env vars still override in index.ts.
const DEFAULT_BUDGETS: Record<CompressionTier, number> = {
  haiku: 3000,
  sonnet: 10000,
  opus: 20000,
};

const MIN_PROMPT_TOKENS = 1200;

function resolveNonNegativeInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value as number);
  return normalized >= 0 ? normalized : fallback;
}

export class LocalCompressorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalCompressorUnavailableError";
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function resolveCompressionBudget(
  tier: string,
  overrides?: Partial<Record<CompressionTier, number>>,
): number {
  const key = (tier.toLowerCase() as CompressionTier);
  return overrides?.[key] ?? DEFAULT_BUDGETS[key] ?? DEFAULT_BUDGETS.haiku;
}

export function splitPromptIntoChunks(prompt: string): PromptChunk[] {
  const sections = prompt
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sections.length === 0) {
    return [];
  }

  const chunks: PromptChunk[] = sections.map((text, idx) => ({
    id: idx + 1,
    text,
    pinned: idx === 0 || idx === sections.length - 1 || /^(Task|Router|Kai,)/i.test(text),
  }));

  return chunks;
}

// Extract first balanced JSON object from a possibly markdown-wrapped response.
// Small local models (LFM2, SmolLM) often emit ```json\n{...}\n``` + trailing
// prose even under GBNF grammar. Strip fences and cut at first balanced brace.
function extractJsonObject(raw: string): string | null {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fencedMatch ? fencedMatch[1] : raw;
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function parseCompressorPayload(raw: string, maxChunkId: number): CompressorPayload {
  let parsed: unknown;
  const jsonSource = extractJsonObject(raw) ?? raw.trim();
  try {
    parsed = JSON.parse(jsonSource);
  } catch {
    if (process.env.KAI_DEBUG_COMPRESSOR === "1") {
      console.error("[kai-compressor] raw response (first 400 chars):", raw.slice(0, 400));
    }
    throw new LocalCompressorUnavailableError("local compressor returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new LocalCompressorUnavailableError("local compressor returned non-object payload");
  }

  const shaped = parsed as Partial<CompressorPayload> & { keep_ids?: unknown };
  // Small models occasionally emit keep_ids as [{id:1,text:"..."}, ...] instead
  // of [1,2,...]. Accept both shapes — we only need the ids.
  const rawIds: unknown[] = Array.isArray(shaped.keep_ids) ? shaped.keep_ids as unknown[] : [];
  const keepIds: number[] = rawIds
    .map((item): number | null => {
      if (Number.isInteger(item)) return item as number;
      if (item && typeof item === "object" && "id" in item && Number.isInteger((item as { id: unknown }).id)) {
        return (item as { id: number }).id;
      }
      return null;
    })
    .filter((id): id is number => id !== null && id >= 1 && id <= maxChunkId);

  // keep_ids=[] is a legitimate "drop all non-pinned" verdict from the model —
  // let mergeCompressedChunks keep only pinned chunks + any summaries. We only
  // bail out if there are ALSO no summaries, which means the payload is empty.
  if (keepIds.length === 0 && !(Array.isArray(shaped.summaries) && shaped.summaries.length)) {
    throw new LocalCompressorUnavailableError("local compressor returned empty payload");
  }

  const summaries = Array.isArray(shaped.summaries)
    ? shaped.summaries.filter((s): s is { id: number; text: string } =>
      !!s && Number.isInteger(s.id) && s.id >= 1 && s.id <= maxChunkId && typeof s.text === "string" && s.text.trim().length > 0)
    : [];

  return { keep_ids: [...new Set(keepIds)], summaries };
}

function compressorMessages(userMessage: string, chunks: PromptChunk[]) {
  const serializedChunks = chunks.map((chunk) => ({
    id: chunk.id,
    pinned: chunk.pinned,
    text: chunk.text.slice(0, 2000),
  }));

  return [{
    role: "user",
    content: [
      "Compress this Claude prompt context for a code-assistant task.",
      "Task query:",
      JSON.stringify(userMessage),
      "Rules:",
      "- Keep all pinned chunks.",
      "- Prefer extractive keep/drop on code and diffs.",
      "- Summarize only prose/log chunks.",
      "- Return strict JSON only: {\"keep_ids\":[...],\"summaries\":[{\"id\":N,\"text\":\"...\"}]}",
      "Chunks:",
      JSON.stringify(serializedChunks),
    ].join("\n"),
  }];
}

// Official llama.cpp server 2026 way: response_format with a JSON schema. Works
// across models regardless of jinja template quirks.
const COMPRESSOR_RESPONSE_FORMAT = {
  type: "json_object",
  schema: {
    type: "object",
    properties: {
      keep_ids: {
        type: "array",
        items: { type: "integer", minimum: 1 },
      },
      summaries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            text: { type: "string" },
          },
          required: ["id", "text"],
        },
      },
    },
    required: ["keep_ids"],
  },
};

function mergeCompressedChunks(chunks: PromptChunk[], payload: CompressorPayload): string {
  const keepIds = new Set(payload.keep_ids);
  const summaryById = new Map((payload.summaries ?? []).map((item) => [item.id, item.text.trim()]));

  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.pinned || keepIds.has(chunk.id)) {
      parts.push(chunk.text);
      continue;
    }
    const summary = summaryById.get(chunk.id);
    if (summary) {
      parts.push(`[compressed summary #${chunk.id}] ${summary}`);
    }
  }
  return parts.join("\n\n").trim();
}

export async function compressPromptWithQwen(
  prompt: string,
  userMessage: string,
  modelTier: string,
  config?: CompressionConfig,
): Promise<CompressionResult> {
  const started = Date.now();
  const rawTokens = estimateTokens(prompt);
  const queryTokens = estimateTokens(userMessage);
  const budget = resolveCompressionBudget(modelTier, config?.budgetByTier);
  const minPromptTokens = resolveNonNegativeInt(
    config?.minPromptTokens ?? Number(process.env.KAI_COMPRESSOR_MIN_PROMPT_TOKENS || MIN_PROMPT_TOKENS),
    MIN_PROMPT_TOKENS,
  );
  const minQueryTokens = resolveNonNegativeInt(
    config?.minQueryTokens ?? Number(process.env.KAI_COMPRESSOR_MIN_QUERY_TOKENS || 0),
    0,
  );

  if (
    config?.disabled
    || rawTokens < minPromptTokens
    || rawTokens <= budget
    || queryTokens < minQueryTokens
  ) {
    return {
      prompt,
      metrics: {
        rawTokens,
        compressedTokens: rawTokens,
        cmpPct: 0,
        durationMs: Date.now() - started,
        usedModel: false,
      },
    };
  }

  const chunks = splitPromptIntoChunks(prompt);
  if (chunks.length === 0) {
    throw new LocalCompressorUnavailableError("compression required but prompt has no compressible chunks");
  }

  const url = config?.url ?? process.env.KAI_COMPRESSOR_URL;
  if (!url) {
    throw new LocalCompressorUnavailableError("compression required but missing KAI_COMPRESSOR_URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config?.timeoutMs ?? Number(process.env.KAI_COMPRESSOR_TIMEOUT_MS || 1500));
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config?.model ?? process.env.KAI_COMPRESSOR_MODEL ?? "LFM2-350M",
        messages: compressorMessages(userMessage, chunks),
        stream: false,
        temperature: 0,
        // Enough for ~200 integer ids + a few summaries; model stops at closing
        // brace so unused tokens are free.
        max_tokens: 1024,
        response_format: COMPRESSOR_RESPONSE_FORMAT,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new LocalCompressorUnavailableError(`local compressor returned HTTP ${response.status}`);
    }

    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content ?? "";
    const parsed = parseCompressorPayload(content, chunks.length);
    const merged = mergeCompressedChunks(chunks, parsed);
    if (!merged.trim()) {
      throw new LocalCompressorUnavailableError("local compressor returned empty merged prompt");
    }
    const compressedTokens = estimateTokens(merged);

    return {
      prompt: compressedTokens >= rawTokens ? prompt : merged,
      metrics: {
        rawTokens,
        compressedTokens: compressedTokens >= rawTokens ? rawTokens : compressedTokens,
        cmpPct: compressedTokens >= rawTokens ? 0 : Math.max(0, Math.round((1 - (compressedTokens / rawTokens)) * 100)),
        durationMs: Date.now() - started,
        usedModel: true,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
