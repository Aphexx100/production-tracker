export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny element builder: h('div.cls#id', {attrs, on: {click}}, ...children) */
export function h(tag, props = {}, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

export function debounce(fn, ms) {
  let t;
  let last = [];
  let pending = false;
  const d = (...a) => {
    last = a; pending = true; clearTimeout(t);
    t = setTimeout(() => { pending = false; fn(...last); }, ms);
  };
  // Run a pending call now (no-op when nothing is pending).
  d.flush = () => { clearTimeout(t); if (pending) { pending = false; return fn(...last); } };
  d.cancel = () => { clearTimeout(t); pending = false; };
  return d;
}

export function toast(msg, kind = 'info', ms = 3500) {
  let box = $('#toasts');
  if (!box) document.body.append((box = h('div#toasts', { role: 'status', 'aria-live': 'polite' })));
  const t = h(`div.toast.${kind}`, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function errMsg(e) {
  return e?.message || e?.error_description || String(e);
}

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export function fmtDay(iso, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, opts);
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Frames to SMPTE-style timecode (non-drop). */
export function framesToTC(frames, fps) {
  if (frames == null || !fps) return '';
  const f = Math.round(Number(fps));
  const sign = frames < 0 ? '-' : '';
  let n = Math.abs(frames);
  const ff = n % f; n = Math.floor(n / f);
  const ss = n % 60; n = Math.floor(n / 60);
  const mm = n % 60; const hh = Math.floor(n / 60);
  return sign + [hh, mm, ss, ff].map((x) => String(x).padStart(2, '0')).join(':');
}

// DOMParser documents are inert: no image loads, no event handlers run.
export function htmlToText(html) {
  const d = new DOMParser().parseFromString(html || '', 'text/html').body;
  d.querySelectorAll('img').forEach((i) => i.replaceWith(' [image] '));
  d.querySelectorAll('p,li,h1,h2,h3,h4,br,tr').forEach((n) => n.append(' '));
  return d.textContent.replace(/\s+/g, ' ').trim();
}

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function uid() {
  return crypto.randomUUID();
}

/** Modal dialog. Returns {el, close}. */
export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const box = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', h('h2', title), h('button.icon-btn', { title: 'Close', 'aria-label': 'Close', on: { click: close } }, '✕')),
    h('div.modal-body', body));
  const back = h('div.modal-back', { on: { mousedown: (e) => { if (e.target === back) close(); } } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  return { el: box, close };
}

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; m.close(); resolve(v); } };
    const m = modal('Please confirm', [
      h('p', message),
      h('div.row.end',
        h('button.btn', { on: { click: () => finish(false) } }, 'Cancel'),
        h('button.btn.danger', { on: { click: () => finish(true) } }, okLabel)),
    ], { onClose: () => { if (!done) { done = true; resolve(false); } } });
    m.el.querySelector('.danger').focus();
  });
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function download(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
