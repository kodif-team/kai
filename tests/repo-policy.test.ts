import assert from "node:assert/strict";
import test from "node:test";

import { checkRepoCodeChangeConsent, evaluateCodeChangeConsent, parseRepoConsentPolicy } from "../dist/repo-policy.js";

const validPolicy = `
version: 1

agent:
  enabled: true

permissions:
  code_changes: true
  pull_requests: true
  direct_push: false
  merge: false

branches:
  bot_branch_prefix: kai/
  allowed_targets:
    - main

triggers:
  github_comments: true
  jira: true
`;

function encodedFile(content: string) {
  return { type: "file", content: Buffer.from(content, "utf8").toString("base64") };
}

test("valid v1 repo consent policy allows code changes through PRs only", () => {
  const policy = parseRepoConsentPolicy(validPolicy);

  assert.deepEqual(evaluateCodeChangeConsent(policy), { allowed: true, policy });
});

test("repo consent policy blocks disabled code changes", () => {
  const policy = parseRepoConsentPolicy(validPolicy.replace("code_changes: true", "code_changes: false"));
  const result = evaluateCodeChangeConsent(policy);

  assert.equal(result.allowed, false);
  assert.match(result.reason, /code_changes/);
});

test("repo consent policy blocks merge permission", () => {
  const policy = parseRepoConsentPolicy(validPolicy.replace("merge: false", "merge: true"));
  const result = evaluateCodeChangeConsent(policy);

  assert.equal(result.allowed, false);
  assert.match(result.reason, /merge/);
});

test("repo consent check reads policy from default branch", async () => {
  const calls: Array<{ ref: string; path: string }> = [];
  const client = {
    repos: {
      get: async () => ({ data: { default_branch: "main" } }),
      getContent: async ({ path, ref }: { path: string; ref: string }) => {
        calls.push({ path, ref });
        return { data: encodedFile(validPolicy) };
      },
    },
  };

  const result = await checkRepoCodeChangeConsent(client, "owner", "repo");

  assert.equal(result.allowed, true);
  assert.deepEqual(calls, [{ path: ".github/kodif-ai.yml", ref: "main" }]);
});

test("repo consent check blocks missing policy file", async () => {
  const client = {
    repos: {
      get: async () => ({ data: { default_branch: "main" } }),
      getContent: async () => {
        const error = new Error("not found") as Error & { status: number };
        error.status = 404;
        throw error;
      },
    },
  };

  const result = await checkRepoCodeChangeConsent(client, "owner", "repo");

  assert.equal(result.allowed, false);
  assert.match(result.reason, /missing/);
});
