import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fork, execSync } from 'child_process';

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;
const BIND_IP = '127.0.0.1';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const ENV_PATH = path.join(process.cwd(), '.env');

// Memory logs buffer
const logBuffer = [];
const sseClients = new Set();
let workerProcess = null;

app.use(express.json());
app.use(express.static('public'));

// Localhost-only middleware guard
function localhostOnly(req, res, next) {
  const remoteIP = req.socket.remoteAddress || req.ip;
  if (remoteIP === '127.0.0.1' || remoteIP === '::1' || remoteIP === '::ffff:127.0.0.1') {
    return next();
  }
  console.warn(`[Security Warning] Blocked request to sensitive endpoint from: ${remoteIP}`);
  return res.status(403).send('Forbidden: Access allowed only from localhost (127.0.0.1)');
}

// Log streaming broadcaster
function broadcastLog(msg) {
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify({ log: msg })}\n\n`);
  }
}

// Write system logs directly to buffer & stream
function systemLog(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const formatted = `[${timestamp}] [System] ${msg}\n`;
  logBuffer.push(formatted);
  if (logBuffer.length > 500) logBuffer.shift();
  broadcastLog(formatted);
}

// Update secrets in .env
function updateEnvSecrets(secrets) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  }

  for (const [key, value] of Object.entries(secrets)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      // Clean up final newline
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${key}=${value}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, content, 'utf8');
  
  // Reload process.env
  dotenv.config();
  systemLog('.env secrets updated.');
}

// Worker control functions
function startWorker() {
  if (workerProcess) {
    systemLog('Worker is already running.');
    return;
  }

  systemLog('Spawning poller worker process...');
  workerProcess = fork('worker.js', [], { silent: true });

  workerProcess.stdout.on('data', (data) => {
    const str = data.toString();
    logBuffer.push(str);
    if (logBuffer.length > 500) logBuffer.shift();
    broadcastLog(str);
  });

  workerProcess.stderr.on('data', (data) => {
    const str = data.toString();
    logBuffer.push(str);
    if (logBuffer.length > 500) logBuffer.shift();
    broadcastLog(str);
  });

  workerProcess.on('close', (code) => {
    systemLog(`Worker process exited with code ${code}`);
    workerProcess = null;
  });
}

function stopWorker() {
  if (workerProcess) {
    systemLog('Terminating worker process...');
    workerProcess.kill();
    workerProcess = null;
  } else {
    systemLog('Worker is not running.');
  }
}

// Slack app credentials created programmatically
const SLACK_CLIENT_ID = '11304557769284.11304635481348';
const SLACK_CLIENT_SECRET = '37b01e9e8e454020e698a8a993bdd19b';

// ── API ROUTES ──

// SSE log stream endpoint
app.get('/api/logs/stream', localhostOnly, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Stream current log buffer on connect
  res.write(`data: ${JSON.stringify({ logs: logBuffer.join('') })}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Slack OAuth redirect endpoint
app.get('/api/slack/oauth', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Error: Missing authorization code from Slack.');
  }

  systemLog('Exchanging Slack OAuth authorization code...');

  try {
    const slackUrl = 'https://slack.com/api/oauth.v2.access';
    const bodyParams = new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: `http://localhost:3000/api/slack/oauth`
    });

    const response = await fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString()
    });

    const data = await response.json();

    if (!data.ok) {
      systemLog(`Slack OAuth exchange failed: ${data.error}`);
      return res.status(400).send(`OAuth Error: ${data.error}`);
    }

    const botToken = data.access_token;
    const webhookUrl = data.incoming_webhook?.url;

    systemLog('OAuth exchange succeeded. Updating environment credentials...');
    
    updateEnvSecrets({
      SLACK_BOT_TOKEN: botToken,
      SLACK_WEBHOOK_URL: webhookUrl || ''
    });

    // Notify poller worker if it is running
    if (workerProcess) {
      workerProcess.send('restart');
    }

    // Redirect to frontend dashboard with success flag
    res.redirect('/?slack_success=true');
  } catch (err) {
    systemLog(`Slack OAuth callback exception: ${err.message}`);
    res.status(500).send(`Exception during OAuth: ${err.message}`);
  }
});

