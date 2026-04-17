import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { compressPromptWithQwen, estimateTokens } from "./compressor";
import { countInputTokens } from "./token-counter";
import { appendContextHistory, buildDynamicPromptFromManifest, createDynamicContextPack } from "./context-pack";
import { buildFooter, buildRouterFooter } from "./footer";
import { isMetaQuestion, routeEventWithLocalLLM, shouldVerifyCommit, suggestTierWithLocalLLM, type RouterDecision } from "./router";
import { META_TEMPLATE, templateForRoute } from "./templates";
import { ensureCacheSchema, lookupCachedReply, storeCachedReply } from "./cache";
import { selectRelevantFiles } from "./file-focus";
import { buildCacheFriendlyPrompt } from "./prompt-order";
import { loadConfig } from "./config";
import { createLogger, errorMeta } from "./log";
import { initAuditDb, latestAuditId, checkRateLimit, recordRateLimit, sessionStart, sessionUpdate, auditLog, logRouterDecision, logContextOptimization, detectAndRecordFollowupAudit as detectAndRecordFollowup, recordAuditQualitySignals as recordCommitVerification, recordAuditCacheHit as recordCacheHit } from "./audit";
import { parseModelFromMessage, requireClaudeCLI, requireRTK, buildHeartbeatFrame, callClaudeCLIWithHeartbeat, safeUpdate, type HeartbeatContext } from "./runner";
import { getPullRequestDiffDigest, truncateDiffDigest } from "./pr-diff";
import { buildRepoContextInstructions } from "./repo-context";
import { answerRepoLookup } from "./repo-lookup";
import {
  disallowedToolsFor as budgetDisallowedToolsFor,
  getMaxTurns as budgetGetMaxTurns,
  isShortAnswerRequest as budgetIsShortAnswerRequest,
  MAX_COST_USD_BY_TIER as BUDGET_MAX_COST_USD_BY_TIER,
  MAX_PROMPT_TOKENS as BUDGET_MAX_PROMPT_TOKENS,
  preflightBudget,
} from "./budget";

type StatusError = Error & { status?: number };
function errorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as StatusError).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

function requireReposPath(): string {
  const value = core.getInput("repos_path") || process.env.KAI_REPOS_PATH;
  if (!value || !value.trim()) {
    throw new Error("Missing required repos path: set action input repos_path or env KAI_REPOS_PATH");
  }
  return value.trim();
}

function ensureLocalReposDirectory(reposPath: string): void {
  const target = reposPath.trim();
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`KAI_REPOS_PATH must point to an existing repos directory: ${target}`);
  }

  const localPath = "repos";
  const localStats = lstatSync(localPath, { throwIfNoEntry: false });
  if (localStats) {
    if (!statSync(localPath).isDirectory()) {
      throw new Error("Local repos path exists but is not a directory");
    }
    return;
  }

  symlinkSync(target, localPath, "dir");
}

async function getPRCommentsContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  maxComments = 5,
  maxChars = 200,
): Promise<string> {
  try {
    const { data: comments } = await octokit.issues.listComments({
      owner, repo, issue_number: issueNumber, per_page: 30,
    });
    const recent = comments.slice(-maxComments);
    if (recent.length === 0) return "";
    return recent.map((c) => {
      const who = c.user?.login ?? "?";
      const body = (c.body ?? "").slice(0, maxChars).replace(/\n/g, " ");
      return `${who}: ${body}`;
    }).join("\n");
  } catch {
    return "";
  }
}

const rawLogLevel = (process.env.KAI_LOG_LEVEL || "info").toLowerCase();
const safeLogLevel = rawLogLevel === "debug" || rawLogLevel === "warn" || rawLogLevel === "error" ? rawLogLevel : "info";
const log = createLogger("kai-action", safeLogLevel);

const MODELS: Record<string, { id: string; label: string }> = {
  haiku:  { id: "claude-haiku-4-5-20251001",  label: "Haiku" },
  sonnet: { id: "claude-sonnet-4-20250514",    label: "Sonnet" },
  opus:   { id: "claude-opus-4-20250514",      label: "Opus" },
};
const LOCAL_LLM_MODEL = "LFM2-350M";
const KODIF_ARCH_CONTEXT = `
Kodif platform: 33+ microservices. Architecture repo: kodif-team/architect
DBs: executor-db (kodif, PostgreSQL 13), chat-db (chat, PostgreSQL 15), ml-db (zendesk-json-db-pgadmin, PostgreSQL 13). All sync to BigQuery (kodif-51ce2, public dataset).
Key services: Nexus (core API), ml-service (ML/embeddings), tools (tool execution), integrations (CRM connectors), chatbot (chat engine), kodif-chat (chat backend), kodif-executor (flow engine, Java), kodif-gateway (API gateway), kodif-dashboard (frontend), kodif-chat-widget (widget), kodif-analytics (reports), insights-api, insights-service, index-service (search), autopilot (policy automation), playground-service.
Infra: Redis (cache + Celery broker), SQS queues via LocalStack or AWS, Milvus (vector DB for knowledge embeddings), etcd, MinIO.
NOTE: Local bootstrap (architect/bootstrap/docker-compose.yml) uses LOCAL ports that differ from production. Port mappings, network config, and credentials in bootstrap are for LOCAL DEV ONLY. Production runs on EKS/K8s with different networking. Do not cite local ports as production architecture.
To explore: kodif-team/architect — .claude/CLAUDE.md, service-summaries/, db-schemas/, feature-deepdives/.
`.trim();

