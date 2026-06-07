// State Management
let currentConfig = {};
let currentStatus = {};

// DOM Elements
const githubRepoInput = document.getElementById('github-repo-input');
const githubBadge = document.getElementById('github-badge');
const btnSaveGithub = document.getElementById('btn-save-github');
const btnCreateRepo = document.getElementById('btn-create-repo');
const btnSyncSecrets = document.getElementById('btn-sync-secrets');

const slackBadge = document.getElementById('slack-badge');
const slackBotVal = document.getElementById('slack-bot-val');
const slackWebhookVal = document.getElementById('slack-webhook-val');
const btnConnectSlack = document.getElementById('btn-connect-slack');

const ytUrlInput = document.getElementById('yt-url-input');
const ytProjectInput = document.getElementById('yt-project-input');
const ytBadge = document.getElementById('youtrack-badge');
const btnSaveYoutrack = document.getElementById('btn-save-youtrack');

const pollerBadge = document.getElementById('poller-badge');
const pollerToggle = document.getElementById('poller-toggle');
const pollerIntervalInput = document.getElementById('poller-interval-input');
const btnStartWorker = document.getElementById('btn-start-worker');
const btnStopWorker = document.getElementById('btn-stop-worker');
const btnRestartWorker = document.getElementById('btn-restart-worker');

const issueForm = document.getElementById('issue-form');
const issueTitle = document.getElementById('issue-title');
const issueBody = document.getElementById('issue-body');
const issueLabelAider = document.getElementById('issue-label-aider');

const consoleStream = document.getElementById('console-stream');
const btnClearConsole = document.getElementById('btn-clear-console');
const toastEl = document.getElementById('toast');

// Toast Notification Helper
function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.style.borderColor = isError ? 'var(--color-red)' : 'var(--border-glow)';
  toastEl.style.boxShadow = isError 
    ? '0 8px 32px 0 rgba(239, 68, 68, 0.25)' 
    : '0 8px 32px 0 rgba(139, 92, 246, 0.25)';
  
  toastEl.classList.add('show');
  setTimeout(() => {
    toastEl.classList.remove('show');
  }, 4000);
}

// Fetch Status and Config
async function fetchState() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Failed to retrieve configurations.');
    const data = await res.json();
    
    currentConfig = data.config || {};
    currentStatus = data.status || {};
    
    updateUI();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Update UI Elements with Config/Status
function updateUI() {
  // GitHub UI
  if (currentConfig.github_repo) {
    githubRepoInput.value = currentConfig.github_repo;
    if (currentStatus.hasGithubToken) {
      githubBadge.textContent = 'Ready';
      githubBadge.className = 'status-badge green';
    } else {
      githubBadge.textContent = 'Token Missing';
      githubBadge.className = 'status-badge yellow';
    }
  } else {
    githubBadge.textContent = 'Not Configured';
    githubBadge.className = 'status-badge red';
  }

  // Slack UI
  if (currentStatus.hasSlackBotToken) {
    slackBadge.textContent = 'Connected';
    slackBadge.className = 'status-badge green';
    slackBotVal.textContent = '✓ Active (xoxb)';
    slackBotVal.className = 'status-item-val green-text';
  } else {
    slackBadge.textContent = 'Not Linked';
    slackBadge.className = 'status-badge red';
    slackBotVal.textContent = 'Not Authored';
    slackBotVal.className = 'status-item-val';
  }

  if (currentStatus.hasSlackWebhookUrl) {
    slackWebhookVal.textContent = '✓ Configured';
    slackWebhookVal.className = 'status-item-val green-text';
  } else {
    slackWebhookVal.textContent = 'Not Set';
    slackWebhookVal.className = 'status-item-val';
  }

  // Set Slack authorize URL link
  btnConnectSlack.onclick = () => {
    window.location.href = 'https://slack.com/oauth/v2/authorize?client_id=11304557769284.11304635481348&scope=chat:write,chat:write.public,incoming-webhook&redirect_uri=http://localhost:3000/api/slack/oauth';
  };

  // YouTrack UI
  ytUrlInput.value = currentConfig.youtrack_base_url || '';
  ytProjectInput.value = currentConfig.youtrack_project_id || '';
  
  if (currentConfig.youtrack_base_url && currentStatus.hasYouTrackToken) {
    ytBadge.textContent = 'Connected';
    ytBadge.className = 'status-badge green';
  } else {
    ytBadge.textContent = 'Disconnected';
    ytBadge.className = 'status-badge red';
  }

  // Poller UI
  pollerToggle.checked = !!currentConfig.polling_enabled;
  pollerIntervalInput.value = currentConfig.polling_interval || 30;

  if (currentStatus.workerRunning) {
    pollerBadge.textContent = 'Active Polling';
    pollerBadge.className = 'status-badge green';
  } else {
    pollerBadge.textContent = 'Stopped';
    pollerBadge.className = 'status-badge red';
  }
}

