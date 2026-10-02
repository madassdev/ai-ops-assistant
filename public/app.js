const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { session: null, role: 'dispatcher', busy: false, seenActions: new Set() };
window.opsDemo = state; // handy when inspecting the demo in devtools

const els = {
  messages: $('#messages'), input: $('#input'), send: $('#send'), composer: $('#composer'), suggestions: $('#suggestions'),
  statusDot: $('#statusDot'), statusText: $('#statusText'), queue: $('#queue'), audit: $('#audit'), pendingCount: $('#pendingCount'),
};

// ---------- figures ----------

async function loadFigures() {
  try {
    const o = await (await fetch('/api/overview')).json();
    const jobs = o.jobsToday.reduce((s, t) => s + t.jobs, 0);
    $('#figJobs').textContent = jobs;
    $('#figJobsSub').textContent = o.jobsToday.map((t) => `${t.technician} ${t.jobs}`).join(', ');
    $('#figOpen').textContent = o.openInvoices.owed;
    $('#figOpenSub').textContent = `${o.openInvoices.count} invoices`;
    $('#figOverdue').textContent = o.overdue.owed;
    $('#figOverdueSub').textContent = `${o.overdue.count} past due`;
    $('#figMonth').textContent = o.collectedThisMonth;
  } catch { /* figures are decoration; the next refresh retries */ }
}

// ---------- chat ----------

/** Minimal formatting for assistant text: paragraphs, bullet lists, **bold**. */
function format(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*([-•*]|\d+\.)\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

function addMessage(kind, text, html = false) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  if (html) div.innerHTML = text; else div.textContent = text;
  els.messages.append(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

const TOOL_LABEL = {
  search_customers: 'Searched customers', get_customer: 'Opened customer', list_jobs: 'Listed jobs',
  list_unpaid_invoices: 'Checked unpaid invoices', revenue_summary: 'Summarised revenue',
};

function addTrace(events) {
  if (!events.length) return;
  const div = document.createElement('div');
  div.className = 'trace';
  div.innerHTML = events.map((e) => {
    if (e.kind === 'proposed') return `<span class="proposed">Queued for approval: ${esc(e.text)}</span>`;
    if (e.kind === 'error') return `<span class="error">${esc(e.text)}</span>`;
    return `<span>${esc(TOOL_LABEL[e.tool] ?? e.tool)}</span>`;
  }).join('');
  els.messages.append(div);
}

function setStatus(kind, text) { els.statusDot.className = `dot ${kind}`; els.statusText.textContent = text; }

function setBusy(busy) {
  state.busy = busy;
  const ready = !!state.session && !busy;
  els.input.disabled = !state.session;
  els.send.disabled = !ready;
  els.suggestions.querySelectorAll('button').forEach((b) => (b.disabled = !ready));
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy || !state.session) return;
  els.suggestions.hidden = true;
  addMessage('me', text);
  els.input.value = '';
  autosize();
  setBusy(true);
  const typing = addMessage('bot typing', '');
  typing.innerHTML = '<i></i><i></i><i></i>';
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: state.session, message: text }) });
    const data = await r.json();
    typing.remove();
    if (!r.ok) {
      addMessage('error', data.error ?? 'Something went wrong.');
      if (data.expired) state.session = null;
      return;
    }
    addTrace(data.events ?? []);
    addMessage('bot', format(data.reply), true);
    if (data.messagesLeft <= 3) setStatus('on', `${data.messagesLeft} message${data.messagesLeft === 1 ? '' : 's'} left in this demo session`);
    await loadActions();
  } catch {
    typing.remove();
    addMessage('error', 'Could not reach the server. Check your connection and try again.');
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

function autosize() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`; }
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(els.input.value); });
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(els.input.value); } });
els.suggestions.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });

// ---------- approvals ----------

const roleName = (r) => (r === 'owner' ? 'owner' : 'dispatcher');

function actionCard(a) {
  const just = a.status === 'pending' && !state.seenActions.has(a.id);
  state.seenActions.add(a.id);
  const cls = { pending: '', executed: 'done', running: '', rejected: 'rejected', failed: 'failed' }[a.status] ?? '';
  let footer = '';
  if (a.status === 'pending') {
    footer = `<p class="needs">Needs the <b>${roleName(a.requiredRole)}</b> to approve.</p>
      <div class="buttons"><button type="button" class="btn approve" data-act="${a.id}" data-approve="1">Approve</button><button type="button" class="btn" data-act="${a.id}" data-approve="0">Reject</button></div>
      <p class="warn" id="warn-${a.id}" hidden></p>`;
  } else if (a.status === 'executed') {
    footer = `<p class="outcome ok">Approved by ${esc(a.decidedBy)} and done.</p>`;
  } else if (a.status === 'failed') {
    footer = `<p class="outcome bad">Approved by ${esc(a.decidedBy)}, but the system refused it: ${esc(a.result?.error ?? 'unknown error')}</p>`;
  } else if (a.status === 'rejected') {
    footer = `<p class="outcome">Rejected by ${esc(a.decidedBy)}. Nothing changed.</p>`;
  }
  return `<article class="action ${cls}${just ? ' just' : ''}">
    <div class="action-top"><h3>${esc(a.summary)}</h3><time>${esc(a.createdAt)}</time></div>
    <pre>${esc(a.detail)}</pre>${footer}</article>`;
}

function auditItem(r) {
  return `<li class="${esc(r.kind)}"><span class="who">${esc(r.time)}, ${esc(r.actor)}:</span> ${esc(r.text)}</li>`;
}

async function loadActions() {
  if (!state.session) return;
  try {
    const data = await (await fetch(`/api/actions?session=${state.session}`)).json();
    const pending = data.actions.filter((a) => a.status === 'pending');
    els.pendingCount.hidden = !pending.length;
    els.pendingCount.textContent = pending.length;
    if (data.actions.length) {
      // Pending first, then decided ones, newest first within each.
      const ordered = [...pending, ...data.actions.filter((a) => a.status !== 'pending')];
      els.queue.innerHTML = ordered.map(actionCard).join('');
    }
    if (data.audit.length) els.audit.innerHTML = data.audit.map(auditItem).join('');
  } catch { /* retried on the next action */ }
}

els.queue.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.act;
  btn.closest('.buttons').querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const r = await fetch(`/api/actions/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: state.session, approve: btn.dataset.approve === '1' }) });
    const data = await r.json();
    if (!r.ok) {
      const warn = $(`#warn-${id}`);
      if (warn) { warn.textContent = data.error; warn.hidden = false; }
      btn.closest('.buttons').querySelectorAll('button').forEach((b) => (b.disabled = false));
      await loadActionsAuditOnly();
      return;
    }
    await loadActions();
    loadFigures();
  } catch {
    btn.closest('.buttons').querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
});

