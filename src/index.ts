import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { DatabaseSync } from "node:sqlite";
import { routeEventWithLocalLLM, type RouterDecision } from "./router";
import { templateForRoute } from "./templates";
import { initAuditDb, checkRateLimit, recordRateLimit, auditLog, logRouterDecision } from "./audit";
import { loadConfig } from "./config";
import { createLogger, errorMeta } from "./log";

type Logger = ReturnType<typeof createLogger>;
let log: Logger | null = null;

const LOCAL_LLM_MODEL = "LFM2-350M";
const DEFAULT_TRIGGER_PHRASE = "@kai";
const EMPTY_MESSAGE_LABEL = "(empty)";
const TRIGGER_MESSAGE_LABEL = "(trigger)";

function optionalInput(name: string): string | null {
  const value = core.getInput(name);
  if (!value || !value.trim()) return null;
  return value.trim();
}

function requireInput(name: string): string {
  const value = optionalInput(name);
  if (value === null) throw new Error(`Missing required input: ${name}`);
  return value;
}

function inputOrConstant(inputName: string, fallback: string): string {
  const value = optionalInput(inputName);
  if (value !== null) return value;
  return fallback;
}

function displayMessage(message: string, fallback: string): string {
  if (message.trim().length > 0) return message;
  return fallback;
}

function buildSimpleFooter(model: string, durationSec: number): string {
  return `Kai · ${model} · ${durationSec}s · OpenHands integration: pending`;
}