// Save Configuration
async function saveConfig(updates) {
  try {
    const nextConfig = { ...currentConfig, ...updates };
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextConfig)
    });
    
    if (!res.ok) throw new Error('Failed to save configuration settings.');
    showToast('Preferences updated successfully.');
    fetchState();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Event Listeners
btnSaveGithub.addEventListener('click', () => {
  saveConfig({ github_repo: githubRepoInput.value.trim() });
});

btnSaveYoutrack.addEventListener('click', () => {
  saveConfig({
    youtrack_base_url: ytUrlInput.value.trim(),
    youtrack_project_id: ytProjectInput.value.trim()
  });
});

pollerToggle.addEventListener('change', (e) => {
  saveConfig({ polling_enabled: e.target.checked });
});

pollerIntervalInput.addEventListener('change', () => {
  saveConfig({ polling_interval: parseInt(pollerIntervalInput.value, 10) });
});

// Sync GitHub Secrets
btnSyncSecrets.addEventListener('click', async () => {
  btnSyncSecrets.disabled = true;
  btnSyncSecrets.textContent = 'Syncing...';
  try {
    const res = await fetch('/api/gh/secrets', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to sync repo secrets.');
    showToast('All secrets pushed to GitHub repository!');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btnSyncSecrets.disabled = false;
    btnSyncSecrets.textContent = '🔗 Push Secrets to GitHub';
  }
});

// Create GitHub Repo
btnCreateRepo.addEventListener('click', async () => {
  if (!confirm('This will initialize local Git, create a remote repo on GitHub, and push the files. Continue?')) return;
  
  btnCreateRepo.disabled = true;
  btnCreateRepo.textContent = 'Executing Git Setup...';
  try {
    const res = await fetch('/api/gh/create-repo', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to initialize repo.');
    showToast('Git Repository set up and pushed to GitHub!');
    fetchState();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btnCreateRepo.disabled = false;
    btnCreateRepo.textContent = '⚡ Init Git & Create GitHub Repo';
  }
});

// Worker Controls
async function triggerWorkerControl(action) {
  try {
    const res = await fetch('/api/worker/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (!res.ok) throw new Error(`Failed to ${action} worker daemon.`);
    showToast(`Daemon poller command "${action}" sent.`);
    setTimeout(fetchState, 1000);
  } catch (err) {
    showToast(err.message, true);
  }
}

btnStartWorker.addEventListener('click', () => triggerWorkerControl('start'));
btnStopWorker.addEventListener('click', () => triggerWorkerControl('stop'));
btnRestartWorker.addEventListener('click', () => triggerWorkerControl('restart'));

// Create GitHub Issue Form
issueForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = issueTitle.value.trim();
  const body = issueBody.value.trim();
  const labels = issueLabelAider.checked ? ['run-aider'] : [];

  const submitBtn = issueForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating Issue...';

  try {
    const res = await fetch('/api/gh/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, labels })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create issue.');
    
    showToast(`Issue #${data.issue.number} raised on GitHub!`);
    issueTitle.value = '';
    issueBody.value = '';
    
    // Refresh state
    fetchState();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '🚀 Submit Issue';
  }
});

// Clear Console Logs
btnClearConsole.addEventListener('click', () => {
  consoleStream.textContent = '';
});

// Connect Real-Time SSE Logs
function connectLogStream() {
  const eventSource = new EventSource('/api/logs/stream');
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const consoleBody = consoleStream.parentElement;
    
    if (data.logs) {
      consoleStream.textContent = data.logs;
      consoleBody.scrollTop = consoleBody.scrollHeight;
    } else if (data.log) {
      consoleStream.textContent += data.log;
      consoleBody.scrollTop = consoleBody.scrollHeight;
    }
  };

  eventSource.onerror = () => {
    consoleStream.textContent += '\n[SSE Connection lost. Retrying...]\n';
    eventSource.close();
    setTimeout(connectLogStream, 5000);
  };
}

// Initial Boot Loader
document.addEventListener('DOMContentLoaded', () => {
  fetchState();
  connectLogStream();

  // Detect Slack Callback Success from Query Param
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('slack_success') === 'true') {
    showToast('Slack Bot Authorization Succeeded!');
    // Clean URL query params
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});
