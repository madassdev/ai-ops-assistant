// Shared demo kit: icons, toasts, confetti, the demo checklist ("guide"), reveal-on-scroll,
// count-up numbers and the proof-of-work session helper.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Inline the icon sprite once so <use href="#name"> works everywhere. */
export async function loadIcons(url = 'icons.svg') {
  const holder = document.createElement('div');
  holder.innerHTML = await (await fetch(url)).text();
  document.body.prepend(holder.firstElementChild);
}
export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;

/** Replace <i data-icon="name"></i> placeholders in static HTML. */
export function hydrateIcons(root = document) {
  for (const el of $$('i[data-icon]', root)) el.outerHTML = icon(el.dataset.icon, el.className);
}

// ---------- toasts ----------
let toastBox;
export function toast(text, { icon: name = 'sparkles', tone = '', ms = 3800 } = {}) {
  toastBox ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts', role: 'status' });
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.innerHTML = `<span class="ico">${icon(name)}</span><span>${esc(text)}</span>`;
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- confetti ----------
export function confetti({ count = 120, colors } = {}) {
  if (reducedMotion()) return;
  const css = getComputedStyle(document.documentElement);
  colors ??= [css.getPropertyValue('--brand'), css.getPropertyValue('--accent'), '#16a34a', '#f43f5e', '#fbbf24'].map((c) => c.trim());
  const canvas = Object.assign(document.createElement('canvas'), { className: 'confetti' });
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const W = (canvas.width = innerWidth), H = (canvas.height = innerHeight);
  const parts = Array.from({ length: count }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 200, y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    r: 4 + Math.random() * 5, c: colors[Math.floor(Math.random() * colors.length)], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3,
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.a += p.va; p.vx *= 0.99;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
    }
    if (++frame < 160) requestAnimationFrame(tick); else canvas.remove();
  })();
}

// ---------- the demo checklist ----------
/**
 * missions: [{ id, title, hint, action?: { label, run } }]
 * Progress is remembered per app in localStorage (best effort).
 */
export class Guide {
  constructor({ key, title, missions, onComplete, openWhen }) {
    this.key = `guide:${key}`;
    this.missions = missions;
    this.onComplete = onComplete;
    this.done = new Set(this.#load());
    this.el = document.createElement('aside');
    this.el.className = 'guide';
    this.el.setAttribute('aria-label', title);
    this.title = title;
    document.body.append(this.el);
    // Start small so it never covers the hero; open by itself when the demo area scrolls into
    // view (on wide screens), unless the visitor has already toggled it.
    this.el.classList.add('collapsed');
    this.touched = false;
    this.render();
    const target = openWhen && document.querySelector(openWhen);
    if (target && innerWidth >= 700 && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); if (!this.touched) this.open(); }
      }, { threshold: 0, rootMargin: '0px 0px -40% 0px' });
      io.observe(target);
    }
  }
  open() {
    this.el.classList.remove('collapsed');
    this.el.querySelector('.guide-head')?.setAttribute('aria-expanded', 'true');
  }
  #load() { try { return JSON.parse(localStorage.getItem(this.key) ?? '[]'); } catch { return []; } }
  #save() { try { localStorage.setItem(this.key, JSON.stringify([...this.done])); } catch { /* storage off */ } }
  complete(id) {
    if (this.done.has(id) || !this.missions.some((m) => m.id === id)) return;
    this.done.add(id);
    this.#save();
    const m = this.missions.find((x) => x.id === id);
    toast(`Checklist: ${m.title}`, { icon: 'check', tone: 'ok', ms: 2600 });
    this.render();
    if (this.done.size === this.missions.length) { confetti(); this.onComplete?.(); }
  }
  reset() { this.done.clear(); this.#save(); this.render(); }
  render() {
    const n = this.done.size, total = this.missions.length;
    const current = this.missions.find((m) => !this.done.has(m.id));
    this.el.innerHTML = `
      <button class="guide-head" type="button" aria-expanded="${!this.el.classList.contains('collapsed')}">
        ${icon('list-checks')}<b>${esc(this.title)}</b><small>${n}/${total}</small>${icon('chevron-down', 'chev')}
      </button>
      <div class="guide-bar"><span style="width:${(n / total) * 100}%"></span></div>
      <div class="guide-body">
        ${this.missions.map((m) => `
          <div class="mission ${this.done.has(m.id) ? 'done' : ''} ${m === current ? 'current' : 'compact'}">
            <span class="box">${icon('check')}</span>
            <div><b>${esc(m.title)}</b>${m === current ? `<span>${esc(m.hint)}</span>` : ''}
            ${m === current && m.action ? `<button type="button" class="btn btn-soft btn-sm" data-mission="${m.id}">${esc(m.action.label)}</button>` : ''}</div>
          </div>`).join('')}
        ${n === total ? `<div class="guide-done">${icon('trophy')} All done. <button type="button" class="btn btn-line btn-sm" data-reset>Start over</button></div>` : ''}
      </div>`;
    this.el.querySelector('.guide-head').onclick = () => {
      this.touched = true;
      this.el.classList.toggle('collapsed');
      this.el.querySelector('.guide-head').setAttribute('aria-expanded', String(!this.el.classList.contains('collapsed')));
    };
    for (const b of this.el.querySelectorAll('[data-mission]')) b.onclick = () => this.missions.find((m) => m.id === b.dataset.mission)?.action?.run();
    this.el.querySelector('[data-reset]')?.addEventListener('click', () => this.reset());
  }
}

// ---------- motion helpers ----------
export function reveal() {
  if (reducedMotion() || !('IntersectionObserver' in window)) { $$('.reveal').forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.15 });
  $$('.reveal').forEach((e) => io.observe(e));
}

export function countUp(el, to, { prefix = '', decimals = 0, ms = 900 } = {}) {
  const fmt = (v) => prefix + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (reducedMotion()) { el.textContent = fmt(to); return; }
  const start = performance.now();
  (function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = fmt(to * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

// ---------- session with proof-of-work ----------
export async function solveChallenge() {
  const ch = await (await fetch('/api/challenge')).json();
  const worker = new Worker('pow-worker.js');
  try {
    const { nonce } = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = reject;
      worker.postMessage({ salt: ch.salt, bits: ch.bits });
    });
    return { token: ch.token, nonce };
  } finally {
    worker.terminate();
  }
}

export async function startSession() {
  const proof = await solveChallenge();
  const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? 'Could not start a session.');
  return data;
}

export async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, data };
}
