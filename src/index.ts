import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { isMetaQuestion, routeEvent, shouldVerifyCommit, type RouterDecision } from "./router";
import { templateForRoute } from "./templates";

// --- Audit DB (SQLite, persistent via Docker volume) ---

const AUDIT_DB_PATH = process.env.KAI_AUDIT_DB || "/home/kai/data/kai-audit.db";

function initAuditDb(): DatabaseSync {
  try { mkdirSync("/home/kai/data", { recursive: true }); } catch { /* */ }
  const db = new DatabaseSync(AUDIT_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      sender TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      model TEXT NOT NULL,
      message TEXT,
      duration_ms INTEGER,
      cost_usd REAL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      rtk_savings TEXT,
      status TEXT DEFAULT 'started',
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT UNIQUE NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      sender TEXT NOT NULL,
      comment_id INTEGER NOT NULL,
      reply_comment_id INTEGER,
      model TEXT NOT NULL,
      phase TEXT DEFAULT 'init',
      attempt INTEGER DEFAULT 1,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT DEFAULT 'running',
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS router_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      intent TEXT NOT NULL,
      decision TEXT NOT NULL,
      confidence REAL NOT NULL,
      model_tier TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      reason TEXT
    )
  `);
  return db;
}

function sessionStart(db: DatabaseSync, data: {
  runId: string; repo: string; prNumber: number; sender: string;
  commentId: number; model: string;
}) {
  try {
    db.prepare(`INSERT OR REPLACE INTO sessions (run_id, repo, pr_number, sender, comment_id, model, status, phase)
      VALUES (?, ?, ?, ?, ?, ?, 'running', 'init')`).run(
      data.runId, data.repo, data.prNumber, data.sender, data.commentId, data.model);
  } catch (e) { core.warning(`Session start failed: ${e}`); }
}

function sessionUpdate(db: DatabaseSync, runId: string, phase: string, extra?: { replyCommentId?: number; attempt?: number; status?: string; error?: string }) {
  try {
    const sets = [`phase = ?`, `last_heartbeat = datetime('now')`];
    const params: unknown[] = [phase];
    if (extra?.replyCommentId) { sets.push(`reply_comment_id = ?`); params.push(extra.replyCommentId); }
    if (extra?.attempt) { sets.push(`attempt = ?`); params.push(extra.attempt); }
    if (extra?.status) { sets.push(`status = ?`); params.push(extra.status); }
    if (extra?.error) { sets.push(`error = ?`); params.push(extra.error); }
    if (extra?.status === "completed" || extra?.status === "failed") { sets.push(`finished_at = datetime('now')`); }
    params.push(runId);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE run_id = ?`).run(...params);
  } catch (e) { core.warning(`Session update failed: ${e}`); }
}

