import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { RouterDecision } from "./router";

type ContextPackInput = {
  runId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  userMessage: string;
  rawMessage: string;
  route: RouterDecision;
  prTitle: string;
  prBody: string;
  filesList: string;
  prCommentsContext: string;
  repoFullName: string;
  prDiffDigest?: string;
  architectureContext?: string;
};

export type DynamicContextPack = {
  baseDir: string;
  manifestPath: string;
  historyPath: string;
};

function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function contentOrLabel(value: string | undefined, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return fallback;
}

function repoServiceName(repoFullName: string): string {
  return posix.basename(repoFullName);
}

export function createDynamicContextPack(input: ContextPackInput): DynamicContextPack {
  const dirName = sanitizeSegment(input.runId);
  const baseDir = join("/tmp", "kai-context", dirName);
  mkdirSync(baseDir, { recursive: true });

  const taskPath = join(baseDir, "task.txt");
  const prMetaPath = join(baseDir, "pr-meta.txt");
  const changedFilesPath = join(baseDir, "changed-files.txt");
  const commentsPath = join(baseDir, "comments.txt");
  const prDiffPath = join(baseDir, "pr-diff.diff");
  const architecturePath = join(baseDir, "architecture.txt");
  const historyPath = join(baseDir, "history.jsonl");
  const manifestPath = join(baseDir, "manifest.json");

  writeFileSync(taskPath, [
    `Task from user: ${input.userMessage}`,
    `Raw mention tail: ${input.rawMessage}`,
    `Router decision: ${input.route.intent} -> ${input.route.decision}`,
    `Reason: ${input.route.reason}`,
  ].join("\n"), "utf-8");

  writeFileSync(prMetaPath, [
    `Repository: ${input.repoFullName}`,
    `PR #${input.issueNumber}: ${input.prTitle}`,
    `Description:`,
    contentOrLabel(input.prBody, "(empty)"),
  ].join("\n"), "utf-8");

  writeFileSync(changedFilesPath, contentOrLabel(input.filesList, "(none)"), "utf-8");
  writeFileSync(commentsPath, contentOrLabel(input.prCommentsContext, "(none)"), "utf-8");
  writeFileSync(prDiffPath, contentOrLabel(input.prDiffDigest, "(none)"), "utf-8");

  if (input.architectureContext) {
    writeFileSync(architecturePath, input.architectureContext, "utf-8");
  }

  const manifest = {
    runId: input.runId,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    route: {
      intent: input.route.intent,
      decision: input.route.decision,
      confidence: input.route.confidence,
      source: input.route.source ?? "unknown",
    },
    files: {
      task: taskPath,
      prMeta: prMetaPath,
      changedFiles: changedFilesPath,
      prDiff: prDiffPath,
      comments: commentsPath,
      architecture: input.architectureContext ? architecturePath : null,
      history: historyPath,
    },
    optimizationChain: "RTK + local context compression",
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  writeFileSync(historyPath, `${JSON.stringify({ ts: new Date().toISOString(), event: "context-pack-created" })}\n`, "utf-8");

  return { baseDir, manifestPath, historyPath };
}

export function appendContextHistory(historyPath: string, event: string, payload: Record<string, unknown>): void {
  appendFileSync(historyPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload,
  })}\n`, "utf-8");
}

export function buildDynamicPromptFromManifest(
  userMessage: string,
  repoFullName: string,
  route: RouterDecision,
  manifestPath: string,
  isArchitectureTask: boolean,
  prDiffDigest: string,
): string {
  const core = [
    `Kai, AI code reviewer. Service: repos/${repoServiceName(repoFullName)}.`,
    `Task: ${userMessage}`,
    `Router: intent=${route.intent}; decision=${route.decision}; confidence=${route.confidence}; contextBudget=${route.maxContextTokens}; commitExpected=${route.commitExpected}`,
    `Dynamic context manifest: ${manifestPath}`,
    "Optimization chain: RTK command rewrites + local context compression.",
    "Read only the necessary context files from manifest (start with task + changed-files + pr-meta).",
  ];

  if (prDiffDigest) {
    core.push(`Full PR diff (pre-fetched via GitHub API — do NOT re-run \`git diff\`):\n\`\`\`diff\n${prDiffDigest}\n\`\`\``);
  }

  if (isArchitectureTask) {
    core.push("For architecture requests, read the architecture context file from manifest and focus on system/service relations.");
  } else {
    core.push("For code tasks, inspect the embedded PR diff first; then fetch extra context lazily only when the diff is insufficient.");
    core.push("Ignore bot/infrastructure files unless explicitly requested (.github/, .claude/, CLAUDE.md, workflow yml).");
  }

  core.push("Keep response concise markdown with concrete file references and avoid repeating prior analysis.");
  return core.join("\n");
}
