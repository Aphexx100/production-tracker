import { h, $, $$, toast, errMsg, framesToTC, htmlToText, lsGet, lsSet, fmtDay, fmtTime, confirmDialog, csvEscape, download, todayISO } from './util.js';
import { icon } from './icons.js';
import { api, state, on, emit, profileName } from './state.js';
import { sanitize } from './sanitize.js';
import { createEditor } from './editor.js';
import { resolveImages, resolveHtml, stripImageUrls, uploadImage, imageFiles } from './media.js';
import { todoStore, todoChips, openTodoPopover, renderBoard } from './todos.js';
import { parseDelimited } from './csv.js';

export const STATUSES = [
  { id: 'wtg', label: 'Waiting' },
  { id: 'rdy', label: 'Ready' },
  { id: 'ip', label: 'In progress' },
  { id: 'shot', label: 'Shot' },
  { id: 'rev', label: 'In review' },
  { id: 'apr', label: 'Approved' },
  { id: 'hld', label: 'On hold' },
  { id: 'omt', label: 'Omitted' },
];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SHOT_TYPES = ['EWS', 'WS', 'MWS', 'MS', 'MCU', 'CU', 'ECU', 'OTS', 'POV', 'Insert', '2-Shot', 'Aerial', 'Cutaway'];
const MOVES = ['Static', 'Pan', 'Tilt', 'Dolly', 'Track', 'Handheld', 'Steadicam', 'Gimbal', 'Crane', 'Drone', 'Zoom', 'Push in', 'Pull out'];

const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label || id;

// Header tooltips: what each column means in production terms.
const T = {
  status: "Where the shot is in the pipeline: Waiting (not ready), Ready (prepped to shoot), In progress, Shot (filmed), In review (with the director or VFX supervisor), Approved (final), On hold, Omitted (cut from the film).",
  shot_name: "Unique shot code, usually sequence + shot number, e.g. SQ010_0020. Numbers go up in steps of 10 so new shots can be slotted in between (0015).",
  sequence: "Sequence: a group of scenes that form one continuous story beat, e.g. SQ010 = “the harbour chase”. One sequence contains one or more scenes. The paperclip opens this sequence's references.",
  scene: "Scene number from the script: the action in one location at one time. A scene is covered by one or more shots.",
  description: "What happens in the shot: action, framing, dialogue cues. Paste storyboards or reference images here.",
  shot_type: "Shot size, i.e. how much of the subject is in frame: EWS extreme wide, WS wide, MWS medium wide, MS medium, MCU medium close-up, CU close-up, ECU extreme close-up, OTS over-the-shoulder, POV point of view, Insert = detail of an object.",
  lens: "Lens used or planned, e.g. “35mm Cooke S4”. Focal length sets the field of view: low mm = wide, high mm = tight.",
  camera: "Camera body or unit, e.g. Alexa 35, A-cam / B-cam.",
  movement: "How the camera moves: Static, Pan (turn left/right), Tilt (up/down), Dolly/Track (camera travels on rails), Handheld, Steadicam, Gimbal, Crane, Drone, Zoom, Push in / Pull out.",
  frame_in: "First frame of the cut, e.g. 1001 (editorial convention: shots start at frame 1001 to leave room for handles).",
  frame_out: "Last frame of the cut. Must be at or after the In frame.",
  duration: "Cut length = Out − In + 1, shown in frames and as timecode (hh:mm:ss:ff) at the project frame rate. Hover a cell to see the length including handles.",
  handles: "Extra frames kept before In and after Out, so editors and VFX have room to adjust the cut. Typically 8–12 frames per side.",
  location: "Where the shot is filmed: set, stage or real place.",
  int_ext: "INT = interior, EXT = exterior. Taken from the scene heading in the script.",
  day_night: "Time of day in the story (DAY, NIGHT, DAWN, DUSK), from the scene heading. Drives lighting and scheduling.",
  shoot_day: "The shooting-schedule date on which this shot is filmed.",
  assignee: "Main person responsible for the shot.",
  priority: "How urgent the shot is: low, normal, high, urgent.",
  due_date: "Deadline for the shot. Shown in red when overdue and not yet approved or omitted.",
  comments: "Free notes: continuity, problems, director’s feedback. Shift+Enter for a new line.",
  _todo: "Open tasks for this shot per team member. The number is how many are still open; ✓ means all done. Click to add or tick off tasks.",
  updated_at: "When the shot was last changed, and by whom."
};

// type: text | int | select | date | rich | long | calc | todo | meta
const COLUMNS = [
  { key: 'status', tip: T.status, label: 'Status', type: 'select', w: 116, options: () => STATUSES.map((s) => [s.id, s.label]) },
  { key: 'shot_name', tip: T.shot_name, label: 'Shot', type: 'text', w: 130 },
  { key: 'sequence', tip: T.sequence, label: 'Seq', type: 'text', w: 104 },
  { key: 'scene', tip: T.scene, label: 'Scene', type: 'text', w: 62 },
  { key: 'description', tip: T.description, label: 'Description', type: 'rich', w: 320 },
  { key: 'shot_type', tip: T.shot_type, label: 'Size', type: 'text', w: 70, suggest: SHOT_TYPES },
  { key: 'lens', tip: T.lens, label: 'Lens', type: 'text', w: 120 },
  { key: 'camera', tip: T.camera, label: 'Camera', type: 'text', w: 100, hidden: true },
  { key: 'movement', tip: T.movement, label: 'Movement', type: 'text', w: 100, suggest: MOVES },
  { key: 'frame_in', tip: T.frame_in, label: 'In', type: 'int', w: 66 },
  { key: 'frame_out', tip: T.frame_out, label: 'Out', type: 'int', w: 66 },
  { key: 'duration', tip: T.duration, label: 'Length', type: 'calc', w: 118 },
  { key: 'handles', tip: T.handles, label: 'Handles', type: 'int', w: 70, hidden: true },
  { key: 'location', tip: T.location, label: 'Location', type: 'text', w: 110, hidden: true },
  { key: 'int_ext', tip: T.int_ext, label: 'I/E', type: 'select', w: 72, hidden: true, options: () => ['', 'INT', 'EXT', 'INT/EXT'].map((v) => [v, v || '—']) },
  { key: 'day_night', tip: T.day_night, label: 'D/N', type: 'select', w: 76, hidden: true, options: () => ['', 'DAY', 'NIGHT', 'DAWN', 'DUSK'].map((v) => [v, v || '—']) },
  { key: 'shoot_day', tip: T.shoot_day, label: 'Shoot day', type: 'date', w: 116, hidden: true },
  { key: 'assignee', tip: T.assignee, label: 'Assigned', type: 'select', w: 96, options: () => [['', '—'], ...state.team.map((m) => [m.name, m.name])] },
  { key: 'priority', tip: T.priority, label: 'Priority', type: 'select', w: 84, options: () => PRIORITIES.map((p) => [p, p]) },
  { key: 'due_date', tip: T.due_date, label: 'Due', type: 'date', w: 110, hidden: true },
  { key: 'comments', tip: T.comments, label: 'Comments', type: 'long', w: 220 },
  { key: '_todo', tip: T._todo, label: 'To-do', type: 'todo', w: 200 },
  { key: 'updated_at', tip: T.updated_at, label: 'Updated', type: 'meta', w: 130, hidden: true },
];
const EDITABLE = new Set(['text', 'int', 'select', 'date', 'rich', 'long']);
const PREFS = 'pt-grid-prefs-v1';

