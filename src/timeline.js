import { h, $, toast, errMsg, modal, confirmDialog, lsGet, lsSet, todayISO, fmtDay } from './util.js';
import { icon } from './icons.js';
import { api, emit } from './state.js';
import { isMissingTable } from './sequences.js';
import { STATUSES } from './statuses.js';

const ZOOMS = { day: 34, week: 14, month: 4 };
const ROW_H = 34;
const LABEL_W = 270;
const PALETTE = ['#f5a524', '#4d9cf5', '#3ecf8e', '#a67cf7', '#f0843c', '#2cc6c6', '#f472b6', '#9ca3af'];
const MIGRATION = 'The Timeline needs supabase/004_timeline.sql. An admin must run it once in the Supabase SQL Editor.';

// ---------- date helpers (UTC day numbers, immune to DST) ----------
const MS_DAY = 86_400_000;
const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / MS_DAY; };
const isoOf = (n) => new Date(n * MS_DAY).toISOString().slice(0, 10);
const weekday = (n) => new Date(n * MS_DAY).getUTCDay(); // 0 = Sunday
const addDays = (iso, k) => isoOf(dayNum(iso) + k);
const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;

function friendly(e) {
  const m = errMsg(e);
  if (isMissingTable(e) || /column/i.test(m) && /schema cache|does not exist/i.test(m)) return MIGRATION;
  if (/dates/.test(m)) return 'The end date must be on or after the start date';
  return m;
}

