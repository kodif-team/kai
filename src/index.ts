import * as core from "@actions/core";
import * as github from "@actions/github";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

async function run() {
  try {
    const trigger = core.getInput("trigger_phrase") || "@kai";
    const appId = core.getInput("app_id");
    const appPrivateKey = core.getInput("app_private_key");
    const githubToken = core.getInput("github_token");

    const { context } = github;
    const event = context.eventName;

    // Get comment body
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

    // Check trigger
    if (!commentBody.toLowerCase().includes(trigger.toLowerCase())) {
      core.info(`No trigger "${trigger}" found in comment, skipping`);
      return;
    }

    // Skip bot comments
    if (sender.includes("[bot]")) {
      core.info("Skipping bot comment");
      return;
    }

    core.info(`Triggered by @${sender} in #${issueNumber}`);

    // Create authenticated Octokit
    let octokit: Octokit;

    if (appId && appPrivateKey) {
      // GitHub App auth → posts as kai[bot]
      const installationId = await getInstallationId(
        appId,
        appPrivateKey,
        context.repo.owner,
      );
      octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey: appPrivateKey,
          installationId,
        },
      });
      core.info("Authenticated as GitHub App (kai[bot])");
    } else {
      // Fallback to GITHUB_TOKEN
      octokit = new Octokit({ auth: githubToken });
      core.info("Authenticated with GITHUB_TOKEN");
    }

    const { owner, repo } = context.repo;

    // 1. Add eyes reaction (graceful — may fail if app lacks reactions permission)
    try {
      await octokit.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content: "eyes",
      });
      core.info("Added 👀 reaction");
    } catch (e: unknown) {
      core.warning(`Could not add reaction: ${e instanceof Error ? e.message : e}`);
    }

    // 2. Extract user message
    const idx = commentBody
      .toLowerCase()
      .indexOf(trigger.toLowerCase());
    const userMessage =
      commentBody.slice(idx + trigger.length).trim() || "review this PR";

    // 3. Create working comment
    const { data: reply } = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body:
        `> @${sender} — got it\n\n` +
        `⏳ Working on it...\n\n` +
        `_Delete this comment to cancel._`,
    });
    core.info(`Created working comment #${reply.id}`);

    // 4. Update with progress
    const steps = [
      "📖 Reading PR context...",
      "🔍 Analyzing changes...",
      "✍️ Preparing response...",
    ];

    for (let i = 0; i < steps.length; i++) {
      // Check if comment still exists (deleted = cancel)
      try {
        await octokit.issues.getComment({
          owner,
          repo,
          comment_id: reply.id,
        });
      } catch {
        core.info("Working comment was deleted — cancelled");
        return;
      }

      const progress = steps.slice(0, i + 1).join("\n");
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: reply.id,
        body:
          `> @${sender} — got it\n\n` +
          `${progress}\n\n` +
          `_Delete this comment to cancel._`,
      });

      // Simulate work
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 5. Final result (placeholder)
    await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: reply.id,
      body:
        `> @${sender}: ${userMessage}\n\n` +
        `✅ Done!\n\n` +
        `_Claude API integration coming next._\n\n` +
        `---\n_Kai (Kodif AI)_`,
    });

    core.info("Job completed");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

async function getInstallationId(
  appId: string,
  privateKey: string,
  owner: string,
): Promise<number> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
  });

  const { data: installations } =
    await appOctokit.apps.listInstallations();
  const inst = installations.find(
    (i) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
  );

  if (!inst) {
    throw new Error(
      `kai-kodif app not installed on ${owner}. Install at https://github.com/apps/kai-kodif`,
    );
  }

  return inst.id;
}

run();
