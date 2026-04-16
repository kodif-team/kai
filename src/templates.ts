import type { RouterDecision } from "./router";

export const META_TEMPLATE = `I'm Kai, the Kodif project assistant. My goal is to help with minimal token spend and provide a good experience for Kodif architecture questions. Usage: write a comment with a task for @kai; for deeper analysis add \`use sonnet\` or \`use opus\`; loop mode (under development) is a sandbox where the agent will work with full permissions, autonomously commit and open PRs.`;

export const OFFTOPIC_TEMPLATE = `Kai only handles development work related to our platform: code review, bug fixes, tests, PRs, architecture, deployments, logs, metrics, and engineering tasks. Please ask a work-related development question or provide a specific repo/PR/task.`;

export function templateForRoute(route: RouterDecision): string {
  return route.intent === "spam-abuse" ? OFFTOPIC_TEMPLATE : META_TEMPLATE;
}