export function mountTimeline(root) {
  let shots = [];
  let seqMeta = [];
  let milestones = [];
  let missing = false;
  let zoom = lsGet('pt-tl-zoom', 'week');
  const expanded = new Set(lsGet('pt-tl-open', []));
  let showDone = lsGet('pt-tl-done', true);
  let origin = 0; // first visible day number
  let days = 0;
  let drag = null;

  // ---------- chrome ----------
  const addMs = h('button.btn', { type: 'button', on: { click: () => editMilestone({ kind: 'milestone', date: todayISO() }) } }, icon('plus', 15), 'Milestone');
  const addDl = h('button.btn', { type: 'button', on: { click: () => editMilestone({ kind: 'deadline', date: addDays(todayISO(), 7) }) } }, icon('plus', 15), 'Deadline');
  const zoomSeg = h('div.seg', { role: 'group', 'aria-label': 'Zoom' });
  const todayBtn = h('button.btn', { type: 'button', on: { click: () => scrollToDate(todayISO(), true) } }, 'Today');
  const expandBtn = h('button.btn', { type: 'button', on: { click: toggleAll } });
  const doneToggle = h('label.check', h('input', { type: 'checkbox', checked: showDone, on: { change: (e) => { showDone = e.target.checked; lsSet('pt-tl-done', showDone); render(); } } }), 'Show completed');
  const upcoming = h('div.tl-upcoming', { 'aria-label': 'Upcoming milestones and deadlines' });
  const bar = h('div.tl-toolbar', addMs, addDl, zoomSeg, todayBtn, expandBtn, doneToggle, upcoming);
  const hint = h('div.tl-hint', 'Drag bars to move, drag their ends to change dates. Drag across an empty row to plan it. Double-click a row to add a milestone or deadline there.');
  const scroller = h('div.tl-scroll');
  root.append(h('div.timeline', bar, hint, scroller));

  // ---------- model ----------
  function seqCodes() {
    const codes = new Set([...seqMeta.map((q) => q.code), ...shots.map((s) => s.sequence || '')]);
    const hasLoose = codes.delete('');
    const order = new Map(seqMeta.map((q) => [q.code, q.sort_order]));
    const list = [...codes].sort((a, b) =>
      (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b, undefined, { numeric: true }));
    if (hasLoose && shots.some((s) => !s.sequence)) list.push('');
    return list;
  }
  const meta = (code) => seqMeta.find((q) => q.code === code);
  const seqColor = (code, i) => meta(code)?.color || PALETTE[i % PALETTE.length];
  const visibleMs = (list) => list.filter((m) => showDone || !m.done);

  function rows() {
    const out = [{ type: 'project', key: 'project', ms: visibleMs(milestones.filter((m) => !m.sequence && !m.shot_id)) }];
    seqCodes().forEach((code, i) => {
      const mine = shots.filter((s) => (s.sequence || '') === code);
      const starts = mine.map((s) => s.start_date).filter(Boolean).sort();
      const ends = mine.map((s) => s.end_date || s.start_date).filter(Boolean).sort();
      const m = meta(code);
      out.push({
        type: 'seq', key: `seq:${code}`, code, color: seqColor(code, i), shots: mine,
        start: m?.start_date || null, end: m?.end_date || null,
        derived: starts.length ? { start: starts[0], end: ends[ends.length - 1] || starts[0] } : null,
        ms: visibleMs(milestones.filter((x) => x.sequence === code && code && !x.shot_id)),
      });
      if (expanded.has(code)) {
        for (const s of mine) {
          out.push({ type: 'shot', key: `shot:${s.id}`, shot: s, code, ms: visibleMs(milestones.filter((x) => x.shot_id === s.id)) });
        }
      }
    });
    return out;
  }

  function computeRange() {
    const dates = [todayISO()];
    for (const q of seqMeta) dates.push(q.start_date, q.end_date);
    for (const s of shots) dates.push(s.start_date, s.end_date, s.shoot_day, s.due_date);
    for (const m of milestones) dates.push(m.date);
    const nums = dates.filter(Boolean).map(dayNum);
    let lo = Math.min(...nums) - 14;
    let hi = Math.max(...nums) + 45;
    if (hi - lo < 120) hi = lo + 120;
    // start on the 1st of a month so the header reads naturally
    const d = new Date(lo * MS_DAY);
    lo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS_DAY;
    origin = lo;
    days = hi - lo + 1;
  }

  // ---------- render ----------
  const dw = () => ZOOMS[zoom];
  const x = (iso) => (dayNum(iso) - origin) * dw();

  function render() {
    renderChrome();
    if (missing) {
      scroller.replaceChildren(h('div.setup-note', h('h2', 'Timeline is not set up yet'), h('p', MIGRATION)));
      return;
    }
    const keepLeft = scroller.scrollLeft;
    const keepTop = scroller.scrollTop;
    const prevOrigin = origin;
    computeRange();
    const W = days * dw();
    const list = rows();
    const canvas = h('div.tl-canvas', { style: { width: `${LABEL_W + W}px` } });
    canvas.append(renderHeader(W));
    const body = h('div.tl-body', { style: { height: `${list.length * ROW_H}px` } });
    body.append(renderOverlay(W, list.length));
    list.forEach((r) => body.append(renderRow(r, W)));
    canvas.append(body);
    scroller.replaceChildren(canvas);
    scroller.scrollTop = keepTop;
    if (render.zoomCenter != null) { scrollToDay(render.zoomCenter); render.zoomCenter = null; }
    else if (!render.done) { scrollToDate(todayISO()); render.done = true; }
    else scroller.scrollLeft = keepLeft + (prevOrigin - origin) * dw();
  }

  function renderChrome() {
    zoomSeg.replaceChildren(...Object.keys(ZOOMS).map((z) => h(`button.seg-btn${zoom === z ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': String(zoom === z),
      on: { click: () => setZoom(z) },
    }, { day: 'Days', week: 'Weeks', month: 'Months' }[z])));
    const anyOpen = seqCodes().some((c) => expanded.has(c));
    expandBtn.textContent = anyOpen ? 'Collapse shots' : 'Show all shots';
    const today = todayISO();
    const open = milestones.filter((m) => !m.done);
    const overdue = open.filter((m) => m.kind === 'deadline' && m.date < today);
    const next = open.filter((m) => m.date >= today).slice(0, 4);
    upcoming.replaceChildren(...[
      overdue.length ? h('button.tl-chip.overdue', { type: 'button', title: overdue.map((m) => `${m.title} (${fmtDay(m.date)})`).join('\n'), on: { click: () => scrollToDate(overdue[0].date, true) } },
        `${overdue.length} overdue`) : null,
      ...next.map((m) => h(`button.tl-chip.${m.kind}`, { type: 'button', title: `${m.kind === 'deadline' ? 'Deadline' : 'Milestone'}: ${m.title}`, on: { click: () => scrollToDate(m.date, true) } },
        h('span.tl-chip-ico', m.kind === 'deadline' ? '⚑' : '◆'), m.title, h('span.faint', ` · ${relDays(m.date)}`))),
    ].filter(Boolean));
  }

  function relDays(iso) {
    const n = dayNum(iso) - dayNum(todayISO());
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n < 0) return `${-n} days ago`;
    return n < 14 ? `in ${n} days` : fmtDay(iso, { day: 'numeric', month: 'short' });
  }

  function renderHeader(W) {
    const months = h('div.tl-months');
    const ticks = h('div.tl-ticks');
    // month blocks
    let n = origin;
    const end = origin + days;
    while (n < end) {
      const d = new Date(n * MS_DAY);
      const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / MS_DAY;
      const w = (Math.min(next, end) - n) * dw();
      months.append(h('div.tl-month', { style: { left: `${(n - origin) * dw()}px`, width: `${w}px` } },
        h('span.tl-month-txt', d.toLocaleDateString(undefined, { month: zoom === 'month' ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' }))));
      n = next;
    }
    // lower tier: day numbers, or week starts
    for (let i = 0; i < days; i++) {
      const dn = origin + i;
      const d = new Date(dn * MS_DAY);
      if (zoom === 'day') {
        ticks.append(h(`div.tl-tick${weekday(dn) % 6 === 0 ? '.we' : ''}`, { style: { left: `${i * dw()}px`, width: `${dw()}px` } },
          h('b', String(d.getUTCDate())), h('span', d.toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' }))));
      } else if (zoom === 'week' && weekday(dn) === 1) {
        ticks.append(h('div.tl-tick.wk', { style: { left: `${i * dw()}px`, width: `${7 * dw()}px` } }, String(d.getUTCDate())));
      }
    }
    return h('div.tl-head',
      h('div.tl-corner', h('span', 'Sequences & shots')),
      h('div.tl-scale', { style: { width: `${W}px` } }, months, zoom === 'month' ? null : ticks));
  }

  function renderOverlay(W, count) {
    const ov = h('div.tl-overlay', { style: { width: `${W}px`, left: `${LABEL_W}px`, height: `${count * ROW_H}px` } });
    if (zoom !== 'month') {
      for (let i = 0; i < days; i++) if (weekday(origin + i) % 6 === 0) ov.append(h('div.tl-weekend', { style: { left: `${i * dw()}px`, width: `${dw()}px` } }));
    }
    for (let i = 0; i < days; i++) {
      if (new Date((origin + i) * MS_DAY).getUTCDate() === 1) ov.append(h('div.tl-monthline', { style: { left: `${i * dw()}px` } }));
    }
    // project deadlines draw across all rows
    for (const m of milestones.filter((q) => !q.sequence && !q.shot_id && q.kind === 'deadline' && (showDone || !q.done))) {
      ov.append(h(`div.tl-dline${m.done ? '.done' : ''}${!m.done && m.date < todayISO() ? '.overdue' : ''}`, { style: { left: `${x(m.date) + dw() / 2}px` } }));
    }
    ov.append(h('div.tl-today', { style: { left: `${x(todayISO()) + dw() / 2}px` }, title: `Today, ${fmtDay(todayISO())}` }));
    return ov;
  }

  function renderRow(r, W) {
    const track = h('div.tl-track', { style: { width: `${W}px` }, dataset: { key: r.key } });
    const label = h('div.tl-label');
    const row = h(`div.tl-row.tl-${r.type}`, { dataset: { key: r.key } }, label, track);

    if (r.type === 'project') {
      label.append(h('span.tl-name', 'Project'), h('span.faint', ' milestones & deadlines'));
    } else if (r.type === 'seq') {
      const open = expanded.has(r.code);
      const n = r.shots.length;
      label.append(
        h('button.icon-btn.small.caret', {
          type: 'button', disabled: !n, 'aria-expanded': String(open), 'aria-label': open ? `Hide shots of ${r.code || 'no sequence'}` : `Show shots of ${r.code || 'no sequence'}`,
          on: { click: () => { if (open) expanded.delete(r.code); else expanded.add(r.code); lsSet('pt-tl-open', [...expanded]); render(); } },
        }, n ? (open ? '▾' : '▸') : ''),
        h('span.tl-swatch', { style: { background: r.color } }),
        h('span.tl-name.mono', r.code || 'No sequence'),
        meta(r.code)?.title ? h('span.tl-sub', meta(r.code).title) : null,
        h('span.tl-count', { title: `${n} shot${n === 1 ? '' : 's'}` }, String(n)),
        r.code ? h('span.tl-links',
          h('button.link-mini', { type: 'button', title: `Show ${r.code} in the shot tracker`, on: { click: () => emit('navigate', { tab: 'shots', sequence: r.code }) } }, 'Shots'),
          h('button.link-mini', { type: 'button', title: `Open references of ${r.code}`, on: { click: () => emit('navigate', { tab: 'references', sequence: r.code }) } }, 'Refs')) : null);
      if (r.start && r.end) track.append(barEl(r, r.start, r.end, false));
      else if (r.start) track.append(barEl(r, r.start, r.start, false));
      else if (r.derived) track.append(barEl(r, r.derived.start, r.derived.end, true));
    } else {
      const s = r.shot;
      label.append(
        h(`span.dot.st-${s.status}`, { title: statusLabel(s.status) }),
        h('button.tl-shot-name', { type: 'button', title: 'Open in the shot tracker', on: { click: () => emit('navigate', { tab: 'shots', shot: s.id }) } }, s.shot_name || 'untitled shot'));
      if (s.start_date) track.append(barEl(r, s.start_date, s.end_date || s.start_date, false));
      if (s.shoot_day) track.append(h('div.tl-mark.shoot', { style: { left: `${x(s.shoot_day) + dw() / 2}px` }, title: `Shoot day: ${fmtDay(s.shoot_day)}` }, icon('film', 12)));
      if (s.due_date) {
        const late = s.due_date < todayISO() && !['apr', 'omt'].includes(s.status);
        track.append(h(`div.tl-mark.due${late ? '.overdue' : ''}`, { style: { left: `${x(s.due_date) + dw() / 2}px` }, title: `Due: ${fmtDay(s.due_date)}${late ? ' (overdue)' : ''}` }, '⚑'));
      }
    }
    for (const m of r.ms) track.append(msEl(m));
    return row;
  }

  function barEl(r, start, end, derived) {
    const isShot = r.type === 'shot';
    const txt = isShot ? r.shot.shot_name : (meta(r.code)?.title || r.code);
    const days_ = dayNum(end) - dayNum(start) + 1;
    const el = h(`div.tl-bar${derived ? '.derived' : ''}${isShot ? `.shot.st-${r.shot.status}` : ''}`, {
      style: { left: `${x(start)}px`, width: `${Math.max(days_ * dw(), 6)}px`, ...(isShot ? {} : { '--bar': r.color }) },
      title: `${txt}: ${fmtDay(start)} – ${fmtDay(end)} (${days_} day${days_ === 1 ? '' : 's'})${derived ? '\nFrom the shot dates. Click to set dates for the sequence.' : ''}`,
      dataset: { key: r.key, start, end },
      tabIndex: 0, role: 'button',
    }, h('span.tl-bar-txt', txt));
    if (!derived) el.append(h('span.h.h-l'), h('span.h.h-r'));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openEditor(r); });
    return el;
  }

  function msEl(m) {
    const late = !m.done && m.kind === 'deadline' && m.date < todayISO();
    return h(`div.tl-ms.${m.kind}${m.done ? '.done' : ''}${late ? '.overdue' : ''}`, {
      style: { left: `${x(m.date) + dw() / 2}px` }, dataset: { ms: m.id }, tabIndex: 0, role: 'button',
      title: `${m.kind === 'deadline' ? 'Deadline' : 'Milestone'}: ${m.title}\n${fmtDay(m.date)}${m.done ? ' · done' : late ? ' · overdue' : ''}${m.notes ? `\n${m.notes}` : ''}`,
      on: { keydown: (e) => { if (e.key === 'Enter') editMilestone(m); } },
    }, h('span.tl-ms-ico', m.kind === 'deadline' ? '⚑' : ''), h('span.tl-ms-txt', m.title));
  }

  // ---------- scrolling / zoom ----------
  function scrollToDay(dn) {
    scroller.scrollLeft = Math.max(0, (dn - origin) * dw() - (scroller.clientWidth - LABEL_W) / 3);
  }
  function scrollToDate(iso, flash) {
    scrollToDay(dayNum(iso));
    if (flash) {
      const f = h('div.tl-flash', { style: { left: `${LABEL_W + x(iso)}px`, width: `${dw()}px` } });
      $('.tl-body', scroller)?.append(f);
      setTimeout(() => f.remove(), 1500);
    }
  }
  function setZoom(z) {
    const center = origin + (scroller.scrollLeft + (scroller.clientWidth - LABEL_W) / 3) / dw();
    zoom = z; lsSet('pt-tl-zoom', z);
    render.zoomCenter = Math.round(center);
    render();
  }
  function toggleAll() {
    const codes = seqCodes();
    if (codes.some((c) => expanded.has(c))) expanded.clear(); else codes.forEach((c) => expanded.add(c));
    lsSet('pt-tl-open', [...expanded]);
    render();
  }

  // ---------- pointer interaction ----------
  const rowByKey = (key) => rows().find((r) => r.key === key);
  const dayAt = (track, clientX) => origin + Math.floor((clientX - track.getBoundingClientRect().left) / dw());

  scroller.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const barNode = e.target.closest('.tl-bar');
    const msNode = e.target.closest('.tl-ms');
    const track = e.target.closest('.tl-track');
    if (!track) return;
    if (msNode) {
      const m = milestones.find((q) => q.id === msNode.dataset.ms);
      drag = { kind: 'ms', m, node: msNode, x0: e.clientX, moved: 0 };
    } else if (barNode) {
      const r = rowByKey(barNode.dataset.key);
      const mode = e.target.classList.contains('h-l') ? 'start' : e.target.classList.contains('h-r') ? 'end' : 'move';
      drag = { kind: 'bar', r, node: barNode, mode, derived: barNode.classList.contains('derived'), s0: barNode.dataset.start, e0: barNode.dataset.end, x0: e.clientX, moved: 0 };
    } else {
      const r = rowByKey(track.dataset.key);
      const hasBar = r && (r.type === 'shot' ? !!r.shot.start_date : r.type === 'seq' ? !!r.start : true);
      if (!r || hasBar || r.type === 'project' || (r.type === 'seq' && !r.code)) return;
      const d0 = dayAt(track, e.clientX);
      const ghost = h('div.tl-bar.ghost', { style: { left: `${(d0 - origin) * dw()}px`, width: `${dw()}px` } });
      track.append(ghost);
      drag = { kind: 'create', r, node: ghost, track, d0, d1: d0, x0: e.clientX, moved: 0 };
    }
    scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  scroller.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / dw());
    drag.moved = Math.max(drag.moved, Math.abs(e.clientX - drag.x0));
    if (drag.kind === 'ms') {
      drag.delta = delta;
      drag.node.style.left = `${x(addDays(drag.m.date, delta)) + dw() / 2}px`;
    } else if (drag.kind === 'bar' && !drag.derived) {
      let s = drag.s0, en = drag.e0;
      if (drag.mode !== 'end') s = addDays(drag.s0, delta);
      if (drag.mode !== 'start') en = addDays(drag.e0, delta);
      if (drag.mode === 'start' && s > en) s = en;
      if (drag.mode === 'end' && en < s) en = s;
      drag.s = s; drag.e = en;
      drag.node.style.left = `${x(s)}px`;
      drag.node.style.width = `${(dayNum(en) - dayNum(s) + 1) * dw()}px`;
      drag.node.classList.add('dragging');
    } else if (drag.kind === 'create') {
      drag.d1 = dayAt(drag.track, e.clientX);
      const a = Math.min(drag.d0, drag.d1), b = Math.max(drag.d0, drag.d1);
      drag.node.style.left = `${(a - origin) * dw()}px`;
      drag.node.style.width = `${(b - a + 1) * dw()}px`;
    }
  });

  const endDrag = async (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    try { scroller.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const clicked = d.moved < 4;
    if (d.kind === 'ms') {
      if (clicked) { editMilestone(d.m); return; }
      if (d.delta) await saveMilestone(d.m, { date: addDays(d.m.date, d.delta) });
      else render();
    } else if (d.kind === 'bar') {
      if (clicked || d.derived) { openEditor(d.r); return; }
      if (d.s && (d.s !== d.s0 || d.e !== d.e0)) await saveDates(d.r, d.s, d.e);
      else render();
    } else if (d.kind === 'create') {
      d.node.remove();
      if (clicked) return;
      const a = Math.min(d.d0, d.d1), b = Math.max(d.d0, d.d1);
      await saveDates(d.r, isoOf(a), isoOf(b));
    }
  };
  scroller.addEventListener('pointerup', endDrag);
  scroller.addEventListener('pointercancel', () => { if (drag) { drag.node?.classList?.contains('ghost') && drag.node.remove(); drag = null; render(); } });

  scroller.addEventListener('dblclick', (e) => {
    const track = e.target.closest('.tl-track');
    if (!track || e.target.closest('.tl-bar, .tl-ms')) return;
    const r = rowByKey(track.dataset.key);
    if (!r) return;
    const date = isoOf(dayAt(track, e.clientX));
    const scope = r.type === 'shot' ? { shot_id: r.shot.id, sequence: r.code || '' } : r.type === 'seq' ? { sequence: r.code } : {};
    quickAdd(e.clientX, e.clientY, date, scope);
  });

  function quickAdd(cx, cy, date, scope) {
    document.querySelector('.ctx-menu')?.remove();
    const m = h('div.ctx-menu.popover', { role: 'menu' },
      h('div.menu-head', fmtDay(date)),
      h('button.menu-item', { type: 'button', role: 'menuitem', on: { click: () => { m.remove(); editMilestone({ kind: 'milestone', date, ...scope }); } } }, '◆ Add milestone here'),
      h('button.menu-item', { type: 'button', role: 'menuitem', on: { click: () => { m.remove(); editMilestone({ kind: 'deadline', date, ...scope }); } } }, '⚑ Add deadline here'));
    document.body.append(m);
    m.style.left = `${Math.min(cx, innerWidth - m.offsetWidth - 8)}px`;
    m.style.top = `${Math.min(cy, innerHeight - m.offsetHeight - 8)}px`;
    const off = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true));
    m.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') m.remove(); });
    m.querySelector('button').focus();
  }

  // ---------- saving ----------
  async function saveDates(r, start, end) {
    if (r.type === 'shot') {
      const s = r.shot;
      const prev = { start_date: s.start_date, end_date: s.end_date };
      Object.assign(s, { start_date: start, end_date: end });
      render();
      try { Object.assign(s, await api().shots.update(s.id, { start_date: start, end_date: end })); }
      catch (e) { Object.assign(s, prev); toast(`Not saved: ${friendly(e)}`, 'error', 8000); }
      render();
    } else if (r.type === 'seq') {
      await saveSeq(r.code, { start_date: start, end_date: end });
    }
  }

  async function saveSeq(code, patch) {
    const i = seqMeta.findIndex((q) => q.code === code);
    const prev = i >= 0 ? { ...seqMeta[i] } : null;
    const optimistic = { code, sort_order: prev?.sort_order ?? Math.max(0, ...seqMeta.map((q) => q.sort_order || 0)) + 1, ...prev, ...patch };
    if (i >= 0) seqMeta[i] = optimistic; else seqMeta.push(optimistic);
    render();
    try {
      const row = await api().sequences.upsert({ code, ...(prev ? {} : { sort_order: optimistic.sort_order }), ...patch });
      const j = seqMeta.findIndex((q) => q.code === code);
      seqMeta[j] = row;
    } catch (e) {
      const j = seqMeta.findIndex((q) => q.code === code);
      if (prev) seqMeta[j] = prev; else seqMeta.splice(j, 1);
      toast(`Not saved: ${friendly(e)}`, 'error', 8000);
    }
    render();
  }

  async function saveMilestone(m, patch) {
    const prev = { ...m };
    Object.assign(m, patch);
    render();
    try { Object.assign(m, await api().milestones.update(m.id, patch)); }
    catch (e) { Object.assign(m, prev); toast(`Not saved: ${friendly(e)}`, 'error', 8000); }
    render();
  }

  // ---------- editors ----------
  function openEditor(r) {
    if (r.type === 'shot') editShot(r.shot);
    else if (r.type === 'seq' && r.code) editSeq(r);
  }

  const dateInput = (value, label) => h('input', { type: 'date', value: value || '', 'aria-label': label });

  function editSeq(r) {
    const m = meta(r.code);
    const start = dateInput(m?.start_date || r.derived?.start, 'Start');
    const end = dateInput(m?.end_date || r.derived?.end, 'End');
    const color = h('input', { type: 'color', value: m?.color || r.color, 'aria-label': 'Colour' });
    const dlg = modal(`Sequence ${r.code}`, h('form.form', {
      on: { submit: async (e) => {
        e.preventDefault();
        if (start.value && end.value && end.value < start.value) { toast('The end date must be on or after the start date', 'error'); return; }
        dlg.close();
        await saveSeq(r.code, { start_date: start.value || null, end_date: end.value || start.value || null, color: color.value });
      } },
    },
    r.derived && !m?.start_date ? h('p.faint', `Suggested from the shot dates: ${fmtDay(r.derived.start)} – ${fmtDay(r.derived.end)}.`) : null,
    h('div.form-row', h('label', 'Start', start), h('label', 'End', end), h('label', 'Colour', color)),
    h('div.row.end',
      h('button.btn', { type: 'button', on: { click: async () => { dlg.close(); await saveSeq(r.code, { start_date: null, end_date: null }); } } }, 'Clear dates'),
      h('button.btn.primary', { type: 'submit' }, 'Save'))));
    start.focus();
  }

  function editShot(s) {
    const start = dateInput(s.start_date, 'Start');
    const end = dateInput(s.end_date, 'End');
    const shoot = dateInput(s.shoot_day, 'Shoot day');
    const due = dateInput(s.due_date, 'Due');
    const dlg = modal(`Shot ${s.shot_name || ''}`, h('form.form', {
      on: { submit: async (e) => {
        e.preventDefault();
        if (start.value && end.value && end.value < start.value) { toast('The end date must be on or after the start date', 'error'); return; }
        const patch = { start_date: start.value || null, end_date: end.value || start.value || null, shoot_day: shoot.value || null, due_date: due.value || null };
        dlg.close();
        const prev = { ...s };
        Object.assign(s, patch); render();
        try { Object.assign(s, await api().shots.update(s.id, patch)); }
        catch (err) { Object.assign(s, prev); toast(`Not saved: ${friendly(err)}`, 'error', 8000); }
        render();
      } },
    },
    h('p.faint', `${statusLabel(s.status)}${s.assignee ? ` · ${s.assignee}` : ''}`),
    h('div.form-row', h('label', 'Work starts', start), h('label', 'Work ends', end)),
    h('div.form-row', h('label', 'Shoot day', shoot), h('label', 'Due (deadline)', due)),
    h('div.row.end',
      h('button.btn', { type: 'button', on: { click: () => { dlg.close(); emit('navigate', { tab: 'shots', shot: s.id }); } } }, 'Open in shot tracker'),
      h('button.btn.primary', { type: 'submit' }, 'Save'))));
    start.focus();
  }

  function editMilestone(m) {
    const isNew = !m.id;
    const title = h('input', { value: m.title || '', required: true, maxLength: 200, placeholder: m.kind === 'deadline' ? 'e.g. VFX turnover' : 'e.g. Shoot starts', 'aria-label': 'Title' });
    const kind = h('select', { 'aria-label': 'Type' }, h('option', { value: 'milestone' }, '◆ Milestone'), h('option', { value: 'deadline' }, '⚑ Deadline'));
    kind.value = m.kind || 'milestone';
    const date = dateInput(m.date || todayISO(), 'Date');
    date.required = true;
    const scope = h('select', { 'aria-label': 'Belongs to' },
      h('option', { value: '' }, 'Whole project'),
      h('optgroup', { label: 'Sequence' }, seqCodes().filter(Boolean).map((c) => h('option', { value: `seq:${c}` }, c))),
      ...seqCodes().map((c) => {
        const list = shots.filter((s) => (s.sequence || '') === c);
        return list.length ? h('optgroup', { label: `Shots · ${c || 'no sequence'}` }, list.map((s) => h('option', { value: `shot:${s.id}` }, s.shot_name || 'untitled shot'))) : null;
      }));
    scope.value = m.shot_id ? `shot:${m.shot_id}` : m.sequence ? `seq:${m.sequence}` : '';
    const notes = h('textarea', { rows: 3, maxLength: 4000, 'aria-label': 'Notes' });
    notes.value = m.notes || '';
    const done = h('input', { type: 'checkbox', checked: !!m.done });
    const dlg = modal(isNew ? `New ${m.kind === 'deadline' ? 'deadline' : 'milestone'}` : 'Edit', h('form.form', {
      on: { submit: async (e) => {
        e.preventDefault();
        const t = title.value.trim();
        if (!t || !date.value) return;
        const [kindOfScope, id] = scope.value.split(':');
        const shot = kindOfScope === 'shot' ? shots.find((s) => s.id === id) : null;
        const row = {
          title: t, kind: kind.value, date: date.value, notes: notes.value.trim(), done: done.checked,
          shot_id: shot ? shot.id : null,
          sequence: shot ? (shot.sequence || '') : kindOfScope === 'seq' ? id : '',
        };
        dlg.close();
        try {
          if (isNew) milestones.push(await api().milestones.create(row));
          else Object.assign(m, await api().milestones.update(m.id, row));
          milestones.sort((a, b) => a.date.localeCompare(b.date));
          if (shot) { expanded.add(shot.sequence || ''); lsSet('pt-tl-open', [...expanded]); }
          render();
          scrollToDate(row.date, true);
        } catch (err) { toast(`Not saved: ${friendly(err)}`, 'error', 8000); }
      } },
    },
    h('label', 'Title', title),
    h('div.form-row', h('label', 'Type', kind), h('label', 'Date', date)),
    h('label', 'Belongs to', scope),
    h('label', 'Notes', notes),
    h('label.check', done, 'Done / met'),
    h('div.row.end',
      !isNew ? h('button.btn.danger', { type: 'button', on: { click: async () => {
        if (!(await confirmDialog(`Delete “${m.title}”?`))) return;
        dlg.close();
        try { await api().milestones.remove(m.id); milestones = milestones.filter((q) => q.id !== m.id); render(); }
        catch (err) { toast(friendly(err), 'error'); }
      } } }, 'Delete') : null,
      h('button.btn.primary', { type: 'submit' }, isNew ? 'Add' : 'Save'))));
    title.focus();
  }

  // ---------- live updates ----------
  const later = () => { if (!drag) render(); };
  const unsubs = [
    api().subscribe('shots', (type, row, old) => {
      shots = type === 'DELETE' ? shots.filter((s) => s.id !== old.id) : [...shots.filter((s) => s.id !== row.id), row].sort((a, b) => a.sort_order - b.sort_order);
      later();
    }),
    api().subscribe('sequences', (type, row, old) => {
      seqMeta = type === 'DELETE' ? seqMeta.filter((q) => q.code !== old.code) : [...seqMeta.filter((q) => q.code !== row.code), row];
      later();
    }),
    api().subscribe('milestones', (type, row, old) => {
      milestones = (type === 'DELETE' ? milestones.filter((m) => m.id !== old.id) : [...milestones.filter((m) => m.id !== row.id), row]).sort((a, b) => a.date.localeCompare(b.date));
      later();
    }),
  ];

  async function load() {
    try {
      const [sh, sq, ms] = await Promise.all([api().shots.list(), api().sequences.list(), api().milestones.list()]);
      shots = sh; seqMeta = sq; milestones = ms; missing = false;
    } catch (e) {
      if (isMissingTable(e)) missing = true;
      else toast(`Could not load the timeline: ${errMsg(e)}`, 'error', 8000);
    }
  }
  const ready = load().then(render);

  return {
    async enter() {
      await ready;
      history.replaceState(null, '', '#timeline');
      await load();
      render();
    },
    async reveal(code) {
      await ready;
      if (code) { expanded.add(code); lsSet('pt-tl-open', [...expanded]); }
      render();
      const r = rows().find((q) => q.key === `seq:${code}`);
      const date = r?.start || r?.derived?.start;
      if (date) scrollToDate(date, true);
      $(`.tl-row[data-key="seq:${CSS.escape(code)}"]`, scroller)?.scrollIntoView({ block: 'nearest' });
    },
    destroy() { unsubs.forEach((u) => u()); },
  };
}

