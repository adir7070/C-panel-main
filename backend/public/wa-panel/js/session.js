// Get session ID from URL: /wa/panel/session/:id
const sessionId = window.location.pathname.split('/wa/panel/session/')[1];
if (!sessionId) {
  window.location.href = '/wa/panel/';
}

let sessionData = null;
const socket = io();
const toast = document.getElementById('toast');
let toastTimer = null;

function getAdminToken() {
  return localStorage.getItem('waAdminToken') || '';
}

function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-admin-key': getAdminToken(),
  };
}

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString();
}

// --- Status UI ---
function setStatus(status, phone) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const qrBox = document.getElementById('qr-box');
  const qrImg = document.getElementById('qr-img');
  const qrPlaceholder = document.getElementById('qr-placeholder');
  const qrHint = document.getElementById('qr-hint');
  const connectedInfo = document.getElementById('connected-info');
  const sendSection = document.getElementById('send-section');

  dot.className = `status-dot ${status}`;
  text.textContent = status.replace('_', ' ');

  if (status === 'connected') {
    qrImg.style.display = 'none';
    qrPlaceholder.style.display = 'none';
    connectedInfo.style.display = 'flex';
    connectedInfo.style.flexDirection = 'column';
    connectedInfo.style.alignItems = 'center';
    qrHint.style.display = 'none';
    if (phone) {
      document.getElementById('connected-phone').textContent = `+${phone}`;
    }
    sendSection.style.display = 'block';
  } else if (status === 'qr_ready') {
    connectedInfo.style.display = 'none';
    qrPlaceholder.style.display = 'none';
    qrHint.style.display = 'block';
    sendSection.style.display = 'none';
  } else {
    // disconnected
    qrImg.style.display = 'none';
    qrPlaceholder.style.display = 'flex';
    qrPlaceholder.style.flexDirection = 'column';
    qrPlaceholder.style.alignItems = 'center';
    qrPlaceholder.innerHTML = `<div style="color: var(--text-muted); text-align:center; padding: 1rem;">Disconnected</div>`;
    connectedInfo.style.display = 'none';
    qrHint.style.display = 'none';
    sendSection.style.display = 'none';
  }
}

// --- Load session info ---
async function loadSession() {
  try {
    const res = await fetch(`/api/wa/panel/sessions/${sessionId}/status`, {
      headers: adminHeaders(),
    });
    const { success, data, error } = await res.json();
    if (!success) throw new Error(error);

    sessionData = data;
    document.getElementById('session-name-heading').textContent = data.name || data.phone || sessionId;
    document.title = `${data.name || data.phone} — WhatsApp API`;

    setStatus(data.status, data.wa_phone);
    setupApiInfo();
    loadMessages();
  } catch (err) {
    document.getElementById('session-name-heading').textContent = 'Error';
    showToast(err.message, 'error');
  }
}

function setupApiInfo() {
  document.getElementById('api-session-id').textContent = sessionId;
  if (sessionData && sessionData.api_key) {
    apiKeyValue = sessionData.api_key;
    const origin = window.location.origin;
    document.getElementById('curl-example').textContent =
`curl -X POST ${origin}/api/wa/session/${sessionId}/send \\
  -H "Content-Type: application/json" \\
  -d '{"phone": "972501234567", "message": "Hello!"}'`;
  }
}

let apiKeyValue = null;

function toggleApiKey(el) {
  if (apiKeyValue) {
    el.textContent = el.textContent.includes('•') ? apiKeyValue : '••••••••••••••••••••••••••••••••';
  }
}

async function copyApiKey() {
  if (apiKeyValue) {
    navigator.clipboard.writeText(apiKeyValue).then(() => showToast('API key copied!'));
  }
}

// --- Socket.IO ---
socket.emit('join', `session:${sessionId}`);

socket.on('qr', ({ qr }) => {
  const qrImg = document.getElementById('qr-img');
  const qrPlaceholder = document.getElementById('qr-placeholder');
  qrImg.src = qr;
  qrImg.style.display = 'block';
  qrPlaceholder.style.display = 'none';
  document.getElementById('connected-info').style.display = 'none';
  document.getElementById('qr-hint').style.display = 'block';
  setStatus('qr_ready', null);
});

socket.on('status', ({ status, phone }) => {
  setStatus(status, phone);
  if (status === 'connected') {
    showToast('WhatsApp connected successfully!');
    loadMessages();
  }
  if (status === 'disconnected') {
    showToast('Session disconnected', 'error');
  }
});

// --- Send Message ---
async function sendMessage() {
  const phone = document.getElementById('phone-input').value.trim();
  const message = document.getElementById('msg-input').value.trim();
  const btn = document.getElementById('send-btn');

  if (!phone) { showToast('Phone number is required', 'error'); return; }
  if (!message) { showToast('Message is required', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await fetch(`/api/wa/session/${sessionId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message }),
    });
    const { success, error } = await res.json();
    if (!success) throw new Error(error);
    showToast('Message sent!');
    document.getElementById('msg-input').value = '';
    setTimeout(loadMessages, 800);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send`;
  }
}

// --- Message History ---
async function loadMessages() {
  try {
    const res = await fetch(`/api/wa/panel/sessions/${sessionId}/messages`, {
      headers: adminHeaders(),
    });
    const { success, data, error } = await res.json();
    if (!success) throw new Error(error);

    const tbody = document.getElementById('messages-tbody');
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No messages yet</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(m => `
      <tr>
        <td style="font-family: monospace; font-size: 0.85rem;">${escHtml(m.to_number)}</td>
        <td style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escHtml(m.message_text)}</td>
        <td><span class="msg-status-${m.status}">${m.status}</span></td>
        <td style="color: var(--text-muted); font-size: 0.82rem; white-space: nowrap;">${formatDate(m.created_at)}</td>
      </tr>`).join('');
  } catch (err) {
    console.error('Load messages error:', err);
  }
}

// --- Delete Session ---
async function deleteSession() {
  if (!confirm('Delete this session? This cannot be undone.')) return;

  if (!sessionData || !sessionData.phone) {
    showToast('No phone number found for session', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/wa/session/${sessionData.phone}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    });
    const { success, error } = await res.json();
    if (!success) throw new Error(error);
    showToast('Session deleted. Redirecting...');
    setTimeout(() => { window.location.href = '/wa/panel/'; }, 1500);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- Init ---
loadSession();

// Enter key to send message
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && e.ctrlKey) {
    const sendSection = document.getElementById('send-section');
    if (sendSection.style.display !== 'none') sendMessage();
  }
});
