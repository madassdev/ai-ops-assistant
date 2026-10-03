import { $, $$, esc, sleep, loadIcons, hydrateIcons, icon, toast, Guide, reveal, countUp, startSession, postJson, reducedMotion } from './kit.js?v=9';

const state = { session: null, role: 'dispatcher', busy: false, playing: false, aiStatus: 'ok', seen: new Set() };
window.opsDemo = state; // handy when inspecting the demo in devtools
const els = { messages: $('#messages'), input: $('#input'), send: $('#send'), composer: $('#composer'), quick: $('#quick'), live: $('#live'), queue: $('#queue'), audit: $('#audit'), auditN: $('#auditN'), pending: $('#pendingCount'), notice: $('#aiNotice') };

const guide = new Guide({
  key: 'ops', title: 'Your demo checklist', openWhen: '#try',
  missions: [
    { id: 'watch', title: 'Watch the example', hint: 'It finds late payers and drafts reminders for you.', action: { label: 'Play it', run: () => playExample() } },
    { id: 'approve', title: 'Approve a reminder as Dee', hint: 'Tap Approve on one of the text messages.', action: { label: 'Show me', run: () => focusInbox() } },
    { id: 'blocked', title: 'Try to approve the refund as Dee', hint: 'Dee is a dispatcher. Money going out needs the owner.', action: { label: 'Show me', run: () => focusInbox() } },
    { id: 'owner', title: 'Approve it as Olivia', hint: 'Switch to Olivia, the owner, and approve the refund.', action: { label: 'Switch to Olivia', run: () => setRole('owner') } },
    { id: 'connect', title: 'Grab the MCP link', hint: 'Plug the same data into your own Claude.', action: { label: 'Show me', run: () => $('#connect').scrollIntoView({ behavior: 'smooth' }) } },
  ],
  onComplete: () => toast('That is the whole tour. Want this connected to your software?', { icon: 'party-popper', ms: 6000 }),
});
const focusInbox = () => { $('.inbox').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('.inbox').animate?.([{ boxShadow: '0 0 0 0 rgba(79,70,229,.6)' }, { boxShadow: '0 0 0 12px rgba(79,70,229,0)' }], { duration: 900 }); };

// ---------- figures ----------
const money = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
async function loadFigures() {
  try {
    const o = await (await fetch('/api/overview')).json();
    countUp($('#figJobs'), o.jobsToday.reduce((s, t) => s + t.jobs, 0));
    $('#figJobsSub').textContent = o.jobsToday.map((t) => `${t.technician} ${t.jobs}`).join(', ');
    countUp($('#figOpen'), money(o.openInvoices.owed), { prefix: '$' });
    $('#figOpenSub').textContent = `${o.openInvoices.count} invoices`;
    countUp($('#figLate'), money(o.overdue.owed), { prefix: '$' });
    $('#figLateSub').textContent = `${o.overdue.count} invoices past due`;
    countUp($('#figMonth'), money(o.collectedThisMonth), { prefix: '$' });
    state.aiStatus = o.ai.status;
    renderNotice();
  } catch { /* decoration only */ }
}

function renderNotice() {
  if (state.aiStatus === 'ok' || state.playing) { els.notice.innerHTML = ''; return; }
  els.notice.innerHTML = `<div class="notice warn">${icon('hourglass')}<div><b>The live AI is taking a break right now.</b> Everything else works: play the example to fill the approval inbox with real cards and try approving them.<br><button type="button" class="btn btn-soft btn-sm" data-play>${icon('play')}Play the example</button></div></div>`;
}

