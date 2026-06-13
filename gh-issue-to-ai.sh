#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║          gh-issue-to-ai.sh — Pipe GitHub Issue to AI        ║
# ║  Routes a GitHub issue to Aider or Cline for local solving  ║
# ╚══════════════════════════════════════════════════════════════╝
#
# USAGE:
#   ./gh-issue-to-ai.sh <issue-number> [aider|cline] [--dry-run]
#
# DEPENDENCIES:
#   gh      → GitHub CLI  (https://cli.github.com)
#   jq      → JSON parser (sudo apt install jq)
#   aider   → pip install aider-chat        (for --aider mode)
#   cline   → npm install -g cline  (for --cline mode)
#
# SECRETS (set as env vars or in a .env file):
#   GITHUB_TOKEN       → gh auth token (gh auth login handles this)
#   ANTHROPIC_API_KEY  → for Cline (uses claude-sonnet-4-20250514)
#   GEMINI_API_KEY     → for Aider (uses gemini/gemini-1.5-flash — free tier)
#   OPENAI_API_KEY     → optional fallback for Aider

set -euo pipefail

# ── Load .env if present ─────────────────────────────────────────────────────
if [ -f ".env" ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── Args ─────────────────────────────────────────────────────────────────────
ISSUE_NUMBER="${1:-}"
AI_BACKEND="${2:-aider}"   # aider | cline
DRY_RUN=false
[[ "${3:-}" == "--dry-run" ]] && DRY_RUN=true

if [ -z "$ISSUE_NUMBER" ]; then
  echo -e "${RED}Usage: $0 <issue-number> [aider|cline] [--dry-run]${RESET}"
  exit 1
fi

# ── Detect repo from git remote ───────────────────────────────────────────────
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null \
  || git remote get-url origin | sed 's|https://github.com/||;s|git@github.com:||;s|\.git$||')

echo -e "${CYAN}${BOLD}📋 Fetching issue #${ISSUE_NUMBER} from ${REPO}...${RESET}"

# ── Fetch issue via GitHub CLI ────────────────────────────────────────────────
ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json \
  number,title,body,labels,assignees,comments,url)

ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
ISSUE_URL=$(echo "$ISSUE_JSON"   | jq -r '.url')
ISSUE_BODY=$(echo "$ISSUE_JSON"  | jq -r '.body // "No description provided."')
ISSUE_LABELS=$(echo "$ISSUE_JSON" | jq -r '[.labels[].name] | join(", ")' )
ISSUE_COMMENTS=$(echo "$ISSUE_JSON" | jq -r \
  '[.comments[] | "### Comment by \(.author.login)\n\(.body)"] | join("\n\n")')

# ── Build the prompt ─────────────────────────────────────────────────────────
PROMPT=$(cat <<EOF
You are an expert software engineer working on the repository: ${REPO}

## GitHub Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}
**URL:** ${ISSUE_URL}
**Labels:** ${ISSUE_LABELS:-none}

### Issue Description
${ISSUE_BODY}

EOF

if [ -n "$ISSUE_COMMENTS" ]; then
cat <<EOF
### Discussion / Comments
${ISSUE_COMMENTS}

EOF
fi

cat <<EOF
---
## Your Task
1. Understand the issue fully before touching any code.
2. Identify the minimal set of files that need to change.
3. Implement a clean fix or feature as described.
4. Write or update tests if a test file already exists for the affected module.
5. After making changes, summarize what you did in 3-5 bullet points.

Do NOT introduce unrelated refactors. Keep changes focused on this issue only.
EOF
)

# ── Dry run — just print the prompt ──────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}──── DRY RUN: Prompt that would be sent ────${RESET}"
  echo "$PROMPT"
  echo -e "${YELLOW}────────────────────────────────────────────${RESET}"
  exit 0
fi

# ── Write prompt to temp file ─────────────────────────────────────────────────
PROMPT_FILE=$(mktemp /tmp/gh-issue-XXXXXX.md)
echo "$PROMPT" > "$PROMPT_FILE"
echo -e "${GREEN}✅ Prompt written to: ${PROMPT_FILE}${RESET}"