// Get configurations and current status
app.get('/api/config', localhostOnly, (req, res) => {
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  // Determine secret presence
  const status = {
    hasSlackBotToken: !!process.env.SLACK_BOT_TOKEN,
    hasSlackWebhookUrl: !!process.env.SLACK_WEBHOOK_URL,
    hasYouTrackToken: !!process.env.YOUTRACK_TOKEN,
    hasGithubToken: !!process.env.GITHUB_TOKEN || (() => {
      try {
        execSync('gh auth token');
        return true;
      } catch (e) {
        return false;
      }
    })(),
    workerRunning: !!workerProcess,
    // Jira status
    hasJiraWebhookUrl: !!process.env.JIRA_WEBHOOK_URL,
    hasJiraWebhookSecret: !!process.env.JIRA_WEBHOOK_SECRET,
    hasJiraBaseUrl: !!process.env.JIRA_BASE_URL,
    hasJiraApiToken: !!process.env.JIRA_API_TOKEN,
  };

  res.json({ config, status });
});

// Update configurations
app.post('/api/config', localhostOnly, (req, res) => {
  const newConfig = req.body;
  
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
  systemLog('Configuration updated in config.json.');

  // Notify or manage worker depending on toggle state
  if (newConfig.polling_enabled) {
    if (!workerProcess) {
      startWorker();
    } else {
      workerProcess.send('restart');
    }
  } else {
    stopWorker();
  }

  res.json({ success: true });
});

// Force start/stop/restart worker
app.post('/api/worker/control', localhostOnly, (req, res) => {
  const { action } = req.body;
  if (action === 'start') {
    startWorker();
  } else if (action === 'stop') {
    stopWorker();
  } else if (action === 'restart') {
    stopWorker();
    setTimeout(startWorker, 500);
  }
  res.json({ success: true });
});

