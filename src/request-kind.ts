export function isReadOnlyValidationRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  const asksToChange = /^(fix|commit|push|apply|create|patch|refactor|document|write|change|remove|delete)\b/.test(normalized)
    || /\b(commit|push)\b/i.test(normalized);
  if (asksToChange) return false;
  return /\b(health\s*check|final\s+health\s*check|check\s+(?:logs?|status|server|runner|container|health)|verify|validate|smoke\s*test)\b/i.test(normalized);
}