// ---------- chat ----------
function format(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const bullets = lines.filter((l) => /^\s*([-•*]|\d+\.)\s+/.test(l));
    if (bullets.length && bullets.length === lines.length) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
    if (bullets.length) {
      const head = lines.filter((l) => !/^\s*([-•*]|\d+\.)\s+/.test(l));
      return `<p>${head.map(inline).join('<br>')}</p><ul>${bullets.map((l) => `<li>${inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}
const meAvatar = () => (state.role === 'owner' ? '<span class="av o">O</span>' : '<span class="av d">D</span>');
function addRow(who, html) {
  const row = document.createElement('div');
  row.className = `row ${who}`;
  row.innerHTML = `${who === 'me' ? meAvatar() : `<span class="av bot">${icon('bot')}</span>`}<div class="bubble">${html}</div>`;
  els.messages.append(row);
  els.messages.scrollTop = els.messages.scrollHeight;
  return row;
}
function addTrace(items) {
  if (!items.length) return;
  const d = document.createElement('div');
  d.className = 'trace';
  d.innerHTML = items.map((t) => `<span class="${t.cls ?? ''}">${icon(t.icon)}${esc(t.text)}</span>`).join('');
  els.messages.append(d);
}
function typingRow() { const r = addRow('bot', '<span class="typing"><i></i><i></i><i></i></span>'); return r; }
function errorNote(text) { const d = document.createElement('div'); d.className = 'err'; d.textContent = text; els.messages.append(d); els.messages.scrollTop = els.messages.scrollHeight; }
function setReady() {
  const ready = !!state.session && !state.busy && !state.playing;
  els.input.disabled = !state.session || state.playing;
  els.send.disabled = !ready;
  $$('.chip', els.quick).forEach((b) => (b.disabled = !ready));
}

const TOOL_LABEL = { search_customers: 'Searched customers', get_customer: 'Opened a customer', list_jobs: 'Checked the schedule', list_unpaid_invoices: 'Checked unpaid invoices', revenue_summary: 'Added up revenue' };

async function send(text) {
  text = String(text ?? '').trim();
  if (!text || state.busy || state.playing) return;
  if (!state.session) { toast('Still connecting, one moment…', { icon: 'hourglass', tone: 'warn' }); return; }
  els.quick.hidden = true;
  addRow('me', esc(text));
  els.input.value = ''; autosize();
  state.busy = true; setReady();
  const t = typingRow();
  const { ok, data } = await postJson('/api/chat', { session: state.session, message: text }).catch(() => ({ ok: false, data: { error: 'Could not reach the server.' } }));
  t.remove();
  state.busy = false; setReady();
  if (!ok) { errorNote(data.error ?? 'Something went wrong.'); if (data.paused) { state.aiStatus = 'paused'; renderNotice(); } return; }
  addTrace((data.events ?? []).map((e) => e.kind === 'proposed' ? { icon: 'clipboard-list', text: `Queued: ${e.text}`, cls: 'q' } : e.kind === 'error' ? { icon: 'x', text: e.text, cls: 'e' } : { icon: 'search', text: TOOL_LABEL[e.tool] ?? e.tool }));
  addRow('bot', format(data.reply));
  if ((data.events ?? []).some((e) => e.kind === 'proposed')) { await loadActions(); focusInbox(); }
}
function autosize() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`; }
els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(els.input.value); });
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(els.input.value); } });
els.quick.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); });

// ---------- example (no AI: real data and real approval cards) ----------
async function playExample() {
  if (state.playing) return;
  if (!state.session) { toast('Still connecting, one moment…', { icon: 'hourglass', tone: 'warn' }); return; }
  state.playing = true; setReady(); renderNotice();
  $('#try').scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.quick.hidden = true;
  const { ok, data } = await postJson('/api/example', { session: state.session });
  if (!ok) { errorNote(data.error ?? 'The example could not load.'); state.playing = false; setReady(); return; }
  if (state.role !== 'dispatcher') await setRole('dispatcher', { quiet: true });
  els.messages.innerHTML = '';
  const tag = document.createElement('div'); tag.className = 'example-tag'; tag.innerHTML = `${icon('play')}Example run: real numbers and real approval cards, pre-written questions`; els.messages.append(tag);
  const speed = reducedMotion() ? 0.2 : 1;
  for (const step of data.steps) {
    if (step.who === 'me') { await sleep(700 * speed); addRow('me', esc(step.text)); continue; }
    const t = typingRow(); await sleep(1500 * speed); t.remove();
    addTrace(step.events.map((e) => e.startsWith('Queued') ? { icon: 'clipboard-list', text: e, cls: 'q' } : { icon: 'search', text: e }));
    addRow('bot', format(step.text));
    if (step.events.some((e) => e.startsWith('Queued'))) await loadActions();
  }
  guide.complete('watch');
  state.playing = false; setReady(); renderNotice();
  toast('Four changes are waiting for approval. Try approving one as Dee.', { icon: 'clipboard-list', ms: 5000 });
  focusInbox();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-play]')) playExample(); });

// ---------- approval inbox ----------
const TYPE = {
  send_payment_reminder: (a) => ({ cls: 'sms', icon: a.summary.startsWith('Email') ? 'mail' : 'message-square', label: a.summary.startsWith('Email') ? 'Email' : 'Text message' }),
  reschedule_job: () => ({ cls: 'move', icon: 'calendar-clock', label: 'Schedule change' }),
  create_invoice_draft: () => ({ cls: 'doc', icon: 'file-text', label: 'Draft invoice' }),
  issue_refund: () => ({ cls: 'money', icon: 'banknote', label: 'Refund' }),
};
const roleChip = (r) => r === 'owner' ? `<span class="badge badge-brand">${icon('crown')}Needs Olivia (owner)</span>` : `<span class="badge badge-accent">Dee or Olivia can approve</span>`;

function card(a) {
  const t = (TYPE[a.tool] ?? (() => ({ cls: 'doc', icon: 'clipboard-list', label: 'Change' })))(a);
  const isNew = !state.seen.has(a.id);
  state.seen.add(a.id);
  let foot = '';
  if (a.status === 'pending') foot = `<div class="act-btns"><button type="button" class="btn btn-ok btn-sm" data-act="${a.id}" data-approve="1">${icon('check')}Approve</button><button type="button" class="btn btn-line btn-sm" data-act="${a.id}" data-approve="0">Reject</button></div><div class="act-warn" id="warn-${a.id}" hidden></div>`;
  else if (a.status === 'executed') foot = `<div class="act-out ok">${icon('check-circle-2')}Approved by ${esc(a.decidedBy === 'Owner' ? 'Olivia' : 'Dee')} and done${a.tool === 'send_payment_reminder' ? ': message sent' : ''}.</div>`;
  else if (a.status === 'failed') foot = `<div class="act-out bad">${icon('alert-triangle')}Approved, but the system refused it: ${esc(a.result?.error ?? 'unknown error')}</div>`;
  else if (a.status === 'rejected') foot = `<div class="act-out muted">${icon('x')}Rejected. Nothing changed.</div>`;
  return `<article class="act ${a.status} ${isNew ? 'new' : ''}" data-id="${a.id}">
    <div class="act-top"><span class="act-type ${t.cls}">${icon(t.icon)}</span><div><h4>${esc(a.summary)}</h4><div class="act-meta"><span class="badge badge-brand">${esc(t.label)}</span>${a.status === 'pending' ? roleChip(a.requiredRole) : ''}</div></div></div>
    <pre>${esc(a.detail)}</pre>${foot}</article>`;
}

async function loadActions({ auditOnly = false } = {}) {
  if (!state.session) return;
  try {
    const data = await (await fetch(`/api/actions?session=${state.session}`)).json();
    const pending = data.actions.filter((a) => a.status === 'pending');
    els.pending.hidden = !pending.length;
    els.pending.textContent = `${pending.length} waiting`;
    // Don't redraw while a warning is showing, or the visitor loses it.
    const warning = !!els.queue.querySelector('.act-warn:not([hidden])');
    if (data.actions.length && !auditOnly && !warning) els.queue.innerHTML = [...pending, ...data.actions.filter((a) => a.status !== 'pending')].map(card).join('');
    els.audit.innerHTML = data.audit.map((r) => `<li class="${esc(r.kind)}"><span>${esc(r.time)}</span> ${esc(r.actor === 'Owner' ? 'Olivia' : r.actor === 'Dispatcher' ? 'Dee' : 'Assistant')}: ${esc(r.text)}</li>`).join('');
    els.auditN.textContent = `${data.audit.length} event${data.audit.length === 1 ? '' : 's'}`;
  } catch { /* retried by the poll */ }
}

els.queue.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    const id = btn.dataset.act, approve = btn.dataset.approve === '1';
    const cardEl = btn.closest('.act');
    cardEl.querySelectorAll('.act-btns button').forEach((b) => (b.disabled = true));
    const { ok, status, data } = await postJson(`/api/actions/${id}`, { session: state.session, approve });
    const tool = cardEl.querySelector('h4').textContent;
    if (!ok) {
      cardEl.querySelectorAll('.act-btns button').forEach((b) => (b.disabled = false));
      if (status === 403) {
        cardEl.classList.remove('shake'); void cardEl.offsetWidth; cardEl.classList.add('shake');
        const w = $(`#warn-${id}`);
        w.hidden = false;
        w.innerHTML = `${icon('lock')}<div>Dee can't approve money going out. Only Olivia, the owner, can.<br><button type="button" class="btn btn-dark btn-sm" data-switch>${icon('crown')}Switch to Olivia</button></div>`;
        guide.complete('blocked');
      } else toast(data.error ?? 'That did not work.', { icon: 'x', tone: 'bad' });
      await loadActions({ auditOnly: true }); // keep the warning on screen; the audit trail records the attempt
      return;
    }
    if (!approve) toast('Rejected. Nothing was changed.', { icon: 'x' });
    else if (data.status === 'executed') {
      toast(tool.startsWith('Refund') ? 'Refund issued' : tool.startsWith('Text') || tool.startsWith('Email') ? 'Reminder sent' : 'Done', { icon: 'check', tone: 'ok' });
      if (tool.startsWith('Refund') && state.role === 'owner') guide.complete('owner');
      else if (state.role === 'dispatcher') guide.complete('approve');
    } else toast(`The system refused it: ${data.result?.error ?? 'unknown error'}`, { icon: 'alert-triangle', tone: 'bad' });
    await loadActions();
    loadFigures();
    return;
  }
  if (e.target.closest('[data-switch]')) setRole('owner');
});

