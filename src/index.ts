import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { execSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { compressPromptWithQwen, estimateTokens } from "./compressor";
import { appendContextHistory, buildDynamicPromptFromManifest, createDynamicContextPack } from "./context-pack";
import { buildFooter, buildRouterFooter } from "./footer";
import { isMetaQuestion, routeEventWithLocalLLM, shouldVerifyCommit, suggestTierWithLocalLLM, type RouterDecision } from "./router";
import { META_TEMPLATE, templateForRoute } from "./templates";
import { ensureCacheSchema, lookupCachedReply, storeCachedReply } from "./cache";
import { ensureQualitySchema, recordCacheHit, recordCommitVerification, detectAndRecordFollowup } from "./quality";
import { selectRelevantFiles } from "./file-focus";
import { buildCacheFriendlyPrompt } from "./prompt-order";

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
    );
    CREATE TABLE IF NOT EXISTS context_optimizer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      model_tier TEXT NOT NULL,
      raw_prompt_tokens INTEGER NOT NULL,
      compressed_prompt_tokens INTEGER NOT NULL,
      cmp_pct INTEGER NOT NULL,
      used_model INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_allowlist (
      sender TEXT PRIMARY KEY,
      max_tier TEXT NOT NULL CHECK(max_tier IN ('haiku','sonnet','opus')),
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      added_by TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      sender TEXT NOT NULL,
      repo TEXT NOT NULL,
      tier TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_sender_ts ON rate_limits(sender, timestamp);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_repo_ts ON rate_limits(repo, timestamp)
  `);
  seedModelAllowlist(db);
  ensureCacheSchema(db);
  ensureQualitySchema(db);
  return db;
}

// Returns the most recent audit_log id matching sender/repo/pr — used to link
// quality signals (commit_verified, cache_hit, grounded score) to the call.
function latestAuditId(db: DatabaseSync, sender: string, repoFull: string, prNumber: number): number | null {
  try {
    const row = db.prepare(
      `SELECT id FROM audit_log WHERE sender = ? AND repo = ? AND pr_number = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(sender, repoFull, prNumber) as { id?: number } | undefined;
    return row?.id ?? null;
  } catch { return null; }
}

type RateLimitCheck = { allowed: boolean; reason?: string };

// Defaults are conservative; tune via env to match your team size.
const RATE_LIMIT_SENDER_PER_HOUR = Number(process.env.KAI_RATE_LIMIT_SENDER_PER_HOUR || 20);
const RATE_LIMIT_REPO_PER_HOUR = Number(process.env.KAI_RATE_LIMIT_REPO_PER_HOUR || 120);
const RATE_LIMIT_SENDER_COST_PER_DAY = Number(process.env.KAI_RATE_LIMIT_SENDER_COST_PER_DAY || 20);

function checkRateLimit(db: DatabaseSync | null, sender: string, repoFull: string): RateLimitCheck {
  if (!db) return { allowed: true };
  try {
    const hourly = db.prepare(
      `SELECT COUNT(*) AS n FROM rate_limits WHERE sender = ? AND timestamp >= datetime('now', '-1 hour')`,
    ).get(sender) as { n: number };
    if (hourly.n >= RATE_LIMIT_SENDER_PER_HOUR) {
      return { allowed: false, reason: `sender rate limit: ${hourly.n}/${RATE_LIMIT_SENDER_PER_HOUR} calls in last hour` };
    }
    const repoHourly = db.prepare(
      `SELECT COUNT(*) AS n FROM rate_limits WHERE repo = ? AND timestamp >= datetime('now', '-1 hour')`,
    ).get(repoFull) as { n: number };
    if (repoHourly.n >= RATE_LIMIT_REPO_PER_HOUR) {
      return { allowed: false, reason: `repo rate limit: ${repoHourly.n}/${RATE_LIMIT_REPO_PER_HOUR} calls in last hour` };
    }
    const dailyCost = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM rate_limits WHERE sender = ? AND timestamp >= datetime('now', '-1 day')`,
    ).get(sender) as { c: number };
    if (dailyCost.c >= RATE_LIMIT_SENDER_COST_PER_DAY) {
      return { allowed: false, reason: `sender daily budget: $${dailyCost.c.toFixed(2)}/$${RATE_LIMIT_SENDER_COST_PER_DAY}` };
    }
    return { allowed: true };
  } catch (e) {
    core.warning(`Rate-limit check failed: ${e}`);
    return { allowed: true }; // fail open on DB errors; allowlist already blocks opus/sonnet
  }
}

function recordRateLimit(db: DatabaseSync | null, sender: string, repoFull: string, tier: string, costUsd: number): void {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO rate_limits (sender, repo, tier, cost_usd) VALUES (?, ?, ?, ?)`)
      .run(sender, repoFull, tier, costUsd);
  } catch (e) { core.warning(`Rate-limit record failed: ${e}`); }
}