function auditLog(db: DatabaseSync, data: {
  sender: string; repo: string; prNumber: number; model: string;
  message?: string; durationMs?: number; costUsd?: number;
  tokensIn?: number; tokensOut?: number; rtkSavings?: string;
  status?: string; error?: string;
}) {
  try {
    db.prepare(`
      INSERT INTO audit_log (sender, repo, pr_number, model, message, duration_ms, cost_usd, tokens_in, tokens_out, rtk_savings, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.sender, data.repo, data.prNumber, data.model,
      data.message ?? null, data.durationMs ?? null, data.costUsd ?? null,
      data.tokensIn ?? null, data.tokensOut ?? null, data.rtkSavings ?? null,
      data.status ?? "started", data.error ?? null,
    );
  } catch (e) {
    core.warning(`Audit log failed: ${e}`);
  }
}

function logRouterDecision(db: DatabaseSync, data: {
  repo: string; prNumber: number; commentId: number; sender: string; route: RouterDecision;
}) {
  try {
    db.prepare(`
      INSERT INTO router_decisions (repo, pr_number, comment_id, sender, intent, decision, confidence, model_tier, estimated_tokens, estimated_cost_usd, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.repo, data.prNumber, data.commentId, data.sender,
      data.route.intent, data.route.decision, data.route.confidence,
      data.route.modelTier, data.route.estimatedTokens, data.route.estimatedCostUsd,
      data.route.reason,
    );
  } catch (e) {
    core.warning(`Router decision log failed: ${e}`);
  }
}

// --- PR Comments Context ---

async function getPRCommentsContext(
  octokit: Octokit, owner: string, repo: string, issueNumber: number,
  maxComments = 5,
  maxChars = 200,
): Promise<string> {
  try {
    const { data: comments } = await octokit.issues.listComments({
      owner, repo, issue_number: issueNumber, per_page: 30,
    });
    // Keep the newest compact comments only — minimize context tokens.
    const recent = comments.slice(-maxComments);
    if (recent.length === 0) return "";
    return recent.map(c => {
      const who = c.user?.login ?? "?";
      const body = (c.body ?? "").slice(0, maxChars).replace(/\n/g, " ");
      return `${who}: ${body}`;
    }).join("\n");
  } catch {
    return "";
  }
}

// --- Models ---

const MODELS: Record<string, { id: string; label: string }> = {
  haiku:  { id: "claude-haiku-4-5-20251001",  label: "Haiku" },
  sonnet: { id: "claude-sonnet-4-20250514",    label: "Sonnet" },
  opus:   { id: "claude-opus-4-20250514",      label: "Opus" },
};
const DEFAULT_MODEL = "haiku";

function parseModelFromMessage(message: string): { model: string; cleanMessage: string } {
  for (const tier of ["opus", "sonnet", "haiku"]) {
    const pattern = new RegExp(`use\\s+${tier}`, "i");
    if (pattern.test(message)) {
      return { model: tier, cleanMessage: message.replace(pattern, "").trim() || "review this PR" };
    }
  }
  return { model: DEFAULT_MODEL, cleanMessage: message };
}

function requireClaudeCLI(): void {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
  } catch {
    throw new Error("Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code");
  }
}

function requireRTK(): string {
  // RTK is mandatory — running without it wastes money
  try {
    const ver = execSync("rtk --version", { stdio: "pipe", timeout: 5000, encoding: "utf-8" }).trim();
    // Verify it's rtk-ai/rtk by checking help output mentions 'rewrite'
    const help = execSync("rtk --help", { stdio: "pipe", timeout: 5000, encoding: "utf-8" });
    if (!help.includes("rewrite")) {
      throw new Error("Wrong rtk binary (missing 'rewrite' command). Need rtk-ai/rtk, not crates.io rtk.");
    }
    core.info(`RTK verified: ${ver}`);
    return ver;
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Wrong rtk")) throw e;
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    throw new Error(`RTK is required but not available: ${msg}`);
  }
}

// --- Claude Code CLI execution (with RTK hooks) ---

interface CLIResult {
  text: string;
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rtkSavings: string;
}

// Kodif architecture context — injected when user asks about architecture
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

