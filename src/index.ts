import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

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

function hasClaudeCLI(): boolean {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch { return false; }
}

function hasRTK(): boolean {
  try {
    // Verify it's rtk-ai/rtk (has 'rewrite' command), not the crates.io rtk
    execSync("rtk rewrite echo test", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch { return false; }
}

// --- Claude Code CLI execution (preferred — uses RTK) ---

interface CLIResult {
  text: string;
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  mode: "cli";
  rtk: boolean;
  rtkSavings: string;
}

async function callClaudeCLI(
  apiKey: string, modelId: string, userMessage: string,
  prTitle: string, prBody: string, filesList: string, diff: string,
): Promise<CLIResult> {
  const rtk = hasRTK();

  // Give Claude the task + tell it to use tools to inspect the code.
  // This makes Claude run bash commands (git diff, read files, etc) → RTK intercepts them.
  const prompt = [
    `You are Kai — the Kodif AI engineering agent.`,
    `PR: "${prTitle}"`,
    prBody ? `Description: ${prBody}` : "",
    `\nChanged files:\n${filesList}`,
    `\nThe repo is checked out. Use Bash and Read tools to inspect the code.`,
    `Run: git diff origin/main...HEAD to see changes.`,
    `Run: git log --oneline -5 for recent commits.`,
    `Then: ${userMessage}`,
    `\nBe concise and actionable. Use markdown. Reference files and line numbers.`,
  ].filter(Boolean).join("\n");

  // Drop to 'kai' user if running as root (Claude blocks --dangerously-skip-permissions under root)
  const isRoot = process.getuid?.() === 0;
  const claudeArgs = `-p --dangerously-skip-permissions --output-format json --max-turns 15 --model ${modelId}`;
  const cmd = isRoot
    ? `su -s /bin/bash kai -c 'ANTHROPIC_API_KEY=${apiKey} claude ${claudeArgs}'`
    : `claude ${claudeArgs}`;

  core.info(`Executing: ${rtk ? "rtk → " : ""}claude CLI (${modelId})`);

  const output = execSync(cmd, {
    input: prompt,
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000,
    encoding: "utf-8",
  });

  // Parse JSON output
  const json = JSON.parse(output);

  // Get RTK savings percentage after the run
  let rtkSavings = "";
  if (rtk) {
    try {
      const gainCmd = isRoot
        ? `su -s /bin/bash kai -c 'rtk gain --json 2>/dev/null || rtk gain 2>/dev/null'`
        : `rtk gain --json 2>/dev/null || rtk gain 2>/dev/null`;
      const raw = execSync(gainCmd, { encoding: "utf-8", timeout: 5000 }).trim();
      // Try to parse JSON for percentage, fall back to regex
      try {
        const g = JSON.parse(raw);
        rtkSavings = g.savings_percent ?? g.percent ?? "";
      } catch {
        const m = raw.match(/(\d+(?:\.\d+)?)\s*%/);
        rtkSavings = m ? m[1] + "%" : raw;
      }
    } catch { /* */ }
  }

  return {
    text: json.result ?? json.content ?? output,
    costUsd: json.total_cost_usd ?? json.cost_usd ?? 0,
    numTurns: json.num_turns ?? 1,
    inputTokens: (json.usage?.input_tokens ?? 0)
      + (json.usage?.cache_read_input_tokens ?? 0)
      + (json.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: json.usage?.output_tokens ?? 0,
    mode: "cli",
    rtk,
    rtkSavings,
  };
}

// --- Direct API fallback (when CLI not available) ---

interface APIResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  mode: "api";
}

async function callClaudeAPI(
  apiKey: string, modelId: string, userMessage: string,
  prTitle: string, prBody: string, filesList: string, diff: string,
): Promise<APIResult> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: `You are Kai — the Kodif AI engineering agent.
You are reviewing PR: "${prTitle}"
${prBody ? `\nPR description: ${prBody}` : ""}
\nFiles changed:\n${filesList}
\nFull diff:\n\`\`\`diff\n${diff}\n\`\`\`
\nBe concise and actionable. Use markdown. Reference files and line numbers.`,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text).join("\n");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    mode: "api",
  };
}

// --- Main ---

