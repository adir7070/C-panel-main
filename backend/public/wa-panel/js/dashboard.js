const tbody = document.getElementById('sessions-tbody');
const toast = document.getElementById('toast');

let toastTimer = null;
let newSessionId = null;

// --- Admin Token ---
function getAdminToken() {
  return localStorage.getItem('waAdminToken') || '';
}

function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-admin-key': getAdminToken(),
  };
}

function saveToken() {
  const val = document.getElementById('token-input').value.trim();
  if (!val) {
    showToast('Please enter your admin token', 'error');
    return;
  }
  localStorage.setItem('waAdminToken', val);
  closeTokenModal();
  loadSessions();
}

function openTokenModal() {
  document.getElementById('token-input').value = getAdminToken();
  document.getElementById('token-modal').classList.add('open');
  setTimeout(() => document.getElementById('token-input').focus(), 100);
}

function closeTokenModal() {
  document.getElementById('token-modal').classList.remove('open');
}

window.addEventListener('DOMContentLoaded', () => {
  if (getAdminToken()) {
    closeTokenModal();
    loadSessions();
  }
});

document.getElementById('token-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') saveToken();
});

// --- Helpers ---
function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString();
}

function statusBadge(status) {
  return `<span class="badge badge-${status}">${status.replace('_', ' ')}</span>`;
}

function apiKeyCell(key) {
  const masked = '••••••••••••••••••••••••••••••••';
  return `
    <div class="api-key-wrap">
      <span class="api-key-hidden" data-key="${escHtml(key)}" onclick="toggleKey(this)" title="Click to reveal">${masked}</span>
      <button class="btn btn-secondary btn-sm" onclick="copyKey('${escHtml(key)}')">Copy</button>
    </div>`;
}

function toggleKey(el) {
  const key = el.dataset.key;
  el.textContent = el.textContent.includes('•') ? key : '••••••••••••••••••••••••••••••••';
}

function copyKey(key) {
  navigator.clipboard.writeText(key).then(() => showToast('API key copied!'));
}

function copyConnectUrl() {
  const url = document.getElementById('connect-url-input').value;
  navigator.clipboard.writeText(url).then(() => showToast('Link copied!'));
}

// --- Load Sessions ---
async function loadSessions() {
  if (!getAdminToken()) return;

  try {
    const res = await fetch('/api/wa/panel/sessions', { headers: adminHeaders() });

    if (res.status === 401) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Invalid admin token. Click "Admin Token" to update.</p></div></td></tr>`;
      return;
    }

    const { success, data, error } = await res.json();
    if (!success) throw new Error(error);

    if (!data.length) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <p>No sessions yet. Create one to get started.</p>
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(s => `
      <tr>
        <td><strong>${escHtml(s.name)}</strong></td>
        <td>${s.wa_phone || s.phone || '—'}</td>
        <td>${statusBadge(s.status)}</td>
        <td>${apiKeyCell(s.api_key)}</td>
        <td>
          <a href="/wa/connect/${s.session_id}" target="_blank" class="btn btn-secondary btn-sm" title="QR link to send to client">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            QR Link
          </a>
        </td>
        <td style="color: var(--text-muted); font-size: 0.82rem;">${formatDate(s.created_at)}</td>
        <td>
          <div class="actions-row">
            <a href="/wa/panel/session/${s.session_id}" class="btn btn-secondary btn-sm">Open</a>
            <button class="btn btn-danger btn-sm" onclick="deleteSession('${escHtml(s.session_id)}')">Delete</button>
          </div>
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Error: ${escHtml(err.message)}</p></div></td></tr>`;
  }
}

// --- Create Session ---
async function createSession() {
  const nameInput = document.getElementById('session-name');
  const phoneInput = document.getElementById('session-phone');
  const btn = document.getElementById('create-btn');
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!phone) {
    showToast('Please enter a phone number', 'error');
    phoneInput.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch('/api/wa/session/get-or-create', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ phone, name: name || phone }),
    });
    const { success, data, error } = await res.json();
    if (!success) throw new Error(error);

    closeCreateModal();
    newSessionId = data.session_id;

    // Show connect URL modal
    document.getElementById('connect-url-input').value = data.connect_url;
    document.getElementById('open-session-btn').onclick = () => {
      window.location.href = `/wa/panel/session/${data.session_id}`;
    };
    document.getElementById('connect-modal').classList.add('open');

    loadSessions();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

// --- Delete Session ---
async function deleteSession(sessionId) {
  if (!confirm('Delete this session? This cannot be undone.')) return;

  try {
    const res = await fetch(`/api/wa/panel/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    const { success, error } = await res.json();
    if (!success) throw new Error(error);
    showToast('Session deleted');
    loadSessions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- Modal Controls ---
function openCreateModal() {
  document.getElementById('create-modal').classList.add('open');
  setTimeout(() => document.getElementById('session-phone').focus(), 100);
}

function closeCreateModal() {
  document.getElementById('create-modal').classList.remove('open');
  document.getElementById('session-name').value = '';
  document.getElementById('session-phone').value = '';
}

document.getElementById('create-modal').addEventListener('click', function(e) {
  if (e.target === this) closeCreateModal();
});

document.getElementById('connect-modal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});

document.getElementById('session-phone').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') createSession();
});

// Auto-refresh every 10s
setInterval(loadSessions, 10000);