function buildFooter(
  modelLabel: string,
  rtkSavings: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  numTurns: number,
  durationSec: number,
  cacheReadTokens = 0,
): string {
  const inK = Math.round(inputTokens / 1000);
  const outK = Math.round(outputTokens / 1000);
  const cachePct = inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 100) : 0;
  const cacheTag = cachePct > 0 ? ` · cache ${cachePct}%` : "";
  return `Kai · ${modelLabel} · [RTK](https://github.com/rtk-ai/rtk) ${rtkSavings}${cacheTag} · ${inK}K in / ${outK}K out · $${costUsd.toFixed(4)} · ${numTurns}t · ${durationSec}s · deeper analysis: use sonnet / use opus`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitOutput(command: string): string {
  return execSync(command, { stdio: "pipe", timeout: 30_000, encoding: "utf-8" }).trim();
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

function commitVerificationNote(userMessage: string, beforeHead: string, branch: string): string {
  if (!shouldVerifyCommit(userMessage) || !beforeHead || !branch) return "";

  const quotedBranch = shellQuote(branch);
  try {
    execSync("git reset -- .claudeignore && rm -f .claudeignore", { stdio: "pipe", timeout: 5000 });
  } catch { /* best-effort cleanup for bot-only ignore file */ }

  const afterHeadBeforeCommit = gitOutput("git rev-parse HEAD");
  if (afterHeadBeforeCommit !== beforeHead) {
    stripProviderCoAuthorFromHead();
    const amendedHead = gitOutput("git rev-parse HEAD");
    core.info(`Commit requested — pushing existing commit ${amendedHead.slice(0, 7)} to ${branch}`);
    execSync(`git push origin HEAD:${quotedBranch}`, { stdio: "pipe", timeout: 60_000 });
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
    execSync(`git push origin HEAD:${quotedBranch}`, { stdio: "pipe", timeout: 60_000 });
    return `\n\n**Commit verification:** pushed \`${amendedHead.slice(0, 7)}\` to \`${branch}\`.`;
  }

  core.warning("Commit requested but no commit was created and worktree is clean");
  return `\n\n**Commit verification failed:** no file changes or new commit were found after the requested work. Nothing was pushed.`;
}

function buildCLIPrompt(
  userMessage: string, prTitle: string, prBody: string,
  filesList: string, prCommentsContext: string, repoFullName: string,
  route: RouterDecision,
): string {
  const parts = [
    `Kai, AI code reviewer. Service: repos/${repoFullName.split("/").pop()}. PR: "${prTitle}"`,
    `Router: intent=${route.intent}; confidence=${route.confidence}; contextBudget=${route.maxContextTokens}; commitExpected=${route.commitExpected}`,
    prBody ? `Desc: ${prBody.slice(0, 300)}` : "",
    `Files:\n${filesList}`,
  ];
  if (prCommentsContext) {
    parts.push(`Prior conversation:\n${prCommentsContext}`);
  }
  if (isMetaQuestion(userMessage)) {
    // Meta question — return fixed template, no CLI needed
    return META_TEMPLATE;
  }
  if (isArchitectureQuestion(userMessage)) {
    parts.push(
      `IMPORTANT: Answer about Kodif platform architecture, NOT about the PR code:`,
      KODIF_ARCH_CONTEXT,
      `Task: ${userMessage}`,
      `Rules: concise, markdown, max 50 lines. Focus on architecture, services, connections.`,
    );
  } else {
    parts.push(
      `PR repo checked out in current dir. Use git diff origin/main...HEAD and Read to inspect PROJECT code only.`,
      `Kodif repos available at /home/kai/architect/repos/ (read-only). Use for cross-service context.`,
      `IGNORE: .github/, .claude/, CLAUDE.md, *.yml workflow files — these are bot infrastructure, not project code.`,
      `Task: ${userMessage}`,
      `Success criteria: satisfy the task, stay within the selected context, and report concrete evidence.`,
      `IMPORTANT: Answer EXACTLY what the user asked. Do NOT default to security review unless explicitly asked.`,
      `Rules: concise, markdown, repos/<service>/path/file.py:line refs, max 50 lines. Don't repeat prior analysis.`,
      `For imperative write tasks (fix/add/update/create/patch/refactor/document), commit and push the change to the PR branch unless the user explicitly asks not to.`,
      `Git commits: NEVER add Co-Authored-By headers or AI provider attribution. Author is already set to kodif-ai[bot].`,
    );
  }
  return parts.filter(Boolean).join("\n");
}

// Smart max_turns based on task complexity
function getMaxTurns(message: string, modelTier: string): number {
  if (modelTier === "opus") return 25;
  if (modelTier === "sonnet") return 20;
  // Haiku: scale by task type
  const needsWrite = /fix|commit|push|apply|create|patch|refactor/i.test(message);
  if (needsWrite) return 20; // write tasks need more turns
  const simple = /^(top|list|one-liner|quick|is this|what|summarize)/i.test(message);
  return simple ? 5 : 10;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const CLI_TIMEOUT_MS = 300_000;
const MAX_CLI_RETRIES = 3;
const RETRY_DELAYS = [15_000, 30_000, 60_000]; // exponential: 15s, 30s, 60s

const LOADING_GIF = "https://emojis.slackmojis.com/emojis/images/1643514453/4358/loading.gif?1643514453";

const PHASES = [
  "Reading PR context",
  "Loading conversation history",
  "Analyzing code changes",
  "Running security checks",
  "Inspecting files",
  "Preparing response",
];

function spinnerFrame(_tick: number, elapsed: number, _modelLabel: string): string {
  const phase = PHASES[Math.min(Math.floor(elapsed / 10), PHASES.length - 1)];
  return `<img src="${LOADING_GIF}" width="20" height="20"> ${phase}...\n\n_Delete this comment to cancel._`;
}

interface HeartbeatContext {
  octokit: Octokit; owner: string; repo: string;
  replyCommentId: number; sender: string; modelLabel: string;
}

async function callClaudeCLIWithHeartbeat(
  apiKey: string, modelId: string, prompt: string, maxTurns: number,
  heartbeat: HeartbeatContext,
  db: DatabaseSync, runId: string,
): Promise<CLIResult> {
  const isRoot = process.getuid?.() === 0;

  for (let attempt = 1; attempt <= MAX_CLI_RETRIES; attempt++) {
    sessionUpdate(db, runId, `cli-attempt-${attempt}`, { attempt });

    if (attempt > 1) {
      const delay = RETRY_DELAYS[attempt - 2] ?? 60_000;
      core.info(`Retry ${attempt}/${MAX_CLI_RETRIES} in ${delay / 1000}s`);
      await safeUpdate(heartbeat.octokit, heartbeat.owner, heartbeat.repo, heartbeat.replyCommentId,
        `> ⚠️ Retrying (attempt ${attempt}/${MAX_CLI_RETRIES})...\n\n🔄 Previous attempt failed, waiting ${delay / 1000}s before retry\n🔍 **${heartbeat.modelLabel}**\n\n_Delete this comment to cancel._`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await runCLIWithHeartbeat(apiKey, modelId, prompt, maxTurns, isRoot, heartbeat, db, runId);
      sessionUpdate(db, runId, "completed", { status: "completed" });
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      core.warning(`CLI attempt ${attempt} failed: ${msg}`);
      sessionUpdate(db, runId, `failed-attempt-${attempt}`, { error: msg });

      if (attempt === MAX_CLI_RETRIES) {
        sessionUpdate(db, runId, "failed", { status: "failed", error: msg });
        throw e;
      }
    }
  }
  throw new Error("All CLI retries exhausted");
}

function runCLIWithHeartbeat(
  apiKey: string, modelId: string, prompt: string, maxTurns: number, isRoot: boolean,
  hb: HeartbeatContext, db: DatabaseSync, runId: string,
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const claudeArgs = ["-p", "--dangerously-skip-permissions", "--output-format", "json", "--max-turns", String(maxTurns), "--model", modelId];
    const startTime = Date.now();
    let output = "";
    let settled = false; // guard against double resolve/reject

    core.info(`Executing: claude CLI (${modelId})`);

    let child: ReturnType<typeof spawn>;
    if (isRoot) {
      child = spawn("su", ["-s", "/bin/bash", "kai", "-c", `ANTHROPIC_API_KEY=${apiKey} claude ${claudeArgs.join(" ")}`], {
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      });
    } else {
      child = spawn("claude", claudeArgs, {
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      });
    }

    // Send prompt to stdin
    child.stdin?.write(prompt);
    child.stdin?.end();

    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { core.info(`CLI stderr: ${data.toString().slice(0, 200)}`); });

    // Heartbeat: every 15s update comment with animated spinner
    let tick = 0;
    const heartbeatTimer = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      tick++;
      sessionUpdate(db, runId, "running");

      // Check if comment still exists (user cancel)
      const exists = await commentExists(hb.octokit, hb.owner, hb.repo, hb.replyCommentId);
      if (!exists) {
        core.info("Comment deleted — killing CLI");
        child.kill("SIGTERM");
        clearInterval(heartbeatTimer);
        if (!settled) { settled = true; reject(new Error("Cancelled by user")); }
        return;
      }

      await safeUpdate(hb.octokit, hb.owner, hb.repo, hb.replyCommentId,
        spinnerFrame(tick, elapsed, hb.modelLabel));
    }, HEARTBEAT_INTERVAL_MS);

    // Timeout
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
        const json = JSON.parse(output);

        // Get RTK savings — parse "Tokens saved: 1.5M (68.2%)" from rtk gain
        let rtkSavings = "";
        try {
          const gainCmd = isRoot
            ? `su -s /bin/bash kai -c 'rtk gain 2>/dev/null'`
            : `rtk gain 2>/dev/null`;
          const raw = execSync(gainCmd, { encoding: "utf-8", timeout: 5000 }).trim();
          const m = raw.match(/Tokens saved:.*?\((\d+(?:\.\d+)?)%\)/);
          rtkSavings = m ? m[1] + "%" : "";
        } catch { /* */ }

        // Handle error responses (max_turns, etc) — don't show raw JSON
        let resultText = json.result ?? json.content ?? "";
        if (!resultText && json.is_error) {
          resultText = `⚠️ Task incomplete (${json.subtype ?? "error"}): reached ${json.num_turns ?? "?"} turns. Ask me to continue or simplify the request.`;
        }
        if (!resultText) resultText = output;

        const cacheRead = json.usage?.cache_read_input_tokens ?? 0;
        const cacheWrite = json.usage?.cache_creation_input_tokens ?? 0;
        const freshInput = json.usage?.input_tokens ?? 0;

        settled = true;
        resolve({
          text: resultText,
          costUsd: json.total_cost_usd ?? json.cost_usd ?? 0,
          numTurns: json.num_turns ?? 1,
          inputTokens: freshInput + cacheRead + cacheWrite,
          outputTokens: json.usage?.output_tokens ?? 0,
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

// --- Main with global error handler ---

async function run() {
  // These are set early so the global error handler can post to PR
  let octokit: Octokit | null = null;
  let owner = "", repo = "", replyCommentId = 0;
  let sender = "", rawMessage = "";

  try {
    const trigger = core.getInput("trigger_phrase") || "@kai";
    const githubToken = core.getInput("github_token");
    const anthropicApiKey = core.getInput("anthropic_api_key");

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

    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    rawMessage = commentBody.slice(idx + trigger.length).trim();
    const { model: modelTier, cleanMessage: userMessage } = parseModelFromMessage(rawMessage);
    const selectedModel = MODELS[modelTier];
    const route = routeEvent(userMessage, modelTier);

    core.info(`Triggered by @${sender} in #${issueNumber}`);
    core.info(`Router: ${route.intent} -> ${route.decision} (${route.reason}, confidence ${route.confidence})`);

    // Audit + Session: init DB
    const auditDb = initAuditDb();
    const runId = `${owner}/${repo}#${issueNumber}-${Date.now()}`;
    const startTime = Date.now();
    logRouterDecision(auditDb, {
      repo: `${owner}/${repo}`, prNumber: issueNumber, commentId, sender, route,
    });

    if (route.decision === "ignore") return;

    if (route.decision === "stop") {
      try {
        await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "+1" });
      } catch { /* */ }
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: "none", message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "cancelled",
      });
      core.info("Stop command handled without model call");
      return;
    }

    try {
      await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "eyes" });
    } catch { /* */ }

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
      const { data: clarificationReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage || "(empty)"}\n\nI need a specific target and expected outcome before spending model tokens. Please include the file, failure, PR, or change you want.\n\n---\n<sub>Kai · router · 0K in / 0K out · $0.0000</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", { status: "completed", replyCommentId: clarificationReply.id });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: "router", message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "needs-input",
      });
      return;
    }

    // Meta question — instant reply, no CLI needed
    if (route.decision === "reply-template") {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildFooter(selectedModel.label, "0.0%", 0, 0, 0, 0, durationSec);
      const template = templateForRoute(route);
      const { data: metaReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}\n\n${template}\n\n---\n<sub>${footer}</sub>`,
      });
      sessionUpdate(auditDb, runId, "completed", { status: "completed", replyCommentId: metaReply.id });
      auditLog(auditDb, { sender, repo: `${owner}/${repo}`, prNumber: issueNumber, model: selectedModel.label, message: rawMessage, durationMs: Date.now() - startTime, costUsd: 0, tokensIn: 0, tokensOut: 0, rtkSavings: "0.0%", status: "completed" });
      core.info("Meta question — template reply");
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
      body: spinnerFrame(0, 0, selectedModel.label),
    });
    replyCommentId = reply.id;
    sessionUpdate(auditDb, runId, "analyzing", { replyCommentId });

    // Get PR context
    let prTitle = "", prBody = "", filesList = "", prCommentsContext = "";
    let prHeadRef = "", beforeHead = "";

    try {
      await safeUpdate(octokit, owner, repo, replyCommentId, spinnerFrame(1, 2, selectedModel.label));
      sessionUpdate(auditDb, runId, "analyzing");

      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: issueNumber });
      prTitle = pr.title;
      prBody = pr.body ?? "";
      prHeadRef = pr.head.ref;

      try {
        // Configure git for push (bot identity + token auth)
        execSync(`git config user.name "kodif-ai[bot]" && git config user.email "kodif-ai[bot]@users.noreply.github.com"`, {
          stdio: "pipe", timeout: 5000,
        });
        execSync(`git remote set-url origin https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`, {
          stdio: "pipe", timeout: 5000,
        });
        execSync(`git fetch origin ${shellQuote(pr.head.ref)} && git checkout ${shellQuote(pr.head.ref)}`, {
          stdio: "pipe", timeout: 30_000, encoding: "utf-8",
        });
        beforeHead = gitOutput("git rev-parse HEAD");
        core.info(`Checked out PR branch: ${pr.head.ref} at ${beforeHead.slice(0, 7)}`);
      } catch (e: unknown) {
        core.warning(`Could not checkout PR branch: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }

      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: issueNumber, per_page: 100 });
      // Compact: "file.py +67/-0" instead of "- file.py (+67/-0) [added]"
      filesList = files.map((f: { filename: string; additions: number; deletions: number }) =>
        `${f.filename} +${f.additions}/-${f.deletions}`).join("\n");

      const commentWindow = route.intent === "simple-answer" ? 2 : route.commitExpected ? 3 : 5;
      const commentChars = route.intent === "simple-answer" ? 160 : 220;
      prCommentsContext = await getPRCommentsContext(octokit, owner, repo, issueNumber, commentWindow, commentChars);
      sessionUpdate(auditDb, runId, "context-loaded");
    } catch (e: unknown) {
      core.warning(`PR context error: ${e instanceof Error ? e.message : e}`);
    }

    // Call Claude CLI with heartbeat + retry
    let result = "";
    let footer = "";

    if (!anthropicApiKey) {
      result = `📋 **PR: ${prTitle}**\n\nFiles:\n${filesList}`;
      footer = `_Add \`ANTHROPIC_API_KEY\` for AI analysis._`;
    } else {
      sessionUpdate(auditDb, runId, "executing");
      await safeUpdate(octokit, owner, repo, replyCommentId, spinnerFrame(2, 5, selectedModel.label));

      // Hide infrastructure files from Claude — bot should only see project code
      try {
        execSync(`echo '.github/\n.claude/\nCLAUDE.md\n*.yml\n*.yaml' > .claudeignore`, {
          stdio: "pipe", timeout: 5000,
        });
      } catch { /* non-critical */ }

      const prompt = buildCLIPrompt(userMessage, prTitle, prBody, filesList, prCommentsContext, `${owner}/${repo}`, route);
      const maxTurns = getMaxTurns(userMessage, modelTier);
      core.info(`Max turns: ${maxTurns} (task: "${userMessage.slice(0, 40)}")`);
      const heartbeatCtx: HeartbeatContext = {
        octokit, owner, repo, replyCommentId, sender, modelLabel: selectedModel.label,
      };

      const r = await callClaudeCLIWithHeartbeat(
        anthropicApiKey, selectedModel.id, prompt, maxTurns, heartbeatCtx, auditDb, runId);
      result = r.text;
      try {
        result += commitVerificationNote(userMessage, beforeHead, prHeadRef);
      } catch (e: unknown) {
        const verifyError = e instanceof Error ? e.message.slice(0, 500) : String(e);
        core.error(`Commit verification failed: ${verifyError}`);
        result += `\n\n**Commit verification failed:** ${verifyError}`;
      }

      const durationMs = Date.now() - startTime;
      const rtkPct = r.rtkSavings || "— %";
      if (!r.rtkSavings || r.rtkSavings === "0.0%") {
        core.error(`CRITICAL: RTK savings empty or zero — tracking is broken. Check /home/kai/.local/share/rtk/history.db`);
      }
      const durationSec = Math.round(durationMs / 1000);
      footer = buildFooter(
        selectedModel.label, rtkPct, r.inputTokens, r.outputTokens,
        r.costUsd, r.numTurns, durationSec, r.cacheReadTokens);

      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: selectedModel.label, message: rawMessage, durationMs,
        costUsd: r.costUsd, tokensIn: r.inputTokens, tokensOut: r.outputTokens,
        rtkSavings: rtkPct, status: "completed",
      });
    }

    if (!(await commentExists(octokit, owner, repo, replyCommentId))) {
      core.info("Cancelled");
      return;
    }

    sessionUpdate(auditDb, runId, "responding");
    await safeUpdate(octokit, owner, repo, replyCommentId,
      `> @${sender}: ${rawMessage}\n\n${result}\n\n---\n<sub>${footer}</sub>`);
    sessionUpdate(auditDb, runId, "completed", { status: "completed" });

    core.info("Done");
  } catch (error) {
    // Global error handler — ALWAYS post error to PR, never silently crash
    const msg = error instanceof Error ? error.message : String(error);
    core.error(msg);

    // Audit: log error
    try {
      const db = initAuditDb();
      auditLog(db, {
        sender: sender || "unknown", repo: owner && repo ? `${owner}/${repo}` : "unknown",
        prNumber: 0, model: "unknown", message: rawMessage,
        status: "error", error: msg.slice(0, 500),
      });
    } catch { /* audit itself should never crash the handler */ }

    if (octokit && owner && repo) {
      const errorBody = `> @${sender}: ${rawMessage || "(trigger)"}\n\n⚠️ **Kai error:**\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`\n\nCheck runner logs or contact infra team.\n\n---\n<sub>Kai (Kodif AI)</sub>`;
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

    core.setFailed(msg);
  }
}

const MAX_RETRIES = 3;

function backoffMs(attempt: number): number {
  // Exponential backoff: 1s, 2s, 4s (capped)
  return Math.min(1000 * Math.pow(2, attempt), 4000);
}

async function safeUpdate(o: Octokit, owner: string, repo: string, id: number, body: string) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await o.issues.updateComment({ owner, repo, comment_id: id, body });
      return;
    } catch (err: unknown) {
      const st = (err as any)?.status ?? 0;
      if (st >= 500 && attempt < MAX_RETRIES - 1) {
        core.warning(`safeUpdate: GitHub ${st}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      core.warning(`safeUpdate failed: ${st}`);
      return;
    }
  }
}

async function commentExists(o: Octokit, owner: string, repo: string, id: number): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await o.issues.getComment({ owner, repo, comment_id: id });
      return true;
    } catch (err: unknown) {
      const st = (err as any)?.status ?? 0;
      if (st === 404) return false; // actually deleted
      if (st >= 500 && attempt < MAX_RETRIES - 1) {
        core.warning(`commentExists: GitHub ${st}, retry ${attempt + 1}/${MAX_RETRIES} (backoff ${backoffMs(attempt)}ms)`);
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      core.warning(`commentExists: unexpected error (${st}), assuming exists`);
      return true;
    }
  }
  return true;
}

run();