async function run() {
  try {
    const trigger = core.getInput("trigger_phrase") || "@kai";
    const githubToken = core.getInput("github_token");
    const anthropicApiKey = core.getInput("anthropic_api_key");

    const { context } = github;
    const event = context.eventName;

    let commentBody = "", commentId = 0, issueNumber = 0, sender = "";

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

    const octokit = new Octokit({ auth: githubToken });
    const { owner, repo } = context.repo;

    try {
      await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content: "eyes" });
    } catch { /* */ }

    const idx = commentBody.toLowerCase().indexOf(trigger.toLowerCase());
    const rawMessage = commentBody.slice(idx + trigger.length).trim() || "review this PR";
    const { model: modelTier, cleanMessage: userMessage } = parseModelFromMessage(rawMessage);
    const selectedModel = MODELS[modelTier];

    // Detect execution mode
    const useCLI = hasClaudeCLI();
    const modeLabel = useCLI ? "CLI" + (hasRTK() ? " + RTK" : "") : "API";
    core.info(`Mode: ${modeLabel} | Model: ${selectedModel.label}`);

    const { data: reply } = await octokit.issues.createComment({
      owner, repo, issue_number: issueNumber,
      body: `> @${sender} — got it\n\n⏳ Working on it... _(${selectedModel.label}, ${modeLabel})_\n\n_Delete this comment to cancel._`,
    });

    // Get PR context
    let prDiff = "", prTitle = "", prBody = "", filesList = "";

    try {
      await safeUpdate(octokit, owner, repo, reply.id,
        `> @${sender} — got it\n\n📖 Reading PR... _(${selectedModel.label}, ${modeLabel})_\n\n_Delete this comment to cancel._`);

      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: issueNumber });
      prTitle = pr.title;
      prBody = pr.body ?? "";

      // Checkout PR branch so CLI can read the actual files
      try {
        execSync(`git fetch origin ${pr.head.ref} && git checkout ${pr.head.ref}`, {
          stdio: "pipe", timeout: 30_000, encoding: "utf-8",
        });
        core.info(`Checked out PR branch: ${pr.head.ref}`);
      } catch (e: unknown) {
        core.warning(`Could not checkout PR branch: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }

      const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: issueNumber, per_page: 100 });
      filesList = files.map(f => `- ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`).join("\n");

      const maxDiff = modelTier === "haiku" ? 30000 : modelTier === "sonnet" ? 60000 : 100000;
      const diffResp = await octokit.pulls.get({ owner, repo, pull_number: issueNumber, mediaType: { format: "diff" } });
      prDiff = String(diffResp.data);
      if (prDiff.length > maxDiff) prDiff = prDiff.slice(0, maxDiff) + "\n\n... (truncated)";
    } catch (e: unknown) {
      core.warning(`PR context error: ${e instanceof Error ? e.message : e}`);
    }

    // Call Claude (CLI or API)
    let result = "";
    let footer = "";

    if (!anthropicApiKey) {
      result = `📋 **PR: ${prTitle}**\n\nFiles:\n${filesList}`;
      footer = `_Add \`ANTHROPIC_API_KEY\` for AI analysis._`;
    } else {
      try {
        await safeUpdate(octokit, owner, repo, reply.id,
          `> @${sender} — got it\n\n📖 Reading PR...\n🔍 Analyzing... _(${selectedModel.label}, ${modeLabel})_\n\n_Delete this comment to cancel._`);

        let usedCLI = false;
        if (useCLI) {
          try {
            const r = await callClaudeCLI(anthropicApiKey, selectedModel.id, userMessage, prTitle, prBody, filesList, prDiff);
            result = r.text;
            usedCLI = true;

            const totalTokens = r.inputTokens + r.outputTokens;
            const rtkPct = r.rtk && r.rtkSavings ? r.rtkSavings : "— %";
            footer = `RTK saves ${rtkPct} | Tokens: ${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out (${totalTokens.toLocaleString()} total) $${r.costUsd.toFixed(4)} · ${r.numTurns} turn(s) | use sonnet or use opus for deeper analysis`;
          } catch (cliErr: unknown) {
            core.warning(`CLI failed, falling back to API: ${cliErr instanceof Error ? cliErr.message.slice(0, 100) : cliErr}`);
          }
        }
        if (!usedCLI) {
          const r = await callClaudeAPI(anthropicApiKey, selectedModel.id, userMessage, prTitle, prBody, filesList, prDiff);
          const total = r.inputTokens + r.outputTokens;
          result = r.text;
          footer = `RTK saves — % | Tokens: ${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out (${total.toLocaleString()} total) | use sonnet or use opus for deeper analysis`;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        core.error(`Claude error: ${msg}`);
        result = `⚠️ Error: \`${msg.slice(0, 200)}\``;
        footer = "";
      }
    }

    if (!(await commentExists(octokit, owner, repo, reply.id))) {
      core.info("Cancelled");
      return;
    }

    await safeUpdate(octokit, owner, repo, reply.id,
      `> @${sender}: ${rawMessage}\n\n${result}\n\n---\n<sub>${footer}</sub>`);

    core.info("Done");
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function safeUpdate(o: Octokit, owner: string, repo: string, id: number, body: string) {
  try { await o.issues.updateComment({ owner, repo, comment_id: id, body }); } catch { /* */ }
}

async function commentExists(o: Octokit, owner: string, repo: string, id: number): Promise<boolean> {
  try { await o.issues.getComment({ owner, repo, comment_id: id }); return true; } catch { return false; }
}

run();