// Sync local settings to GitHub Secrets
app.post('/api/gh/secrets', localhostOnly, async (req, res) => {
  systemLog('Syncing credentials to GitHub Repository Secrets...');
  
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const repo = config.github_repo;
  if (!repo) {
    return res.status(400).json({ error: 'GitHub repository not set in preferences.' });
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const ytBaseUrl = config.youtrack_base_url;
  const ytToken = process.env.YOUTRACK_TOKEN;
  const ytProj = config.youtrack_project_id;

  try {
    if (webhookUrl) {
      systemLog('Setting GitHub secret: SLACK_WEBHOOK_URL...');
      execSync(`gh secret set SLACK_WEBHOOK_URL --body "${webhookUrl}" --repo "${repo}"`);
    }
    if (ytBaseUrl) {
      systemLog('Setting GitHub secret: YOUTRACK_BASE_URL...');
      execSync(`gh secret set YOUTRACK_BASE_URL --body "${ytBaseUrl}" --repo "${repo}"`);
    }
    if (ytToken) {
      systemLog('Setting GitHub secret: YOUTRACK_TOKEN...');
      execSync(`gh secret set YOUTRACK_TOKEN --body "${ytToken}" --repo "${repo}"`);
    }
    if (ytProj) {
      systemLog('Setting GitHub secret: YOUTRACK_PROJECT_ID...');
      execSync(`gh secret set YOUTRACK_PROJECT_ID --body "${ytProj}" --repo "${repo}"`);
    }

    // Jira secrets
    const jiraBaseUrl = process.env.JIRA_BASE_URL;
    const jiraEmail = process.env.JIRA_USER_EMAIL;
    const jiraToken = process.env.JIRA_API_TOKEN;
    const jiraProjKey = process.env.JIRA_PROJECT_KEY;
    const jiraWebhookUrl = process.env.JIRA_WEBHOOK_URL;
    const jiraWebhookSecret = process.env.JIRA_WEBHOOK_SECRET;

    if (jiraBaseUrl) {
      systemLog('Setting GitHub secret: JIRA_BASE_URL...');
      execSync(`gh secret set JIRA_BASE_URL --body "${jiraBaseUrl}" --repo "${repo}"`);
    }
    if (jiraEmail) {
      systemLog('Setting GitHub secret: JIRA_USER_EMAIL...');
      execSync(`gh secret set JIRA_USER_EMAIL --body "${jiraEmail}" --repo "${repo}"`);
    }
    if (jiraToken) {
      systemLog('Setting GitHub secret: JIRA_API_TOKEN...');
      execSync(`gh secret set JIRA_API_TOKEN --body "${jiraToken}" --repo "${repo}"`);
    }
    if (jiraProjKey) {
      systemLog('Setting GitHub secret: JIRA_PROJECT_KEY...');
      execSync(`gh secret set JIRA_PROJECT_KEY --body "${jiraProjKey}" --repo "${repo}"`);
    }
    if (jiraWebhookUrl) {
      systemLog('Setting GitHub secret: JIRA_WEBHOOK_URL...');
      execSync(`gh secret set JIRA_WEBHOOK_URL --body "${jiraWebhookUrl}" --repo "${repo}"`);
    }
    if (jiraWebhookSecret) {
      systemLog('Setting GitHub secret: JIRA_WEBHOOK_SECRET...');
      execSync(`gh secret set JIRA_WEBHOOK_SECRET --body "${jiraWebhookSecret}" --repo "${repo}"`);
    }

    systemLog('All secrets synchronized successfully with GitHub repository!');
    res.json({ success: true });
  } catch (err) {
    systemLog(`GitHub CLI secret set failure: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Initialize Git, create remote GitHub repo, and push
app.post('/api/gh/create-repo', localhostOnly, (req, res) => {
  systemLog('Initializing local Git repository & creating remote GitHub repository...');
  
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const repoPath = config.github_repo;
  if (!repoPath) {
    return res.status(400).json({ error: 'GitHub repository path not set in config.json.' });
  }

  try {
    // 1. Git init if not initialized
    if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
      systemLog('Running "git init"...');
      execSync('git init');
    }

    // 2. Configure .gitignore safety check
    systemLog('Verifying .gitignore contains credentials...');
    let gitignore = '';
    if (fs.existsSync('.gitignore')) {
      gitignore = fs.readFileSync('.gitignore', 'utf8');
    }
    if (!gitignore.includes('.env')) {
      fs.appendFileSync('.gitignore', '\n.env\n');
    }
    if (!gitignore.includes('config.json')) {
      fs.appendFileSync('.gitignore', '\nconfig.json\n');
    }

    // 3. Add and commit files
    systemLog('Staging and committing files...');
    execSync('git add -A');
    // Check if there are changes to commit
    const status = execSync('git status --porcelain').toString();
    if (status.trim()) {
      execSync('git commit -m "Initial commit of TeamWok Bridge setup"');
    }

    // 4. Create repository on GitHub if not existing, or update remote
    systemLog(`Checking if remote repository '${repoPath}' exists on GitHub...`);
    let repoExists = false;
    try {
      execSync(`gh repo view "${repoPath}"`);
      repoExists = true;
      systemLog(`GitHub repository '${repoPath}' already exists.`);
    } catch (e) {
      systemLog(`Creating repository '${repoPath}' on GitHub...`);
      const isPrivate = repoPath.includes('private') ? '--private' : '--public';
      execSync(`gh repo create "${repoPath}" ${isPrivate} --confirm || gh repo create "${repoPath}" --public --confirm`);
    }

    // Set remote origin safely
    try {
      execSync(`git remote remove origin`);
    } catch (e) {
      // remote didn't exist, ignore
    }
    execSync(`git remote add origin "https://github.com/${repoPath}.git"`);

    // 5. Push initial commit
    systemLog('Pushing codebase to origin main...');
    execSync('git branch -M main');
    execSync('git push -u origin main');

    systemLog('GitHub Repository set up and pushed successfully!');
    res.json({ success: true });
  } catch (err) {
    systemLog(`Git automation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Fetch issues from GitHub repository
app.get('/api/gh/issues', localhostOnly, async (req, res) => {
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const repo = config.github_repo;
  if (!repo) {
    return res.json({ issues: [] });
  }

  try {
    let token = process.env.GITHUB_TOKEN;
    if (!token) {
      token = execSync('gh auth token').toString().trim();
    }

    const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=15`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `GitHub API returned ${response.status}` });
    }

    const issues = await response.json();
    res.json({ issues: Array.isArray(issues) ? issues : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new issue on GitHub
app.post('/api/gh/issues', localhostOnly, async (req, res) => {
  const { title, body, labels } = req.body;
  
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const repo = config.github_repo;
  if (!repo) {
    return res.status(400).json({ error: 'GitHub repository not configured.' });
  }

  try {
    let token = process.env.GITHUB_TOKEN;
    if (!token) {
      token = execSync('gh auth token').toString().trim();
    }

    systemLog(`Creating GitHub issue: "${title}"...`);

    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API'
      },
      body: JSON.stringify({ title, body, labels: labels || [] })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message });
    }

    systemLog(`GitHub issue #${data.number} created successfully.`);

    // Trigger local syncs in parallel — YouTrack + Jira
    // allSettled: if one fails the other still completes
    Promise.allSettled([
      (config.youtrack_base_url && process.env.YOUTRACK_TOKEN)
        ? syncIssueToYouTrack(data, config)
        : Promise.resolve(),
      (process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN)
        ? syncIssueToJira(data, config)
        : Promise.resolve(),
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          systemLog(`Sync ${i === 0 ? 'YouTrack' : 'Jira'} failed: ${r.reason?.message}`);
        }
      });
    });

    res.json({ success: true, issue: data });
  } catch (err) {
    systemLog(`GitHub issue creation exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// YouTrack sync function
async function syncIssueToYouTrack(issue, config) {
  const ytBaseRaw = config.youtrack_base_url || "";
  const ytBase = ytBaseRaw.replace(/\/+$/, '');
  const token = process.env.YOUTRACK_TOKEN;
  let ytProj = config.youtrack_project_id;

  if (!ytBase || !token || !ytProj) {
    systemLog('YouTrack credentials missing, skipping auto-sync.');
    return;
  }

  try {
    systemLog(`Syncing GitHub Issue #${issue.number} to YouTrack...`);

    // Dynamic Look-up for Project ShortName to internal ID
    if (!ytProj.includes('-') && isNaN(Number(ytProj))) {
      systemLog(`Resolving YouTrack project shortName: ${ytProj} to DB ID...`);
      const projRes = await fetch(`${ytBase}/api/admin/projects?fields=id,shortName`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (projRes.ok) {
        const projects = await projRes.json();
        const resolved = projects.find(p => p.shortName.toUpperCase() === ytProj.toUpperCase());
        if (resolved) {
          systemLog(`Resolved shortName ${ytProj} to database ID: ${resolved.id}`);
          ytProj = resolved.id;
        }
      }
    }

    // Create YouTrack Issue
    const description = `**GitHub Issue:** [${config.github_repo}#${issue.number}](${issue.html_url})\n\n${issue.body || ''}`;
    
    const ytRes = await fetch(`${ytBase}/api/issues?fields=id,idReadable`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        summary: `GH#${issue.number}: ${issue.title}`,
        description,
        project: { id: ytProj }
      })
    });

    const ytData = await ytRes.json();
    if (!ytRes.ok) {
      systemLog(`Failed to create YouTrack issue: ${ytData.error_description || 'Unknown error'}`);
      return;
    }

    const ytId = ytData.idReadable;
    systemLog(`Created YouTrack issue ${ytId} successfully.`);

    // Leave a comment on GitHub issue referencing the YouTrack issue
    let ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      ghToken = execSync('gh auth token').toString().trim();
    }

    await fetch(`https://api.github.com/repos/${config.github_repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${ghToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API'
      },
      body: JSON.stringify({
        body: `🔗 YouTrack issue created: [${ytId}](${ytBase}/issue/${ytId})`
      })
    });

    // Notify Slack as well
    const slackMsg = `🔗 *Synced to YouTrack*: Issue *#${issue.number}* linked to YouTrack issue *${ytId}*\nView details: ${ytBase}/issue/${ytId}`;
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: slackMsg })
      });
    }
  } catch (err) {
    systemLog(`YouTrack sync failed: ${err.message}`);
  }
}