function isArchitectureQuestion(msg: string): boolean {
  return /architect|infra|service|microservice|system|overview|how.*work|database|schema|stack/i.test(msg);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function logErrorToSentry(error: unknown, extra?: Record<string, unknown>): void {
  const sentry = (globalThis as unknown as {
    Sentry?: { captureException: (err: unknown, context?: Record<string, unknown>) => void };
  }).Sentry;
  try {
    sentry?.captureException?.(error, extra);
  } catch {
    // never fail workflow on telemetry
  }
}

function gitOutput(command: string): string {
  return execSync(command, { stdio: "pipe", timeout: 30_000, encoding: "utf-8" }).trim();
}

// Pre-digests the PR diff so Claude has it in the prompt (cached, stable across
// calls for the same PR state) instead of burning a bash tool-call + extra turn
// to fetch it. Truncates past MAX_DIFF_CHARS to keep the stable prefix bounded.
const MAX_DIFF_CHARS = 12_000; // ~3K tokens
function getPrDiffDigest(): string {
  try {
    const diff = execSync("git diff origin/main...HEAD --no-color --unified=3", {
      stdio: "pipe", timeout: 15_000, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024,
    });
    if (!diff.trim()) return "";
    return truncateDiffDigest(diff, MAX_DIFF_CHARS);
  } catch (e: unknown) {
    core.warning(`diff digest failed: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
    return "";
  }
}

function stripProviderCoAuthorFromHead(): void {
  const message = gitOutput("git log -1 --pretty=%B");
  const cleaned = message
    .split("\n")
    .filter((line) => !/^Co-Authored-By:\s*(Claude|Anthropic|OpenAI|ChatGPT|Codex|AI)/i.test(line.trim()))
    .join("\n")
    .trim();

  if (cleaned && cleaned !== message.trim()) {
    core.info("Removing AI provider Co-Authored-By trailer from HEAD commit");
    execSync(`git commit --amend -m ${shellQuote(cleaned)}`, { stdio: "pipe", timeout: 30_000 });
  }
}

function gitAuthFlag(githubToken: string): string {
  // http.extraheader keeps the token out of argv and .git/config persisted state.
  const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`;
  return `-c ${shellQuote(`http.https://github.com/.extraheader=${authHeader}`)}`;
}

function commitVerificationNote(
  userMessage: string, beforeHead: string, branch: string, githubToken: string,
): string {
  if (!shouldVerifyCommit(userMessage) || !beforeHead || !branch) return "";

  const quotedBranch = shellQuote(branch);
  const auth = gitAuthFlag(githubToken);
  try {
    execSync("git reset -- .claudeignore && rm -f .claudeignore", { stdio: "pipe", timeout: 5000 });
  } catch {}

  const afterHeadBeforeCommit = gitOutput("git rev-parse HEAD");
  if (afterHeadBeforeCommit !== beforeHead) {
    stripProviderCoAuthorFromHead();
    const amendedHead = gitOutput("git rev-parse HEAD");
    core.info(`Commit requested — pushing existing commit ${amendedHead.slice(0, 7)} to ${branch}`);
    execSync(`git ${auth} push origin HEAD:${quotedBranch}`, { stdio: "pipe", timeout: 60_000 });
    return `\n\n**Commit verification:** pushed \`${amendedHead.slice(0, 7)}\` to \`${branch}\`.`;
  }

  const status = gitOutput("git status --porcelain");

  if (status) {
    core.info("Commit requested and worktree is dirty — committing changes deterministically");
    execSync("git add -A", { stdio: "pipe", timeout: 30_000 });
    execSync(`git commit -m ${shellQuote("chore: apply Kai requested changes")}`, {
      stdio: "pipe", timeout: 30_000,
    });
  }

  const afterHead = gitOutput("git rev-parse HEAD");
  if (afterHead !== beforeHead) {
    stripProviderCoAuthorFromHead();
    const amendedHead = gitOutput("git rev-parse HEAD");
    core.info(`Commit requested — pushing ${amendedHead.slice(0, 7)} to ${branch}`);
    execSync(`git ${auth} push origin HEAD:${quotedBranch}`, { stdio: "pipe", timeout: 60_000 });
    return `\n\n**Commit verification:** pushed \`${amendedHead.slice(0, 7)}\` to \`${branch}\`.`;
  }

  core.warning("Commit requested but no commit was created and worktree is clean");
  return `\n\n**Commit verification failed:** no file changes or new commit were found after the requested work. Nothing was pushed.`;
}

async function attemptInfrastructureRecovery(reason: string): Promise<void> {
  if (!reason.includes("local router") && !reason.includes("compressor") && !reason.includes("fetch failed")) {
    return;
  }
  try {
    execSync("docker compose restart kai-router kai-compressor", { stdio: "pipe", timeout: 60_000 });
    core.warning("Infrastructure recovery attempted: docker compose restart kai-router kai-compressor");
  } catch (err: unknown) {
    core.warning(`Infrastructure recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Re-exported from src/budget.ts so existing callsites compile without diff
// noise. All budget decisions live in budget.ts (single source of truth).
const isShortAnswerRequest = budgetIsShortAnswerRequest;

function buildCLIPrompt(
  userMessage: string, prTitle: string, prBody: string,
  filesList: string, prCommentsContext: string, repoFullName: string,
  route: RouterDecision, focusedFiles: string[] = [],
  prDiffDigest = "",
): string {
  if (isMetaQuestion(userMessage)) return META_TEMPLATE;

  const archTask = isArchitectureQuestion(userMessage);
  const shortAnswer = isShortAnswerRequest(userMessage);

  // Stable prefix — identical across calls inside the same PR, so Anthropic's
  // implicit prompt cache will hit.
  const stable: string[] = [
    `Kai, AI code reviewer. Service: repos/${repoFullName.split("/").pop()}. PR: "${prTitle}"`,
  ];
  if (prBody) stable.push(`Desc: ${prBody.slice(0, 300)}`);
  stable.push(`Files:\n${filesList}`);
  // Pre-attached diff — Claude should NOT re-fetch via bash. This is the single
  // largest cost win on short-answer tasks: 1 cached prefix read vs. multiple
  // turns of `git diff` + Read calls.
  if (prDiffDigest) {
    stable.push(`Full PR diff (pre-fetched — do NOT re-run \`git diff\`):\n\`\`\`diff\n${prDiffDigest}\n\`\`\``);
  }
  if (archTask) {
    stable.push(`Kodif architecture context:\n${KODIF_ARCH_CONTEXT}`);
  } else {
    stable.push(...buildRepoContextInstructions(shortAnswer));
  }

  // Dynamic tail — changes every call; cache miss happens only here.
  const dynamic: string[] = [
    `Router: intent=${route.intent}; confidence=${route.confidence}; contextBudget=${route.maxContextTokens}; commitExpected=${route.commitExpected}`,
  ];
  if (focusedFiles.length) {
    dynamic.push(`Priority files (local LLM pre-selected): ${focusedFiles.join(", ")}`);
  }
  if (prCommentsContext) dynamic.push(`Prior conversation:\n${prCommentsContext}`);
  dynamic.push(
    `Task: ${userMessage}`,
    archTask
      ? `Rules: concise, markdown, max 50 lines. Focus on architecture, services, connections.`
      : shortAnswer
        ? `This is a short-answer task. Produce the final one-sentence answer now. Do NOT open any file.`
        : route.commitExpected
          ? `Success criteria: satisfy the task, stay within the selected context, and report concrete evidence. Answer EXACTLY what the user asked.`
          : `Read-only task. Do NOT edit files, commit, or push. Satisfy the task from the selected context and report concrete evidence. Answer EXACTLY what the user asked.`,
  );

  return buildCacheFriendlyPrompt({ stable, dynamic });
}

const getMaxTurns = budgetGetMaxTurns;

// Single source of truth for budget caps lives in src/budget.ts. Re-bind for
// the legacy callsites that read these directly.
const MAX_COST_USD_BY_TIER = BUDGET_MAX_COST_USD_BY_TIER;
const MAX_PROMPT_TOKENS = BUDGET_MAX_PROMPT_TOKENS;

const disallowedToolsFor = budgetDisallowedToolsFor;

const TIER_ESCALATION_ORDER = ["haiku", "sonnet", "opus"] as const;
const TIER_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

function escalationTierSequence(startTier: string): string[] {
  return TIER_ESCALATION_ORDER.filter(
    (t) => TIER_RANK[t] > TIER_RANK[startTier],
  );
}

// --- Main with global error handler ---

async function run() {
  // These are set early so the global error handler can post to PR
  let octokit: Octokit | null = null;
  let owner = "", repo = "", replyCommentId = 0;
  let sender = "", rawMessage = "";

  try {
    const cfg = loadConfig();
    const reposPath = requireReposPath();
    ensureLocalReposDirectory(reposPath);
    const trigger = core.getInput("trigger_phrase") || "@kai";
    const githubToken = core.getInput("github_token");
    const anthropicApiKey = core.getInput("anthropic_api_key");
    const routerUrl = core.getInput("router_url") || cfg.routerUrl;
    const routerModel = LOCAL_LLM_MODEL;
    const compressorUrl = core.getInput("compressor_url") || cfg.compressorUrl;
    const compressorModel = LOCAL_LLM_MODEL;
    const compressorDisabled = (core.getInput("compressor_disable") || process.env.KAI_COMPRESSOR_DISABLE || "false").toLowerCase() === "true";
    const compressorMinQueryTokens = Number(core.getInput("compressor_min_query_tokens") || cfg.compressorMinQueryTokens);
    const compressorMinPromptTokens = Number(core.getInput("compressor_min_prompt_tokens") || cfg.compressorMinPromptTokens);

    const { context } = github;
    const event = context.eventName;

    let commentBody = "", commentId = 0, issueNumber = 0;

    if (event === "issue_comment" || event === "pull_request_review_comment") {
      const payload = context.payload;
      commentBody = payload.comment?.body ?? "";
      commentId = payload.comment?.id ?? 0;
      sender = payload.comment?.user?.login ?? "";
      issueNumber = event === "issue_comment"
        ? payload.issue?.number ?? 0
        : payload.pull_request?.number ?? 0;
    }

    if (!commentBody.toLowerCase().includes(trigger.toLowerCase())) return;
    if (sender.includes("[bot]")) return;

    octokit = new Octokit({ auth: githubToken });
    ({ owner, repo } = context.repo);

    // Audit + Session: init DB early so every path can record status.
    const auditDb = initAuditDb(cfg.auditDbPath);

    // Self-heal local LLM containers if they're down. Runs before any router
    // call so we don't waste retries against a dead endpoint. Silent no-op when
    // everything is already healthy.
    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    rawMessage = commentBody.slice(idx + trigger.length).trim();
    const { model: parsedTier, cleanMessage: userMessage } = parseModelFromMessage(rawMessage);
    const userSpecifiedTier = /\buse\s+(haiku|sonnet|opus)\b/i.test(rawMessage);

    // If the user didn't explicitly pick a tier, ask the local LLM to suggest one
    // based on task complexity. Skipped
    // when router and compressor share the same endpoint (llama.cpp --parallel 1
    // chokes on back-to-back hits) or when disabled via env.
    let suggestedTier: string | null = null;
    const tierSuggestDisabled = process.env.KAI_TIER_SUGGEST_DISABLE === "true"
      || (!!routerUrl && !!compressorUrl && routerUrl === compressorUrl);
    if (!userSpecifiedTier && routerUrl && !tierSuggestDisabled) {
      try {
        suggestedTier = await suggestTierWithLocalLLM(userMessage, {
          url: routerUrl, model: routerModel, timeoutMs: cfg.routerTimeoutMs,
        });
        if (suggestedTier) core.info(`Local-LLM tier suggestion: ${suggestedTier} (task: "${userMessage.slice(0, 40)}")`);
      } catch (e) { core.warning(`Tier suggest failed: ${e}`); }
    }
    const requestedTier = suggestedTier ?? parsedTier;
    const modelTier = requestedTier;
    const selectedModel = MODELS[modelTier];
    const tierNotice = "";
    const route = await routeEventWithLocalLLM(userMessage, modelTier, {
      url: routerUrl,
      model: routerModel,
      timeoutMs: 5000,
    });

    core.info(`Triggered by @${sender} in #${issueNumber}`);
    core.info(`Router: ${route.intent} -> ${route.decision} (${route.reason}, confidence ${route.confidence})`);
    const runId = `${owner}/${repo}#${issueNumber}-${Date.now()}`;
    const startTime = Date.now();
    logRouterDecision(auditDb, {
      repo: `${owner}/${repo}`, prNumber: issueNumber, commentId, sender, route,
    });

    if (route.decision === "stop") {
      try {
        await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "+1" });
      } catch { /* */ }
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "cancelled",
      });
      core.info(`Stop handled by local router (${routerModel})`);
      return;
    }

    try {
      await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "eyes" });
    } catch { /* */ }

    // Quality signal: if sender pinged Kai on the same PR within 15 min, mark
    // the previous completed run as a follow-up (= user wasn't satisfied).
    try {
      const { previousAuditId } = detectAndRecordFollowup(auditDb, sender, `${owner}/${repo}`, issueNumber);
      if (previousAuditId) core.info(`Follow-up detected; flagged audit #${previousAuditId}`);
    } catch (e) { core.warning(`Follow-up detection failed: ${e}`); }

    auditLog(auditDb, {
      sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
      model: selectedModel.label, message: rawMessage, status: "started",
    });
    sessionStart(auditDb, {
      runId, repo: `${owner}/${repo}`, prNumber: issueNumber,
      sender, commentId, model: selectedModel.label,
    });
    sessionUpdate(auditDb, runId, "queued");

    if (route.decision === "ask-clarification") {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildRouterFooter(routerModel, durationSec);
      const { data: clarificationReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage || "(empty)"}\n\nI need a specific target and expected outcome before spending model tokens. Please include the file, failure, PR, or change you want.\n\n---\n<sub>${footer}</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", { status: "completed", replyCommentId: clarificationReply.id });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "needs-input",
      });
      return;
    }

    // Template reply served entirely by the local router — no paid model call.
    if (route.decision === "reply-template") {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildRouterFooter(routerModel, durationSec);
      const template = templateForRoute(route);
      const { data: metaReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}\n\n${template}\n\n---\n<sub>${footer}</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", { status: "completed", replyCommentId: metaReply.id });
      auditLog(auditDb, { sender, repo: `${owner}/${repo}`, prNumber: issueNumber, model: routerModel, message: rawMessage, durationMs: Date.now() - startTime, costUsd: 0, tokensIn: 0, tokensOut: 0, rtkSavings: "0.0%", status: "completed" });
      core.info(`Template reply by local router (${routerModel})`);
      return;
    }

    // Enforce request-frequency limits before any work that responds to @kai.
    const frequencyLimit = checkRateLimit(auditDb, sender, `${owner}/${repo}`, { includeCostBudget: false });
    if (!frequencyLimit.allowed) {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildRouterFooter(routerModel, durationSec);
      const { data: rlReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}\n\n⛔ Rate limit hit: ${frequencyLimit.reason}. Try again later.\n\n---\n<sub>${footer}</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", { status: "rate-limited", replyCommentId: rlReply.id });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "rate-limited", error: frequencyLimit.reason,
      });
      core.warning(`Rate-limited @${sender}: ${frequencyLimit.reason}`);
      return;
    }

    const localLookup = answerRepoLookup(userMessage);
    if (localLookup) {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = `Kai · local repo lookup · RTK 0% · CMP 0% · 0K in / 0K out · $0.0000 · 0t · ${durationSec}s · scanned ${localLookup.scannedFiles} files`;
      const { data: lookupReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}${tierNotice}\n\n${localLookup.answer}\n\n---\n<sub>${footer}</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", {
        status: "completed-local-repo-lookup",
        replyCommentId: lookupReply.id,
      });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: "local-repo-lookup", message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, rtkSavings: "0.0%", status: "completed-local-repo-lookup",
      });
      recordRateLimit(auditDb, sender, `${owner}/${repo}`, "local-repo-lookup", 0);
      core.info(`Local repo lookup hit: ${localLookup.hit.filePath}:${localLookup.hit.line} (${localLookup.hit.framework}); scanned=${localLookup.scannedFiles}`);
      return;
    }

    // Paid budget guard stays immediately before the heavy CLI path.
    const rateLimit = checkRateLimit(auditDb, sender, `${owner}/${repo}`);
    if (!rateLimit.allowed) {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildRouterFooter(routerModel, durationSec);
      const { data: rlReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}\n\n⛔ Rate limit hit: ${rateLimit.reason}. Try again later.\n\n---\n<sub>${footer}</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", { status: "rate-limited", replyCommentId: rlReply.id });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "rate-limited", error: rateLimit.reason,
      });
      core.warning(`Rate-limited @${sender}: ${rateLimit.reason}`);
      return;
    }

    // Require CLI + RTK only after no-model router/template paths are handled.
    requireClaudeCLI();
    const rtkVersion = requireRTK();
    const modeLabel = "CLI + RTK";
    core.info(`Mode: ${modeLabel} | Model: ${selectedModel.label} | RTK: ${rtkVersion}`);

    // Create working comment with initial spinner
    const { data: reply } = await octokit.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: buildHeartbeatFrame(0, 0, selectedModel.label),
    });
    replyCommentId = reply.id;
    sessionUpdate(auditDb, runId, "analyzing", { replyCommentId });

    // Get PR context
    let prTitle = "", prBody = "", filesList = "", prCommentsContext = "", prDiffDigest = "";
    let prHeadRef = "", beforeHead = "";
    let contextManifestPath = "";
    let contextHistoryPath = "";

    try {
      await safeUpdate(octokit, owner, repo, replyCommentId, buildHeartbeatFrame(1, 2, selectedModel.label));
      sessionUpdate(auditDb, runId, "analyzing");

      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: issueNumber });
      prTitle = pr.title;
      prBody = pr.body ?? "";
      prHeadRef = pr.head.ref;

      try {
        // Configure git identity; auth goes through http.extraheader so the token
        // never lands in .git/config or process argv (safer on shared runners).
        execSync(`git config user.name "kodif-ai[bot]" && git config user.email "kodif-ai[bot]@users.noreply.github.com"`, {
          stdio: "pipe", timeout: 5000,
        });
        execSync(`git remote set-url origin https://github.com/${owner}/${repo}.git`, {
          stdio: "pipe", timeout: 5000,
        });
        beforeHead = gitOutput("git rev-parse HEAD");
        core.info(`Current HEAD: ${beforeHead.slice(0, 7)}`);
      } catch (e: unknown) {
        core.warning(`Could not get git HEAD: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }

      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: issueNumber, per_page: 100 });
      // Compact: "file.py +67/-0" instead of "- file.py (+67/-0) [added]"
      filesList = files.map((f: { filename: string; additions: number; deletions: number }) =>
        `${f.filename} +${f.additions}/-${f.deletions}`).join("\n");
      prDiffDigest = await getPullRequestDiffDigest(octokit, owner, repo, issueNumber, MAX_DIFF_CHARS);
      if (prDiffDigest) core.info(`PR API diff digest attached: ${prDiffDigest.length} chars`);

      const commentWindow = route.intent === "simple-answer" ? 2 : route.commitExpected ? 3 : 5;
      const commentChars = route.intent === "simple-answer" ? 160 : 220;
      prCommentsContext = await getPRCommentsContext(octokit, owner, repo, issueNumber, commentWindow, commentChars);
      sessionUpdate(auditDb, runId, "context-loaded");
    } catch (e: unknown) {
      core.warning(`PR context error: ${e instanceof Error ? e.message : e}`);
    }

    try {
      const contextPack = createDynamicContextPack({
        runId,
        owner,
        repo,
        issueNumber,
        userMessage,
        rawMessage,
        route,
        prTitle,
        prBody,
        filesList,
        prCommentsContext,
        prDiffDigest,
        repoFullName: `${owner}/${repo}`,
        architectureContext: isArchitectureQuestion(userMessage) ? KODIF_ARCH_CONTEXT : undefined,
      });
      contextManifestPath = contextPack.manifestPath;
      contextHistoryPath = contextPack.historyPath;
      appendContextHistory(contextHistoryPath, "routing", {
        intent: route.intent,
        decision: route.decision,
        source: route.source ?? "unknown",
      });
    } catch (e: unknown) {
      core.warning(`Context pack build failed: ${e instanceof Error ? e.message : String(e)}`);
      logErrorToSentry(e, {
        subsystem: "dynamic-context-pack",
        owner,
        repo,
        issueNumber,
      });
    }

    // Call Claude CLI with heartbeat + retry
    let result = "";
    let footer = "";
    let escalationNotice = "";

    if (!anthropicApiKey) {
      result = `📋 **PR: ${prTitle}**\n\nFiles:\n${filesList}`;
      footer = `_Add \`ANTHROPIC_API_KEY\` for AI analysis._`;
    } else {
      sessionUpdate(auditDb, runId, "executing");
      await safeUpdate(octokit, owner, repo, replyCommentId, buildHeartbeatFrame(2, 5, selectedModel.label));

    // Hide infrastructure files from Claude — bot should only see project code
      try {
        execSync(`printf '%s\n' '.github/' '.claude/' 'CLAUDE.md' '*.yml' '*.yaml' > .claudeignore`, {
          stdio: "pipe", timeout: 5000,
        });
      } catch { /* non-critical */ }

      // File-focus pre-step: for big PRs, ask local LLM which 3-5 files matter
      // most for this task. Claude reads fewer files → fewer tokens. Best-effort
      // — empty list just means Claude picks files itself.
      let focusedFiles: string[] = [];
      if (compressorUrl && filesList && !isArchitectureQuestion(userMessage)) {
        try {
          focusedFiles = await selectRelevantFiles(userMessage, filesList, {
            url: compressorUrl, model: compressorModel, timeoutMs: cfg.routerTimeoutMs, maxFiles: 5,
          });
          if (focusedFiles.length) core.info(`File focus: ${focusedFiles.join(", ")}`);
        } catch (e) { core.warning(`File focus failed: ${e}`); }
      }

      // API diff is authoritative for PR comments because issue_comment checks
      // out the default branch. Local git diff is only a best-effort fallback.
      if (!prDiffDigest && beforeHead) {
        prDiffDigest = getPrDiffDigest();
        if (prDiffDigest) core.info(`Local PR diff digest attached: ${prDiffDigest.length} chars`);
      }

      const prompt = contextManifestPath
        ? buildDynamicPromptFromManifest(
          userMessage,
          `${owner}/${repo}`,
          route,
          contextManifestPath,
          isArchitectureQuestion(userMessage),
          prDiffDigest,
        )
        : buildCLIPrompt(userMessage, prTitle, prBody, filesList, prCommentsContext, `${owner}/${repo}`, route, focusedFiles, prDiffDigest);

      // Dedup: if the identical finalPrompt was answered for this PR in the last
      // 24h, return the cached reply without touching Claude (0 tokens). Hash
      // covers task + files + comments, so any change invalidates naturally.
      const cached = lookupCachedReply(auditDb, prompt, `${owner}/${repo}`, issueNumber);
      if (cached) {
        const aid = latestAuditId(auditDb, sender, `${owner}/${repo}`, issueNumber);
        if (aid != null) recordCacheHit(auditDb, aid);
        const durationSec = Math.round((Date.now() - startTime) / 1000);
        const cacheFooter = `Kai · cache hit · 0K in / 0K out · $0.0000 · 0t · ${durationSec}s · deeper analysis: use sonnet / use opus`;
        await safeUpdate(octokit, owner, repo, replyCommentId,
          `> @${sender}: ${rawMessage}${tierNotice}\n\n♻️ **Cached reply** (${cached.created_at}, same prompt within 24h):\n\n${cached.reply}\n\n---\n<sub>${cacheFooter}</sub>`);
        sessionUpdate(auditDb, runId, "completed", { status: "completed-cached" });
        auditLog(auditDb, {
          sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
          model: selectedModel.label, message: rawMessage, durationMs: Date.now() - startTime,
          costUsd: 0, tokensIn: 0, tokensOut: 0, rtkSavings: "100%", status: "completed-cached",
        });
        return;
      }
      if (contextHistoryPath) {
        appendContextHistory(contextHistoryPath, "prompt-built", {
          promptTokens: estimateTokens(prompt),
          dynamicManifest: contextManifestPath || null,
        });
      }
      let finalPrompt = prompt;
      let cmpSavings = "0%";
      try {
        const compressed = await compressPromptWithQwen(prompt, userMessage, modelTier, {
          url: compressorUrl,
          model: compressorModel,
          timeoutMs: cfg.compressorTimeoutMs,
          disabled: compressorDisabled,
          minQueryTokens: compressorMinQueryTokens,
          minPromptTokens: compressorMinPromptTokens,
          budgetByTier: {
            haiku: cfg.compressorBudgetHaiku,
            sonnet: cfg.compressorBudgetSonnet,
            opus: cfg.compressorBudgetOpus,
          },
        });
        finalPrompt = compressed.prompt;
        cmpSavings = `${compressed.metrics.cmpPct}%`;
        core.info(`Context compression: ${compressed.metrics.rawTokens} -> ${compressed.metrics.compressedTokens} tokens (${cmpSavings}, model=${compressed.metrics.usedModel})`);
        logContextOptimization(auditDb, {
          repo: `${owner}/${repo}`,
          prNumber: issueNumber,
          runId,
          modelTier,
          rawPromptTokens: compressed.metrics.rawTokens,
          compressedPromptTokens: compressed.metrics.compressedTokens,
          cmpPct: compressed.metrics.cmpPct,
          usedModel: compressed.metrics.usedModel,
          durationMs: compressed.metrics.durationMs,
        });
        if (contextHistoryPath) {
          appendContextHistory(contextHistoryPath, "compression", {
            cmpPct: compressed.metrics.cmpPct,
            rawTokens: compressed.metrics.rawTokens,
            compressedTokens: compressed.metrics.compressedTokens,
            usedModel: compressed.metrics.usedModel,
          });
        }
      } catch (compressionError) {
        const compressionErrorMessage = compressionError instanceof Error ? compressionError.message : String(compressionError);
        core.error(`Context compression failed: ${compressionErrorMessage}`);
        if (contextHistoryPath) {
          appendContextHistory(contextHistoryPath, "compression-failed", {
            reason: compressionErrorMessage,
          });
        }
        logErrorToSentry(compressionError, {
          subsystem: "context-compressor",
          owner,
          repo,
          issueNumber,
          modelTier,
        });
        throw new Error(`context compression is required but failed: ${compressionErrorMessage}`);
      }
      // FIRST LAW: single place that enforces budget before any external API
      // call. Runs all per-tier, prompt-size, and worst-case cost checks.
      // Token count is authoritative via Anthropic's /v1/messages/count_tokens
      // endpoint; on failure it falls back to the character-ratio heuristic so
      // preflight never hard-fails on a transient network blip.
      const tokenCount = await countInputTokens(anthropicApiKey, selectedModel.id, finalPrompt);
      const finalPromptTokens = tokenCount.tokens;
      core.info(`Prompt tokens: ${finalPromptTokens} (source: ${tokenCount.source}, ${tokenCount.durationMs}ms)`);
      let activeTier = modelTier;
      let activeModel = selectedModel;
      let preflight = preflightBudget(userMessage, finalPromptTokens, activeTier);

      // Auto-escalation: if haiku budget is exceeded, try sonnet, then opus.
      if (!preflight.allowed && preflight.kind === "cost-over-cap") {
        for (const candidateTier of escalationTierSequence(activeTier)) {
          const candidate = preflightBudget(userMessage, finalPromptTokens, candidateTier);
          if (candidate.allowed) {
            escalationNotice = `\n\n> _Budget for **${activeTier}** exceeded (${finalPromptTokens} tokens). Auto-escalated to **${candidateTier}**._`;
            core.warning(`Auto-escalated ${activeTier}→${candidateTier}: ${preflight.reason}`);
            auditLog(auditDb, {
              sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
              model: `escalated-${activeTier}-to-${candidateTier}`, message: rawMessage,
              durationMs: Date.now() - startTime,
              costUsd: 0, tokensIn: finalPromptTokens, tokensOut: 0,
              status: "escalated", error: preflight.reason,
            });
            await safeUpdate(octokit, owner, repo, replyCommentId,
              buildHeartbeatFrame(2, Math.round((Date.now() - startTime) / 1000), MODELS[candidateTier].label));
            activeTier = candidateTier;
            activeModel = MODELS[candidateTier];
            preflight = candidate;
            break;
          }
        }
      }

      if (!preflight.allowed) {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const hint = preflight.kind === "hard-ceiling"
          ? `Prompt (${finalPromptTokens} tokens) exceeds the ${MAX_PROMPT_TOKENS}-token hard ceiling. Split the request into smaller tasks.`
          : escalationTierSequence(modelTier).length === 0
            ? `Even the highest tier cannot handle this prompt size. Reduce context.`
            : `Even the highest tier that passed budget checks cannot handle this prompt size. Reduce context.`;
        result = `⛔ Pre-flight refused: ${preflight.reason}.\n\n${hint}`;
        footer = `Kai · preflight-refused · 0K in / 0K out · $0.0000 · 0t · ${elapsedSec}s`;
        auditLog(auditDb, {
          sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
          model: "preflight-refused", message: rawMessage,
          durationMs: Date.now() - startTime,
          costUsd: 0, tokensIn: finalPromptTokens, tokensOut: 0,
          status: "refused-pre-flight", error: preflight.reason,
        });
        try {
          await octokit.issues.getComment({ owner, repo, comment_id: replyCommentId });
        } catch {
          return;
        }
        await safeUpdate(octokit, owner, repo, replyCommentId,
          `> @${sender}: ${rawMessage}${tierNotice}${escalationNotice}\n\n${result}\n\n---\n<sub>${footer}</sub>`);
        sessionUpdate(auditDb, runId, "completed", { status: "refused-pre-flight" });
        core.warning(`Pre-flight refused paid call: ${preflight.reason}`);
        return;
      }

      const maxTurns = getMaxTurns(userMessage, activeTier);
      core.info(`Max turns: ${maxTurns} (task: "${userMessage.slice(0, 40)}")`);
      const heartbeatCtx: HeartbeatContext = {
        octokit, owner, repo, replyCommentId, sender, modelLabel: activeModel.label,
      };

      const disallowed = disallowedToolsFor(userMessage);
      if (disallowed.length) core.info(`Gated tools: ${disallowed.join(",")}`);
      const r = await callClaudeCLIWithHeartbeat(
        anthropicApiKey, activeModel.id, finalPrompt, maxTurns, heartbeatCtx, auditDb, runId, activeTier, disallowed);
      result = r.text;
      let commitVerifiedOutcome: boolean | null = null;
      try {
        const note = commitVerificationNote(userMessage, beforeHead, prHeadRef, githubToken);
        result += note;
        if (shouldVerifyCommit(userMessage)) {
          commitVerifiedOutcome = note.includes("Commit verification:") && !note.includes("failed");
        }
      } catch (e: unknown) {
        const verifyError = e instanceof Error ? e.message.slice(0, 500) : String(e);
        core.error(`Commit verification failed: ${verifyError}`);
        result += `\n\n**Commit verification failed:** ${verifyError}`;
        commitVerifiedOutcome = false;
      }

      const durationMs = Date.now() - startTime;
      // r.rtkSavings is always a non-empty string: either a measured percent
      // like "41.0%", the sentinel "0.0%" (measured zero = bypass), or the
      // sentinel "n/a" (not tracked — rtk binary missing or output unparseable).
      const rtkPct = r.rtkSavings;
      const rtkBypassed = r.rtkSavings === "0.0%"; // Only warn on measured zero, not unavailable
      if (rtkBypassed) {
        core.error(`CRITICAL: RTK savings = 0% — RTK was bypassed or tracking is broken. Check /home/kai/.local/share/rtk/history.db`);
        result += `\n\n> ⚠️ **RTK bypassed** — no token savings recorded for this call. Operator: verify hook in \`$HOME/.claude/settings.json\`.`;
      }
      const costCap = MAX_COST_USD_BY_TIER[modelTier] ?? MAX_COST_USD_BY_TIER.haiku;
      const costOverCap = r.costUsd > costCap;
      if (costOverCap) {
        // Cost limits are enforced before the request. Once a paid call already
        // happened, we must still deliver the best available answer instead of
        // turning a paid result into a user-visible failure.
        core.error(`Post-call cost over cap: $${r.costUsd.toFixed(4)} > $${costCap} (${modelTier})`);
      }
      const durationSec = Math.round(durationMs / 1000);
      footer = buildFooter(
        activeModel.label, rtkPct, cmpSavings, r.inputTokens, r.outputTokens,
        r.costUsd, r.numTurns, durationSec, r.cacheReadTokens);

      const finalStatus = costOverCap
        ? "completed-cost-over-cap"
        : r.rtkSavings === "0.0%" ? "completed-rtk-bypass" : "completed";
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: activeModel.label, message: rawMessage, durationMs,
        costUsd: r.costUsd, tokensIn: r.inputTokens, tokensOut: r.outputTokens,
        rtkSavings: rtkPct, status: finalStatus,
      });
      recordRateLimit(auditDb, sender, `${owner}/${repo}`, activeTier, r.costUsd);

      // Link quality signals to the just-inserted audit row, and remember the
      // reply for 24h so an identical follow-up hits dedup cache.
      const newAuditId = latestAuditId(auditDb, sender, `${owner}/${repo}`, issueNumber);
      if (newAuditId != null && commitVerifiedOutcome !== null) {
        try { recordCommitVerification(auditDb, newAuditId, commitVerifiedOutcome); }
        catch (e) { core.warning(`Quality link failed: ${e}`); }
      }
      if (!costOverCap && !rtkBypassed && result.trim()) {
        try { storeCachedReply(auditDb, finalPrompt, `${owner}/${repo}`, issueNumber, sender, result, r.costUsd); }
        catch (e) { core.warning(`Cache store failed: ${e}`); }
      }
    }

    try {
      await octokit.issues.getComment({ owner, repo, comment_id: replyCommentId });
    } catch {
      core.info("Cancelled");
      return;
    }

    sessionUpdate(auditDb, runId, "responding");
    await safeUpdate(octokit, owner, repo, replyCommentId,
      `> @${sender}: ${rawMessage}${tierNotice}${escalationNotice}\n\n${result}\n\n---\n<sub>${footer}</sub>`);
    sessionUpdate(auditDb, runId, "completed", { status: "completed" });

    core.info("Done");
  } catch (error) {
    // Global error handler — ALWAYS post error to PR, never silently crash
    const msg = error instanceof Error ? error.message : String(error);
    log.error("kai-action failed", { ...errorMeta(error), message: msg, owner, repo, sender });
    logErrorToSentry(error, {
      subsystem: "kai-action-run",
      owner,
      repo,
      sender,
    });

    // Audit: log error
    try {
      const db = initAuditDb(process.env.KAI_AUDIT_DB || "/home/kai/data/kai-audit.db");
      auditLog(db, {
        sender: sender || "unknown", repo: owner && repo ? `${owner}/${repo}` : "unknown",
        prNumber: 0, model: "unknown", message: rawMessage,
        status: "error", error: msg.slice(0, 500),
      });
    } catch { /* audit itself should never crash the handler */ }

    if (octokit && owner && repo) {
      const routerHint = msg.includes("local router")
        ? "\n\n**Root cause (captured from runner):** the LLM containers are unreachable AND the runner user cannot access `/var/run/docker.sock` to restart them (owned `root:992`, runner user `kai` only in group `1001`).\n\n**Operator fix — one of:**\n1. Rebuild runner image with `usermod -aG 992 kai` (or `--group-add 992` in `docker run`).\n2. Or make the runner LLM containers restart themselves via `restart: always` in docker-compose + a host-level watchdog.\n3. Or expose a small privileged sidecar that restarts siblings; give `kai` user access to that control plane instead of the docker socket."
        : "";
      const errorBody = `> @${sender}: ${rawMessage || "(trigger)"}\n\n⚠️ **Kai error:**\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`${routerHint}\n\nCheck runner logs or contact infra team.\n\n---\n<sub>Kai (Kodif AI)</sub>`;
      try {
        if (replyCommentId) {
          await safeUpdate(octokit, owner, repo, replyCommentId, errorBody);
        } else {
          // Reply comment wasn't created yet — post a new one
          const issueNumber = github.context.payload.issue?.number ?? github.context.payload.pull_request?.number ?? 0;
          if (issueNumber) {
            await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: errorBody });
          }
        }
      } catch (postErr) {
        core.error(`Failed to post error to PR: ${postErr}`);
      }
    }

    await attemptInfrastructureRecovery(msg);
    core.setFailed(msg);
  }
}

process.on("uncaughtException", (err) => {
  core.error(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
});

process.on("unhandledRejection", (err) => {
  core.error(`unhandledRejection: ${err instanceof Error ? err.message : String(err)}`);
});

run().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  await attemptInfrastructureRecovery(msg);
  core.setFailed(msg);
});
