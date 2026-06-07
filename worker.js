import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// Log helper to standard output (captured by server.js for SSE)
function log(msg) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] [Worker] ${msg}`);
}

function logError(msg) {
  const timestamp = new Date().toLocaleTimeString();
  console.error(`[${timestamp}] [Worker] [ERROR] ${msg}`);
}

// Retrieve GitHub Token from env or local gh CLI
function getGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token').toString().trim();
  } catch (e) {
    logError(`GitHub token not found in env and 'gh auth token' failed: ${e.message}`);
    return null;
  }
}

// Read config.json safely
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    logError(`Failed to read config.json: ${e.message}`);
  }
  return null;
}

// Send message to Slack Webhook
async function notifySlack(text, attachments = []) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    log('Slack webhook URL not configured, skipping notification.');
    return;
  }

  try {
    const payload = { text };
    if (attachments.length > 0) {
      payload.attachments = attachments;
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      logError(`Slack notification failed with HTTP ${res.status}`);
    } else {
      log('Slack notification dispatched successfully.');
    }
  } catch (e) {
    logError(`Failed to send Slack notification: ${e.message}`);
  }
}

// Check GitHub for issues labeled 'run-aider'
async function checkIssues() {
  const config = readConfig();
  if (!config || !config.polling_enabled) {
    return;
  }

  const repo = config.github_repo;
  if (!repo) {
    logError('No GitHub repository configured in config.json.');
    return;
  }

  const token = getGithubToken();
  if (!token) {
    return;
  }

  try {
    log(`Checking repository '${repo}' for issues labeled 'run-aider'...`);
    
    // Fetch issues
    const url = `https://api.github.com/repos/${repo}/issues?state=open&labels=run-aider`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API-Worker'
      }
    });

    if (!res.ok) {
      logError(`GitHub API returned HTTP ${res.status}`);
      return;
    }

    const issues = await res.json();
    if (!Array.isArray(issues)) {
      logError('Invalid response from GitHub API.');
      return;
    }

    if (issues.length === 0) {
      log('No matching issues found.');
      return;
    }

    const targetIssue = issues[0];
    const issueNum = targetIssue.number;
    const issueTitle = targetIssue.title;
    const issueUrl = targetIssue.html_url;

    log(`🚀 Found issue #${issueNum}: "${issueTitle}"`);

    // Remove the label first to prevent duplicate triggering
    log(`Removing 'run-aider' label from issue #${issueNum}...`);
    const labelDeleteUrl = `https://api.github.com/repos/${repo}/issues/${issueNum}/labels/run-aider`;
    const delRes = await fetch(labelDeleteUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API-Worker'
      }
    });

    if (!delRes.ok) {
      logError(`Failed to remove label from issue #${issueNum}. HTTP ${delRes.status}`);
      return;
    }
    log(`Label removed successfully.`);

    // Notify Slack about start
    await notifySlack(`🤖 *Aider* started working on issue *#${issueNum}*: <${issueUrl}|${issueTitle}>`);

    // Run Aider script
    log(`Spawning local Aider runner for issue #${issueNum}...`);
    await runAider(issueNum, issueTitle, issueUrl);

  } catch (e) {
    logError(`Error during checkIssues cycle: ${e.message}`);
  }
}

// Spawn Aider script and monitor output
function runAider(issueNum, issueTitle, issueUrl) {
  return new Promise((resolve) => {
    // Make sure script is executable
    try {
      execSync('chmod +x gh-issue-to-ai.sh');
    } catch (e) {
      logError(`Failed to chmod script: ${e.message}`);
    }

    // Set env variables including GEMINI_API_KEY if we have it or get it
    const env = {
      ...process.env,
      GITHUB_TOKEN: getGithubToken()
    };

    const aiderProcess = spawn('./gh-issue-to-ai.sh', [issueNum.toString(), 'aider'], { env });

    aiderProcess.stdout.on('data', (data) => {
      // Forward output to parent process stdout
      process.stdout.write(data);
    });

    aiderProcess.stderr.on('data', (data) => {
      // Forward stderr to parent process stderr
      process.stderr.write(data);
    });

    aiderProcess.on('close', async (code) => {
      log(`Aider process exited with code ${code}`);
      
      if (code === 0) {
        log(`Aider successfully resolved issue #${issueNum}!`);
        await notifySlack(`✅ *Aider* successfully finished working on issue *#${issueNum}*!\nPR raised for: <${issueUrl}|${issueTitle}>`);
      } else {
        logError(`Aider failed to resolve issue #${issueNum}. Exit code: ${code}`);
        await notifySlack(`❌ *Aider* failed to resolve issue *#${issueNum}* (Exit code: ${code}). Manual review needed.`);
      }
      resolve();
    });
  });
}

// Polling Loop
let intervalId = null;

function startLoop() {
  const config = readConfig();
  const intervalSeconds = config?.polling_interval || 30;
  log(`Starting polling loop. Interval: ${intervalSeconds} seconds.`);
  
  if (intervalId) clearInterval(intervalId);
  
  // Run initial check immediately
  checkIssues();
  
  intervalId = setInterval(checkIssues, intervalSeconds * 1000);
}

// Listen to commands from parent process
process.on('message', (msg) => {
  if (msg === 'start' || msg === 'restart') {
    startLoop();
  } else if (msg === 'stop') {
    log('Stopping polling loop.');
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }
});

// Start loop on boot
startLoop();
