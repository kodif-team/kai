import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type RepoLookupHit = {
  filePath: string;
  line: number;
  evidence: string;
  framework: string;
};

export type RepoLookupResult = {
  answer: string;
  hit: RepoLookupHit;
  scannedFiles: number;
};

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 512_000;
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", ".next", ".venv", "venv",
  "__pycache__", ".gradle", ".mvn",
]);

const ENTRYPOINT_PATTERNS: Array<{ framework: string; pattern: RegExp }> = [
  { framework: "Spring Boot", pattern: /\bSpringApplication\.run\s*\(/ },
  { framework: "Spring Boot", pattern: /@SpringBootApplication\b/ },
  { framework: "FastAPI", pattern: /\bFastAPI\s*\(/ },
  { framework: "Flask", pattern: /\bFlask\s*\(/ },
  { framework: "Express", pattern: /\bexpress\s*\(/ },
  { framework: "Express", pattern: /\bapp\.listen\s*\(/ },
  { framework: "NestJS", pattern: /\bNestFactory\.create\s*\(/ },
  { framework: "Node HTTP", pattern: /\bcreateServer\s*\(/ },
  { framework: "Uvicorn", pattern: /\buvicorn\.run\s*\(/ },
];

function parseServiceName(message: string): string | null {
  const match = /\brepos\/([A-Za-z0-9._-]+)/.exec(message);
  return match?.[1] ?? null;
}

function isHttpEntrypointLookup(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\b(which file|what file|where)\b/.test(normalized)
    && /\b(start|starts|entrypoint|entry point|run|runs)\b/.test(normalized)
    && /\b(http|app|server|service)\b/.test(normalized);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name));
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function findEntrypoint(serviceDir: string): { hit: RepoLookupHit; scannedFiles: number } | null {
  const files = walkFiles(serviceDir);
  let scannedFiles = 0;
  for (const file of files) {
    const stats = statSync(file);
    if (stats.size > MAX_FILE_BYTES) continue;
    scannedFiles++;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (const { framework, pattern } of ENTRYPOINT_PATTERNS) {
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) {
          return {
            scannedFiles,
            hit: {
              filePath: `repos/${relative(join(serviceDir, ".."), file)}`,
              line: index + 1,
              evidence: line.trim(),
              framework,
            },
          };
        }
      }
    }
  }
  return null;
}

export function answerRepoLookup(message: string, reposPath = "repos"): RepoLookupResult | null {
  if (!isHttpEntrypointLookup(message)) return null;
  const service = parseServiceName(message);
  if (!service) return null;

  const serviceDir = join(reposPath, service);
  if (!existsSync(serviceDir) || !statSync(serviceDir).isDirectory()) return null;

  const result = findEntrypoint(serviceDir);
  if (!result) return null;

  const { hit, scannedFiles } = result;
  return {
    hit,
    scannedFiles,
    answer: `**${hit.framework}** starts the HTTP app in \`${hit.filePath}\` at line ${hit.line}.\n\nEvidence: \`${hit.evidence}\``,
  };
}
