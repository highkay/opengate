function fmtTTL(ms) {
  if (ms == null || ms < 0) return '\u2014';
  var m = Math.floor(ms / 60000),
    h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toasts = container.querySelectorAll('.toast');
  while (toasts.length >= 5) {
    toasts[0].remove();
    toasts = container.querySelectorAll('.toast');
  }
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function () {
    if (toast.parentNode) toast.remove();
  }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}

var activeLoginJobs = {};
var activePollTimers = {};
var manualNotifications = {};

function isActiveLoginStatus(status) {
  return (
    status === 'queued' || status === 'api_login' || status === 'browser_login' || status === 'captcha' || status === 'awaiting_manual'
  );
}

function getLoginJob(email) {
  return activeLoginJobs[String(email || '').toLowerCase()] || null;
}

function setLoginJobNotice(email, job) {
  var box = document.getElementById('loginJobBox');
  if (!box) return;
  if (!job) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }

  box.style.display = '';
  box.textContent = '';
  var label = document.createElement('span');
  label.textContent = email + ': ' + (job.message || job.status || 'Login task updated.');
  box.appendChild(label);
  if (job.manualUrl) {
    var link = document.createElement('a');
    link.href = job.manualUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = ' Open manual login';
    link.style.marginLeft = '8px';
    box.appendChild(link);
  }
}

function formatLoginFailure(job) {
  var parts = [];
  if (job && job.failure) {
    parts.push('[' + job.failure.code + '] ' + job.failure.message);
  } else if (job && job.message) {
    parts.push(job.message);
  } else {
    parts.push('Login failed.');
  }
  if (job && job.apiFailure && (!job.failure || job.apiFailure.code !== job.failure.code)) {
    parts.push('API [' + job.apiFailure.code + ']: ' + job.apiFailure.message);
  }
  return parts.join(' ');
}

function rememberLoginJob(job) {
  if (!job || !job.email) return;
  var key = job.email.toLowerCase();
  var current = activeLoginJobs[key];
  if (!current || (job.updatedAt || 0) >= (current.updatedAt || 0)) activeLoginJobs[key] = job;
}

function syncLoginJobs(payload) {
  if (!payload || !Array.isArray(payload.jobs)) return;
  for (var i = 0; i < payload.jobs.length; i++) {
    rememberLoginJob(payload.jobs[i]);
    if (isActiveLoginStatus(payload.jobs[i].status)) pollLoginJob(payload.jobs[i].email, payload.jobs[i].id);
  }
}

/* ── Accounts Table ── */
function getAuthStatus(acct) {
  var job = getLoginJob(acct.email);
  if (job) {
    if (job.status === 'authenticated') return 'live';
    if (job.status === 'api_login' || job.status === 'browser_login') return 'connecting';
    if (job.status === 'queued' || job.status === 'captcha' || job.status === 'awaiting_manual') return 'pending';
  }
  if (acct.startupStatus === 'connecting') return 'connecting';
  if (acct.startupStatus === 'initializing' || acct.startupStatus === 'pending') {
    return 'pending';
  }
  if (acct.throttled) return 'throttled';
  if (acct.authenticated) return 'live';
  if (acct.tokenExpiresInMs != null && acct.tokenExpiresInMs < 0) return 'expired';
  return 'unknown';
}

function getAuthLabel(status, job) {
  if (job) {
    if (job.status === 'queued') return 'Login queued';
    if (job.status === 'api_login') return 'API login...';
    if (job.status === 'browser_login') return 'Browser login...';
    if (job.status === 'captcha') return 'CAPTCHA required';
    if (job.status === 'awaiting_manual') return 'Awaiting manual login';
    if (job.status === 'failed') return 'Login failed';
  }
  if (status === 'live') return 'Authenticated';
  if (status === 'pending') return 'Starting...';
  if (status === 'connecting') return 'Connecting...';
  if (status === 'expired') return 'Expired';
  if (status === 'throttled') return 'Throttled';
  return 'Not authenticated';
}

function makeThrottleBadge(acct) {
  if (acct.throttled) {
    var label = 'Throttled';
    if (acct.throttledUnlockAt) {
      var unlockTime = new Date(acct.throttledUnlockAt);
      var timeStr = unlockTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      label += ' until ' + timeStr;
    } else if (acct.throttledRemainingMs != null) {
      label += ' ' + fmtTTL(acct.throttledRemainingMs);
    }
    return '<span class="badge badge-warning">' + label + '</span>';
  }
  return '<span class="badge badge-neutral">OK</span>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' total');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var job = getLoginJob(a.email);
    var status = getAuthStatus(a);
    var label = getAuthLabel(status, job);
    var hideLogin = status === 'live' ? ' style="display:none"' : '';
    var disableLogin = job && isActiveLoginStatus(job.status) ? ' disabled' : '';
    var loginLabel = job && job.status === 'failed' ? 'Retry Login' : job && isActiveLoginStatus(job.status) ? 'Working...' : 'Login';
    var statusTitle = job && job.message ? ' title="' + escHtml(job.message) + '"' : '';
    rows +=
      '<tr>' +
      '<td>' +
      escHtml(a.email) +
      '</td>' +
      '<td><div class="auth-status"' +
      statusTitle +
      '><span class="auth-dot ' +
      status +
      '"></span>' +
      label +
      '</div></td>' +
      '<td>' +
      (a.inFlight || 0) +
      '</td>' +
      '<td>' +
      (a.totalRequests || 0) +
      '</td>' +
      '<td>' +
      makeThrottleBadge(a) +
      '</td>' +
      '<td style="font-family:var(--mono);font-size:0.75rem">' +
      fmtTTL(a.tokenExpiresInMs) +
      '</td>' +
      '<td>' +
      '<span class="toggle-trigger" onclick="handleToggleDisabled(event,\'' +
      escHtml(a.email) +
      "'," +
      a.disabled +
      ')">' +
      '<span class="toggle-track' +
      (a.disabled ? ' active' : '') +
      '">' +
      '<span class="toggle-thumb"></span>' +
      '</span></span>' +
      '</td>' +
      '<td><div class="action-cell">' +
      '<button class="account-btn small danger" data-email="' +
      escHtml(a.email) +
      '" data-action="remove">Remove</button>' +
      '<button class="account-btn small primary" data-email="' +
      escHtml(a.email) +
      '" data-action="login"' +
      hideLogin +
      disableLogin +
      '>' +
      loginLabel +
      '</button>' +
      '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var results = await Promise.all([apiFetch('/accounts'), apiFetch('/api/accounts/login-jobs')]);
  syncLoginJobs(results[1]);
  renderAccountsTable(results[0]);
}

