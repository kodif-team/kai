export type Config = {
  auditDbPath: string;
  routerUrl: string;
  routerModel: string;
  compressorUrl: string;
  compressorModel: string;
  compressorTimeoutMs: number;
  compressorMinQueryTokens: number;
  compressorMinPromptTokens: number;
  compressorBudgetHaiku: number;
  compressorBudgetSonnet: number;
  compressorBudgetOpus: number;
  routerHfRepo: string;
  routerGguf: string;
  routerMinBytes: number;
  compressorHfRepo: string;
  compressorGguf: string;
  compressorMinBytes: number;
  runnerAllowNoToken: boolean;
  runnerToken?: string;
  routerGitContext?: string;
  fileFocusModel: string;
  routerTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

function env(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env: ${name}`);
  return value.trim();
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function optEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function num(name: string, min: number, max: number, fallback?: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    if (fallback == null) throw new Error(`Missing required env: ${name}`);
    if (fallback < min || fallback > max) throw new Error(`${name} default out of range: ${fallback}`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  if (value < min || value > max) throw new Error(`${name} out of range: ${value} not in [${min}, ${max}]`);
  return value;
}

function bool(name: string, fallback?: boolean): boolean {
  const rawMaybe = process.env[name];
  if (!rawMaybe || !rawMaybe.trim()) {
    if (fallback == null) throw new Error(`Missing required env: ${name}`);
    return fallback;
  }
  const raw = rawMaybe.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function logLevel(name: string): "debug" | "info" | "warn" | "error" {
  const raw = env(name).toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  throw new Error(`Invalid log level for ${name}: ${raw}`);
}

export function loadConfig(): Config {
  const runnerAllowNoToken = bool("KAI_RUNNER_ALLOW_NO_TOKEN", false);
  const runnerToken = optEnv("RUNNER_TOKEN");
  if (!runnerAllowNoToken && !runnerToken) {
    throw new Error("RUNNER_TOKEN is required unless KAI_RUNNER_ALLOW_NO_TOKEN=true");
  }
  return {
    auditDbPath: env("KAI_AUDIT_DB"),
    routerUrl: envOr("KAI_ROUTER_URL", "http://kai-router:8080"),
    routerModel: envOr("KAI_ROUTER_MODEL", "LFM2-350M"),
    compressorUrl: envOr("KAI_COMPRESSOR_URL", "http://kai-compressor:8081"),
    compressorModel: envOr("KAI_COMPRESSOR_MODEL", "LFM2-350M"),
    compressorTimeoutMs: num("KAI_COMPRESSOR_TIMEOUT_MS", 1, 120_000, 1_500),
    compressorMinQueryTokens: num("KAI_COMPRESSOR_MIN_QUERY_TOKENS", 0, 1_000_000, 10),
    compressorMinPromptTokens: num("KAI_COMPRESSOR_MIN_PROMPT_TOKENS", 0, 1_000_000, 2_200),
    compressorBudgetHaiku: num("KAI_COMPRESSOR_BUDGET_HAIKU", 0, 1_000_000, 3_000),
    compressorBudgetSonnet: num("KAI_COMPRESSOR_BUDGET_SONNET", 0, 1_000_000, 10_000),
    compressorBudgetOpus: num("KAI_COMPRESSOR_BUDGET_OPUS", 0, 1_000_000, 20_000),
    routerHfRepo: env("KAI_ROUTER_HF_REPO"),
    routerGguf: env("KAI_ROUTER_GGUF"),
    routerMinBytes: num("KAI_ROUTER_MIN_BYTES", 1, 10_000_000_000),
    compressorHfRepo: env("KAI_COMPRESSOR_HF_REPO"),
    compressorGguf: env("KAI_COMPRESSOR_GGUF"),
    compressorMinBytes: num("KAI_COMPRESSOR_MIN_BYTES", 1, 10_000_000_000),
    runnerAllowNoToken,
    runnerToken,
    routerGitContext: env("KAI_ROUTER_GIT_CONTEXT"),
    fileFocusModel: envOr("KAI_FILE_FOCUS_MODEL", "LFM2-350M"),
    routerTimeoutMs: num("KAI_ROUTER_TIMEOUT_MS", 1, 120_000, 5_000),
    logLevel: logLevel("KAI_LOG_LEVEL"),
  };
}
