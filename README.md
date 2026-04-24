# Kai — Kodif AI Agent

AI engineering agent for GitHub. Mention `@kai` in any PR comment to trigger.

## First Law: cost efficiency overrides everything

**Any change that increases the upper bound on cost per `@kai` invocation is a regression and must be reverted or justified with a load test.** Rules that follow from this law:

1. **No paid API call without a pre-flight budget check.** We refuse the call locally when the projected cost exceeds the per-tier ceiling; we do not rely on the model aborting.
2. **We do not pay for errors.** `max_turns` is set so that on a max-turns failure the spend is still within the tier ceiling. For `short-answer` intents it is 2 turns with every exploration tool disabled — the model cannot burn tokens exploring.
3. **Every code path that hits Claude must go through the stable-prefix prompt builder** so Anthropic's cache can hit. A cache-miss run on a known-stable PR is a bug.
4. **The footer is load-bearing** — every reply advertises input, output, cost, cache hit, RTK savings and turns. If you can't see the footer, you don't merge the change.
5. **Short-answer requests have a hard prompt ceiling** (`KAI_SHORT_ANSWER_MAX_INPUT_TOKENS`). A bigger prompt is not allowed to enter Claude under the short-answer label — we redirect to full review tier instead.
6. **Hooks are mandatory.** RTK savings == 0% means the hook isn't active; treat that as an incident, not a metric to log and move on.
7. **Operator escalation beats quiet spending.** If we can't honor the contract (router dead, compose missing, docker.sock not readable), we return a refusal reply with a one-line operator action. We don't "try harder" by re-hitting the paid API.

## Setup (3 steps)

### 1. Install the Kai GitHub App

[Install kodif-ai](https://github.com/apps/kodif-ai) on your repository.

### 2. Add secrets to your repo

| Secret | Required | Description |
|--------|----------|-------------|
| `KAI_APP_PRIVATE_KEY` | Yes | Kai app private key (get from your admin) |
| `ANTHROPIC_API_KEY` | No | Enables AI-powered analysis |

### 3. Add workflow file

Create `.github/workflows/kai.yml`:

```yaml
name: Kai (Kodif AI)
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
permissions:
  contents: write
  issues: write
  pull-requests: write
jobs:
  kai:
    if: contains(github.event.comment.body, '@kai')
    runs-on: [self-hosted, kai]
    steps:
      - uses: actions/create-github-app-token@v1
        id: kai-token
        with:
          app-id: 3394026
          private-key: ${{ secrets.KAI_APP_PRIVATE_KEY }}

      - uses: kodif-team/kai@v1
        with:
          github_token: ${{ steps.kai-token.outputs.token }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          router_url: http://localhost:21434
```

## Local Router LLM

Kai requires a local LLM router (OpenAI-compatible, served by llama.cpp) before any paid model call. If the router is not available or returns an invalid classification, Kai fails closed and does not call Claude.

On the EC2 self-hosted runner:

```bash
# one-time setup — place compose file where kai can find it on action start
sudo mkdir -p /home/kai/kai-router
sudo cp docker-compose.router.yml /home/kai/kai-router/
sudo chown -R kai:kai /home/kai/kai-router

# pull models and start
cd /home/kai/kai-router
docker compose -f docker-compose.router.yml run --rm kai-router-pull
docker compose -f docker-compose.router.yml run --rm kai-compressor-pull
docker compose -f docker-compose.router.yml up -d kai-router-llm kai-compressor-llm
```

Keep `router_url` pointed at `http://localhost:21434`. Classifier is `LFM2-350M` (Q4_0 gguf, ~220 MB, optimized for the small local router path).

**Self-healing:** if the containers crash between runs, Kai now probes `/health` at action start and runs `docker compose up -d kai-router-llm kai-compressor-llm` itself when it finds them down. Requires the compose file at one of: `$KAI_COMPOSE_FILE`, `/home/kai/kai-router/docker-compose.router.yml`, or `$HOME/kai-router/docker-compose.router.yml`, and the runner user in the `docker` group. Disable with `KAI_LLM_AUTOSTART=false`.

## Usage

```
@kai review this PR
@kai check for security issues
@kai explain the changes
@kai fix the failing test
```

Delete Kai's working comment to cancel a running job.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github_token` | Yes | `github.token` | Token for GitHub API |
| `anthropic_api_key` | No | — | Anthropic API key for Claude |
| `repos_path` | Yes | — | Local source path to Kodif repositories; Kai exposes it to the model only as `repos/` |
| `trigger_phrase` | No | `@kai` | Trigger phrase |
| `router_url` | No | — | Local LLM router URL (OpenAI-compatible); required before paid model calls |
ё
