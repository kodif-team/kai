# Kai — Kodif AI Agent

AI engineering agent for GitHub. Mention `@kai` in any PR comment to trigger.

## Setup (3 steps)

### 1. Install the Kai GitHub App

[Install kai-kodif](https://github.com/apps/kai-kodif) on your repository.

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

      - uses: er-zhi/kai@v1
        with:
          github_token: ${{ steps.kai-token.outputs.token }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          router_url: http://localhost:11434
          router_model: LFM2-350M
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

Keep `router_url` pointed at `http://localhost:11434`. Default classifier is `LFM2-350M` (Q4_0 gguf, ~220 MB, ~2x faster on CPU than Qwen3 per Liquid AI benchmarks).

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
| `trigger_phrase` | No | `@kai` | Trigger phrase |
| `router_url` | No | — | Local LLM router URL (OpenAI-compatible); required before paid model calls |
| `router_model` | No | `LFM2-350M` | Local router classifier model |