// ── JIRA SYNC ──

/**
 * Sync a GitHub issue to Jira Cloud via REST API v3.
 * Mirrors the YouTrack sync pattern exactly.
 */
async function syncIssueToJira(issue, config) {
  const jiraBaseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const jiraEmail = process.env.JIRA_USER_EMAIL;
  const jiraApiToken = process.env.JIRA_API_TOKEN;
  const jiraProjectKey = process.env.JIRA_PROJECT_KEY || config.jira_project_key;

  if (!jiraBaseUrl || !jiraEmail || !jiraApiToken || !jiraProjectKey) {
    systemLog('Jira credentials incomplete — skipping Jira sync. Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY.');
    return;
  }

  const agentName = config.agent_name || 'Antigravity';
  const agentRole = config.agent_role || 'lead';

  try {
    systemLog(`Syncing GitHub Issue #${issue.number} to Jira (${jiraProjectKey})...`);

    const auth = Buffer.from(`${jiraEmail}:${jiraApiToken}`).toString('base64');

    const payload = {
      fields: {
        project: { key: jiraProjectKey },
        summary: `GH#${issue.number}: ${issue.title}`,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{
              type: 'text',
              text: [
                `GitHub Issue: ${issue.html_url}`,
                `Agent: ${agentName} (${agentRole})`,
                `Scope: issue`,
                '',
                issue.body || 'No description provided.'
              ].join('\n')
            }]
          }]
        },
        issuetype: { name: 'Task' },
        labels: ['teamwok', `agent-${agentName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`]
      }
    };

    const jiraRes = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const jiraData = await jiraRes.json();
    if (!jiraRes.ok) {
      systemLog(`Jira issue creation failed: ${JSON.stringify(jiraData.errors || jiraData)}`);
      return;
    }

    const jiraKey = jiraData.key;
    systemLog(`Jira issue created: ${jiraKey}`);

    // Post Jira key back as GitHub comment
    let ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      ghToken = execSync('gh auth token').toString().trim();
    }

    await fetch(`https://api.github.com/repos/${config.github_repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${ghToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API'
      },
      body: JSON.stringify({
        body: `🔗 Jira issue created: [${jiraKey}](${jiraBaseUrl}/browse/${jiraKey})`
      })
    });

    systemLog(`Jira link comment posted on GH#${issue.number}.`);
  } catch (err) {
    systemLog(`Jira sync exception: ${err.message}`);
    throw err;
  }
}

