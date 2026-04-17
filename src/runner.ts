import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { execSync, spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { createLogger, errorMeta, LogLevel } from "./log";
import type { RouterDecision } from "./types";
import { parseRtkSavings, RTK_NOT_TRACKED } from "./rtk";
import { sessionUpdate } from "./audit";
import { calculateAnthropicUsageCostUsd, MAX_COST_USD_BY_TIER } from "./budget";
import { buildClaudeSpawnSpec } from "./runner-spawn";
import { buildRepoContextInstructions } from "./repo-context";

export type CLIResult = {
  text: string;
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rtkSavings: string;
};

export type HeartbeatContext = {
  octokit: Octokit;
  owner: string;
  repo: string;
  replyCommentId: number;
  sender: string;
  modelLabel: string;
};

export type RTKConfig = {
  claudeSettingsPath: string;
  hookSkipCheck: boolean;
};


type CliJsonPayload = {
  result?: string;
  content?: string;
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  usage?: {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
  cost_usd?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseCliJsonPayload(output: string): CliJsonPayload {
  const json = JSON.parse(output);
  if (!isRecord(json)) throw new Error("CLI payload is not an object");
  const payload: CliJsonPayload = {};
  if (typeof json.result === "string") payload.result = json.result;
  if (typeof json.content === "string") payload.content = json.content;
  if (typeof json.is_error === "boolean") payload.is_error = json.is_error;
  if (typeof json.subtype === "string") payload.subtype = json.subtype;
  if (typeof json.num_turns === "number") payload.num_turns = json.num_turns;
  if (isRecord(json.usage)) {
    payload.usage = {};
    if (typeof json.usage.cache_read_input_tokens === "number") payload.usage.cache_read_input_tokens = json.usage.cache_read_input_tokens;
    if (typeof json.usage.cache_creation_input_tokens === "number") payload.usage.cache_creation_input_tokens = json.usage.cache_creation_input_tokens;
    if (isRecord(json.usage.cache_creation)) {
      payload.usage.cache_creation = {};
      if (typeof json.usage.cache_creation.ephemeral_5m_input_tokens === "number") {
        payload.usage.cache_creation.ephemeral_5m_input_tokens = json.usage.cache_creation.ephemeral_5m_input_tokens;
      }
      if (typeof json.usage.cache_creation.ephemeral_1h_input_tokens === "number") {
        payload.usage.cache_creation.ephemeral_1h_input_tokens = json.usage.cache_creation.ephemeral_1h_input_tokens;
      }
    }
    if (typeof json.usage.input_tokens === "number") payload.usage.input_tokens = json.usage.input_tokens;
    if (typeof json.usage.output_tokens === "number") payload.usage.output_tokens = json.usage.output_tokens;
  }
  if (typeof json.total_cost_usd === "number") payload.total_cost_usd = json.total_cost_usd;
  if (typeof json.cost_usd === "number") payload.cost_usd = json.cost_usd;
  return payload;
}

export type BuildPromptInput = {
  userMessage: string;
  prTitle: string;
  prBody: string;
  filesList: string;
  prCommentsContext: string;
  repoFullName: string;
  route: RouterDecision;
  focusedFiles?: string[];
  prDiffDigest?: string;
  architectureContext?: string;
  metaTemplate: string;
  buildCacheFriendlyPrompt: (input: { stable: string[]; dynamic: string[] }) => string;
  isArchitectureQuestion: (message: string) => boolean;
  isShortAnswerRequest: (message: string) => boolean;
};

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const CLI_TIMEOUT_MS = 300_000;
export const LOADING_GIF = "https://emojis.slackmojis.com/emojis/images/1643514453/4358/loading.gif?1643514453";
export const DEFAULT_CLEAN_MODEL_MESSAGE = "review this PR";
export const DEFAULT_KAI_HOME = "/home/kai";
export const DEFAULT_CLI_NUM_TURNS = 1;
export const MAX_SAFE_UPDATE_ATTEMPTS = 3;
export const RETRY_STATUS_MIN = 500;
export const PHASES = [
  "Reading PR context",
  "Loading conversation history",
  "Analyzing code changes",
  "Running security checks",
  "Inspecting files",
  "Preparing response",
];

export function spinnerFrame(_tick: number, elapsed: number, _modelLabel: string): string {
  const phase = PHASES[Math.min(Math.floor(elapsed / 10), PHASES.length - 1)];
  return `<img src="${LOADING_GIF}" width="20" height="20"> ${phase}...\n\n_Delete this comment to cancel._`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function gitOutput(command: string): string {
  return execSync(command, { stdio: "pipe", timeout: 30_000, encoding: "utf-8" }).trim();
}

function isRootUser(): boolean {
  return process.getuid?.() === 0;
}

function tierCostCap(modelTier: string): number {
  const cap = MAX_COST_USD_BY_TIER[modelTier];
  if (typeof cap !== "number") throw new Error(`Unknown model tier for cost cap: ${modelTier}`);
  return cap;
}

function firstString(values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function numberOrConstant(value: number | undefined, fallback: number): number {
  if (typeof value === "number") return value;
  return fallback;
}

function repoServiceName(repoFullName: string): string {
  return posix.basename(repoFullName);
}

function requireRTKHookConfigured(config: RTKConfig, logger: ReturnType<typeof createLogger>): void {
  if (config.hookSkipCheck) {
    logger.warn("KAI_RTK_HOOK_SKIP_CHECK=true — skipping RTK hook verification");
    return;
  }
  const candidates = [
    config.claudeSettingsPath,
    join("/home", "kai", ".claude", "settings.json"),
    join("/root", ".claude", "settings.json"),
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    if (/\brtk\b/i.test(content)) return;
  }
  throw new Error("RTK hook not configured in Claude settings.json");
}

export function requireRTK(config: RTKConfig): string {
  const ver = execSync("rtk --version", { stdio: "pipe", timeout: 5000, encoding: "utf-8" }).trim();
  const help = execSync("rtk --help", { stdio: "pipe", timeout: 5000, encoding: "utf-8" });
  if (!help.includes("rewrite")) {
    throw new Error("Wrong rtk binary (missing 'rewrite' command). Need rtk-ai/rtk, not crates.io rtk.");
  }
  requireRTKHookConfigured(config, createLogger("kai-runner", LogLevel.Info));
  return ver;
}

export function requireClaudeCLI(): void {
  execSync("claude --version", { stdio: "pipe", timeout: 5000 });
}

export function parseModelFromMessage(message: string): { model: string; cleanMessage: string } {
  for (const tier of ["opus", "sonnet", "haiku"]) {
    const pattern = new RegExp(`use\\s+${tier}`, "i");
    if (pattern.test(message)) {
      const cleanMessage = message.replace(pattern, "").trim();
      if (cleanMessage.length > 0) {
        return { model: tier, cleanMessage };
      }
      return { model: tier, cleanMessage: DEFAULT_CLEAN_MODEL_MESSAGE };
    }
  }
  return { model: "haiku", cleanMessage: message };
}

function architectureContextValue(input: BuildPromptInput): string {
  if (typeof input.architectureContext === "string") return input.architectureContext;
  return "";
}

function promptRuleText(archTask: boolean, shortAnswer: boolean, commitExpected: boolean): string {
  if (archTask) {
    return "Rules: concise, markdown, max 50 lines. Focus on architecture, services, connections.";
  }
  if (shortAnswer) {
    return "This is a short-answer task. Produce the final one-sentence answer now. Do NOT open any file.";
  }
  if (commitExpected) {
    return "Success criteria: satisfy the task, stay within the selected context, and report concrete evidence. Answer EXACTLY what the user asked.";
  }
  return "Read-only task. Do NOT edit files, commit, or push. Satisfy the task from the selected context and report concrete evidence. Answer EXACTLY what the user asked.";
}

export function buildCLIPrompt(input: BuildPromptInput): string {
  const archTask = input.isArchitectureQuestion(input.userMessage);
  const shortAnswer = input.isShortAnswerRequest(input.userMessage);
  const stable: string[] = [`Kai, AI code reviewer. Service: repos/${repoServiceName(input.repoFullName)}. PR: "${input.prTitle}"`];
  if (input.prBody) stable.push(`Desc: ${input.prBody.slice(0, 300)}`);
  stable.push(`Files:\n${input.filesList}`);
  if (input.prDiffDigest) {
    stable.push(`Full PR diff (pre-fetched — do NOT re-run \`git diff\`):\n\`\`\`diff\n${input.prDiffDigest}\n\`\`\``);
  }
  if (archTask) {
    stable.push(`Kodif architecture context:\n${architectureContextValue(input)}`);
  } else {
    stable.push(...buildRepoContextInstructions(shortAnswer));
  }
  const dynamic: string[] = [
    `Router: intent=${input.route.intent}; confidence=${input.route.confidence}; contextBudget=${input.route.maxContextTokens}; commitExpected=${input.route.commitExpected}`,
  ];
  if (input.focusedFiles?.length) dynamic.push(`Priority files (local LLM pre-selected): ${input.focusedFiles.join(", ")}`);
  if (input.prCommentsContext) dynamic.push(`Prior conversation:\n${input.prCommentsContext}`);
  dynamic.push(
    `Task: ${input.userMessage}`,
    promptRuleText(archTask, shortAnswer, input.route.commitExpected),
  );
  return input.buildCacheFriendlyPrompt({ stable, dynamic });
}

export function buildHeartbeatFrame(tick: number, elapsed: number, modelLabel: string): string {
  return spinnerFrame(tick, elapsed, modelLabel);
}

// Map tier to Claude CLI --effort level. High for opus (quality-sensitive
// agentic work), medium for sonnet, low for haiku (fast/cheap). xhigh/max
// reserved — they scale cost and we already cap at tier level.
function effortForTier(tier: string): string {
  if (tier === "opus") return "high";
  if (tier === "sonnet") return "medium";
  return "low";
}

export async function callClaudeCLIWithHeartbeat(
  apiKey: string,
  modelId: string,
  prompt: string,
  maxTurns: number,
  heartbeat: HeartbeatContext,
  db: DatabaseSync,
  runId: string,
  modelTier: string,
  disallowedTools: string[],
  runtimeEnv: NodeJS.ProcessEnv,
): Promise<CLIResult> {
  const isRoot = isRootUser();
  sessionUpdate(db, runId, "cli-attempt-1", { attempt: 1 });
  try {
    const result = await runCLIWithHeartbeat(apiKey, modelId, modelTier, prompt, maxTurns, isRoot, heartbeat, db, runId, disallowedTools, runtimeEnv);
    sessionUpdate(db, runId, "completed", { status: "completed" });
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    sessionUpdate(db, runId, "failed-attempt-1", { error: msg });
    sessionUpdate(db, runId, "failed", { status: "failed", error: msg });
    throw e;
  }
}

async function runCLIWithHeartbeat(
  apiKey: string,
  modelId: string,
  modelTier: string,
  prompt: string,
  maxTurns: number,
  isRoot: boolean,
  hb: HeartbeatContext,
  db: DatabaseSync,
  runId: string,
  disallowedTools: string[],
  runtimeEnv: NodeJS.ProcessEnv,
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    // Tier cap acts as a second defence layer: CLI enforces at runtime even if
    // preflight estimation was off. --exclude-dynamic-system-prompt-sections
    // moves per-machine state out of the system prompt so the stable prefix
    // stays cacheable across runs. --effort tunes thinking depth per tier.
    const tierCapUsd = tierCostCap(modelTier);
    const claudeArgs = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--max-turns", String(maxTurns),
      "--model", modelId,
      "--effort", effortForTier(modelTier),
      "--max-budget-usd", String(tierCapUsd),
      "--exclude-dynamic-system-prompt-sections",
    ];
    if (disallowedTools.length) claudeArgs.push("--disallowed-tools", disallowedTools.join(","));
    const startTime = Date.now();
    let output = "";
    let settled = false;

    const spawnSpec = buildClaudeSpawnSpec({
      isRoot,
      apiKey,
      claudeArgs,
      env: runtimeEnv,
    });
    const child = spawn(spawnSpec.command, spawnSpec.args, { env: spawnSpec.env });

    child.stdin?.write(prompt);
    child.stdin?.end();
    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { core.info(`CLI stderr: ${data.toString().slice(0, 200)}`); });

    const heartbeatTimer = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sessionUpdate(db, runId, "running");
      try {
        await hb.octokit.issues.getComment({ owner: hb.owner, repo: hb.repo, comment_id: hb.replyCommentId });
      } catch {
        child.kill("SIGTERM");
        clearInterval(heartbeatTimer);
        if (!settled) { settled = true; reject(new Error("Cancelled by user")); }
        return;
      }
      await safeUpdate(hb.octokit, hb.owner, hb.repo, hb.replyCommentId, buildHeartbeatFrame(0, elapsed, hb.modelLabel));
    }, HEARTBEAT_INTERVAL_MS);

    const timeoutTimer = setTimeout(() => {
      core.warning(`CLI timeout after ${CLI_TIMEOUT_MS / 1000}s`);
      child.kill("SIGTERM");
    }, CLI_TIMEOUT_MS);

    child.on("close", (code) => {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
      if (settled) return;
      if (code !== 0 && !output) {
        settled = true;
        reject(new Error(`CLI exited with code ${code}`));
        return;
      }
      try {
        const json = parseCliJsonPayload(output);
        let rtkSavings: string = RTK_NOT_TRACKED;
        try {
          const gainCmd = isRoot ? `su -s /bin/bash kai -c 'rtk gain 2>/dev/null'` : `rtk gain 2>/dev/null`;
          const raw = execSync(gainCmd, { encoding: "utf-8", timeout: 5000 }).trim();
          rtkSavings = parseRtkSavings(raw);
        } catch { /* RTK binary missing or failed — keep sentinel */ }
        let resultText = firstString([json.result, json.content]);
        if (!resultText && json.is_error) {
          const subtype = firstString([json.subtype, "error"]);
          const numTurns = typeof json.num_turns === "number" ? String(json.num_turns) : "?";
          resultText = `⚠️ Task incomplete (${subtype}): reached ${numTurns} turns. Ask me to continue or simplify the request.`;
        }
        if (!resultText) resultText = output;
        const cacheRead = numberOrConstant(json.usage?.cache_read_input_tokens, 0);
        const cacheWrite = numberOrConstant(json.usage?.cache_creation_input_tokens, 0);
        const cacheWrite5m = json.usage?.cache_creation?.ephemeral_5m_input_tokens;
        const cacheWrite1h = json.usage?.cache_creation?.ephemeral_1h_input_tokens;
        const freshInput = numberOrConstant(json.usage?.input_tokens, 0);
        const outputTokens = numberOrConstant(json.usage?.output_tokens, 0);
        const providerCost = typeof json.total_cost_usd === "number" ? json.total_cost_usd : json.cost_usd;
        const computedCost = calculateAnthropicUsageCostUsd(modelId, {
          inputTokens: freshInput,
          outputTokens,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheWrite,
          cacheCreation5mInputTokens: cacheWrite5m,
          cacheCreation1hInputTokens: cacheWrite1h,
        });
        const actualCost = typeof providerCost === "number" ? providerCost : computedCost;
        if (typeof providerCost === "number" && Math.abs(providerCost - computedCost) > 0.005) {
          core.warning(`Cost mismatch provider=${providerCost.toFixed(4)} computed=${computedCost.toFixed(4)}`);
        }
        settled = true;
        resolve({
          text: resultText,
          costUsd: actualCost,
          numTurns: numberOrConstant(json.num_turns, DEFAULT_CLI_NUM_TURNS),
          inputTokens: freshInput + cacheRead + cacheWrite,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          rtkSavings,
        });
      } catch (e) {
        settled = true;
        reject(new Error(`Failed to parse CLI output: ${(e as Error).message}`));
      }
    });
  });
}

export async function safeUpdate(o: Octokit, owner: string, repo: string, id: number, body: string) {
  for (let attempt = 0; attempt < MAX_SAFE_UPDATE_ATTEMPTS; attempt++) {
    try {
      await o.issues.updateComment({ owner, repo, comment_id: id, body });
      return;
    } catch (err: unknown) {
      const st = typeof err === "object" && err !== null && "status" in err
        ? numberOrConstant((err as { status?: number }).status, 0)
        : 0;
      if (st >= RETRY_STATUS_MIN && attempt < MAX_SAFE_UPDATE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return;
    }
  }
}