// Seeds model_allowlist from KAI_MODEL_ALLOWLIST env, e.g. "alice:opus,bob:sonnet".
// Idempotent: INSERT OR REPLACE so operators can edit the env var and redeploy.
function seedModelAllowlist(db: DatabaseSync): void {
  const raw = process.env.KAI_MODEL_ALLOWLIST?.trim();
  if (!raw) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO model_allowlist (sender, max_tier, added_by, note)
     VALUES (?, ?, 'env-seed', 'seeded from KAI_MODEL_ALLOWLIST')`,
  );
  for (const entry of raw.split(",")) {
    const [senderRaw, tierRaw] = entry.split(":").map((s) => s?.trim());
    if (!senderRaw || !tierRaw) continue;
    const tier = tierRaw.toLowerCase();
    if (tier !== "haiku" && tier !== "sonnet" && tier !== "opus") continue;
    try { stmt.run(senderRaw, tier); }
    catch (e) { core.warning(`Allowlist seed failed for ${senderRaw}: ${e}`); }
  }
}

const TIER_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

// Default tier for senders not in allowlist. haiku is safe — cheapest paid tier.
function defaultAllowedTier(): string {
  const env = (process.env.KAI_ALLOWLIST_DEFAULT_TIER || "haiku").toLowerCase();
  return TIER_RANK[env] ? env : "haiku";
}

function resolveAllowedModel(
  db: DatabaseSync | null,
  sender: string,
  requestedTier: string,
): { tier: string; downgraded: boolean; maxTier: string } {
  const fallbackTier = defaultAllowedTier();
  const requested = requestedTier.toLowerCase();
  if (!db) {
    // DB unavailable — fail closed: only allow fallback tier.
    const allowed = TIER_RANK[requested] <= TIER_RANK[fallbackTier] ? requested : fallbackTier;
    return { tier: allowed, downgraded: allowed !== requested, maxTier: fallbackTier };
  }
  let maxTier = fallbackTier;
  try {
    const row = db.prepare(`SELECT max_tier FROM model_allowlist WHERE sender = ?`).get(sender) as { max_tier?: string } | undefined;
    if (row?.max_tier && TIER_RANK[row.max_tier]) maxTier = row.max_tier;
  } catch (e) {
    core.warning(`Allowlist lookup failed for ${sender}: ${e}`);
  }
  const allowed = TIER_RANK[requested] <= TIER_RANK[maxTier] ? requested : maxTier;
  return { tier: allowed, downgraded: allowed !== requested, maxTier };
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
    const params: (string | number)[] = [phase];
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

function logContextOptimization(db: DatabaseSync, data: {
  repo: string;
  prNumber: number;
  runId: string;
  modelTier: string;
  rawPromptTokens: number;
  compressedPromptTokens: number;
  cmpPct: number;
  usedModel: boolean;
  durationMs: number;
}) {
  try {
    db.prepare(`
      INSERT INTO context_optimizer_log (repo, pr_number, run_id, model_tier, raw_prompt_tokens, compressed_prompt_tokens, cmp_pct, used_model, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.repo,
      data.prNumber,
      data.runId,
      data.modelTier,
      data.rawPromptTokens,
      data.compressedPromptTokens,
      data.cmpPct,
      data.usedModel ? 1 : 0,
      data.durationMs,
    );
  } catch (e) {
    core.warning(`Context optimization log failed: ${e}`);
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
    // RTK actually saves tokens via a Claude Code PreToolUse hook that rewrites
    // bash commands. Having the binary on PATH without the hook = silent bypass.
    requireRTKHookConfigured();
    core.info(`RTK verified: ${ver}`);
    return ver;
  } catch (e: unknown) {
    if (e instanceof Error && (e.message.includes("Wrong rtk") || e.message.includes("RTK hook"))) throw e;
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    throw new Error(`RTK is required but not available: ${msg}`);
  }
}

