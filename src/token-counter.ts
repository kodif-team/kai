import Anthropic from "@anthropic-ai/sdk";
import { estimateTokens } from "./compressor";

// Single client per action invocation. Anthropic SDK is already a dependency
// and recommends reuse to amortize TLS setup across calls.
let sharedClient: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!sharedClient) sharedClient = new Anthropic({ apiKey });
  return sharedClient;
}

export type TokenCount = {
  tokens: number;
  source: "api" | "heuristic";
  durationMs: number;
};

// Use Anthropic's /v1/messages/count_tokens endpoint for authoritative input
// token count. Preflight must operate on real counts, not heuristic estimates,
// or we reject safe requests and admit unsafe ones. Falls back to the
// character-ratio heuristic if the API call fails (network, auth, timeout) so
// preflight never fully blocks — fail-safe toward heuristic, never silent.
export async function countInputTokens(
  apiKey: string,
  modelId: string,
  prompt: string,
  timeoutMs = 3000,
): Promise<TokenCount> {
  const started = Date.now();
  if (!apiKey || !apiKey.trim()) {
    return { tokens: estimateTokens(prompt), source: "heuristic", durationMs: 0 };
  }
  const client = getClient(apiKey);
  try {
    const response = await client.messages.countTokens(
      {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: timeoutMs },
    );
    return {
      tokens: response.input_tokens,
      source: "api",
      durationMs: Date.now() - started,
    };
  } catch {
    return {
      tokens: estimateTokens(prompt),
      source: "heuristic",
      durationMs: Date.now() - started,
    };
  }
}