export function mountShots(root) {
  let shots = [];
  let view = lsGet('pt-shot-view', 'grid');
  const prefs = lsGet(PREFS, {});
  const hidden = new Set(prefs.hidden || COLUMNS.filter((c) => c.hidden).map((c) => c.key));
  const widths = prefs.widths || {};
  let sort = prefs.sort || null; // {key, dir}
  let groupBySeq = prefs.group ?? false;
  const filter = { q: '', sequence: null, statuses: new Set(prefs.statuses || []), assignee: prefs.assignee || '', hideOmitted: prefs.hideOmitted ?? false };
  let sel = null; // {id, key}
  let editing = null; // {id, key, close()}
  const deferred = new Set(); // rows changed remotely while being edited

  const savePrefs = () => lsSet(PREFS, {
    hidden: [...hidden], widths, sort, group: groupBySeq,
    statuses: [...filter.statuses], assignee: filter.assignee, hideOmitted: filter.hideOmitted,
  });
  const cols = () => COLUMNS.filter((c) => !hidden.has(c.key));
  const byId = (id) => shots.find((s) => s.id === id);

  const store = todoStore(api, () => shots);
  store.onChange(() => { if (view === 'grid') refreshTodoCells(); });

  // ---------- chrome ----------
  const searchInput = h('input.search', { type: 'search', placeholder: 'Search shots…', 'aria-label': 'Search shots' });
  searchInput.addEventListener('input', () => { filter.q = searchInput.value; renderBody(); });
  const assigneeSel = h('select.tb-select', { 'aria-label': 'Filter by assignee' });
  assigneeSel.addEventListener('change', () => { filter.assignee = assigneeSel.value; savePrefs(); renderBody(); });
  const statusBox = h('div.status-filter', { role: 'group', 'aria-label': 'Filter by status' });
  const addBtn = h('button.btn.primary', { type: 'button', on: { click: () => addShot() } }, icon('plus', 16), 'Add shot');
  const viewSwitch = h('div.seg', { role: 'tablist', 'aria-label': 'Shot view' });
  const moreBtn = h('button.btn', { type: 'button', 'aria-haspopup': 'true' }, icon('more', 16), 'More');
  moreBtn.addEventListener('click', () => openMoreMenu(moreBtn));

  const toolbar = h('div.shot-toolbar', addBtn, h('div.search-wrap', icon('search', 15), searchInput), assigneeSel, viewSwitch, h('div.spacer'), moreBtn);
  const statusBar = h('div.shot-filterbar', statusBox);
  const scroller = h('div.grid-scroll', { tabIndex: 0, 'aria-label': 'Shot list. Arrow keys move, Enter edits.' });
  const table = h('table.grid', { role: 'grid' });
  scroller.append(table);
  const boardBox = h('div.board-wrap');
  const footer = h('footer.grid-foot');
  const wrap = h('div.shots', toolbar, statusBar, scroller, boardBox, footer);
  root.append(wrap);

  function renderChrome() {
    viewSwitch.replaceChildren(
      ...[['grid', 'Shots', 'grid'], ['board', 'To-dos by person', 'list']].map(([v, label, ic]) =>
        h(`button.seg-btn${view === v ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(view === v), on: { click: () => setView(v) } }, icon(ic, 15), label)));
    assigneeSel.replaceChildren(h('option', { value: '' }, 'Everyone'), ...state.team.map((m) => h('option', { value: m.name }, m.name)));
    assigneeSel.value = filter.assignee;
    statusBox.replaceChildren(...[
      ...STATUSES.map((s) => {
        const b = h(`button.status-chip.st-${s.id}${filter.statuses.has(s.id) ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(filter.statuses.has(s.id)) }, s.label);
        b.addEventListener('click', () => {
          if (filter.statuses.has(s.id)) filter.statuses.delete(s.id); else filter.statuses.add(s.id);
          savePrefs(); renderChrome(); renderBody();
        });
        return b;
      }),
      filter.sequence != null ? h('button.seq-filter', {
        type: 'button', title: 'Showing one sequence. Click to show all.',
        on: { click: () => { filter.sequence = null; renderChrome(); renderBody(); } },
      }, `Seq ${filter.sequence || '(none)'}`, icon('x', 12)) : null,
      filter.statuses.size ? h('button.link-btn', { type: 'button', on: { click: () => { filter.statuses.clear(); savePrefs(); renderChrome(); renderBody(); } } }, 'Clear') : null,
      h('label.check', h('input', { type: 'checkbox', checked: filter.hideOmitted, on: { change: (e) => { filter.hideOmitted = e.target.checked; savePrefs(); renderBody(); } } }), 'Hide omitted'),
      h('label.check', h('input', { type: 'checkbox', checked: groupBySeq, on: { change: (e) => { groupBySeq = e.target.checked; savePrefs(); renderBody(); } } }), 'Group by sequence'),
    ].filter(Boolean));
    const grid = view === 'grid';
    scroller.hidden = !grid; statusBar.hidden = !grid; footer.hidden = !grid;
    searchInput.parentElement.hidden = !grid; assigneeSel.hidden = !grid; addBtn.hidden = !grid;
    boardBox.hidden = grid;
  }

  let offBoard = null;
  function setView(v) {
    closeEditor(true);
    view = v; lsSet('pt-shot-view', v);
    offBoard?.(); offBoard = null;
    renderChrome();
    if (v === 'board') offBoard = renderBoard(boardBox, store, { onOpenShot: revealShot });
    else renderAll();
  }

  function revealShot(id) {
    filter.q = ''; searchInput.value = ''; filter.sequence = null; filter.statuses.clear(); filter.assignee = ''; filter.hideOmitted = false;
    setView('grid');
    select(id, 'shot_name');
  }

  // ---------- filtering / sorting ----------
  function visibleShots() {
    const q = filter.q.trim().toLowerCase();
    let list = shots.filter((s) =>
      (!filter.statuses.size || filter.statuses.has(s.status)) &&
      (!filter.assignee || s.assignee === filter.assignee) &&
      (filter.sequence == null || (s.sequence || '') === filter.sequence) &&
      (!filter.hideOmitted || s.status !== 'omt') &&
      (!q || searchText(s).includes(q)));
    if (sort) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      const val = (s) => {
        const v = col.type === 'rich' ? htmlToText(s[col.key]) : s[col.key];
        return v == null || v === '' ? null : v;
      };
      list = [...list].sort((a, b) => {
        const x = val(a), y = val(b);
        if (x === y) return a.sort_order - b.sort_order;
        if (x == null) return 1;
        if (y == null) return -1;
        const r = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort.dir === 'desc' ? -r : r;
      });
    }
    if (groupBySeq) {
      const order = [];
      const groups = new Map();
      for (const s of list) {
        const k = s.sequence || '';
        if (!groups.has(k)) { groups.set(k, []); order.push(k); }
        groups.get(k).push(s);
      }
      list = order.flatMap((k) => groups.get(k));
    }
    return list;
  }
  const textCache = new WeakMap();
  function searchText(s) {
    let c = textCache.get(s);
    if (!c) {
      c = [s.shot_name, s.sequence, s.scene, htmlToText(s.description), s.lens, s.camera, s.movement, s.shot_type, s.comments, s.location, s.assignee, statusLabel(s.status)]
        .join(' ').toLowerCase();
      textCache.set(s, c);
    }
    return c;
  }

  // ---------- rendering ----------
  function renderAll() {
    renderHead();
    renderBody();
  }

  function renderHead() {
    pins = pinned();
    const colgroup = h('colgroup', h('col', { style: { width: '34px' } }), cols().map((c) => h('col', { style: { width: `${widths[c.key] || c.w}px` } })));
    const tr = h('tr', h('th.gutter', { scope: 'col', 'aria-label': 'Row' }, '#'));
    for (const c of cols()) {
      const sorted = sort?.key === c.key ? sort.dir : null;
      const th = h(`th${sorted ? '.sorted' : ''}`, { scope: 'col', dataset: { key: c.key }, 'aria-sort': sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : null });
      const hint = c.type === 'todo' ? '' : '\n\nClick to sort.';
      const label = h('button.th-btn', { type: 'button', title: `${c.label}: ${c.tip}${hint}` },
        c.label, sorted ? h('span.sort-ind', sorted === 'asc' ? '▲' : '▼') : null);
      if (c.type !== 'todo') label.addEventListener('click', () => cycleSort(c.key));
      const grip = h('span.col-resize', { 'aria-hidden': 'true' });
      grip.addEventListener('pointerdown', (e) => startResize(e, c));
      th.append(label, grip);
      applyPin(th, c.key);
      tr.append(th);
    }
    table.replaceChildren(colgroup, h('thead', tr), h('tbody'));
  }

  function cycleSort(key) {
    closeEditor(true);
    if (!sort || sort.key !== key) sort = { key, dir: 'asc' };
    else if (sort.dir === 'asc') sort = { key, dir: 'desc' };
    else sort = null;
    savePrefs(); renderAll();
  }

  function startResize(e, c) {
    e.preventDefault(); e.stopPropagation();
    const idx = cols().indexOf(c) + 1;
    const colEl = table.querySelectorAll('col')[idx];
    const startX = e.clientX;
    const start = widths[c.key] || c.w;
    const move = (ev) => { widths[c.key] = Math.max(48, start + ev.clientX - startX); colEl.style.width = `${widths[c.key]}px`; };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); savePrefs();
      if (pins.has(c.key)) renderAll();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function renderBody() {
    closeEditor(true);
    const tbody = table.tBodies[0] || table.appendChild(h('tbody'));
    const list = visibleShots();
    const frag = document.createDocumentFragment();
    let group = null;
    const ncols = cols().length + 1;
    list.forEach((s, i) => {
      if (groupBySeq && (s.sequence || '') !== group) {
        group = s.sequence || '';
        const members = list.filter((x) => (x.sequence || '') === group);
        const frames = members.reduce((a, x) => a + (x.duration || 0), 0);
        frag.append(h('tr.group-row', h('td', { colSpan: ncols },
          h('strong', group || 'No sequence'), h('span.faint', ` · ${members.length} shot${members.length === 1 ? '' : 's'} · ${frames} f · ${framesToTC(frames, state.settings.fps)}`))));
      }
      frag.append(renderRow(s, i + 1));
    });
    tbody.replaceChildren(frag);
    if (!list.length) {
      tbody.append(h('tr.empty-row', h('td', { colSpan: ncols },
        shots.length ? 'No shots match the filters.' : h('span', 'No shots yet. ', h('button.link-btn', { type: 'button', on: { click: () => addShot() } }, 'Add the first shot'), ' or import a CSV from the More menu.'))));
    }
    resolveImages(tbody).catch(() => {});
    renderFooter(list);
    paintSelection();
  }

  function renderRow(s, n) {
    const tr = h(`tr.shot-row.st-row-${s.status}`, { dataset: { id: s.id } });
    const grip = h('td.gutter', { title: 'Drag to reorder · click for actions' }, h('span.row-n', String(n ?? '')), icon('grip', 14));
    grip.draggable = !sort;
    grip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-shot', s.id); e.dataTransfer.effectAllowed = 'move'; tr.classList.add('dragging'); });
    grip.addEventListener('dragend', () => tr.classList.remove('dragging'));
    grip.addEventListener('click', () => openRowMenu(grip, s));
    tr.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-shot')) return;
      e.preventDefault();
      const r = tr.getBoundingClientRect();
      tr.classList.toggle('drop-above', e.clientY < r.top + r.height / 2);
      tr.classList.toggle('drop-below', e.clientY >= r.top + r.height / 2);
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drop-above', 'drop-below'));
    tr.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('text/x-shot');
      const above = tr.classList.contains('drop-above');
      tr.classList.remove('drop-above', 'drop-below');
      if (id && id !== s.id) { e.preventDefault(); moveShot(id, s.id, above); }
    });
    tr.append(grip);
    for (const c of cols()) tr.append(renderCell(s, c));
    return tr;
  }

  // Keep the columns up to "Shot" visible while scrolling sideways.
  function pinned() {
    const list = cols();
    const upto = list.findIndex((c) => c.key === 'shot_name');
    if (upto < 0 || upto > 2) return new Map();
    const map = new Map();
    let left = 34;
    for (let i = 0; i <= upto; i++) {
      map.set(list[i].key, { left, last: i === upto });
      left += widths[list[i].key] || list[i].w;
    }
    return map;
  }
  let pins = new Map();
  function applyPin(el, key) {
    const p = pins.get(key);
    if (!p) return;
    el.classList.add('pin');
    if (p.last) el.classList.add('last');
    el.style.left = `${p.left}px`;
  }

  function renderCell(s, c) {
    const td = h(`td.c-${c.type}`, { dataset: { key: c.key }, role: 'gridcell' });
    applyPin(td, c.key);
    const v = s[c.key];
    switch (c.type) {
      case 'text':
        if (c.key === 'sequence' && v) {
          const n = refCounts.get(v) || 0;
          td.append(h('span', v), h('button.seq-ref', {
            type: 'button', dataset: { seq: v },
            title: n ? `${n} reference${n === 1 ? '' : 's'} for ${v}. Open in References.` : `No references for ${v} yet. Open in References to add some.`,
            'aria-label': `References for ${v}`,
          }, icon('paperclip', 12), n ? String(n) : ''));
        } else td.textContent = v ?? '';
        break;
      case 'select':
        if (c.key === 'status') td.append(h(`span.status.st-${v}`, statusLabel(v)));
        else if (c.key === 'priority') td.append(h(`span.prio.p-${v}`, v));
        else td.textContent = v || '';
        break;
      case 'rich': {
        const div = h('div.rich-view');
        div.innerHTML = sanitize(v);
        td.append(div);
        break;
      }
      case 'long':
        td.append(h('div.long-view', v || ''));
        break;
      case 'date':
        td.textContent = v ? fmtDay(v, { day: 'numeric', month: 'short', year: '2-digit' }) : '';
        if (c.key === 'due_date' && v && v < todayISO() && !['apr', 'omt'].includes(s.status)) td.classList.add('overdue');
        break;
      case 'calc':
        if (s.duration != null) {
          td.append(h('span', `${s.duration} f`), h('span.tc', framesToTC(s.duration, state.settings.fps)));
          if (s.handles) td.title = `With handles: ${s.duration + 2 * s.handles} f`;
        }
        break;
      case 'todo':
        td.append(todoChips(store.todos.filter((t) => t.shot_id === s.id)));
        break;
      case 'meta':
        td.append(h('span', fmtTime(s.updated_at)), h('span.faint.block', profileName(s.updated_by)));
        break;
      default:
        td.textContent = v ?? '';
    }
    return td;
  }

  function rerenderRow(id) {
    const tr = rowEl(id);
    const s = byId(id);
    if (!tr || !s) return;
    const n = tr.querySelector('.row-n')?.textContent;
    const fresh = renderRow(s, n);
    tr.replaceWith(fresh);
    resolveImages(fresh).catch(() => {});
    paintSelection();
  }

  function refreshTodoCells() {
    if (hidden.has('_todo')) return;
    for (const td of $$('td.c-todo', table)) {
      const id = td.parentElement.dataset.id;
      td.replaceChildren(todoChips(store.todos.filter((t) => t.shot_id === id)));
    }
  }

  function renderFooter(list) {
    const frames = list.reduce((a, s) => a + (s.duration || 0), 0);
    const counts = STATUSES.map((st) => [st, list.filter((s) => s.status === st.id).length]).filter(([, n]) => n);
    const bar = h('div.status-bar', { 'aria-hidden': 'true' },
      counts.map(([st, n]) => h(`span.st-${st.id}`, { style: { flexGrow: n }, title: `${st.label}: ${n}` })));
    footer.replaceChildren(
      h('span', h('strong', String(list.length)), list.length !== shots.length ? ` of ${shots.length}` : '', ' shots'),
      h('span', 'Total length ', h('strong', `${frames} f`), ` · ${framesToTC(frames, state.settings.fps)} @ ${Number(state.settings.fps)} fps`),
      h('span.foot-counts', counts.map(([st, n]) => h('span', h(`i.dot.st-${st.id}`), `${st.label} ${n}`))),
      bar);
  }

  // ---------- selection & keyboard ----------
  const rowEl = (id) => table.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
  const cellEl = (id, key) => rowEl(id)?.querySelector(`td[data-key="${CSS.escape(key)}"]`);

  function paintSelection() {
    $$('td.sel', table).forEach((td) => td.classList.remove('sel'));
    $$('tr.sel-row', table).forEach((tr) => tr.classList.remove('sel-row'));
    if (!sel) return;
    const td = cellEl(sel.id, sel.key);
    if (!td) return;
    td.classList.add('sel');
    td.parentElement.classList.add('sel-row');
  }

  function select(id, key, { scroll = true } = {}) {
    sel = { id, key };
    paintSelection();
    const td = cellEl(id, key);
    if (td && scroll) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (document.activeElement !== scroller && !editing) scroller.focus({ preventScroll: true });
  }

  function moveSel(dr, dc) {
    const ids = $$('tr.shot-row', table).map((tr) => tr.dataset.id);
    const keys = cols().map((c) => c.key);
    if (!ids.length) return;
    if (!sel) { select(ids[0], keys[0]); return; }
    const r = Math.max(0, Math.min(ids.length - 1, ids.indexOf(sel.id) + dr));
    const c = Math.max(0, Math.min(keys.length - 1, keys.indexOf(sel.key) + dc));
    select(ids[r] ?? ids[0], keys[c] ?? keys[0]);
  }

  table.addEventListener('mousedown', (e) => {
    const td = e.target.closest('td[data-key]');
    if (!td || e.target.closest('a, .seq-ref')) return;
    const id = td.parentElement.dataset.id;
    const key = td.dataset.key;
    if (editing && editing.id === id && editing.key === key) return;
    wasSelected = sel?.id === id && sel?.key === key;
    closeEditor(true);
    select(id, key, { scroll: false });
    e.preventDefault(); // keep focus on the grid
  });
  table.addEventListener('dblclick', (e) => {
    const td = e.target.closest('td[data-key]');
    if (td) startEdit(td.parentElement.dataset.id, td.dataset.key);
  });
  // Single click opens to-dos; a second click on a selected dropdown/date cell opens its picker.
  let wasSelected = false;
  table.addEventListener('click', (e) => {
    const td = e.target.closest('td.c-todo, td.c-select, td.c-date');
    if (!td || editing) return;
    if (td.matches('.c-todo') || wasSelected) startEdit(td.parentElement.dataset.id, td.dataset.key);
  });

  scroller.addEventListener('keydown', (e) => {
    if (editing || view !== 'grid' || e.target !== scroller) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'ArrowDown') { e.preventDefault(); moveSel(1, 0); }
    else if (k === 'ArrowUp') { e.preventDefault(); moveSel(-1, 0); }
    else if (k === 'ArrowRight') { e.preventDefault(); moveSel(0, 1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveSel(0, -1); }
    else if (k === 'Tab') { e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Home') { e.preventDefault(); moveSel(0, -99); }
    else if (k === 'End') { e.preventDefault(); moveSel(0, 99); }
    else if (k === 'PageDown') { e.preventDefault(); moveSel(15, 0); }
    else if (k === 'PageUp') { e.preventDefault(); moveSel(-15, 0); }
    else if (!sel) return;
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(sel.id, sel.key); }
    else if ((k === 'Delete' || k === 'Backspace') && !mod) { e.preventDefault(); clearCell(sel.id, sel.key); }
    else if (mod && k.toLowerCase() === 'c') { e.preventDefault(); copyCell(); }
    else if (mod && k.toLowerCase() === 'd') { e.preventDefault(); duplicateShot(byId(sel.id)); }
    else if (k.length === 1 && !mod && !e.altKey) {
      const col = COLUMNS.find((c) => c.key === sel.key);
      if (['text', 'int', 'long'].includes(col.type)) { e.preventDefault(); startEdit(sel.id, sel.key, k); }
    }
  });

  scroller.addEventListener('paste', async (e) => {
    if (editing || !sel) return;
    const files = imageFiles(e.clipboardData);
    if (files.length && sel.key === 'description') {
      e.preventDefault();
      const s = byId(sel.id);
      toast('Uploading image…');
      try {
        let html = s.description || '';
        for (const f of files) {
          const { path } = await uploadImage(f);
          html += `<p><img src="" data-path="${path}"></p>`;
        }
        await commit(s.id, 'description', html);
      } catch (err) { toast(`Image upload failed: ${errMsg(err)}`, 'error', 6000); }
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    await pasteGrid(text);
  });

  function copyCell() {
    const s = byId(sel.id);
    const col = COLUMNS.find((c) => c.key === sel.key);
    let v = s?.[sel.key];
    if (col.type === 'rich') v = htmlToText(v);
    if (col.type === 'todo') v = store.todos.filter((t) => t.shot_id === s.id).map((t) => `${t.person}: ${t.body}`).join('; ');
    navigator.clipboard?.writeText(v == null ? '' : String(v)).then(() => toast('Copied'), () => toast('Copy blocked by the browser', 'error'));
  }

  function clearCell(id, key) {
    const col = COLUMNS.find((c) => c.key === key);
    if (!EDITABLE.has(col.type) || col.type === 'select' && ['status', 'priority'].includes(key)) return;
    commit(id, key, col.type === 'int' || col.type === 'date' ? null : '');
  }

  /** Paste tab-separated text (e.g. copied from Excel) starting at the selected cell. */
  async function pasteGrid(text) {
    const rows = parseDelimited(text.replace(/\r?\n$/, ''), '\t');
    const keys = cols().map((c) => c.key);
    const startCol = keys.indexOf(sel.key);
    let ids = $$('tr.shot-row', table).map((tr) => tr.dataset.id);
    const startRow = ids.indexOf(sel.id);
    const need = startRow + rows.length - ids.length;
    if (need > 0) {
      if (!(await confirmDialog(`The pasted block has ${rows.length} rows. Create ${need} new shot${need === 1 ? '' : 's'} for the overflow?`, 'Create shots'))) return;
      for (let i = 0; i < need; i++) await addShot({ select: false });
      ids = $$('tr.shot-row', table).map((tr) => tr.dataset.id);
    }
    let changed = 0;
    for (let r = 0; r < rows.length; r++) {
      const id = ids[startRow + r];
      const patch = {};
      rows[r].forEach((raw, i) => {
        const col = COLUMNS.find((c) => c.key === keys[startCol + i]);
        if (!col || !EDITABLE.has(col.type)) return;
        const v = parseValue(col, raw);
        if (v !== undefined) patch[col.key] = v;
      });
      if (Object.keys(patch).length) { await commitPatch(id, patch); changed++; }
    }
    if (changed) toast(`Pasted into ${changed} row${changed === 1 ? '' : 's'}`);
  }

  function parseValue(col, raw) {
    const s = String(raw ?? '').trim();
    if (col.type === 'int') { if (!s) return null; const n = parseInt(s, 10); return Number.isFinite(n) ? n : undefined; }
    if (col.type === 'date') {
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? undefined : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }
    if (col.type === 'select') {
      const opts = col.options();
      const hit = opts.find(([v, l]) => v.toLowerCase() === s.toLowerCase() || String(l).toLowerCase() === s.toLowerCase());
      if (!hit) return undefined;
      return col.key === 'assignee' && !hit[0] ? null : hit[0];
    }
    if (col.type === 'rich') return s ? `<p>${s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))}</p>` : '';
    return s;
  }

  // ---------- editing ----------
  function closeEditor(save) {
    if (!editing) return;
    const e = editing;
    editing = null;
    e.close(save);
    if (deferred.has(e.id)) { deferred.delete(e.id); rerenderRow(e.id); }
  }

  function startEdit(id, key, initial) {
    const col = COLUMNS.find((c) => c.key === key);
    const s = byId(id);
    const td = cellEl(id, key);
    if (!s || !td) return;
    closeEditor(true);
    select(id, key, { scroll: true });

    if (col.type === 'todo') {
      const close = openTodoPopover(td, s, store);
      editing = { id, key, close: () => close() };
      const obs = setInterval(() => { if (!document.querySelector('.todo-pop')) { clearInterval(obs); if (editing?.key === '_todo') editing = null; scroller.focus({ preventScroll: true }); } }, 250);
      return;
    }
    if (!EDITABLE.has(col.type)) return;
    if (col.type === 'rich') { editRich(td, s, col); return; }

    let input;
    if (col.type === 'select') {
      input = h('select.cell-input', { 'aria-label': col.label }, col.options().map(([v, l]) => h('option', { value: v }, l)));
      input.value = s[key] ?? '';
    } else if (col.type === 'long') {
      input = h('textarea.cell-input', { 'aria-label': col.label, rows: 3 });
      input.value = initial ?? s[key] ?? '';
    } else {
      input = h('input.cell-input', { 'aria-label': col.label, type: col.type === 'int' ? 'number' : col.type === 'date' ? 'date' : 'text', step: col.type === 'int' ? 1 : null });
      input.value = initial ?? s[key] ?? '';
      if (col.suggest) {
        const listId = `dl-${key}`;
        if (!document.getElementById(listId)) document.body.append(h(`datalist#${listId}`, col.suggest.map((o) => h('option', { value: o }))));
        input.setAttribute('list', listId);
      }
    }
    td.classList.add('editing');
    const box = h('div.cell-editor', input);
    td.append(box);
    const original = input.value;

    const finish = (save) => {
      box.remove(); td.classList.remove('editing');
      if (save && input.value !== original) commit(id, key, parseValue(col, input.value) ?? s[key]);
      scroller.focus({ preventScroll: true });
    };
    editing = { id, key, close: finish };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
      else if (e.key === 'Enter' && !(col.type === 'long' && e.shiftKey)) { e.preventDefault(); closeEditor(true); moveSel(1, 0); }
      else if (e.key === 'Tab') { e.preventDefault(); closeEditor(true); moveSel(0, e.shiftKey ? -1 : 1); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (editing?.close === finish) closeEditor(true); }, 0));
    if (col.type === 'select') input.addEventListener('change', () => closeEditor(true));
    input.focus();
    if (initial == null && input.select && col.type !== 'select') input.select();
    if (col.type === 'select' || col.type === 'date') input.showPicker?.();
  }

  async function editRich(td, s, col) {
    const pop = h('div.rich-pop.popover', { role: 'dialog', 'aria-label': `Edit ${col.label}` });
    const hint = h('div.rich-hint', 'Paste or drop images · Ctrl+Enter to save · Esc to cancel');
    const actions = h('div.row.end',
      h('button.btn', { type: 'button', on: { click: () => closeEditor(false) } }, 'Cancel'),
      h('button.btn.primary', { type: 'button', on: { click: () => closeEditor(true) } }, 'Save'));
    document.body.append(pop);
    const r = td.getBoundingClientRect();
    const w = Math.min(Math.max(r.width, 480), window.innerWidth - 16);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - 360))}px`;
    const mount = h('div.rich-mount');
    pop.append(mount, h('div.rich-foot', hint, actions));
    const original = s.description || '';
    const ed = createEditor(mount, { compact: true, placeholder: 'Describe the shot. Paste reference images or storyboards.', content: await resolveHtml(original) });
    ed.commands.focus('end');
    // Capture phase: act before ProseMirror, which would turn Ctrl+Enter into a line break.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEditor(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); closeEditor(true); }
    };
    const onDoc = (e) => { if (!pop.contains(e.target) && !e.target.closest('.toast, .tb-pop')) closeEditor(true); };
    pop.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onDoc, true));
    const finish = (save) => {
      document.removeEventListener('mousedown', onDoc, true);
      const html = ed.isEmpty ? '' : stripImageUrls(ed.getHTML());
      ed.destroy(); pop.remove();
      if (save && html !== original) commit(s.id, 'description', html);
      scroller.focus({ preventScroll: true });
    };
    editing = { id: s.id, key: col.key, close: finish };
  }

  async function commit(id, key, value) {
    return commitPatch(id, { [key]: value });
  }

  async function commitPatch(id, patch) {
    const s = byId(id);
    if (!s) return;
    const prev = { ...s };
    const same = Object.entries(patch).every(([k, v]) => (s[k] ?? null) === (v ?? null));
    if (same) return;
    Object.assign(s, patch);
    if ('frame_in' in patch || 'frame_out' in patch) s.duration = s.frame_in != null && s.frame_out != null ? s.frame_out - s.frame_in + 1 : null;
    textCache.delete(s);
    rerenderRow(id);
    try {
      const row = await api().shots.update(id, patch);
      Object.assign(s, row);
      textCache.delete(s);
      if (!(editing && editing.id === id)) rerenderRow(id);
      renderFooter(visibleShots());
    } catch (e) {
      Object.assign(s, prev);
      rerenderRow(id);
      toast(`Not saved: ${friendly(e)}`, 'error', 6000);
    }
  }

  function friendly(e) {
    const m = errMsg(e);
    if (/frames_order/.test(m)) return 'frame Out must be at or after frame In';
    return m;
  }

  // ---------- row operations ----------
  function nextName(prev) {
    const m = prev?.shot_name?.match(/^(.*?)(\d+)$/);
    if (!m) return '';
    const n = String(Number(m[2]) + 10).padStart(m[2].length, '0');
    return m[1] + n;
  }

  async function addShot({ after = null, select: doSelect = true } = {}) {
    const ordered = [...shots].sort((a, b) => a.sort_order - b.sort_order);
    let sortOrder;
    let template;
    if (after) {
      const i = ordered.findIndex((x) => x.id === after.id);
      const next = ordered[i + 1];
      sortOrder = next ? (after.sort_order + next.sort_order) / 2 : after.sort_order + 1;
      template = after;
    } else {
      template = ordered[ordered.length - 1];
      sortOrder = (template?.sort_order ?? 0) + 1;
    }
    try {
      const row = await api().shots.create({
        sort_order: sortOrder,
        shot_name: nextName(template),
        sequence: template?.sequence || '',
        scene: template?.scene || '',
        frame_in: template?.frame_in ?? 1001,
        handles: template?.handles ?? 0,
        camera: template?.camera || '',
      });
      if (!shots.some((x) => x.id === row.id)) shots.push(row);
      shots.sort((a, b) => a.sort_order - b.sort_order);
      renderBody();
      if (doSelect) select(row.id, 'shot_name');
      return row;
    } catch (e) { toast(`Could not add shot: ${errMsg(e)}`, 'error', 6000); }
  }

  async function duplicateShot(s) {
    if (!s) return;
    const ordered = [...shots].sort((a, b) => a.sort_order - b.sort_order);
    const next = ordered[ordered.findIndex((x) => x.id === s.id) + 1];
    const copy = {};
    for (const c of COLUMNS) if (EDITABLE.has(c.type)) copy[c.key] = s[c.key];
    copy.shot_name = s.shot_name ? `${s.shot_name} copy` : '';
    copy.sort_order = next ? (s.sort_order + next.sort_order) / 2 : s.sort_order + 1;
    try {
      const row = await api().shots.create(copy);
      if (!shots.some((x) => x.id === row.id)) shots.push(row);
      shots.sort((a, b) => a.sort_order - b.sort_order);
      renderBody();
      select(row.id, 'shot_name');
      toast('Shot duplicated');
    } catch (e) { toast(`Could not duplicate: ${errMsg(e)}`, 'error', 6000); }
  }

  async function deleteShot(s) {
    const n = store.todos.filter((t) => t.shot_id === s.id).length;
    if (!(await confirmDialog(`Delete shot “${s.shot_name || 'untitled'}”${n ? ` and its ${n} to-do${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`))) return;
    try {
      await api().shots.remove(s.id);
      shots = shots.filter((x) => x.id !== s.id);
      store.todos = store.todos.filter((t) => t.shot_id !== s.id);
      if (sel?.id === s.id) sel = null;
      renderBody();
      toast('Shot deleted');
    } catch (e) { toast(`Delete failed: ${errMsg(e)}`, 'error', 6000); }
  }

  async function moveShot(id, targetId, above) {
    if (sort) { toast('Turn off column sorting to reorder rows by hand'); return; }
    const ordered = [...shots].sort((a, b) => a.sort_order - b.sort_order).filter((x) => x.id !== id);
    const ti = ordered.findIndex((x) => x.id === targetId);
    const before = above ? ordered[ti - 1] : ordered[ti];
    const after = above ? ordered[ti] : ordered[ti + 1];
    const order = before && after ? (before.sort_order + after.sort_order) / 2
      : before ? before.sort_order + 1 : after.sort_order - 1;
    const s = byId(id);
    const prev = s.sort_order;
    s.sort_order = order;
    shots.sort((a, b) => a.sort_order - b.sort_order);
    renderBody();
    try { await api().shots.update(id, { sort_order: order }); }
    catch (e) {
      s.sort_order = prev; shots.sort((a, b) => a.sort_order - b.sort_order); renderBody();
      toast(`Could not move: ${errMsg(e)}`, 'error', 6000);
    }
  }

  function menu(anchor, items) {
    document.querySelector('.ctx-menu')?.remove();
    const m = h('div.ctx-menu.popover', { role: 'menu' },
      items.map((it) => it === '-' ? h('hr') : h(`button.menu-item${it.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem', on: { click: () => { m.remove(); it.run(); } } }, it.icon ? icon(it.icon, 15) : null, it.label)));
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = `${Math.min(r.left, window.innerWidth - m.offsetWidth - 8)}px`;
    m.style.top = `${r.bottom + m.offsetHeight > window.innerHeight ? r.top - m.offsetHeight : r.bottom + 2}px`;
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true));
    m.querySelector('button')?.focus();
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { m.remove(); anchor.focus?.(); } });
  }

  function openRowMenu(anchor, s) {
    menu(anchor, [
      { label: 'Insert shot below', icon: 'plus', run: () => addShot({ after: s }) },
      { label: 'Duplicate (Ctrl+D)', icon: 'copy', run: () => duplicateShot(s) },
      { label: 'To-dos…', icon: 'list', run: () => startEdit(s.id, '_todo') },
      '-',
      { label: 'Delete shot', icon: 'trash', danger: true, run: () => deleteShot(s) },
    ]);
  }

  function openMoreMenu(anchor) {
    menu(anchor, [
      { label: 'Show / hide columns…', icon: 'columns', run: openColumns },
      { label: 'Export CSV (current view)', icon: 'download', run: exportCsv },
      { label: 'Import CSV…', icon: 'upload', run: importCsv },
      { label: 'Keyboard shortcuts', icon: 'more', run: showKeys },
    ]);
  }

  function openColumns() {
    import('./util.js').then(({ modal }) => {
      const list = h('div.col-list', COLUMNS.map((c) => h('label.check', { title: c.tip },
        h('input', { type: 'checkbox', checked: !hidden.has(c.key), on: { change: (e) => {
          if (e.target.checked) hidden.delete(c.key); else hidden.add(c.key);
          savePrefs(); renderAll();
        } } }), c.label)));
      modal('Columns', [list, h('div.row.end', h('button.btn', { type: 'button', on: { click: () => {
        hidden.clear(); COLUMNS.filter((c) => c.hidden).forEach((c) => hidden.add(c.key));
        Object.keys(widths).forEach((k) => delete widths[k]);
        savePrefs(); renderAll(); $$('.col-list input').forEach((i, n) => { i.checked = !hidden.has(COLUMNS[n].key); });
      } } }, 'Reset layout'))]);
    });
  }

  function showKeys() {
    import('./util.js').then(({ modal }) => modal('Keyboard shortcuts', h('dl.keys',
      [['Arrows / Tab', 'Move between cells'], ['Enter or F2', 'Edit cell'], ['Type any key', 'Start editing with that text'],
        ['Enter', 'Save and move down'], ['Shift+Enter', 'New line in Comments'], ['Esc', 'Cancel edit'],
        ['Delete', 'Clear cell'], ['Ctrl+C', 'Copy cell'], ['Ctrl+V', 'Paste text, or a block copied from Excel / Sheets; images into Description'],
        ['Ctrl+D', 'Duplicate shot'], ['Ctrl+Enter', 'Save description']].map(([k, d]) => [h('dt', h('kbd', k)), h('dd', d)]))));
  }

  function exportCsv() {
    const list = visibleShots();
    const exportCols = COLUMNS.filter((c) => c.type !== 'meta');
    const head = [...exportCols.map((c) => c.label), 'Timecode'];
    const lines = [head.map(csvEscape).join(',')];
    for (const s of list) {
      lines.push([...exportCols.map((c) => {
        if (c.type === 'rich') return htmlToText(s[c.key]);
        if (c.type === 'todo') return store.todos.filter((t) => t.shot_id === s.id).map((t) => `${t.done ? '[x]' : '[ ]'} ${t.person}: ${t.body}`).join('\n');
        if (c.key === 'status') return statusLabel(s.status);
        return s[c.key];
      }), framesToTC(s.duration, state.settings.fps)].map(csvEscape).join(','));
    }
    const name = (state.settings.project_name || 'shots').replace(/[^\w-]+/g, '_');
    download(`${name}_shots_${todayISO()}.csv`, '﻿' + lines.join('\r\n'));
  }

  function importCsv() {
    const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const rows = parseDelimited((await file.text()).replace(/^﻿/, ''));
      if (rows.length < 2) { toast('The file has no data rows', 'error'); return; }
      const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
      const aliases = { shot: 'shot_name', shotname: 'shot_name', name: 'shot_name', shotdescription: 'description', desc: 'description', comment: 'comments', notes: 'comments', seq: 'sequence', size: 'shot_type', type: 'shot_type', in: 'frame_in', out: 'frame_out', assigned: 'assignee' };
      const map = rows[0].map((hd) => {
        const n = norm(hd);
        const col = COLUMNS.find((c) => EDITABLE.has(c.type) && (norm(c.key) === n || norm(c.label) === n)) || COLUMNS.find((c) => c.key === aliases[n]);
        return col || null;
      });
      const found = map.filter(Boolean).map((c) => c.label);
      if (!found.length) { toast('No known column headers found (e.g. Shot, Description, Lens, Comments)', 'error', 6000); return; }
      const data = rows.slice(1).filter((r) => r.some((x) => x.trim()));
      if (!(await confirmDialog(`Import ${data.length} shots using columns: ${found.join(', ')}?`, 'Import'))) return;
      let order = Math.max(0, ...shots.map((s) => s.sort_order));
      const payload = data.map((r) => {
        const row = { sort_order: ++order };
        r.forEach((raw, i) => { const col = map[i]; if (col) { const v = parseValue(col, raw); if (v !== undefined) row[col.key] = v; } });
        if (row.frame_in != null && row.frame_out != null && row.frame_out < row.frame_in) delete row.frame_out;
        return row;
      });
      try {
        const created = await api().shots.createMany(payload);
        for (const row of created) if (!shots.some((x) => x.id === row.id)) shots.push(row);
        shots.sort((a, b) => a.sort_order - b.sort_order);
        renderBody();
        toast(`Imported ${created.length} shots`);
      } catch (e) { toast(`Import failed: ${errMsg(e)}`, 'error', 8000); }
    });
    input.click();
  }

  // ---------- live updates ----------
  const unsubShots = api().subscribe('shots', (type, row, old) => {
    if (type === 'DELETE') {
      if (!byId(old.id)) return;
      shots = shots.filter((s) => s.id !== old.id);
      if (editing?.id === old.id) closeEditor(false);
      if (view === 'grid') renderBody();
      return;
    }
    const s = byId(row.id);
    if (s && s.updated_at === row.updated_at) return;
    if (s) {
      const orderChanged = s.sort_order !== row.sort_order;
      Object.assign(s, row); textCache.delete(s);
      if (view !== 'grid') return;
      if (orderChanged) { shots.sort((a, b) => a.sort_order - b.sort_order); if (!editing) renderBody(); return; }
      if (editing?.id === row.id) deferred.add(row.id); else rerenderRow(row.id);
      renderFooter(visibleShots());
    } else {
      shots.push(row); shots.sort((a, b) => a.sort_order - b.sort_order);
      if (view === 'grid' && !editing) renderBody();
    }
  });
  // Reference counts per sequence, shown as a paperclip in the Seq column.
  let refCounts = new Map();
  const countRefs = (rows) => {
    refCounts = new Map();
    for (const r of rows) if (r.sequence) refCounts.set(r.sequence, (refCounts.get(r.sequence) || 0) + 1);
  };
  let refRows = [];
  const unsubRefs = api().subscribe('refs', (type, row, old) => {
    refRows = type === 'DELETE' ? refRows.filter((r) => r.id !== old.id) : [...refRows.filter((r) => r.id !== row.id), row];
    countRefs(refRows);
    if (view === 'grid' && !editing) renderBody();
  });
  table.addEventListener('click', (e) => {
    const b = e.target.closest('.seq-ref');
    if (b) { e.stopPropagation(); emit('navigate', { tab: 'references', sequence: b.dataset.seq }); }
  }, true);

  const unsubTodos = api().subscribe('todos', (type, row, old) => {
    if (type === 'DELETE') { if (store.todos.some((t) => t.id === old.id)) store.drop(old.id); return; }
    const t = store.todos.find((x) => x.id === row.id);
    if (!t || t.updated_at !== row.updated_at) store.upsert(row);
  });
  const offTeam = on('team-changed', () => { renderChrome(); if (view === 'grid') renderAll(); else setView('board'); });
  const offSettings = on('settings-changed', () => { if (view === 'grid') renderBody(); });

  // ---------- init ----------
  renderChrome();
  const ready = (async () => {
    try {
      [shots, store.todos, refRows] = await Promise.all([api().shots.list(), api().todos.list(), api().refs.list().catch(() => [])]);
      countRefs(refRows);
    } catch (e) { toast(`Could not load shots: ${errMsg(e)}`, 'error', 8000); }
    setView(view);
  })();

  return {
    async reveal(code) {
      await ready;
      filter.sequence = code; filter.q = ''; searchInput.value = '';
      if (view !== 'grid') setView('grid'); else { renderChrome(); renderBody(); }
    },
    async enter() {
      history.replaceState(null, '', '#shots');
      // counts may have changed while another tab was open
      refRows = await api().refs.list().catch(() => refRows);
      countRefs(refRows);
      if (view === 'grid' && !editing) renderBody();
    },
    leave() { closeEditor(true); document.querySelector('.todo-pop')?._close?.(); },
    destroy() { unsubRefs(); unsubShots(); unsubTodos(); offTeam(); offSettings(); offBoard?.(); },
  };
}