async function loadActionsAuditOnly() {
  const data = await (await fetch(`/api/actions?session=${state.session}`)).json();
  if (data.audit.length) els.audit.innerHTML = data.audit.map(auditItem).join('');
}

// ---------- role switch (demo only) ----------

document.querySelector('.role').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-role]');
  if (!btn || !state.session || btn.dataset.role === state.role) return;
  const r = await fetch('/api/role', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: state.session, role: btn.dataset.role }) });
  if (!r.ok) return;
  state.role = btn.dataset.role;
  document.querySelectorAll('.role button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
});

// ---------- session ----------

async function startSession() {
  try {
    const ch = await (await fetch('/api/challenge')).json();
    const worker = new Worker('pow-worker.js');
    const { nonce } = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = reject;
      worker.postMessage({ salt: ch.salt, bits: ch.bits });
    });
    worker.terminate();
    const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ch.token, nonce }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    state.session = data.session;
    setStatus('on', 'Connected. Demo data resets every day.');
    loadActions();
    setBusy(false);
  } catch (err) {
    setStatus('off', 'Assistant unavailable');
    addMessage('error', err?.message || 'Could not start a session. Reload the page to try again.');
  }
}

// ---------- MCP box ----------

const mcpUrl = `${location.origin}/mcp`;
$('#mcpUrl').textContent = mcpUrl;
$('#mcpCmd').textContent = `claude mcp add --transport http copperline-ops ${mcpUrl}`;
$('#copyUrl').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText(mcpUrl); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Copy failed'; }
  setTimeout(() => (e.target.textContent = 'Copy URL'), 1500);
});

loadFigures();
setInterval(loadFigures, 60_000);
setInterval(loadActions, 15_000);
setBusy(false);
startSession();