function requireRTKHookConfigured(): void {
  if (process.env.KAI_RTK_HOOK_SKIP_CHECK === "true") {
    core.warning("KAI_RTK_HOOK_SKIP_CHECK=true — skipping RTK hook verification (RTK may be bypassed)");
    return;
  }
  const candidates = [
    process.env.KAI_CLAUDE_SETTINGS_PATH,
    `${process.env.HOME || "/home/kai"}/.claude/settings.json`,
    "/home/kai/.claude/settings.json",
    "/root/.claude/settings.json",
  ].filter((p): p is string => !!p);

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf-8");
      if (/\brtk\b/i.test(content)) {
        core.info(`RTK hook found in ${path}`);
        return;
      }
    } catch { /* try next */ }
  }
  throw new Error(
    "RTK hook not configured in Claude settings.json — RTK would be bypassed silently. "
    + "Configure PreToolUse hook with rtk, or set KAI_RTK_HOOK_SKIP_CHECK=true to override.",
  );
}

// Probe the local LLM /health endpoint once, quickly.
async function probeHealth(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: ctl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

// Dumps the runner's shell environment to the workflow log so operators can
// diagnose self-hosted runner issues without SSH (we don't have SSH from this
// sandbox). Read-only. Cheap. Runs once per invocation when the LLM endpoints
// are unreachable.
let runnerDiagnosticsEmitted = false;
function emitRunnerDiagnostics(routerUrl?: string, compressorUrl?: string): void {
  if (runnerDiagnosticsEmitted) return;
  runnerDiagnosticsEmitted = true;
  const tryRun = (label: string, cmd: string, timeoutMs = 5000) => {
    try {
      const out = execSync(cmd, { stdio: "pipe", timeout: timeoutMs, encoding: "utf-8" }).trim();
      core.info(`[diag] ${label}: ${out.slice(0, 600)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      core.info(`[diag] ${label}: ERROR ${msg}`);
    }
  };
  core.info("===== runner diagnostics =====");
  tryRun("uname", "uname -a");
  tryRun("whoami", "whoami && id");
  tryRun("cwd", "pwd");
  tryRun("PATH", "echo $PATH");
  tryRun("HOME", "echo $HOME");
  tryRun("docker-cli", "command -v docker || echo not-found");
  tryRun("docker-sock", "ls -la /var/run/docker.sock 2>/dev/null || echo no-socket");
  tryRun("listening-ports", "(ss -tln 2>/dev/null || netstat -tln 2>/dev/null || echo no-ss) | head -20");
  tryRun("processes-listening", "lsof -iTCP -sTCP:LISTEN 2>/dev/null | head -20 || echo no-lsof");
  tryRun("action-path-ls", "ls -la /home/runner/actions-runner/_work/_actions/er-zhi/kai/v1 2>/dev/null | head -10 || echo not-found");
  tryRun("bundleDir-ls", "ls -la $(dirname $(node -e 'console.log(process.argv[1])' 2>/dev/null || echo /))/.. 2>/dev/null | head -10 || echo not-found");
  if (routerUrl) {
    tryRun(`curl ${routerUrl}/health`, `curl -sS -v --max-time 5 ${routerUrl.replace(/\/$/, "")}/health 2>&1 | tail -30`);
  }
  if (compressorUrl) {
    tryRun(`curl ${compressorUrl}/health`, `curl -sS -v --max-time 5 ${compressorUrl.replace(/\/$/, "")}/health 2>&1 | tail -30`);
  }
  core.info("===== /runner diagnostics =====");
}

// Self-heal the local LLM containers when they're down at action start. Uses
// docker compose on the runner — requires: (1) the kai user in the docker
// group, (2) docker-compose.router.yml placed somewhere the runner can read
// (KAI_COMPOSE_FILE or the default paths below). If the file isn't there or
// docker fails, we log a warning and let routeEventWithLocalLLM fail-close
// with the helpful error message.
async function ensureLocalLLMsUp(routerUrl?: string, compressorUrl?: string): Promise<void> {
  if (process.env.KAI_LLM_AUTOSTART === "false") return;
  const endpoints = [routerUrl, compressorUrl].filter((u): u is string => !!u);
  if (endpoints.length === 0) return;

  const probes = await Promise.all(endpoints.map((u) => probeHealth(u)));
  if (probes.every(Boolean)) return; // everything already up

  // Dump the runner's environment so we can diagnose without SSH.
  emitRunnerDiagnostics(routerUrl, compressorUrl);

  // __dirname of the bundle is <action>/dist/; the compose file ships one level
  // up. GITHUB_ACTION_PATH is only set for composite actions, not JS actions,
  // so __dirname is the reliable source. Works zero-config on any runner.
  const bundleDir = typeof __dirname === "string" ? __dirname : "";
  const composeCandidates = [
    process.env.KAI_COMPOSE_FILE,
    bundleDir ? `${bundleDir}/../docker-compose.router.yml` : "",
    process.env.GITHUB_ACTION_PATH ? `${process.env.GITHUB_ACTION_PATH}/docker-compose.router.yml` : "",
    "/home/kai/kai-router/docker-compose.router.yml",
    "/home/kai/docker-compose.router.yml",
    `${process.env.HOME || "/home/kai"}/kai-router/docker-compose.router.yml`,
  ].filter((p): p is string => !!p && existsSync(p));

  // READ-ONLY probes via /var/run/docker.sock. Captures stderr and runs a
  // progressive chain: curl features → socket ping → list containers → logs.
  // Each step's output is forwarded to the workflow log so we can see exactly
  // where the access path breaks without SSH.
  if (existsSync("/var/run/docker.sock")) {
    const sh = (cmd: string, timeout = 10_000): { ok: boolean; out: string } => {
      try {
        const out = execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout, encoding: "utf-8" });
        return { ok: true, out: out.toString() };
      } catch (e: unknown) {
        const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
        const merged = [err.stdout?.toString?.() ?? "", err.stderr?.toString?.() ?? "", err.message ?? ""].join("\n");
        return { ok: false, out: merged.slice(0, 800) };
      }
    };
    core.info("[diag] docker-sock probe starting");
    core.info(`[diag] curl-version: ${sh("curl --version | head -2").out.trim()}`);
    core.info(`[diag] sock-stat: ${sh("stat -c '%A %U:%G uid=%u gid=%g' /var/run/docker.sock").out.trim()}`);
    core.info(`[diag] my-groups: ${sh("id -G; echo gid-names; id -Gn").out.trim()}`);
    core.info(`[diag] can-write-sock: ${sh("[ -w /var/run/docker.sock ] && echo yes || echo no").out.trim()}`);
    const ping = sh("curl -sS -v --unix-socket /var/run/docker.sock http://localhost/_ping 2>&1 | tail -15");
    core.info(`[diag] /_ping (ok=${ping.ok}):\n${ping.out.trim()}`);

    const filters = encodeURIComponent(JSON.stringify({ name: ["kai-router", "kai-compressor"] }));
    const listCmd = `curl -sS -v --unix-socket /var/run/docker.sock 'http://localhost/containers/json?all=true&filters=${filters}' 2>&1`;
    const listRes = sh(listCmd);
    core.info(`[diag] list (ok=${listRes.ok}):\n${listRes.out.slice(-1500)}`);

    if (listRes.ok) {
      try {
        // extract JSON array from combined verbose output
        const jsonStart = listRes.out.indexOf("[");
        const body = jsonStart >= 0 ? listRes.out.slice(jsonStart) : listRes.out;
        const containers = JSON.parse(body) as Array<{
          Id: string; Names: string[]; State: string; Status: string; Image: string;
        }>;
        if (containers.length === 0) {
          core.warning("[diag] docker API: no kai-router/kai-compressor containers");
        }
        for (const c of containers) {
          const name = (c.Names[0] || "").replace(/^\//, "");
          core.info(`[diag] container ${name}: state=${c.State} status=${c.Status} image=${c.Image}`);
          const logs = sh(
            `curl -sS --unix-socket /var/run/docker.sock 'http://localhost/containers/${c.Id}/logs?stdout=1&stderr=1&tail=80&timestamps=1' 2>&1 | tr -cd '[:print:][:space:]'`,
          );
          core.info(`[diag] ${name} last 80 lines (ok=${logs.ok}):\n${logs.out.slice(-3000)}`);
        }
      } catch (e) { core.info(`[diag] parse error: ${e instanceof Error ? e.message : e}`); }
    }
  }

  // Separate fallback path for autostart — only runs when compose file + docker
  // CLI both available. Not used on bare runners (those see read-only diag
  // above and escalate to the operator until we know what's crashing).
  const composeFile = composeCandidates[0];
  const hasDockerCli = (() => {
    try { execSync("command -v docker", { stdio: "pipe", timeout: 2000 }); return true; }
    catch { return false; }
  })();

  if (hasDockerCli && composeFile) {
    core.info(`Starting containers via ${composeFile}`);
    try {
      execSync(`docker compose -f ${shellQuote(composeFile)} run --rm kai-router-pull`,
        { stdio: "pipe", timeout: 180_000 });
      execSync(`docker compose -f ${shellQuote(composeFile)} run --rm kai-compressor-pull`,
        { stdio: "pipe", timeout: 180_000 });
      execSync(`docker compose -f ${shellQuote(composeFile)} up -d kai-router-llm kai-compressor-llm`,
        { stdio: "pipe", timeout: 60_000 });
    } catch (e: unknown) {
      core.warning(`docker compose up failed: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
      return;
    }
  } else {
    core.warning("No docker CLI available to restart containers; leaving as-is until we know why they're down.");
    return;
  }

  // Wait up to 30s for both endpoints to come alive.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await Promise.all(endpoints.map((u) => probeHealth(u)));
    if (ok.every(Boolean)) {
      core.info("Local LLM is healthy after auto-start");
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  core.warning("Local LLM auto-start timed out — proceeding; router call will retry");
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
const MAX_DIFF_CHARS = Number(process.env.KAI_MAX_DIFF_CHARS || 12_000); // ~3K tokens
function getPrDiffDigest(): string {
  try {
    const diff = execSync("git diff origin/main...HEAD --no-color --unified=3", {
      stdio: "pipe", timeout: 15_000, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024,
    });
    if (!diff.trim()) return "";
    if (diff.length <= MAX_DIFF_CHARS) return diff;
    const head = diff.slice(0, Math.floor(MAX_DIFF_CHARS * 0.7));
    const tail = diff.slice(-Math.floor(MAX_DIFF_CHARS * 0.2));
    return `${head}\n... [truncated ${diff.length - MAX_DIFF_CHARS} chars] ...\n${tail}`;
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
  } catch { /* best-effort cleanup for bot-only ignore file */ }

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

// Short-answer heuristic: user asked for a terse reply (one sentence, brief,
// yes/no, etc). For these we tighten Claude's exploration budget so it doesn't
// Read a dozen files to produce a 20-word answer — that was the 12-turn, $0.057
// pattern we hit on 2026-04-17.
function isShortAnswerRequest(message: string): boolean {
  return /\b(one\s+(?:sentence|line|word|paragraph)|1\s+sentence|single\s+sentence|briefly|tl;?\s*dr|in\s+(?:a\s+)?(?:word|sentence|line)|short\s+answer|yes\/no|quick(?:ly)?)\b/i.test(message);
}

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
    stable.push(
      `PR repo checked out in current dir. The diff above is authoritative; only Read files if you need more than the diff shows.`,
      // Cross-service context invite — skipped for short-answer tasks because
      // it provoked Claude to wander /home/kai/architect/repos/ and balloon
      // token usage on trivial questions.
      shortAnswer
        ? `STRICT BUDGET: this is a short-answer request. The diff above contains everything you need. Do NOT Read any file. Do NOT explore /home/kai/architect/repos/. Answer from the diff in at most 2 sentences.`
        : `Kodif repos available at /home/kai/architect/repos/ (read-only). Use for cross-service context only when the diff alone is insufficient.`,
      `IGNORE: .github/, .claude/, CLAUDE.md, *.yml workflow files — these are bot infrastructure, not project code.`,
      `Rules: concise, markdown, repos/<service>/path/file.py:line refs, max 50 lines. Don't repeat prior analysis.`,
      `For imperative write tasks (fix/add/update/create/patch/refactor/document), commit and push the change to the PR branch unless the user explicitly asks not to.`,
      `Git commits: NEVER add Co-Authored-By headers or AI provider attribution. Author is already set to kodif-ai[bot].`,
    );
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
        : `Success criteria: satisfy the task, stay within the selected context, and report concrete evidence. Answer EXACTLY what the user asked.`,
  );

  return buildCacheFriendlyPrompt({ stable, dynamic });
}

// Smart max_turns based on task complexity
function getMaxTurns(message: string, modelTier: string): number {
  if (modelTier === "opus") return 25;
  if (modelTier === "sonnet") return 20;
  // Haiku: scale by task type. Earlier we used 5 for "simple" read tasks which
  // repeatedly hit error_max_turns (Claude needs ≥1 diff-read + ≥1 file-read +
  // 1 synthesis = 3-5 turns minimum; leave headroom). "what is the biggest risk"
  // also matched simple but is actually a review — bumped to 12 default.
  const needsWrite = /fix|commit|push|apply|create|patch|refactor|document/i.test(message);
  if (needsWrite) return 20;
  // Short-answer requests (one sentence / briefly / tl;dr) must stay cheap:
  // prompt directive plus a tight budget cap aligns model behavior with cost.
  if (isShortAnswerRequest(message)) return 6;
  const isTrulySimple = message.length < 50
    && /^(top|list|one-liner|quick|summarize|how many|which file)/i.test(message);
  return isTrulySimple ? 8 : 12;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const CLI_TIMEOUT_MS = 300_000;
const RETRY_DELAYS = [15_000, 30_000, 60_000]; // exponential: 15s, 30s, 60s

// Retries multiply cost. Paid tiers get fewer chances so a single broken prompt
// can't silently burn 3x budget.
function maxRetriesFor(tier: string): number {
  if (tier === "opus") return 1;
  if (tier === "sonnet") return 2;
  return Number(process.env.KAI_MAX_CLI_RETRIES || 3);
}

// Per-call cost + prompt-size ceilings. Post-call cost is logged to audit; if
// over the ceiling we flag status so ops can see drift quickly.
const MAX_COST_USD_BY_TIER: Record<string, number> = {
  haiku: Number(process.env.KAI_MAX_COST_USD_HAIKU || 0.5),
  sonnet: Number(process.env.KAI_MAX_COST_USD_SONNET || 2),
  opus: Number(process.env.KAI_MAX_COST_USD_OPUS || 5),
};
const MAX_PROMPT_TOKENS = Number(process.env.KAI_MAX_PROMPT_TOKENS || 50_000);

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
  db: DatabaseSync, runId: string, modelTier: string,
  disallowedTools: string[] = [],
): Promise<CLIResult> {
  const isRoot = process.getuid?.() === 0;
  const maxRetries = maxRetriesFor(modelTier);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    sessionUpdate(db, runId, `cli-attempt-${attempt}`, { attempt });

    if (attempt > 1) {
      const delay = RETRY_DELAYS[attempt - 2] ?? 60_000;
      core.info(`Retry ${attempt}/${maxRetries} in ${delay / 1000}s`);
      await safeUpdate(heartbeat.octokit, heartbeat.owner, heartbeat.repo, heartbeat.replyCommentId,
        `> ⚠️ Retrying (attempt ${attempt}/${maxRetries})...\n\n🔄 Previous attempt failed, waiting ${delay / 1000}s before retry\n🔍 **${heartbeat.modelLabel}**\n\n_Delete this comment to cancel._`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await runCLIWithHeartbeat(apiKey, modelId, prompt, maxTurns, isRoot, heartbeat, db, runId, disallowedTools);
      sessionUpdate(db, runId, "completed", { status: "completed" });
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      core.warning(`CLI attempt ${attempt} failed: ${msg}`);
      sessionUpdate(db, runId, `failed-attempt-${attempt}`, { error: msg });

      if (attempt === maxRetries) {
        sessionUpdate(db, runId, "failed", { status: "failed", error: msg });
        throw e;
      }
    }
  }
  throw new Error("All CLI retries exhausted");
}

// Tools Claude cannot call on short-answer requests. Read stays allowed in case
// the diff digest was truncated; Glob/Grep/find are the expensive explorers.
function disallowedToolsFor(userMessage: string): string[] {
  if (!isShortAnswerRequest(userMessage)) return [];
  return ["Glob", "WebFetch", "WebSearch", "Bash(find:*)", "Bash(cd:*)", "Bash(ls:*)"];
}

function runCLIWithHeartbeat(
  apiKey: string, modelId: string, prompt: string, maxTurns: number, isRoot: boolean,
  hb: HeartbeatContext, db: DatabaseSync, runId: string, disallowedTools: string[] = [],
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    const claudeArgs = ["-p", "--dangerously-skip-permissions", "--output-format", "json", "--max-turns", String(maxTurns), "--model", modelId];
    if (disallowedTools.length) {
      claudeArgs.push("--disallowed-tools", disallowedTools.join(","));
    }
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
    const routerUrl = core.getInput("router_url") || process.env.KAI_ROUTER_URL;
    const routerModel = core.getInput("router_model") || process.env.KAI_ROUTER_MODEL || "LFM2-350M";
    const compressorUrl = core.getInput("compressor_url") || process.env.KAI_COMPRESSOR_URL;
    const compressorModel = core.getInput("compressor_model") || process.env.KAI_COMPRESSOR_MODEL || "LFM2-350M";
    const compressorDisabled = (core.getInput("compressor_disable") || process.env.KAI_COMPRESSOR_DISABLE || "false").toLowerCase() === "true";
    const compressorMinQueryTokens = Number(core.getInput("compressor_min_query_tokens") || process.env.KAI_COMPRESSOR_MIN_QUERY_TOKENS || 10);
    const compressorMinPromptTokens = Number(core.getInput("compressor_min_prompt_tokens") || process.env.KAI_COMPRESSOR_MIN_PROMPT_TOKENS || 2200);

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

    // Audit + Session: init DB early so allowlist lookup sees it.
    const auditDb = initAuditDb();

    // Self-heal local LLM containers if they're down. Runs before any router
    // call so we don't waste retries against a dead endpoint. Silent no-op when
    // everything is already healthy.
    await ensureLocalLLMsUp(routerUrl, compressorUrl);

    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    rawMessage = commentBody.slice(idx + trigger.length).trim();
    const { model: parsedTier, cleanMessage: userMessage } = parseModelFromMessage(rawMessage);
    const userSpecifiedTier = /\buse\s+(haiku|sonnet|opus)\b/i.test(rawMessage);

    // If the user didn't explicitly pick a tier, ask the local LLM to suggest one
    // based on task complexity. Honors user override + allowlist cap. Skipped
    // when router and compressor share the same endpoint (llama.cpp --parallel 1
    // chokes on back-to-back hits) or when disabled via env.
    let suggestedTier: string | null = null;
    const tierSuggestDisabled = process.env.KAI_TIER_SUGGEST_DISABLE === "true"
      || (!!routerUrl && !!compressorUrl && routerUrl === compressorUrl);
    if (!userSpecifiedTier && routerUrl && !tierSuggestDisabled) {
      try {
        suggestedTier = await suggestTierWithLocalLLM(userMessage, {
          url: routerUrl, model: routerModel, timeoutMs: 2500,
        });
        if (suggestedTier) core.info(`Local-LLM tier suggestion: ${suggestedTier} (task: "${userMessage.slice(0, 40)}")`);
      } catch (e) { core.warning(`Tier suggest failed: ${e}`); }
    }
    const requestedTier = suggestedTier ?? parsedTier;
    const { tier: modelTier, downgraded: tierDowngraded, maxTier: senderMaxTier } =
      resolveAllowedModel(auditDb, sender, requestedTier);
    const selectedModel = MODELS[modelTier];
    const tierNotice = tierDowngraded
      ? `\n\n> _Note: @${sender} is allowed up to **${senderMaxTier}**. Requested **${requestedTier}** was downgraded to **${modelTier}**. Ask an admin to update the allowlist._`
      : "";
    if (tierDowngraded) {
      core.warning(`Tier downgrade for @${sender}: ${requestedTier} -> ${modelTier} (max=${senderMaxTier})`);
    }
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

    if (route.decision === "ignore") return;

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

    // Rate-limit BEFORE spinning up the heavy CLI path — cheap deterministic guard.
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
      body: spinnerFrame(0, 0, selectedModel.label),
    });
    replyCommentId = reply.id;
    sessionUpdate(auditDb, runId, "analyzing", { replyCommentId });

    // Get PR context
    let prTitle = "", prBody = "", filesList = "", prCommentsContext = "";
    let prHeadRef = "", beforeHead = "";
    let contextManifestPath = "";
    let contextHistoryPath = "";

    try {
      await safeUpdate(octokit, owner, repo, replyCommentId, spinnerFrame(1, 2, selectedModel.label));
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
        const auth = gitAuthFlag(githubToken);
        execSync(`git ${auth} fetch origin ${shellQuote(pr.head.ref)} && git checkout ${shellQuote(pr.head.ref)}`, {
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

      // File-focus pre-step: for big PRs, ask local LLM which 3-5 files matter
      // most for this task. Claude reads fewer files → fewer tokens. Best-effort
      // — empty list just means Claude picks files itself.
      let focusedFiles: string[] = [];
      if (compressorUrl && filesList && !isArchitectureQuestion(userMessage)) {
        try {
          focusedFiles = await selectRelevantFiles(userMessage, filesList, {
            url: compressorUrl, model: compressorModel, timeoutMs: 2500, maxFiles: 5,
          });
          if (focusedFiles.length) core.info(`File focus: ${focusedFiles.join(", ")}`);
        } catch (e) { core.warning(`File focus failed: ${e}`); }
      }

      // Pre-fetch the diff once — cached as part of the stable prefix.
      const prDiffDigest = beforeHead ? getPrDiffDigest() : "";
      if (prDiffDigest) core.info(`PR diff digest attached: ${prDiffDigest.length} chars`);

      const prompt = contextManifestPath
        ? buildDynamicPromptFromManifest(
          userMessage,
          `${owner}/${repo}`,
          route,
          contextManifestPath,
          isArchitectureQuestion(userMessage),
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
          timeoutMs: Number(process.env.KAI_COMPRESSOR_TIMEOUT_MS || 1500),
          disabled: compressorDisabled,
          minQueryTokens: compressorMinQueryTokens,
          minPromptTokens: compressorMinPromptTokens,
          budgetByTier: {
            haiku: Number(process.env.KAI_COMPRESSOR_BUDGET_HAIKU || 6000),
            sonnet: Number(process.env.KAI_COMPRESSOR_BUDGET_SONNET || 24000),
            opus: Number(process.env.KAI_COMPRESSOR_BUDGET_OPUS || 80000),
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
        throw compressionError;
      }
      // Hard prompt-size ceiling — guards against "compressor returned original"
      // or huge paste in comment. Fails closed before paying the model.
      const finalPromptTokens = estimateTokens(finalPrompt);
      if (finalPromptTokens > MAX_PROMPT_TOKENS) {
        throw new Error(
          `Final prompt ${finalPromptTokens} tokens exceeds KAI_MAX_PROMPT_TOKENS=${MAX_PROMPT_TOKENS}. `
          + `Compression may be disabled or ineffective. Refusing to call paid model.`,
        );
      }

      const maxTurns = getMaxTurns(userMessage, modelTier);
      core.info(`Max turns: ${maxTurns} (task: "${userMessage.slice(0, 40)}")`);
      const heartbeatCtx: HeartbeatContext = {
        octokit, owner, repo, replyCommentId, sender, modelLabel: selectedModel.label,
      };

      const disallowed = disallowedToolsFor(userMessage);
      if (disallowed.length) core.info(`Gated tools: ${disallowed.join(",")}`);
      const r = await callClaudeCLIWithHeartbeat(
        anthropicApiKey, selectedModel.id, finalPrompt, maxTurns, heartbeatCtx, auditDb, runId, modelTier, disallowed);
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
      const rtkPct = r.rtkSavings || "— %";
      const rtkBypassed = !r.rtkSavings || r.rtkSavings === "0.0%";
      if (rtkBypassed) {
        core.error(`CRITICAL: RTK savings empty or zero — RTK was bypassed or tracking is broken. Check /home/kai/.local/share/rtk/history.db`);
        result += `\n\n> ⚠️ **RTK bypassed** — no token savings recorded for this call. Operator: verify hook in \`$HOME/.claude/settings.json\`.`;
      }
      const costCap = MAX_COST_USD_BY_TIER[modelTier] ?? MAX_COST_USD_BY_TIER.haiku;
      const costOverCap = r.costUsd > costCap;
      if (costOverCap) {
        core.error(`Cost cap exceeded: $${r.costUsd.toFixed(4)} > $${costCap} (${modelTier})`);
        result += `\n\n> ⚠️ **Cost cap exceeded** for ${modelTier}: $${r.costUsd.toFixed(4)} > $${costCap}. Operator alerted.`;
      }
      const durationSec = Math.round(durationMs / 1000);
      footer = buildFooter(
        selectedModel.label, rtkPct, cmpSavings, r.inputTokens, r.outputTokens,
        r.costUsd, r.numTurns, durationSec, r.cacheReadTokens);

      const finalStatus = costOverCap
        ? "completed-cost-over-cap"
        : rtkBypassed ? "completed-rtk-bypass" : "completed";
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: selectedModel.label, message: rawMessage, durationMs,
        costUsd: r.costUsd, tokensIn: r.inputTokens, tokensOut: r.outputTokens,
        rtkSavings: rtkPct, status: finalStatus,
      });
      recordRateLimit(auditDb, sender, `${owner}/${repo}`, modelTier, r.costUsd);

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

    if (!(await commentExists(octokit, owner, repo, replyCommentId))) {
      core.info("Cancelled");
      return;
    }

    sessionUpdate(auditDb, runId, "responding");
    await safeUpdate(octokit, owner, repo, replyCommentId,
      `> @${sender}: ${rawMessage}${tierNotice}\n\n${result}\n\n---\n<sub>${footer}</sub>`);
    sessionUpdate(auditDb, runId, "completed", { status: "completed" });

    core.info("Done");
  } catch (error) {
    // Global error handler — ALWAYS post error to PR, never silently crash
    const msg = error instanceof Error ? error.message : String(error);
    core.error(msg);
    logErrorToSentry(error, {
      subsystem: "kai-action-run",
      owner,
      repo,
      sender,
    });

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
      const routerHint = msg.includes("local router")
        ? "\n\n**Likely cause:** local router (LFM2-350M on port 11434) is not reachable from the runner. On the runner, run `docker compose -f docker-compose.router.yml ps` — if containers are Exited, start with `docker compose -f docker-compose.router.yml up -d kai-router-llm kai-compressor-llm`."
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
