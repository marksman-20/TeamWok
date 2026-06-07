#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║          setup.sh — Automated Setup & Bootstrapper           ║
# ║  Configures Git, installs dependencies, & boots server.     ║
# ╚══════════════════════════════════════════════════════════════╝

set -euo pipefail

# Colours
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

echo -e "${CYAN}${BOLD}🤖 Initiating TeamWok Bridge Setup...${RESET}"

# 1. Ensure security rules are written in .gitignore first
echo -e "${CYAN}Checking .gitignore for security rules...${RESET}"
touch .gitignore
grep -q "config.json" .gitignore || (echo -e "${YELLOW}Adding config.json to .gitignore...${RESET}" && echo "config.json" >> .gitignore)
grep -q ".env" .gitignore        || (echo -e "${YELLOW}Adding .env to .gitignore...${RESET}" && echo ".env" >> .gitignore)
grep -q "node_modules" .gitignore || echo "node_modules/" >> .gitignore
grep -q "*.log" .gitignore       || echo "*.log" >> .gitignore

# 2. Initialize Git if not already done
if [ ! -d ".git" ]; then
  echo -e "${CYAN}Initializing new local Git repository...${RESET}"
  git init
  git branch -M main
else
  echo -e "${GREEN}Git repository already initialized.${RESET}"
fi

# 3. Safe Remote Configuration
if [ -f "config.json" ]; then
  REPO_NAME=$(jq -r '.github_repo // empty' config.json)
  if [ -n "$REPO_NAME" ]; then
    echo -e "${CYAN}Configuring Git remote for repository: ${REPO_NAME}...${RESET}"
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/${REPO_NAME}.git"
    echo -e "${GREEN}Git remote origin updated safely.${RESET}"
  fi
fi

# 4. Install Dependencies
echo -e "${CYAN}Installing NPM packages...${RESET}"
npm install

# 5. Build Initial Commit safely
echo -e "${CYAN}Staging files and checking for changes...${RESET}"
git add -A
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo -e "${CYAN}Committing local changes...${RESET}"
  git commit -m "Configure TeamWok Bridge and Automation Workflow"
else
  echo -e "${GREEN}No changes to commit.${RESET}"
fi

# 6. Make scripts executable
chmod +x gh-issue-to-ai.sh

echo -e "${GREEN}${BOLD}🎉 Setup Complete! Starting the Express Dashboard Server...${RESET}"
echo -e "${YELLOW}Navigate to http://127.0.0.1:3000 to manage your integrations.${RESET}\n"

# 7. Start Node Server
npm start
