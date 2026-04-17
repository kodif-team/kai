import type { RouterDecision } from "./router";

export const META_TEMPLATE = `I'm Kai, the Kodif project assistant. My goal is to help with minimal token spend and provide a good experience for Kodif architecture questions. Response by local LLM (LFM2-350M). Usage: write a comment with a task for @kai; for deeper analysis add \`use sonnet\` or \`use opus\`.`;

export const OFFTOPIC_TEMPLATE = `That's outside my scope. I help with **Kodif development work**: code review, bug fixes, tests, PRs, architecture questions, deployments, metrics, and engineering tasks.

**I can help with:**
- **Code review**: Review this PR for bugs/security/performance
- **Architecture questions**: How do these services interact across the platform?
- **Bug fixes**: What's wrong with this code and how to fix it?
- **Testing**: Add tests or strengthen test coverage for this code
- **Commits**: Create/update commits for these changes

Please ask a specific development question with code context or a repo/PR reference.`;

export const CLARIFICATION_TEMPLATE = `I'm not sure what you're asking. Can you clarify:

1. **Which service/component?** (e.g., "in the executor-service" or "in this PR")
2. **What kind of help?** Examples:
   - **Code review**: Review this PR for bugs/security/performance
   - **Architecture questions**: How do these services interact across the platform?
   - **Bug fixes**: What's wrong with this code and how to fix it?
   - **Testing**: Add tests or strengthen test coverage for this code
   - **Commits**: Create/update commits for these changes
3. **Scope?** (e.g., "in this repository" or "across all Kodif services")

Provide a specific task with context and I'll help with minimal token spend.`;

export function templateForRoute(route: RouterDecision): string {
  if (route.intent === "spam-abuse") return OFFTOPIC_TEMPLATE;
  if (route.intent === "needs-input") return CLARIFICATION_TEMPLATE;
  return META_TEMPLATE;
}
