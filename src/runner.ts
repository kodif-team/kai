import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { execSync, spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { createLogger, errorMeta } from "./log";
import type { RouterDecision } from "./types";
import { parseRtkSavings } from "./rtk";
import { sessionUpdate } from "./audit";
import { calculateAnthropicUsageCostUsd } from "./budget";
import { buildClaudeSpawnSpec } from "./runner-spawn";

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

function requireRTKHookConfigured(logger = createLogger("kai-runner", "info")): void {
  if (process.env.KAI_RTK_HOOK_SKIP_CHECK === "true") {
    logger.warn("KAI_RTK_HOOK_SKIP_CHECK=true — skipping RTK hook verification");
    return;
  }
  const candidates = [
    process.env.KAI_CLAUDE_SETTINGS_PATH,
    `${process.env.HOME || "/home/kai"}/.claude/settings.json`,
    "/home/kai/.claude/settings.json",
    "/root/.claude/settings.json",
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    if (/\brtk\b/i.test(content)) return;
  }
  throw new Error("RTK hook not configured in Claude settings.json");
}

export function requireRTK(): string {
  const ver = execSync("rtk --version", { stdio: "pipe", timeout: 5000, encoding: "utf-8" }).trim();
  const help = execSync("rtk --help", { stdio: "pipe", timeout: 5000, encoding: "utf-8" });
  if (!help.includes("rewrite")) {
    throw new Error("Wrong rtk binary (missing 'rewrite' command). Need rtk-ai/rtk, not crates.io rtk.");
  }
  requireRTKHookConfigured();
  return ver;
}

export function requireClaudeCLI(): void {
  execSync("claude --version", { stdio: "pipe", timeout: 5000 });
}

export function parseModelFromMessage(message: string): { model: string; cleanMessage: string } {
  for (const tier of ["opus", "sonnet", "haiku"]) {
    const pattern = new RegExp(`use\\s+${tier}`, "i");
    if (pattern.test(message)) {
      return { model: tier, cleanMessage: message.replace(pattern, "").trim() || "review this PR" };
    }
  }
  return { model: "haiku", cleanMessage: message };
}

export function buildCLIPrompt(input: BuildPromptInput): string {
  const archTask = input.isArchitectureQuestion(input.userMessage);
  const shortAnswer = input.isShortAnswerRequest(input.userMessage);
  const stable: string[] = [`Kai, AI code reviewer. Service: repos/${input.repoFullName.split("/").pop()}. PR: "${input.prTitle}"`];
  if (input.prBody) stable.push(`Desc: ${input.prBody.slice(0, 300)}`);
  stable.push(`Files:\n${input.filesList}`);
  if (input.prDiffDigest) {
    stable.push(`Full PR diff (pre-fetched — do NOT re-run \`git diff\`):\n\`\`\`diff\n${input.prDiffDigest}\n\`\`\``);
  }
  if (archTask) {
    stable.push(`Kodif architecture context:\n${input.architectureContext ?? ""}`);
  } else {
    stable.push(
      `PR repo checked out in current dir. The diff above is authoritative; only Read files if you need more than the diff shows.`,
      shortAnswer
        ? `STRICT BUDGET: this is a short-answer request. The diff above contains everything you need. Do NOT Read any file. Do NOT explore /home/kai/architect/repos/. Answer from the diff in at most 2 sentences.`
        : `Kodif repos available at /home/kai/architect/repos/ (read-only). Use for cross-service context only when the diff alone is insufficient.`,
      `IGNORE: .github/, .claude/, CLAUDE.md, *.yml workflow files — these are bot infrastructure, not project code.`,
      `Rules: concise, markdown, repos/<service>/path/file.py:line refs, max 50 lines. Don't repeat prior analysis.`,
      `For imperative write tasks (fix/add/update/create/patch/refactor/document), commit and push the change to the PR branch unless the user explicitly asks not to.`,
      `Git commits: NEVER add Co-Authored-By headers or AI provider attribution. Author is already set to kodif-ai[bot].`,
    );
  }
  const dynamic: string[] = [
    `Router: intent=${input.route.intent}; confidence=${input.route.confidence}; contextBudget=${input.route.maxContextTokens}; commitExpected=${input.route.commitExpected}`,
  ];
  if (input.focusedFiles?.length) dynamic.push(`Priority files (local LLM pre-selected): ${input.focusedFiles.join(", ")}`);
  if (input.prCommentsContext) dynamic.push(`Prior conversation:\n${input.prCommentsContext}`);
  dynamic.push(
    `Task: ${input.userMessage}`,
    archTask ? `Rules: concise, markdown, max 50 lines. Focus on architecture, services, connections.` :
      shortAnswer ? `This is a short-answer task. Produce the final one-sentence answer now. Do NOT open any file.` :
      `Success criteria: satisfy the task, stay within the selected context, and report concrete evidence. Answer EXACTLY what the user asked.`,
  );
  return input.buildCacheFriendlyPrompt({ stable, dynamic });
}

export function buildHeartbeatFrame(tick: number, elapsed: number, modelLabel: string): string {
  return spinnerFrame(tick, elapsed, modelLabel);
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
  disallowedTools: string[] = [],
): Promise<CLIResult> {
  const isRoot = isRootUser();
  sessionUpdate(db, runId, "cli-attempt-1", { attempt: 1 });
  try {
    const result = await runCLIWithHeartbeat(apiKey, modelId, prompt, maxTurns, isRoot, heartbeat, db, runId, disallowedTools);
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
  prompt: string,
  maxTurns: number,
  isRoot: boolean,
  hb: HeartbeatContext,
  db: DatabaseSync,
  runId: string,
  disallowedTools: string[] = [],
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const claudeArgs = ["-p", "--dangerously-skip-permissions", "--output-format", "json", "--max-turns", String(maxTurns), "--model", modelId];
    if (disallowedTools.length) claudeArgs.push("--disallowed-tools", disallowedTools.join(","));
    const startTime = Date.now();
    let output = "";
    let settled = false;

    const spawnSpec = buildClaudeSpawnSpec({
      isRoot,
      apiKey,
      claudeArgs,
      env: process.env,
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
        let rtkSavings = "";
        try {
          const gainCmd = isRoot ? `su -s /bin/bash kai -c 'rtk gain 2>/dev/null'` : `rtk gain 2>/dev/null`;
          const raw = execSync(gainCmd, { encoding: "utf-8", timeout: 5000 }).trim();
          rtkSavings = parseRtkSavings(raw);
        } catch { /* */ }
        let resultText = json.result ?? json.content ?? "";
        if (!resultText && json.is_error) {
          resultText = `⚠️ Task incomplete (${json.subtype ?? "error"}): reached ${json.num_turns ?? "?"} turns. Ask me to continue or simplify the request.`;
        }
        if (!resultText) resultText = output;
        const cacheRead = json.usage?.cache_read_input_tokens ?? 0;
        const cacheWrite = json.usage?.cache_creation_input_tokens ?? 0;
        const cacheWrite5m = json.usage?.cache_creation?.ephemeral_5m_input_tokens;
        const cacheWrite1h = json.usage?.cache_creation?.ephemeral_1h_input_tokens;
        const freshInput = json.usage?.input_tokens ?? 0;
        const outputTokens = json.usage?.output_tokens ?? 0;
        const providerCost = json.total_cost_usd ?? json.cost_usd;
        const computedCost = calculateAnthropicUsageCostUsd(modelId, {
          inputTokens: freshInput,
          outputTokens,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheWrite,
          cacheCreation5mInputTokens: cacheWrite5m,
          cacheCreation1hInputTokens: cacheWrite1h,
        });
        if (typeof providerCost === "number" && Math.abs(providerCost - computedCost) > 0.005) {
          core.warning(`Cost mismatch provider=${providerCost.toFixed(4)} computed=${computedCost.toFixed(4)}`);
        }
        settled = true;
        resolve({
          text: resultText,
          costUsd: computedCost,
          numTurns: json.num_turns ?? 1,
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await o.issues.updateComment({ owner, repo, comment_id: id, body });
      return;
    } catch (err: unknown) {
      const st = typeof err === "object" && err !== null && "status" in err ? Number((err as { status?: number }).status ?? 0) : 0;
      if (st >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return;
    }
  }
}