/* ── Add Account ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  setError(null);
  (async function () {
    try {
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ email: email, password: password }),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : 'Failed to add account (' + res.status + ')',
        );
      }
      if (result.loginSucceeded) {
        showToast('Account added and logged in: ' + email, 'success');
      } else {
        showToast(result.loginError || 'Account added but login failed. Click Login to open browser.', 'warning');
      }
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Account';
    }
  })();
}

/* ── Remove Account ── */
function handleRemove(email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function () {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(
          result && result.error && result.error.message ? result.error.message : 'Failed to remove account (' + res.status + ')',
        );
      }
      showToast('Account removed: ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function () {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

function findLoginButton(email) {
  var buttons = document.querySelectorAll('button[data-action="login"]');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].getAttribute('data-email') === email) return buttons[i];
  }
  return null;
}

/* ── Login Jobs ── */
function handleLogin(email) {
  var btn = findLoginButton(email);
  if (btn) {
    btn.textContent = 'Authorizing...';
    btn.disabled = true;
  }
  setError(null);
  (async function () {
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email) + '/login', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ mode: 'auto' }),
      });
      var result;
      try {
        result = await res.json();
      } catch {
        result = null;
      }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Login failed (' + res.status + ')');
      }
      rememberLoginJob(result.job);
      setLoginJobNotice(email, result.job);
      showToast(result.reused ? 'Existing login task is still running.' : 'Login task started for ' + email, 'info');
      loadAccounts();
      pollLoginJob(email, result.jobId);
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
      if (btn) {
        btn.textContent = 'Login';
        btn.disabled = false;
      }
    }
  })();
}

function pollLoginJob(email, jobId) {
  if (activePollTimers[email]) {
    if (activePollTimers[email].jobId === jobId) return;
    clearTimeout(activePollTimers[email].timer);
  }

  var attempt = 0;
  async function tick() {
    attempt += 1;
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email) + '/login-jobs/' + encodeURIComponent(jobId), {
        headers: authHeaders(),
      });
      var result = await res.json().catch(function () {
        return null;
      });
      if (!res.ok || !result || !result.job) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Login status unavailable.');
      }

      var job = result.job;
      rememberLoginJob(job);
      setLoginJobNotice(email, job);
      loadAccounts();

      if (job.status === 'authenticated') {
        delete activePollTimers[email];
        delete manualNotifications[jobId];
        setError(null);
        showToast('Login completed for ' + email + ' via ' + (job.method || 'Qwen') + '.', 'success');
        return;
      }
      if (job.status === 'failed') {
        delete activePollTimers[email];
        delete manualNotifications[jobId];
        var failureMessage = formatLoginFailure(job);
        setError(failureMessage);
        showToast(failureMessage, 'error');
        return;
      }
      if ((job.status === 'captcha' || job.status === 'awaiting_manual') && !manualNotifications[jobId]) {
        manualNotifications[jobId] = true;
        showToast(job.message || 'Complete the Qwen login manually.', 'warning');
      }
    } catch (e) {
      delete activePollTimers[email];
      setError(e.message);
      showToast(e.message, 'error');
      return;
    }

    if (attempt >= 300) {
      delete activePollTimers[email];
      showToast('Login task is still running. Refresh to resume status polling.', 'warning');
      return;
    }
    activePollTimers[email] = { jobId: jobId, timer: setTimeout(tick, 2000) };
  }

  activePollTimers[email] = { jobId: jobId, timer: setTimeout(tick, 250) };
}

/* ── Toggle Disabled ── */
async function handleToggleDisabled(event, email, currentlyDisabled) {
  event.stopPropagation();
  var newDisabled = !currentlyDisabled;
  var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ disabled: newDisabled }),
  });
  if (res.ok) {
    showToast(email + ' ' + (newDisabled ? 'disabled' : 'enabled'), 'success');
    loadAccounts();
  } else {
    var err = await res.json().catch(function () {
      return { error: 'Failed' };
    });
    showToast(err.error || 'Failed to toggle', 'error');
  }
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Auto-poll every 2 seconds */
  createPoller(loadAccounts, 2000);

  /* Add form submit */
  document.getElementById('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) {
      showToast('Email and password are required', 'error');
      return;
    }
    handleAdd(email, password);
    this.reset();
  });

  /* Table button delegation */
  document.getElementById('acctTable').addEventListener('click', function (e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    if (!email || !action) return;
    if (action === 'login') handleLogin(email);
    else if (action === 'remove') handleRemove(email);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function (e) {
    if (e.target === this) this.classList.remove('open');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