// ---------- who am I ----------
async function setRole(role, { quiet = false } = {}) {
  if (!state.session || role === state.role) return;
  const { ok } = await postJson('/api/role', { session: state.session, role });
  if (!ok) return;
  state.role = role;
  $$('.people button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.role === role)));
  if (!quiet) toast(role === 'owner' ? 'You are now Olivia, the owner' : 'You are now Dee, the dispatcher', { icon: role === 'owner' ? 'crown' : 'user' });
  if (!quiet) $('.who').scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Switching person clears any "only the owner can approve" warning.
  for (const w of $$('.act-warn', els.queue)) w.hidden = true;
  if (!quiet) loadActions();
}
$('.people').addEventListener('click', (e) => { const b = e.target.closest('button[data-role]'); if (b) setRole(b.dataset.role); });

// ---------- MCP link ----------
const mcpUrl = `${location.origin}/mcp`;
$('#mcpUrl').textContent = mcpUrl;
$('#copyUrl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(mcpUrl); toast('MCP link copied', { icon: 'copy', tone: 'ok' }); } catch { toast(mcpUrl, { icon: 'copy' }); }
  guide.complete('connect');
});

// ---------- boot ----------
await loadIcons();
hydrateIcons();
reveal();
loadFigures();
setInterval(loadFigures, 60_000);
addRow('bot', format("Hi, I'm the Copperline assistant. Ask me about jobs, customers, unpaid invoices or revenue. If something needs changing, I'll prepare it and you approve it."));
setReady();
try {
  const s = await startSession();
  state.session = s.session;
  els.live.textContent = 'Online'; els.live.className = 'pill-live on';
  loadActions();
  setInterval(loadActions, 15_000);
} catch (err) {
  els.live.textContent = 'Offline'; els.live.className = 'pill-live off';
  errorNote(err.message);
}
setReady();
