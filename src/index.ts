import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import Anthropic from "@anthropic-ai/sdk";

async function run() {
  try {
    const trigger = core.getInput("trigger_phrase") || "@kai";
    const githubToken = core.getInput("github_token");
    const anthropicApiKey = core.getInput("anthropic_api_key");

    const { context } = github;
    const event = context.eventName;

    // Parse comment event
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
      core.info("Added 👀 reaction");
    } catch {
      core.warning("Could not add reaction (missing permission?)");
    }

    // 2. Extract user message
    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    const userMessage = commentBody.slice(idx + trigger.length).trim() || "review this PR";

    // 3. Create working comment
    const { data: reply } = await octokit.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: `> @${sender} — got it\n\n⏳ Working on it...\n\n_Delete this comment to cancel._`,
    });
    core.info(`Created working comment #${reply.id}`);

    // 4. Get PR context
    let prDiff = "";
    let prTitle = "";
    let prBody = "";
    let filesList = "";

    try {
      await safeUpdate(octokit, owner, repo, reply.id,
        `> @${sender} — got it\n\n📖 Reading PR context...\n\n_Delete this comment to cancel._`);

      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: issueNumber });
      prTitle = pr.title;
      prBody = pr.body ?? "";

      const { data: files } = await octokit.pulls.listFiles({
        owner, repo, pull_number: issueNumber, per_page: 100,
      });
      filesList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`).join("\n");

      const diffResponse = await octokit.pulls.get({
        owner, repo, pull_number: issueNumber,
        mediaType: { format: "diff" },
      });
      prDiff = String(diffResponse.data);
      if (prDiff.length > 80000) {
        prDiff = prDiff.slice(0, 80000) + "\n\n... (diff truncated)";
      }
    } catch (e: unknown) {
      core.warning(`Could not fetch PR context: ${e instanceof Error ? e.message : e}`);
    }

    // 5. Call Claude or show PR info
    let result: string;

    if (anthropicApiKey) {
      try {
        await safeUpdate(octokit, owner, repo, reply.id,
          `> @${sender} — got it\n\n📖 Reading PR context...\n🔍 Analyzing with Claude...\n\n_Delete this comment to cancel._`);

        result = await callClaude(anthropicApiKey, userMessage, prTitle, prBody, filesList, prDiff);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        core.error(`Claude API error: ${msg}`);
        result = `⚠️ Claude API error: \`${msg}\`\n\nPR context loaded. Check \`ANTHROPIC_API_KEY\` secret and API balance.`;
      }
    } else {
      result = `📋 **PR: ${prTitle}**\n\nFiles changed:\n${filesList}\n\n_Add \`ANTHROPIC_API_KEY\` to repo secrets for AI analysis._`;
    }

    // 6. Post final result (check if comment still exists)
    if (!(await commentExists(octokit, owner, repo, reply.id))) {
      core.info("Working comment deleted — cancelled");
      return;
    }

    await safeUpdate(octokit, owner, repo, reply.id,
      `> @${sender}: ${userMessage}\n\n${result}\n\n---\n_Kai (Kodif AI)_`);

    core.info("Done");
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function callClaude(
  apiKey: string, userMessage: string,
  prTitle: string, prBody: string, filesList: string, diff: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
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
- Reference specific files and line numbers`,
    messages: [{ role: "user", content: userMessage }],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

async function safeUpdate(octokit: Octokit, owner: string, repo: string, id: number, body: string) {
  try { await octokit.issues.updateComment({ owner, repo, comment_id: id, body }); } catch { /* */ }
}

async function commentExists(octokit: Octokit, owner: string, repo: string, id: number): Promise<boolean> {
  try { await octokit.issues.getComment({ owner, repo, comment_id: id }); return true; } catch { return false; }
}

run();
