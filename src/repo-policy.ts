export const DEFAULT_POLICY_PATH = ".github/kodif-ai.yml";

export type RepoConsentPolicy = {
  version: number;
  agent: {
    enabled: boolean;
  };
  permissions: {
    code_changes: boolean;
    pull_requests: boolean;
    direct_push: boolean;
    merge: boolean;
  };
};

export type RepoConsentResult =
  | { allowed: true; policy: RepoConsentPolicy }
  | { allowed: false; reason: string };

type ContentsResponse = {
  data: unknown;
};

type RepoReader = {
  repos: {
    get: (params: { owner: string; repo: string }) => Promise<{ data: { default_branch?: string | null } }>;
    getContent: (params: { owner: string; repo: string; path: string; ref: string }) => Promise<ContentsResponse>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64(content: string): string {
  return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
}

function getFileContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload.type !== "file" || typeof payload.content !== "string") return null;
  return decodeBase64(payload.content);
}

function parseBool(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

export function parseRepoConsentPolicy(source: string): RepoConsentPolicy {
  const values = new Map<string, string>();
  const sectionStack: Array<{ indent: number; key: string }> = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;

    if (/^\s*-\s+/.test(withoutComment)) continue;

    const match = withoutComment.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      throw new Error(`Unsupported policy syntax: ${rawLine.trim()}`);
    }

    const indent = match[1].length;
    const key = match[2];
    const value = (match[3] ?? "").trim();

    while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].indent >= indent) {
      sectionStack.pop();
    }

    const path = [...sectionStack.map((entry) => entry.key), key].join(".");
    if (value === "") {
      sectionStack.push({ indent, key });
    } else {
      values.set(path, value.replace(/^["']|["']$/g, ""));
    }
  }

  const version = Number(values.get("version"));
  if (version !== 1) {
    throw new Error("version must be 1");
  }

  const requiredBool = (path: string): boolean => {
    const raw = values.get(path);
    if (raw === undefined) throw new Error(`${path} is required`);
    const parsed = parseBool(raw);
    if (parsed === null) throw new Error(`${path} must be true or false`);
    return parsed;
  };

  return {
    version,
    agent: {
      enabled: requiredBool("agent.enabled"),
    },
    permissions: {
      code_changes: requiredBool("permissions.code_changes"),
      pull_requests: requiredBool("permissions.pull_requests"),
      direct_push: requiredBool("permissions.direct_push"),
      merge: requiredBool("permissions.merge"),
    },
  };
}

export function evaluateCodeChangeConsent(policy: RepoConsentPolicy): RepoConsentResult {
  if (!policy.agent.enabled) {
    return { allowed: false, reason: "agent.enabled is false" };
  }
  if (!policy.permissions.code_changes) {
    return { allowed: false, reason: "permissions.code_changes is false" };
  }
  if (!policy.permissions.pull_requests) {
    return { allowed: false, reason: "permissions.pull_requests is false" };
  }
  if (policy.permissions.direct_push) {
    return { allowed: false, reason: "permissions.direct_push must remain false for v1" };
  }
  if (policy.permissions.merge) {
    return { allowed: false, reason: "permissions.merge must remain false" };
  }
  return { allowed: true, policy };
}

export async function checkRepoCodeChangeConsent(
  client: RepoReader,
  owner: string,
  repo: string,
  policyPath = DEFAULT_POLICY_PATH,
): Promise<RepoConsentResult> {
  let defaultBranch: string;
  try {
    const { data } = await client.repos.get({ owner, repo });
    defaultBranch = data.default_branch || "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { allowed: false, reason: `could not read repository metadata: ${message}` };
  }

  if (!defaultBranch) {
    return { allowed: false, reason: "repository default branch is unavailable" };
  }

  let content: string | null;
  try {
    const { data } = await client.repos.getContent({ owner, repo, path: policyPath, ref: defaultBranch });
    content = getFileContent(data);
  } catch (error) {
    const status = isRecord(error) && typeof error.status === "number" ? error.status : 0;
    if (status === 404) {
      return { allowed: false, reason: `${policyPath} is missing on default branch ${defaultBranch}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { allowed: false, reason: `could not read ${policyPath}: ${message}` };
  }

  if (content === null) {
    return { allowed: false, reason: `${policyPath} is not a regular file` };
  }

  try {
    return evaluateCodeChangeConsent(parseRepoConsentPolicy(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { allowed: false, reason: `${policyPath} is invalid: ${message}` };
  }
}