# ─────────────────────────────────────────────────────────────────────────────
# BACKEND: AIDER
# Uses Gemini Flash free tier by default. Switch model with --model flag.
# Free tier: 1500 req/day at gemini/gemini-1.5-flash
# ─────────────────────────────────────────────────────────────────────────────
run_aider() {
  if ! command -v aider &>/dev/null; then
    echo -e "${RED}aider not found. Install with: pip install aider-chat${RESET}"
    exit 1
  fi

  # Prefer Gemini (free), fall back to OpenAI
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    MODEL_FLAG="--model gemini/gemini-1.5-flash"
    export GEMINI_API_KEY
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    MODEL_FLAG="--model gpt-4o-mini"
    export OPENAI_API_KEY
  else
    echo -e "${RED}Set GEMINI_API_KEY (free) or OPENAI_API_KEY in your .env${RESET}"
    exit 1
  fi

  echo -e "${CYAN}${BOLD}🤖 Launching Aider (${MODEL_FLAG})...${RESET}"
  echo -e "${YELLOW}Issue: #${ISSUE_NUMBER} — ${ISSUE_TITLE}${RESET}\n"

  # aider reads the prompt from a message file and enters interactive mode
  # --yes auto-confirms file edits; remove it if you want to review each change
  aider $MODEL_FLAG \
    --message-file "$PROMPT_FILE" \
    --yes \
    --no-auto-commits \
    --pretty

  echo -e "\n${GREEN}✅ Aider session complete for issue #${ISSUE_NUMBER}${RESET}"
}

# ─────────────────────────────────────────────────────────────────────────────
# BACKEND: CLINE (Claude via Anthropic API)
# Uses claude-sonnet-4-20250514. Requires ANTHROPIC_API_KEY.
# Free tier: use via claude.ai API free quota or Anthropic API credits.
# ─────────────────────────────────────────────────────────────────────────────
run_cline() {
  if ! command -v cline &>/dev/null; then
    echo -e "${YELLOW}cline CLI not found. Trying npx...${RESET}"
    CLINE_CMD="npx cline"
  else
    CLINE_CMD="cline"
  fi

  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo -e "${RED}Set ANTHROPIC_API_KEY in your .env${RESET}"
    exit 1
  fi

  export ANTHROPIC_API_KEY

  echo -e "${CYAN}${BOLD}🤖 Launching Cline (claude-sonnet-4-20250514)...${RESET}"
  echo -e "${YELLOW}Issue: #${ISSUE_NUMBER} — ${ISSUE_TITLE}${RESET}\n"

  $CLINE_CMD \
    --model "claude-sonnet-4-20250514" \
    --task "$(cat "$PROMPT_FILE")"

  echo -e "\n${GREEN}✅ Cline session complete for issue #${ISSUE_NUMBER}${RESET}"
}

# ─────────────────────────────────────────────────────────────────────────────
# BACKEND: BOTH — run Aider first, then Cline reviews the diff
# ─────────────────────────────────────────────────────────────────────────────
run_both() {
  echo -e "${BOLD}Running Aider first, then Cline reviews...${RESET}\n"
  run_aider

  echo -e "\n${CYAN}${BOLD}Handing off diff to Cline for review...${RESET}"

  DIFF=$(git diff --staged 2>/dev/null || git diff HEAD 2>/dev/null || echo "No diff available.")

  REVIEW_PROMPT="Review this diff for issue #${ISSUE_NUMBER} (${ISSUE_TITLE}).
Point out any bugs, edge cases, or improvements. Do NOT rewrite — only comment.

\`\`\`diff
${DIFF}
\`\`\`"

  echo "$REVIEW_PROMPT" > "$PROMPT_FILE"
  run_cline
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$AI_BACKEND" in
  aider) run_aider ;;
  cline) run_cline ;;
  both)  run_both  ;;
  *)
    echo -e "${RED}Unknown backend '${AI_BACKEND}'. Use: aider | cline | both${RESET}"
    exit 1
    ;;
esac

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -f "$PROMPT_FILE"
echo -e "${GREEN}${BOLD}🎉 Done. Issue #${ISSUE_NUMBER} handed to ${AI_BACKEND}.${RESET}"
