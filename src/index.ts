import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import Anthropic from "@anthropic-ai/sdk";

// Model tiers — default is cheapest
const MODELS: Record<string, { id: string; label: string; cost: string }> = {
  haiku:  { id: "claude-haiku-4-5-20251001",  label: "Haiku",  cost: "$0.25/$1.25" },
  sonnet: { id: "claude-sonnet-4-20250514",    label: "Sonnet", cost: "$3/$15" },
  opus:   { id: "claude-opus-4-20250514",      label: "Opus",   cost: "$15/$75" },
};
const DEFAULT_MODEL = "haiku";

function parseModelFromMessage(message: string): { model: string; cleanMessage: string } {
  const lower = message.toLowerCase();

  for (const tier of ["opus", "sonnet", "haiku"]) {
    const pattern = new RegExp(`use\\s+${tier}`, "i");
    if (pattern.test(lower)) {
      const cleanMessage = message.replace(pattern, "").trim();
      return { model: tier, cleanMessage: cleanMessage || "review this PR" };
    }
  }

  return { model: DEFAULT_MODEL, cleanMessage: message };
}

async function run() {
  try {
    const trigger = core.getInput("trigger_phrase") || "@kai";
    const githubToken = core.getInput("github_token");
    const anthropicApiKey = core.getInput("anthropic_api_key");

    const { context } = github;
    const event = context.eventName;

    let commentBody = "";
    let commentId = 0;
    let issueNumber = 0;
    let sender = "";

    if (event === "issue_comment" || event === "pull_request_review_comment") {
      const payload = context.payload;
      commentBody = payload.comment?.body ?? "";
      commentId = payload.comment?.id ?? 0;
      sender = payload.comment?.user?.login ?? "";
      issueNumber =
        event === "issue_comment"
          ? payload.issue?.number ?? 0
          : payload.pull_request?.number ?? 0;
    }

    if (!commentBody.toLowerCase().includes(trigger.toLowerCase())) {
      core.info("No trigger found, skipping");
      return;
    }

    if (sender.includes("[bot]")) {
      core.info("Skipping bot comment");
      return;
    }

    core.info(`Triggered by @${sender} in #${issueNumber}`);

    const octokit = new Octokit({ auth: githubToken });
    const { owner, repo } = context.repo;

    // 1. Eyes reaction
    try {
      await octokit.reactions.createForIssueComment({
        owner, repo, comment_id: commentId, content: "eyes",
      });
    } catch { /* graceful */ }

    // 2. Extract message and model
    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    const rawMessage = commentBody.slice(idx + trigger.length).trim() || "review this PR";
    const { model: modelTier, cleanMessage: userMessage } = parseModelFromMessage(rawMessage);
    const selectedModel = MODELS[modelTier];

    core.info(`Model: ${selectedModel.label} (${selectedModel.id}) | Cost: ${selectedModel.cost}/MTok`);

    // 3. Create working comment
    const { data: reply } = await octokit.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: `> @${sender} — got it\n\n⏳ Working on it... _(${selectedModel.label})_\n\n_Delete this comment to cancel._`,
    });

    // 4. Get PR context
    let prDiff = "";
    let prTitle = "";
    let prBody = "";
    let filesList = "";

    try {
      await safeUpdate(octokit, owner, repo, reply.id,
        `> @${sender} — got it\n\n📖 Reading PR context... _(${selectedModel.label})_\n\n_Delete this comment to cancel._`);

      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: issueNumber });
      prTitle = pr.title;
      prBody = pr.body ?? "";

      const { data: files } = await octokit.pulls.listFiles({
        owner, repo, pull_number: issueNumber, per_page: 100,
      });
      filesList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`).join("\n");

      // Limit diff size based on model (cheaper model = smaller context to save tokens)
      const maxDiff = modelTier === "haiku" ? 30000 : modelTier === "sonnet" ? 60000 : 100000;
      const diffResponse = await octokit.pulls.get({
        owner, repo, pull_number: issueNumber,
        mediaType: { format: "diff" },
      });
      prDiff = String(diffResponse.data);
      if (prDiff.length > maxDiff) {
        prDiff = prDiff.slice(0, maxDiff) + `\n\n... (diff truncated at ${maxDiff} chars)`;
      }
    } catch (e: unknown) {
      core.warning(`Could not fetch PR context: ${e instanceof Error ? e.message : e}`);
    }

    // 5. Call Claude
    let result: string;

    if (anthropicApiKey) {
      try {
        await safeUpdate(octokit, owner, repo, reply.id,
          `> @${sender} — got it\n\n📖 Reading PR context...\n🔍 Analyzing with Claude ${selectedModel.label}...\n\n_Delete this comment to cancel._`);

        const response = await callClaude(anthropicApiKey, selectedModel.id, userMessage, prTitle, prBody, filesList, prDiff);
        const totalTokens = response.inputTokens + response.outputTokens;
        result = response.text;
        result += `\n\n_Model: **${selectedModel.label}** · Tokens: ${response.inputTokens.toLocaleString()} in / ${response.outputTokens.toLocaleString()} out (${totalTokens.toLocaleString()} total) · \`use sonnet\` or \`use opus\` for deeper analysis_`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        core.error(`Claude API error: ${msg}`);
        result = `⚠️ Claude API error: \`${msg}\``;
      }
    } else {
      result = `📋 **PR: ${prTitle}**\n\nFiles:\n${filesList}\n\n_Add \`ANTHROPIC_API_KEY\` for AI analysis._`;
    }

    // 6. Post result
    if (!(await commentExists(octokit, owner, repo, reply.id))) {
      core.info("Cancelled");
      return;
    }

    await safeUpdate(octokit, owner, repo, reply.id,
      `> @${sender}: ${rawMessage}\n\n${result}\n\n---\n_Kai (Kodif AI)_`);

    core.info("Done");
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function callClaude(
  apiKey: string, modelId: string, userMessage: string,
  prTitle: string, prBody: string, filesList: string, diff: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: `You are Kai — the Kodif AI engineering agent.
You are reviewing PR: "${prTitle}"

PR description:
${prBody || "(no description)"}

Files changed:
${filesList}

Full diff:
\`\`\`diff
${diff}
\`\`\`

Instructions:
- Answer the user's question about this PR
- If asked to review, check for: bugs, security issues, performance, code quality
- Be concise and actionable — use markdown
- Reference specific files and line numbers
- Keep responses focused — avoid unnecessary verbosity`,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("\n");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function safeUpdate(octokit: Octokit, owner: string, repo: string, id: number, body: string) {
  try { await octokit.issues.updateComment({ owner, repo, comment_id: id, body }); } catch { /* */ }
}

async function commentExists(octokit: Octokit, owner: string, repo: string, id: number): Promise<boolean> {
  try { await octokit.issues.getComment({ owner, repo, comment_id: id }); return true; } catch { return false; }
}

run();
