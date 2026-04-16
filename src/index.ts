import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

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

// --- PR Comments Context ---

async function getPRCommentsContext(
  octokit: Octokit, owner: string, repo: string, issueNumber: number,
): Promise<string> {
  try {
    const { data: comments } = await octokit.issues.listComments({
      owner, repo, issue_number: issueNumber, per_page: 30,
    });
    // Only last 5 comments, 200 chars max — minimize context tokens
    const recent = comments.slice(-5);
    if (recent.length === 0) return "";
    return recent.map(c => {
      const who = c.user?.login ?? "?";
      const body = (c.body ?? "").slice(0, 200).replace(/\n/g, " ");
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
  rtkSavings: string;
}

// Kodif architecture context — injected when user asks about architecture
const KODIF_ARCH_CONTEXT = `
Kodif platform: 33+ microservices. Architecture repo: kodif-team/architect
DBs: executor-db (kodif, PostgreSQL 13), chat-db (chat, PostgreSQL 15), ml-db (zendesk-json-db-pgadmin, PostgreSQL 13). All sync to BigQuery.
Key services: Nexus (core API, port 8000), ml-service (ML/embeddings, 8005), tools (tool execution, 8002), integrations (CRM connectors, 8004), chatbot (chat engine, 8003), kodif-chat (chat backend, 8081), kodif-executor (flow engine, Java, 8080), kodif-gateway (API gateway, 8087), kodif-dashboard (frontend, 3000), kodif-chat-widget (widget, 3001), kodif-analytics (reports), insights-api, insights-service, index-service (search), autopilot (policy automation), playground-service.
Infra: Redis, LocalStack (SQS), Milvus (vectors), etcd, MinIO.
Bootstrap: docker-compose in architect/bootstrap/. Repos cloned to architect/repos/.
To explore architecture: clone kodif-team/architect and read .claude/CLAUDE.md, service-summaries/, db-schemas/, feature-deepdives/.
`.trim();

function isArchitectureQuestion(msg: string): boolean {
  return /architect|infra|service|microservice|system|overview|how.*work|database|schema|stack/i.test(msg);
}

function buildCLIPrompt(
  userMessage: string, prTitle: string, prBody: string,
  filesList: string, prCommentsContext: string,
): string {
  const parts = [
    `Kai, AI code reviewer. PR: "${prTitle}"`,
    prBody ? `Desc: ${prBody.slice(0, 300)}` : "",
    `Files:\n${filesList}`,
  ];
  if (prCommentsContext) {
    parts.push(`Prior conversation:\n${prCommentsContext}`);
  }
  if (isArchitectureQuestion(userMessage)) {
    // Architecture mode: answer about Kodif platform, NOT about the PR code
    parts.push(
      `IMPORTANT: The user is asking about Kodif platform architecture. Answer using this context, NOT the PR code:`,
      KODIF_ARCH_CONTEXT,
      `Task: ${userMessage}`,
      `Rules: concise, markdown, max 50 lines. Focus on architecture, services, and how they connect.`,
    );
  } else {
    parts.push(
      `Repo checked out. Use git diff origin/main...HEAD and Read to inspect PROJECT code only.`,
      `IGNORE: .github/, .claude/, CLAUDE.md, *.yml workflow files — these are infrastructure, not project code.`,
      `Task: ${userMessage}`,
      `Rules: concise, markdown, file:line refs, max 50 lines. Don't repeat prior analysis.`,
    );
  }
  return parts.filter(Boolean).join("\n");
}

// Smart max_turns based on task complexity
function getMaxTurns(message: string, modelTier: string): number {
  if (modelTier === "opus") return 20;
  if (modelTier === "sonnet") return 15;
  // Haiku: simple tasks get fewer turns
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
  return `<img src="${LOADING_GIF}" width="20" height="20"> ${phase}...\n\n_Delete this comment or send new \`@kai\` to cancel._`;
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

        settled = true;
        resolve({
          text: json.result ?? json.content ?? output,
          costUsd: json.total_cost_usd ?? json.cost_usd ?? 0,
          numTurns: json.num_turns ?? 1,
          inputTokens: (json.usage?.input_tokens ?? 0)
            + (json.usage?.cache_read_input_tokens ?? 0)
            + (json.usage?.cache_creation_input_tokens ?? 0),
          outputTokens: json.usage?.output_tokens ?? 0,
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

    core.info(`Triggered by @${sender} in #${issueNumber}`);

    octokit = new Octokit({ auth: githubToken });
    ({ owner, repo } = context.repo);

    try {
      await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "eyes" });
    } catch { /* */ }

    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    rawMessage = commentBody.slice(idx + trigger.length).trim() || "review this PR";
    const { model: modelTier, cleanMessage: userMessage } = parseModelFromMessage(rawMessage);
    const selectedModel = MODELS[modelTier];

    // Require CLI + RTK — fail early with clear error
    requireClaudeCLI();
    const rtkVersion = requireRTK();
    const modeLabel = "CLI + RTK";
    core.info(`Mode: ${modeLabel} | Model: ${selectedModel.label} | RTK: ${rtkVersion}`);

    // Audit + Session: init DB
    const auditDb = initAuditDb();
    const runId = `${owner}/${repo}#${issueNumber}-${Date.now()}`;
    const startTime = Date.now();

    auditLog(auditDb, {
      sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
      model: selectedModel.label, message: rawMessage, status: "started",
    });
    sessionStart(auditDb, {
      runId, repo: `${owner}/${repo}`, prNumber: issueNumber,
      sender, commentId, model: selectedModel.label,
    });

    // Create working comment with initial spinner
    const { data: reply } = await octokit.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: spinnerFrame(0, 0, selectedModel.label),
    });
    replyCommentId = reply.id;
    sessionUpdate(auditDb, runId, "working-comment", { replyCommentId });

    // Get PR context
    let prTitle = "", prBody = "", filesList = "", prCommentsContext = "";

    try {
      await safeUpdate(octokit, owner, repo, replyCommentId, spinnerFrame(1, 2, selectedModel.label));
      sessionUpdate(auditDb, runId, "loading-context");

      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: issueNumber });
      prTitle = pr.title;
      prBody = pr.body ?? "";

      try {
        execSync(`git fetch origin ${pr.head.ref} && git checkout ${pr.head.ref}`, {
          stdio: "pipe", timeout: 30_000, encoding: "utf-8",
        });
        core.info(`Checked out PR branch: ${pr.head.ref}`);
      } catch (e: unknown) {
        core.warning(`Could not checkout PR branch: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }

      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: issueNumber, per_page: 100 });
      // Compact: "file.py +67/-0" instead of "- file.py (+67/-0) [added]"
      filesList = files.map((f: { filename: string; additions: number; deletions: number }) =>
        `${f.filename} +${f.additions}/-${f.deletions}`).join("\n");

      prCommentsContext = await getPRCommentsContext(octokit, owner, repo, issueNumber);
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
      sessionUpdate(auditDb, runId, "cli-starting");
      await safeUpdate(octokit, owner, repo, replyCommentId, spinnerFrame(2, 5, selectedModel.label));

      // Hide infrastructure files from Claude — bot should only see project code
      try {
        execSync(`echo '.github/\n.claude/\nCLAUDE.md\n*.yml\n*.yaml' > .claudeignore`, {
          stdio: "pipe", timeout: 5000,
        });
      } catch { /* non-critical */ }

      const prompt = buildCLIPrompt(userMessage, prTitle, prBody, filesList, prCommentsContext);
      const maxTurns = getMaxTurns(userMessage, modelTier);
      core.info(`Max turns: ${maxTurns} (task: "${userMessage.slice(0, 40)}")`);
      const heartbeatCtx: HeartbeatContext = {
        octokit, owner, repo, replyCommentId, sender, modelLabel: selectedModel.label,
      };

      const r = await callClaudeCLIWithHeartbeat(
        anthropicApiKey, selectedModel.id, prompt, maxTurns, heartbeatCtx, auditDb, runId);
      result = r.text;

      const durationMs = Date.now() - startTime;
      const totalTokens = r.inputTokens + r.outputTokens;
      const rtkPct = r.rtkSavings || "— %";
      if (!r.rtkSavings || r.rtkSavings === "0.0%") {
        core.error(`CRITICAL: RTK savings empty or zero — tracking is broken. Check /home/kai/.local/share/rtk/history.db`);
      }
      const durationSec = Math.round(durationMs / 1000);
      const inK = Math.round(r.inputTokens / 1000);
      const outK = Math.round(r.outputTokens / 1000);
      footer = `Kai · ${selectedModel.label} · [RTK](https://github.com/rtk-ai/rtk) ${rtkPct} · ${inK}K in / ${outK}K out · $${r.costUsd.toFixed(2)} · ${r.numTurns}t · ${durationSec}s · deeper analysis: use sonnet / use opus`;

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

    await safeUpdate(octokit, owner, repo, replyCommentId,
      `> @${sender}: ${rawMessage}\n\n${result}\n\n---\n<sub>${footer}</sub>`);

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