async function run() {
  let octokit: Octokit | null = null;
  let owner = "", repo = "", replyCommentId = 0;
  let sender = "", rawMessage = "";
  let auditDbPath: string | null = null;

  try {
    const cfg = loadConfig();
    auditDbPath = cfg.auditDbPath;
    log = createLogger("kai-action", cfg.logLevel);
    const trigger = inputOrConstant("trigger_phrase", DEFAULT_TRIGGER_PHRASE);
    const githubToken = requireInput("github_token");
    const routerUrl = inputOrConstant("router_url", cfg.routerUrl ?? "");
    const routerModel = LOCAL_LLM_MODEL;

    const { context } = github;
    const event = context.eventName;

    let commentBody = "", commentId = 0, issueNumber = 0;

    if (event === "issue_comment" || event === "pull_request_review_comment") {
      const payload = context.payload;
      commentBody = payload.comment?.body ?? "";
      commentId = payload.comment?.id ?? 0;
      sender = payload.comment?.user?.login ?? "";
      if (event === "issue_comment") {
        issueNumber = payload.issue?.number ?? 0;
      } else {
        issueNumber = payload.pull_request?.number ?? 0;
      }
    }

    if (!commentBody.toLowerCase().includes(trigger.toLowerCase())) return;
    if (sender.includes("[bot]")) return;

    octokit = new Octokit({ auth: githubToken });
    ({ owner, repo } = context.repo);

    const auditDb = initAuditDb(cfg.auditDbPath);

    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    rawMessage = commentBody.slice(idx + trigger.length).trim();

    core.info(`============================================================`);
    core.info(`KAI REQUEST RECEIVED`);
    core.info(`  Sender:    @${sender}`);
    core.info(`  Repo:      ${owner}/${repo}`);
    core.info(`  PR/Issue:  #${issueNumber}`);
    core.info(`  Comment:   ${commentId}`);
    core.info(`  Raw msg:   ${rawMessage}`);
    core.info(`  Event:     ${event}`);
    core.info(`============================================================`);

    const route = await routeEventWithLocalLLM(rawMessage, "haiku", {
      url: routerUrl,
      model: routerModel,
      timeoutMs: cfg.routerTimeoutMs,
    });

    core.info(`Router decision: intent=${route.intent} decision=${route.decision} confidence=${route.confidence} reason="${route.reason}"`);

    const runId = `${owner}/${repo}#${issueNumber}-${Date.now()}`;
    const startTime = Date.now();
    logRouterDecision(auditDb, {
      repo: `${owner}/${repo}`, prNumber: issueNumber, commentId, sender, route,
    });

    auditLog(auditDb, {
      sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
      model: routerModel, message: rawMessage, status: "started",
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

    const rateLimit = checkRateLimit(auditDb, sender, `${owner}/${repo}`);
    if (!rateLimit.allowed) {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildSimpleFooter(routerModel, durationSec);
      const { data: rlReply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}\n\n⛔ Rate limit hit: ${rateLimit.reason}. Try again later.\n\n---\n<sub>${footer}</sub>`,
      });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "rate-limited", error: rateLimit.reason,
      });
      core.warning(`Rate-limited @${sender}: ${rateLimit.reason}`);
      return;
    }

    if (route.decision === "ask-clarification") {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildSimpleFooter(routerModel, durationSec);
      const template = templateForRoute(route);
      const { data: reply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${displayMessage(rawMessage, EMPTY_MESSAGE_LABEL)}\n\n${template}\n\n---\n<sub>${footer}</sub>`,
      });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "needs-input",
      });
      core.info(`Clarification requested by local router (${routerModel})`);
      return;
    }

    if (route.decision === "reply-template") {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const footer = buildSimpleFooter(routerModel, durationSec);
      const template = templateForRoute(route);
      const { data: reply } = await octokit.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `> @${sender}: ${rawMessage}\n\n${template}\n\n---\n<sub>${footer}</sub>`,
      });
      auditLog(auditDb, {
        sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
        model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
        costUsd: 0, tokensIn: 0, tokensOut: 0, status: "completed",
      });
      recordRateLimit(auditDb, sender, `${owner}/${repo}`, "local-template", 0);
      core.info(`Template reply by local router (${routerModel})`);
      return;
    }

    // Valid request — log and acknowledge (OpenHands integration pending)
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const footer = buildSimpleFooter(routerModel, durationSec);
    const { data: reply } = await octokit.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: `> @${sender}: ${rawMessage}\n\n✅ **Accepted** — intent: \`${route.intent}\`.\n\nOpenHands integration is pending. This request has been logged.\n\n---\n<sub>${footer}</sub>`,
    });
    replyCommentId = reply.id;

    core.info(`============================================================`);
    core.info(`KAI REQUEST ACCEPTED (OpenHands pending)`);
    core.info(`  Intent:    ${route.intent}`);
    core.info(`  Reply ID:  ${replyCommentId}`);
    core.info(`  Duration:  ${durationSec}s`);
    core.info(`============================================================`);

    auditLog(auditDb, {
      sender, repo: `${owner}/${repo}`, prNumber: issueNumber,
      model: routerModel, message: rawMessage, durationMs: Date.now() - startTime,
      costUsd: 0, tokensIn: 0, tokensOut: 0, status: "accepted-pending-openhands",
    });
    recordRateLimit(auditDb, sender, `${owner}/${repo}`, "pending", 0);
    core.info("Done");

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (log) {
      log.error("kai-action failed", { ...errorMeta(error), message: msg, owner, repo, sender });
    } else {
      core.error(`kai-action failed: ${msg}`);
    }

    try {
      if (auditDbPath === null) throw new Error("audit DB path unavailable");
      const db = initAuditDb(auditDbPath);
      auditLog(db, {
        sender: displayMessage(sender, "unknown"), repo: owner && repo ? `${owner}/${repo}` : "unknown",
        prNumber: 0, model: "unknown", message: rawMessage,
        status: "error", error: msg.slice(0, 500),
      });
    } catch { /* audit itself should never crash the handler */ }

    if (octokit && owner && repo) {
      const errorBody = `> @${sender}: ${displayMessage(rawMessage, TRIGGER_MESSAGE_LABEL)}\n\n⚠️ **Kai error:**\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\`\n\nCheck runner logs or contact infra team.\n\n---\n<sub>Kai (Kodif AI)</sub>`;
      try {
        if (replyCommentId) {
          await octokit.issues.updateComment({ owner, repo, comment_id: replyCommentId, body: errorBody });
        } else {
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

process.on("uncaughtException", (err) => {
  core.error(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
});

process.on("unhandledRejection", (err) => {
  core.error(`unhandledRejection: ${err instanceof Error ? err.message : String(err)}`);
});

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(msg);
});
