import * as core from "@actions/core";
import { DatabaseSync } from "node:sqlite";
import type { RouterDecision } from "./types";
import { ensureCacheSchema } from "./cache";
import { ensureQualitySchema, detectAndRecordFollowup, recordCacheHit, recordCommitVerification } from "./quality";

export type RateLimitCheck = { allowed: boolean; reason?: string };

export type AuditDb = DatabaseSync;

export type AuditLogInput = {
  sender: string;
  repo: string;
  prNumber: number;
  model: string;
  message?: string;
  durationMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  rtkSavings?: string;
  status?: string;
  error?: string;
};

export type RouterDecisionLogInput = {
  repo: string;
  prNumber: number;
  commentId: number;
  sender: string;
  route: RouterDecision;
};

export type ContextOptimizationLogInput = {
  repo: string;
  prNumber: number;
  runId: string;
  modelTier: string;
  rawPromptTokens: number;
  compressedPromptTokens: number;
  cmpPct: number;
  usedModel: boolean;
  durationMs: number;
};

export type SessionStartInput = {
  runId: string;
  repo: string;
  prNumber: number;
  sender: string;
  commentId: number;
  model: string;
};

export type SessionUpdateInput = {
  replyCommentId?: number;
  attempt?: number;
  status?: string;
  error?: string;
};

const TIER_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    if (fallback == null) throw new Error(`Missing required env: ${name}`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return value;
}

const DEFAULT_RATE_LIMIT_SENDER_PER_HOUR = 20;
const DEFAULT_RATE_LIMIT_REPO_PER_HOUR = 100;
const DEFAULT_RATE_LIMIT_SENDER_COST_PER_DAY = 0.25;
const DEFAULT_ALLOWLIST_TIER = "haiku";

export function initAuditDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
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

export function latestAuditId(db: DatabaseSync, sender: string, repoFull: string, prNumber: number): number | null {
  try {
    const row = db.prepare(
      `SELECT id FROM audit_log WHERE sender = ? AND repo = ? AND pr_number = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(sender, repoFull, prNumber) as { id?: number } | undefined;
    return row?.id ?? null;
  } catch { return null; }
}

export function checkRateLimit(db: DatabaseSync | null, sender: string, repoFull: string): RateLimitCheck {
  const senderPerHour = envNumber("KAI_RATE_LIMIT_SENDER_PER_HOUR", DEFAULT_RATE_LIMIT_SENDER_PER_HOUR);
  const repoPerHour = envNumber("KAI_RATE_LIMIT_REPO_PER_HOUR", DEFAULT_RATE_LIMIT_REPO_PER_HOUR);
  const senderCostPerDay = envNumber("KAI_RATE_LIMIT_SENDER_COST_PER_DAY", DEFAULT_RATE_LIMIT_SENDER_COST_PER_DAY);
  if (!db) return { allowed: false, reason: "rate-limit database unavailable" };
  try {
    const hourly = db.prepare(
      `SELECT COUNT(*) AS n FROM rate_limits WHERE sender = ? AND timestamp >= datetime('now', '-1 hour')`,
    ).get(sender) as { n: number };
    if (hourly.n >= senderPerHour) {
      return { allowed: false, reason: `sender rate limit: ${hourly.n}/${senderPerHour} calls in last hour` };
    }
    const repoHourly = db.prepare(
      `SELECT COUNT(*) AS n FROM rate_limits WHERE repo = ? AND timestamp >= datetime('now', '-1 hour')`,
    ).get(repoFull) as { n: number };
    if (repoHourly.n >= repoPerHour) {
      return { allowed: false, reason: `repo rate limit: ${repoHourly.n}/${repoPerHour} calls in last hour` };
    }
    const dailyCost = db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM rate_limits WHERE sender = ? AND timestamp >= datetime('now', '-1 day')`,
    ).get(sender) as { c: number };
    if (dailyCost.c >= senderCostPerDay) {
      return { allowed: false, reason: `sender daily budget: $${dailyCost.c.toFixed(2)}/$${senderCostPerDay}` };
    }
    return { allowed: true };
  } catch (e) {
    core.warning(`Rate-limit check failed: ${e}`);
    return { allowed: false, reason: "rate-limit check failed" };
  }
}