// ── JIRA CONFIG ENDPOINT ──

// POST /api/jira/config — store Jira credentials
app.post('/api/jira/config', localhostOnly, (req, res) => {
  const { jira_webhook_url, jira_webhook_secret, jira_project_key, jira_base_url, jira_user_email, jira_api_token } = req.body;

  const secrets = {};
  if (jira_webhook_url)   secrets.JIRA_WEBHOOK_URL    = jira_webhook_url;
  if (jira_webhook_secret) secrets.JIRA_WEBHOOK_SECRET = jira_webhook_secret;
  if (jira_project_key)  secrets.JIRA_PROJECT_KEY   = jira_project_key;
  if (jira_base_url)     secrets.JIRA_BASE_URL       = jira_base_url;
  if (jira_user_email)   secrets.JIRA_USER_EMAIL     = jira_user_email;
  if (jira_api_token)    secrets.JIRA_API_TOKEN      = jira_api_token;

  if (Object.keys(secrets).length === 0) {
    return res.status(400).json({ error: 'No Jira fields provided.' });
  }

  updateEnvSecrets(secrets);

  // Also persist project key to config.json
  if (jira_project_key) {
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    config.jira_project_key = jira_project_key;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  }

  systemLog('Jira configuration saved.');
  res.json({ ok: true });
});

// ── JIRA WEBHOOK RECEIVER ──

const KNOWN_AGENT_NAMES = ['Antigravity', 'OpenCode-A', 'OpenCode-B', 'Aider-Senior', 'Demo-Agent'];

/**
 * Verify Jira webhook signature.
 * Jira can send: x-hub-signature-256, x-atlassian-token, or a shared secret header.
 */
function verifyJiraSignature(req) {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured — accept all (dev mode)

  const sig256 = req.headers['x-hub-signature-256'];
  const atlassianToken = req.headers['x-atlassian-token'];
  const sharedSecret = req.headers['x-jira-webhook-secret'];

  if (sharedSecret) {
    return sharedSecret === secret;
  }
  if (atlassianToken) {
    return atlassianToken === secret;
  }
  if (sig256) {
    const body = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig256), Buffer.from(expected));
  }
  return false;
}

