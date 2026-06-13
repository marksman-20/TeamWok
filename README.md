# GitHub Automation Stack

Zero-cost pipeline: GitHub Issues → Slack + YouTrack, with local AI coding via Aider/Cline.

---

## File Structure

```
.github/
  workflows/
    github-to-slack.yml       # Posts all GitHub events to a Slack channel
    github-to-youtrack.yml    # Syncs issues/PRs to YouTrack Cloud
gh-issue-to-ai.sh             # Pipes any issue into Aider or Cline locally
```

---

## 1. Setup: github-to-slack.yml

### Step 1 — Create a Slack Incoming Webhook
1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Enable **Incoming Webhooks** → Add to a channel
3. Copy the Webhook URL (starts with `https://hooks.slack.com/services/...`)

### Step 2 — Add GitHub Secret
In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name        | Value                              |
|--------------------|------------------------------------|
| `SLACK_WEBHOOK_URL` | Your Slack webhook URL            |

### Step 3 — Paste the workflow
Copy `github-to-slack.yml` into `.github/workflows/` and push. Done.

---

## 2. Setup: github-to-youtrack.yml

### Step 1 — Get YouTrack credentials
1. Log into your YouTrack Cloud instance
2. Go to **Profile → Auth tokens → New token** → grant `YouTrack` scope
3. Note your **Project Short ID** (e.g. `PROJ`) from the project settings

### Step 2 — Add GitHub Secrets

| Secret Name            | Value                                      |
|------------------------|--------------------------------------------|
| `YOUTRACK_BASE_URL`    | `https://yourname.youtrack.cloud`          |
| `YOUTRACK_TOKEN`       | Your permanent token                       |
| `YOUTRACK_PROJECT_ID`  | Short project ID, e.g. `PROJ`             |

### Step 3 — Paste the workflow
Copy `github-to-youtrack.yml` into `.github/workflows/` and push.

**What it does:**
- **Issue opened** → creates a YouTrack issue, posts back a comment on GitHub with the YT link
- **Issue closed** → comments on the YouTrack issue
- **Issue labeled** → applies matching tag in YouTrack
- **PR opened** → links PR to the YouTrack issue if the PR mentions `#<number>`

---

## 3. Setup: gh-issue-to-ai.sh

### Dependencies
```bash
# GitHub CLI
brew install gh   # or: sudo apt install gh

# jq
sudo apt install jq

# Aider (uses Gemini free tier — 1500 req/day)
pip install aider-chat

# Cline (optional, uses Anthropic API)
npm install -g cline
# The published Cline CLI package name is `cline`.
```

### Auth
```bash
gh auth login   # authenticate GitHub CLI once
```

### .env file (create in your repo root, add to .gitignore)
```
GEMINI_API_KEY=your_gemini_key_here         # free at aistudio.google.com
ANTHROPIC_API_KEY=your_anthropic_key_here   # for Cline
```

### Make executable
```bash
chmod +x gh-issue-to-ai.sh
```

### Usage
```bash
# Pipe issue #42 into Aider (Gemini Flash, free)
./gh-issue-to-ai.sh 42 aider

# Pipe into Cline (Claude Sonnet)
./gh-issue-to-ai.sh 42 cline

# Aider solves → Cline reviews the diff
./gh-issue-to-ai.sh 42 both

# Preview the prompt without running anything
./gh-issue-to-ai.sh 42 aider --dry-run
```

---

## Free Tier Summary

| Tool              | Free Tier                          |
|-------------------|------------------------------------|
| GitHub Actions    | 2000 min/month (private), unlimited (public) |
| Slack Webhooks    | Unlimited incoming webhooks        |
| YouTrack Cloud    | Free up to 10 users                |
| Gemini Flash      | 1500 requests/day                  |
| Aider             | Open source, free forever          |
| Cline             | Open source; uses your API key     |
