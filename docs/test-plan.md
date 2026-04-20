# Kai — GitHub Test Plan

Manual regression test plan for the `kodif-team/kai@v1` GitHub Action. Designed so a junior engineer or a small LLM can follow it step by step and produce a clear pass/fail table.

## Setup

1. Open any PR in a repo that has `.github/workflows/kai.yml` using `kodif-team/kai@v1`.
2. Make sure the self-hosted runner is online and both local LLM servers are up:
   - Router at `http://localhost:21434/health` → `{"status":"ok"}`
   - Compressor at `http://localhost:21435/health` → `{"status":"ok"}`
3. Keep the Actions tab open in a second browser window.
4. For each test below:
   - Post the comment **exactly as written**.
   - Wait up to 120 s for Kai's reply.
   - Compare Kai's reply against the **Expected** column.
   - Mark **PASS** if every "must contain" string is present and no "must NOT contain" string is present; otherwise **FAIL**.

---

## Test cases

### T1 — Meta/identity (free path, no paid LLM)

- **Post:** `@kai who are you`
- **Expected reply must contain:**
  - `I'm Kai`
  - `local LLM (LFM2-350M)` in the footer
  - `$0`
- **Must NOT contain:** `Haiku`, `Sonnet`, `Opus`
- **Why:** confirms the local router classifies meta questions and replies via template without touching Claude.

### T2 — Stop command

- **Post:** `@kai stop`
- **Expected:** Kai reacts to your comment with 👍 (`+1`) emoji. No reply comment is created.
- **Why:** deterministic `stop` intent, no model call.

### T3 — Simple PR question (paid Haiku)

- **Post:** `@kai list the files changed in this PR`
- **Expected reply must contain:**
  - `Haiku` in the footer
  - `RTK` percentage > 0% (e.g. `RTK 12%`)
  - `$0.0` at the start of the price (under $0.10)
- **Why:** paid path works, RTK hook is active, cost is contained.

### T4 — Cache warm-up

- **Post:** exactly the same comment as T3 again: `@kai list the files changed in this PR`
- **Expected:** footer shows higher `cache` percentage than T3 (typically ≥ 70%).
- **Why:** stable prompt prefix lets Anthropic's prompt cache hit on repeat calls.

### T5 — Allowlist downgrade

- **Post:** `@kai use opus just say hi in one word`
- **Expected reply must contain:**
  - `was downgraded to **haiku**`
  - `Haiku` in the footer (not Opus)
  - Price under `$0.05`
- **Why:** only operators whose GitHub login is in the `model_allowlist` SQLite table may upgrade tier; everyone else is capped at Haiku.

### T6 — Offtopic / spam template

- **Post:** `@kai what's the weather today`
- **Expected reply must contain:** `Kai only handles development work`
- **Must NOT contain:** `Haiku` (no paid model call)
- **Why:** spam detection served by the local router.

### T7 — Commit task (paid + push to branch)

- **Post:** `@kai add one short comment to README explaining what Kai is, and commit`
- **Expected reply must contain:**
  - `Commit verification: pushed` followed by a 7-character SHA
- **Also verify on the PR:** a new commit authored by `kodif-ai[bot]` appears.
- **Why:** write path plus git auth via `http.extraheader` works.

### T8 — Empty mention → clarification

- **Post:** `@kai` (nothing else)
- **Expected reply must contain:** `I need a specific target`
- **Must NOT contain:** `Haiku`, `$0.0` with non-zero price
- **Why:** deterministic rule returns `needs-input`, no tokens spent.

### T9 — Error reporting (hard-to-handle input)

- **Post:** `@kai please review the fake-file-that-does-not-exist.xyz`
- **Expected:** Kai replies with either a polite "not found" note or a gracefully truncated response with a valid footer. Workflow conclusion in Actions tab must be **success**, not **failure**.
- **Why:** global error handler posts a reply instead of crashing the workflow.

### T10 — Cost cap sanity

- **Post:** `@kai describe every file in this PR in extreme detail`
- **Expected:** footer price under `$0.50`.
- **Why:** `KAI_MAX_COST_USD_HAIKU` cap ($0.50 default). If you see `⚠️ Cost cap exceeded`, that's still a PASS for this test — the cap is working; just tune the env variable.

---

## Quick pass/fail template

Copy this into a new issue comment on the PR when done:

```
| # | Test                         | Status |
|---|------------------------------|--------|
| 1 | Meta/identity                |  ?     |
| 2 | Stop command                 |  ?     |
| 3 | Simple PR question           |  ?     |
| 4 | Cache warm-up                |  ?     |
| 5 | Allowlist downgrade          |  ?     |
| 6 | Offtopic template            |  ?     |
| 7 | Commit task                  |  ?     |
| 8 | Empty mention                |  ?     |
| 9 | Error reporting              |  ?     |
| 10 | Cost cap sanity             |  ?     |
```

---

## Troubleshooting

| Symptom                                           | Likely cause                                               | Where to look                                                                  |
|--------------------------------------------------|------------------------------------------------------------|--------------------------------------------------------------------------------|
| Reply has `⚠️ RTK bypassed`                      | RTK hook not in `~/.claude/settings.json` on the runner     | Runner logs; set `KAI_RTK_HOOK_SKIP_CHECK=true` to override during triage      |
| Workflow fails with `local router URL is required` | `router_url` input missing from `kai.yml`                  | `.github/workflows/kai.yml` inputs                                             |
| `⛔ Rate limit hit`                               | Too many calls in an hour (configured via env)              | `KAI_RATE_LIMIT_*` env vars on the runner                                      |
| Reply: `error_max_turns`                         | Task needed more turns than `getMaxTurns()` granted         | Rephrase or add `use sonnet` (also increase `max_turns` in `src/index.ts`)     |
| `completed-cost-over-cap` in audit log           | Call spent more than tier cap                               | `KAI_MAX_COST_USD_HAIKU/SONNET/OPUS` env                                        |