app.post('/api/jira/webhook', express.json(), async (req, res) => {
  if (!verifyJiraSignature(req)) {
    systemLog(`[Security] Jira webhook signature mismatch — request rejected.`);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body;
  const eventType = event.webhookEvent || event.event_type || '';
  systemLog(`Jira webhook received: ${eventType}`);

  // Extract Jira issue summary to find matching GitHub issue number
  const summary = event.issue?.fields?.summary || '';
  const ghMatch = summary.match(/^GH#(\d+):/);
  const ghIssueNumber = ghMatch ? ghMatch[1] : null;

  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  if (ghIssueNumber && config.github_repo) {
    let ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      try { ghToken = execSync('gh auth token').toString().trim(); } catch(e) { ghToken = null; }
    }

    let commentBody = null;

    if (eventType === 'jira:issue_updated') {
      const updatedField = event.changelog?.items?.[0]?.field || 'unknown field';
      const newValue = event.changelog?.items?.[0]?.toString || '';
      commentBody = `🔄 **Jira update:** Field \`${updatedField}\` changed to \`${newValue}\` on ${summary}`;
    } else if (eventType === 'jira:issue_deleted') {
      commentBody = `⚠️ **Jira issue deleted:** ${summary} — Jira tracking removed (GitHub issue preserved).`;
    } else if (eventType === 'comment_created') {
      const author = event.comment?.author?.displayName || 'Unknown';
      // Avoid echo loop — skip if author is a known agent
      const isAgent = KNOWN_AGENT_NAMES.some(a => author.toLowerCase().includes(a.toLowerCase()));
      if (!isAgent) {
        const commentText = event.comment?.body || '';
        commentBody = `💬 **Jira comment** (from ${author}): ${commentText}`;
      }
    }

    if (commentBody && ghToken) {
      await fetch(`https://api.github.com/repos/${config.github_repo}/issues/${ghIssueNumber}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${ghToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'TeamWok-Bridge-API'
        },
        body: JSON.stringify({ body: commentBody })
      }).catch(e => systemLog(`Failed to post Jira→GH comment: ${e.message}`));

      systemLog(`Jira→GH comment posted on GH#${ghIssueNumber}`);
    }
  }

  res.json({ ok: true });
});

// Manually trigger YouTrack sync
app.post('/api/youtrack/sync/:issueNumber', localhostOnly, async (req, res) => {
  const { issueNumber } = req.params;
  
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const repo = config.github_repo;
  if (!repo) {
    return res.status(400).json({ error: 'GitHub repository not configured.' });
  }

  try {
    let token = process.env.GITHUB_TOKEN;
    if (!token) {
      token = execSync('gh auth token').toString().trim();
    }

    // Fetch details of the issue from GitHub
    const issueRes = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'TeamWok-Bridge-API'
      }
    });

    if (!issueRes.ok) {
      return res.status(issueRes.status).json({ error: `Issue not found on GitHub` });
    }

    const issue = await issueRes.json();
    await syncIssueToYouTrack(issue, config);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send custom Slack message
app.post('/api/slack/notify', localhostOnly, async (req, res) => {
  const { message } = req.body;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    return res.status(400).json({ error: 'Slack Webhook URL not configured.' });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message })
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to post message' });
    }

    systemLog('Manual Slack notification dispatched successfully.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Boot logic
app.listen(PORT, BIND_IP, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 TeamWok Bridge API running at http://${BIND_IP}:${PORT}`);
  console.log(`🔒 Localhost Security: Bound to 127.0.0.1`);
  console.log(`==================================================\n`);

  // Jira startup warnings
  const jiraRequired = ['JIRA_BASE_URL', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'];
  const jiraMissing = jiraRequired.filter(k => !process.env[k]);
  if (jiraMissing.length > 0) {
    console.warn(`⚠️  [Jira] Missing env vars: ${jiraMissing.join(', ')}`);
    console.warn(`   Jira mirroring will be skipped until configured via POST /api/jira/config`);
  } else {
    console.log(`✅ Jira mirroring configured → ${process.env.JIRA_BASE_URL} (${process.env.JIRA_PROJECT_KEY})`);
  }

  // Start worker if config calls for it
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      // ignore empty/corrupt config on first run
    }
  }

  if (config.polling_enabled) {
    startWorker();
  }
});
