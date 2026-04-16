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
```

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
