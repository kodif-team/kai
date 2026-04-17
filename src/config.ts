import { LogLevel, parseLogLevel } from "./log";

export type Config = {
  runtimeEnv: NodeJS.ProcessEnv;
  reposPath: string | null;
  routerUrl: string | null;
  compressorUrl: string | null;
  compressorDisabled: boolean | null;
  auditDbPath: string;
  compressorTimeoutMs: number;
  compressorMinQueryTokens: number;
  compressorMinPromptTokens: number;
  compressorBudgetHaiku: number;
  compressorBudgetSonnet: number;
  compressorBudgetOpus: number;
  runnerAllowNoToken: boolean;
  runnerToken: string | null;
  routerGitContext?: string;
  claudeSettingsPath: string;
  rtkHookSkipCheck: boolean;
  tierSuggestDisabled: boolean;
  debugCompressor: boolean;
  routerTimeoutMs: number;
  logLevel: LogLevel;
};

const COMPRESSOR_TIMEOUT_MS = 1_500;
const COMPRESSOR_MIN_QUERY_TOKENS = 10;
const COMPRESSOR_MIN_PROMPT_TOKENS = 500;
const COMPRESSOR_BUDGET_HAIKU = 3_000;
const COMPRESSOR_BUDGET_SONNET = 10_000;
const COMPRESSOR_BUDGET_OPUS = 20_000;
const ROUTER_TIMEOUT_MS = 5_000;
const DEFAULT_CLAUDE_SETTINGS_PATH = "/home/kai/.claude/settings.json";
const DEFAULT_RTK_HOOK_SKIP_CHECK = false;
const DEFAULT_TIER_SUGGEST_DISABLE = false;
const DEFAULT_DEBUG_COMPRESSOR = false;

function env(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required env: ${name}`);
  return value.trim();
}

function optEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function bool(name: string): boolean {
  const rawMaybe = process.env[name];
  if (!rawMaybe || !rawMaybe.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  const raw = rawMaybe.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function optBool(name: string): boolean | null {
  const rawMaybe = optEnv(name);
  if (rawMaybe === null) return null;
  const raw = rawMaybe.toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function boolOrConstant(name: string, fallback: boolean): boolean {
  const value = optBool(name);
  if (value !== null) return value;
  return fallback;
}

function envOrConstant(name: string, fallback: string): string {
  const value = optEnv(name);
  if (value !== null) return value;
  return fallback;
}

export function loadConfig(): Config {
  const runnerAllowNoToken = bool("KAI_RUNNER_ALLOW_NO_TOKEN");
  const runnerToken = optEnv("RUNNER_TOKEN");
  if (!runnerAllowNoToken && !runnerToken) {
    throw new Error("RUNNER_TOKEN is required unless KAI_RUNNER_ALLOW_NO_TOKEN=true");
  }
  return {
    runtimeEnv: process.env,
    reposPath: optEnv("KAI_REPOS_PATH"),
    routerUrl: optEnv("KAI_ROUTER_URL"),
    compressorUrl: optEnv("KAI_COMPRESSOR_URL"),
    compressorDisabled: optBool("KAI_COMPRESSOR_DISABLE"),
    auditDbPath: env("KAI_AUDIT_DB"),
    compressorTimeoutMs: COMPRESSOR_TIMEOUT_MS,
    compressorMinQueryTokens: COMPRESSOR_MIN_QUERY_TOKENS,
    compressorMinPromptTokens: COMPRESSOR_MIN_PROMPT_TOKENS,
    compressorBudgetHaiku: COMPRESSOR_BUDGET_HAIKU,
    compressorBudgetSonnet: COMPRESSOR_BUDGET_SONNET,
    compressorBudgetOpus: COMPRESSOR_BUDGET_OPUS,
    runnerAllowNoToken,
    runnerToken,
    routerGitContext: env("KAI_ROUTER_GIT_CONTEXT"),
    claudeSettingsPath: envOrConstant("KAI_CLAUDE_SETTINGS_PATH", DEFAULT_CLAUDE_SETTINGS_PATH),
    rtkHookSkipCheck: boolOrConstant("KAI_RTK_HOOK_SKIP_CHECK", DEFAULT_RTK_HOOK_SKIP_CHECK),
    tierSuggestDisabled: boolOrConstant("KAI_TIER_SUGGEST_DISABLE", DEFAULT_TIER_SUGGEST_DISABLE),
    debugCompressor: boolOrConstant("KAI_DEBUG_COMPRESSOR", DEFAULT_DEBUG_COMPRESSOR),
    routerTimeoutMs: ROUTER_TIMEOUT_MS,
    logLevel: parseLogLevel(env("KAI_LOG_LEVEL")),
  };
}
