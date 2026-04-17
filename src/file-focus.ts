// Local-LLM pre-step: given user task + changed-files list, pick the small set
// of files Claude should look at first. Reduces wandering Read calls.

import { isRecord, parseJsonObject } from "./json";

export type FileFocusConfig = {
  url: string;
  model?: string;
  timeoutMs?: number;
  maxFiles?: number;
};

const FILE_FOCUS_RESPONSE_FORMAT = {
  type: "json_object",
  schema: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
    },
    required: ["files"],
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

export async function selectRelevantFiles(
  userMessage: string,
  filesList: string,
  config: FileFocusConfig,
): Promise<string[]> {
  if (config.maxFiles == null) throw new Error("file-focus maxFiles is required");
  if (config.timeoutMs == null) throw new Error("file-focus timeoutMs is required");
  if (!config.model) throw new Error("local file-focus model is required");
  const maxFiles = config.maxFiles;
  const files = filesList.split("\n").map((l) => l.split(" ")[0]).filter(Boolean);
  if (files.length <= maxFiles) return files;
  try {
    const response = await fetch(chatCompletionsUrl(config.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: "user",
          content: `Pick up to ${maxFiles} most relevant file paths for this task.\nTask: ${JSON.stringify(userMessage)}\nFiles:\n${files.join("\n")}\nReturn {"files":["path","..."]} with exact paths from the list.`,
        }],
        stream: false,
        temperature: 0,
        max_tokens: 256,
        response_format: FILE_FOCUS_RESPONSE_FORMAT,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return [];
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = responseContent(body);
    let parsed: unknown;
    try { parsed = parseJsonObject(content); } catch { return []; }
    if (!isRecord(parsed) || !Array.isArray(parsed.files)) return [];
    const known = new Set(files);
    // Only trust paths the LLM actually saw (avoid hallucinated paths).
    return parsed.files.filter((p): p is string => typeof p === "string" && known.has(p)).slice(0, maxFiles);
  } catch {
    return [];
  }
}
