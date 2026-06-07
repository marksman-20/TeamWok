import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
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
    workerRunning: !!workerProcess
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

    // Trigger local YouTrack sync immediately for user convenience
    if (config.youtrack_base_url && process.env.YOUTRACK_TOKEN) {
      syncIssueToYouTrack(data, config);
    }

    res.json({ success: true, issue: data });
  } catch (err) {
    systemLog(`GitHub issue creation exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// YouTrack sync function
async function syncIssueToYouTrack(issue, config) {
  const ytBase = config.youtrack_base_url;
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