export function recordRateLimit(db: DatabaseSync | null, sender: string, repoFull: string, tier: string, costUsd: number): void {
  if (!db) return;
  try {
    db.prepare(`INSERT INTO rate_limits (sender, repo, tier, cost_usd) VALUES (?, ?, ?, ?)`)
      .run(sender, repoFull, tier, costUsd);
  } catch (e) { core.warning(`Rate-limit record failed: ${e}`); }
}

export function resolveAllowedModel(
  db: DatabaseSync | null,
  sender: string,
  requestedTier: string,
): { tier: string; downgraded: boolean; maxTier: string } {
  const fallbackTier = (process.env.KAI_ALLOWLIST_DEFAULT_TIER ?? DEFAULT_ALLOWLIST_TIER).toLowerCase();
  const requested = requestedTier.toLowerCase();
  if (!db) {
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

export function sessionStart(db: DatabaseSync, data: SessionStartInput): void {
  try {
    db.prepare(`INSERT OR REPLACE INTO sessions (run_id, repo, pr_number, sender, comment_id, model, status, phase)
      VALUES (?, ?, ?, ?, ?, ?, 'running', 'init')`).run(
      data.runId, data.repo, data.prNumber, data.sender, data.commentId, data.model);
  } catch (e) { core.warning(`Session start failed: ${e}`); }
}

export function sessionUpdate(db: DatabaseSync, runId: string, phase: string, extra?: SessionUpdateInput): void {
  try {
    const sets = [`phase = ?`, `last_heartbeat = datetime('now')`];
    const params: Array<string | number> = [phase];
    if (extra?.replyCommentId) { sets.push(`reply_comment_id = ?`); params.push(extra.replyCommentId); }
    if (extra?.attempt) { sets.push(`attempt = ?`); params.push(extra.attempt); }
    if (extra?.status) { sets.push(`status = ?`); params.push(extra.status); }
    if (extra?.error) { sets.push(`error = ?`); params.push(extra.error); }
    if (extra?.status === "completed" || extra?.status === "failed") { sets.push(`finished_at = datetime('now')`); }
    params.push(runId);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE run_id = ?`).run(...params);
  } catch (e) { core.warning(`Session update failed: ${e}`); }
}

export function auditLog(db: DatabaseSync, data: AuditLogInput): void {
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

export function logRouterDecision(db: DatabaseSync, data: RouterDecisionLogInput): void {
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

export function logContextOptimization(db: DatabaseSync, data: ContextOptimizationLogInput): void {
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

export function latestFollowupAuditId(db: DatabaseSync, sender: string, repo: string, prNumber: number): number | null {
  const row = db.prepare(
    `SELECT id FROM audit_log
     WHERE sender = ? AND repo = ? AND pr_number = ?
       AND status IN ('completed','completed-rtk-bypass','completed-cost-over-cap')
       AND timestamp >= datetime('now', '-15 minutes')
       AND timestamp < datetime('now', '-5 seconds')
     ORDER BY timestamp DESC LIMIT 1`,
  ).get(sender, repo, prNumber) as { id?: number } | undefined;
  return row?.id ?? null;
}

export function detectAndRecordFollowupAudit(db: DatabaseSync, sender: string, repo: string, prNumber: number): { previousAuditId: number | null } {
  const id = detectAndRecordFollowup(db, sender, repo, prNumber).previousAuditId;
  return { previousAuditId: id };
}

export function recordAuditQualitySignals(db: DatabaseSync, auditId: number, commitVerified: boolean): void {
  recordCommitVerification(db, auditId, commitVerified);
}

export function recordAuditCacheHit(db: DatabaseSync, auditId: number): void {
  recordCacheHit(db, auditId);
}
