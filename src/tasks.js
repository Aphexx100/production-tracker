import { h, toast, errMsg, modal, confirmDialog, lsGet, lsSet, todayISO, fmtDay } from './util.js';
import { icon } from './icons.js';
import { api, state, on, emit } from './state.js';
import { isMissingTable } from './sequences.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const MIGRATION = 'Tasks need supabase/004_timeline.sql, 005_tasks.sql and 006_task_priority.sql. An admin must run them once in the Supabase SQL Editor.';
const PRIORITIES = [
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
];
const PRIO_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const SORTS = {
  priority: (a, b) => (PRIO_RANK[a.priority || 'normal'] - PRIO_RANK[b.priority || 'normal']) || (a.due_date || '9999').localeCompare(b.due_date || '9999'),
  due: (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || (PRIO_RANK[a.priority || 'normal'] - PRIO_RANK[b.priority || 'normal']),
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
};

export function mountTasks(root) {
  let tasks = [];
  let milestones = [];
  let shots = [];
  let dailies = [];
  let showDone = lsGet('pt-tasks-done', false);
  let query = '';
  let sortBy = lsGet('pt-tasks-sort', 'priority');
  let missing = false;

  const search = h('input.search', { type: 'search', placeholder: 'Search tasks…', 'aria-label': 'Search tasks' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  const doneToggle = h('label.check', h('input', { type: 'checkbox', checked: showDone, on: { change: (e) => { showDone = e.target.checked; lsSet('pt-tasks-done', showDone); render(); } } }), 'Show completed');
  const convertBtn = h('button.btn.primary', { type: 'button', title: 'Put every task that names a milestone onto the Timeline', on: { click: convertToMilestones } }, icon('calendar', 15), 'Convert to milestones');
  const summary = h('span.faint.tasks-summary');
  const sortSel = h('select.tb-select', { 'aria-label': 'Sort tasks', title: 'Sort tasks' },
    h('option', { value: 'priority' }, 'Sort: Priority'), h('option', { value: 'due' }, 'Sort: Due date'), h('option', { value: 'newest' }, 'Sort: Newest'));
  sortSel.value = SORTS[sortBy] ? sortBy : 'priority';
  sortSel.addEventListener('change', () => { sortBy = sortSel.value; lsSet('pt-tasks-sort', sortBy); render(); });
  const board = h('div.board.tasks-board');
  root.append(h('div.tasks',
    h('div.tasks-toolbar', h('div.search-wrap', icon('search', 15), search), sortSel, doneToggle, summary, h('div.spacer'), convertBtn),
    h('div.board-wrap', board)));

  // ---------- lookups ----------
  const msById = (id) => milestones.find((m) => m.id === id);
  const shotById = (id) => shots.find((s) => s.id === id);
  const dailyById = (id) => dailies.find((d) => d.id === id);
  const matches = (t) => (showDone || !t.done) && (!query || `${t.body} ${t.person} ${t.milestone_title || ''} ${msById(t.milestone_id)?.title || ''} ${shotById(t.shot_id)?.shot_name || ''}`.toLowerCase().includes(query));

  // ---------- render ----------
  function render() {
    if (missing) {
      board.replaceChildren(h('div.setup-note', h('h2', 'Tasks are not set up yet'), h('p', MIGRATION)));
      convertBtn.disabled = true;
      return;
    }
    const open = tasks.filter((t) => !t.done);
    const overdue = open.filter((t) => t.due_date && t.due_date < todayISO());
    const urgent = open.filter((t) => t.priority === 'urgent');
    const withMs = tasks.filter((t) => t.milestone_title || t.milestone_id);
    summary.textContent = `${open.length} open${urgent.length ? ` · ${urgent.length} urgent` : ''}${overdue.length ? ` · ${overdue.length} overdue` : ''} · ${withMs.length} linked to milestones`;
    board.replaceChildren(...state.team.map((m) => {
      const mine = tasks.filter((t) => t.person === m.name);
      const shown = mine.filter(matches).sort((a, b) => (a.done - b.done) || SORTS[sortBy](a, b) || a.created_at.localeCompare(b.created_at));
      const add = h('input.todo-add', { placeholder: `New task for ${m.name}…`, maxLength: 2000, 'aria-label': `New task for ${m.name}`, dataset: { person: m.name } });
      add.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !add.value.trim()) return;
        const body = add.value.trim();
        add.value = '';
        try { upsert(await api().todos.create({ person: m.name, body })); render(); board.querySelector(`.todo-add[data-person="${CSS.escape(m.name)}"]`)?.focus(); }
        catch (err) { add.value = body; toast(`Could not add task: ${errMsg(err)}`, 'error'); }
      });
      return h('section.board-col', { dataset: { person: m.name } },
        h('header', h('h3', m.name), h('span.count', `${mine.filter((t) => !t.done).length} open`)),
        add,
        shown.length ? h('ul.task-list', shown.map(card)) : h('p.empty-small', mine.length ? 'Nothing matches.' : 'No tasks.'));
    }));
  }

  // ---------- card with inline fields ----------
  function card(t) {
    const prio = t.priority || 'normal';
    const cb = h('input', { type: 'checkbox', checked: t.done, 'aria-label': `Done: ${t.body}` });
    cb.addEventListener('change', () => save(t, { done: cb.checked }, { rerender: true }));

    // text: looks like plain text, edits in place
    const text = h('textarea.task-text', { rows: 1, maxLength: 2000, 'aria-label': 'Task text', spellcheck: true, lang: 'en' });
    text.textContent = t.body; // default value; also findable as text
    const grow = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight}px`; };
    requestAnimationFrame(grow);
    text.addEventListener('input', grow);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { text.value = t.body; grow(); text.blur(); }
    });
    text.addEventListener('blur', () => {
      const v = text.value.trim();
      if (!v) { text.value = t.body; grow(); return; }
      if (v !== t.body) { text.textContent = v; save(t, { body: v }); }
    });

    const prioSel = h(`select.fld.prio.p-${prio}`, { 'aria-label': 'Priority', title: 'Priority' },
      PRIORITIES.map((p) => h('option', { value: p.id }, p.label)));
    prioSel.value = prio;
    prioSel.addEventListener('change', () => save(t, { priority: prioSel.value }, { rerender: true }));

    const late = !t.done && t.due_date && t.due_date < todayISO();
    const due = h(`input.fld.due${late ? '.late' : ''}${t.due_date ? '' : '.empty'}`, { type: 'date', value: t.due_date || '', 'aria-label': 'Due date', title: late ? 'Overdue' : 'Due date' });
    due.addEventListener('change', () => save(t, { due_date: due.value || null }, { rerender: true }));

    const personSel = h('select.fld.person', { 'aria-label': 'Person', title: 'Move to another person' },
      state.team.map((m) => h('option', { value: m.name }, m.name)));
    personSel.value = t.person;
    personSel.addEventListener('change', () => save(t, { person: personSel.value }, { rerender: true }));

    const linked = msById(t.milestone_id);
    const msSel = h(`select.fld.ms${linked ? `.${linked.kind}` : t.milestone_title ? '.pending' : '.empty'}`, {
      'aria-label': 'Milestone',
      title: linked ? `On the Timeline: ${linked.title}, ${fmtDay(linked.date)}` : t.milestone_title ? 'Named milestone, not on the Timeline yet. Use “Convert to milestones”.' : 'Link to a milestone',
    },
    h('option', { value: '' }, 'No milestone'),
    milestones.map((m) => h('option', { value: m.id }, `${m.kind === 'deadline' ? '⚑' : '◆'} ${m.title}`)),
    !linked && t.milestone_title ? h('option', { value: '__pending' }, `◇ ${t.milestone_title}`) : null,
    h('option', { value: '__new' }, 'New name…'));
    msSel.value = linked ? linked.id : t.milestone_title ? '__pending' : '';
    msSel.addEventListener('change', async () => {
      if (msSel.value === '__pending') return;
      if (msSel.value === '__new') {
        const name = await askText('Milestone name', 'e.g. Picture lock');
        if (!name) { render(); return; }
        const match = milestones.find((m) => norm(m.title) === norm(name));
        await save(t, { milestone_id: match?.id || null, milestone_title: match ? match.title : name }, { rerender: true });
        return;
      }
      const m = msById(msSel.value);
      await save(t, { milestone_id: m?.id || null, milestone_title: m ? m.title : null }, { rerender: true });
    });

    const shotSel = h(`select.fld.shot${t.shot_id ? '' : '.empty'}`, { 'aria-label': 'Shot', title: 'Shot' },
      h('option', { value: '' }, 'No shot'), shots.map((s) => h('option', { value: s.id }, s.shot_name || 'untitled')));
    shotSel.value = t.shot_id || '';
    shotSel.addEventListener('change', () => save(t, { shot_id: shotSel.value || null }, { rerender: true }));

    const links = [];
    if (t.shot_id && shotById(t.shot_id)) {
      links.push(h('button.icon-btn.small', { type: 'button', title: 'Open the shot in the shot tracker', 'aria-label': 'Open shot', on: { click: () => emit('navigate', { tab: 'shots', shot: t.shot_id }) } }, icon('film', 13)));
    }
    if (linked) {
      links.push(h('button.icon-btn.small', { type: 'button', title: 'Show on the Timeline', 'aria-label': 'Show on the Timeline', on: { click: () => emit('navigate', { tab: 'timeline' }) } }, icon('calendar', 13)));
    }
    const daily = dailyById(t.daily_id);
    const src = daily ? h('button.tchip.src', { type: 'button', title: t.source_quote ? `From the call: “${t.source_quote}”` : 'Open the call summary', on: { click: () => emit('navigate', { tab: 'dailies', daily: daily.id }) } },
      icon('note', 12), `Call ${fmtDay(daily.day, { day: 'numeric', month: 'short' })}`) : null;

    const del = h('button.icon-btn.small.task-del', { type: 'button', title: 'Delete task', 'aria-label': `Delete ${t.body}` }, icon('trash', 14));
    del.addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete the task “${t.body}”?`))) return;
      try { await api().todos.remove(t.id); tasks = tasks.filter((x) => x.id !== t.id); render(); emit('tasks-changed'); }
      catch (err) { toast(errMsg(err), 'error'); }
    });

    return h(`li.task.p-${prio}${t.done ? '.done' : ''}`, { dataset: { id: t.id } },
      h('div.task-top', h('label.todo-check', cb), text, del),
      h('div.task-fields', prioSel, due, personSel, msSel, shotSel, ...links, src));
  }

  function askText(title, placeholder) {
    return new Promise((resolve) => {
      let done = false;
      const input = h('input', { maxLength: 200, placeholder, required: true, 'aria-label': title });
      const m = modal(title, h('form.form', {
        on: { submit: (e) => { e.preventDefault(); if (!input.value.trim()) return; done = true; m.close(); resolve(input.value.trim()); } },
      }, input, h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'OK'))), { onClose: () => { if (!done) resolve(null); } });
      input.focus();
    });
  }

  /** Save a patch. Only re-render when the change moves or re-sorts the card. */
  async function save(t, patch, { rerender = false } = {}) {
    const prev = { ...t };
    Object.assign(t, patch);
    if (rerender) render();
    try { Object.assign(t, await api().todos.update(t.id, patch)); emit('tasks-changed'); }
    catch (e) {
      Object.assign(t, prev);
      toast(`Not saved: ${isMissingTable(e) ? MIGRATION : errMsg(e)}`, 'error', 8000);
      render();
    }
  }

  function upsert(row) {
    const i = tasks.findIndex((x) => x.id === row.id);
    if (i >= 0) tasks[i] = row; else tasks.push(row);
  }

  // ---------- convert to milestones ----------
  /** Group tasks by the milestone they name, and find what already exists. */
  function plan() {
    const groups = new Map();
    for (const t of tasks) {
      const linked = msById(t.milestone_id);
      const title = linked?.title || t.milestone_title;
      if (!title) continue;
      const key = linked ? `id:${linked.id}` : `title:${norm(title)}`;
      if (!groups.has(key)) groups.set(key, { title, tasks: [], existing: linked || milestones.find((m) => norm(m.title) === norm(title)) || null });
      groups.get(key).tasks.push(t);
    }
    return [...groups.values()].map((g) => {
      const dues = g.tasks.map((t) => t.due_date).filter(Boolean).sort();
      const shotIds = [...new Set(g.tasks.map((t) => t.shot_id))];
      const seqs = [...new Set(g.tasks.map((t) => shotById(t.shot_id)?.sequence || ''))];
      const scope = shotIds.length === 1 && shotIds[0] ? { shot_id: shotIds[0], sequence: shotById(shotIds[0])?.sequence || '' }
        : seqs.length === 1 && seqs[0] ? { shot_id: null, sequence: seqs[0] } : { shot_id: null, sequence: '' };
      return { ...g, date: dues[0] || g.existing?.date || '', scope };
    });
  }

  function scopeLabel(scope) {
    if (scope.shot_id) return `Shot ${shotById(scope.shot_id)?.shot_name || ''}`;
    if (scope.sequence) return `Sequence ${scope.sequence}`;
    return 'Whole project';
  }

  function convertToMilestones() {
    const groups = plan();
    if (!groups.length) {
      toast('No task names a milestone yet. Set one in a task (Edit › Milestone) or let “Convert to task list” find them in a call.', 'info', 8000);
      return;
    }
    const conflicts = groups.filter((g) => g.existing);
    const rows = groups.map((g) => {
      const date = h('input', { type: 'date', value: g.date, required: true, 'aria-label': `Date for ${g.title}` });
      const action = h('select', { 'aria-label': `What to do with ${g.title}` },
        g.existing
          ? [h('option', { value: '' }, 'Choose…'), h('option', { value: 'update' }, 'Override existing'), h('option', { value: 'new' }, 'Create a new milestone'), h('option', { value: 'skip' }, 'Do nothing')]
          : [h('option', { value: 'create' }, 'Create milestone'), h('option', { value: 'skip' }, 'Do nothing')]);
      const tr = h(`tr${g.existing ? '.conflict' : ''}`,
        h('td', h('strong', g.title), h('div.quote', g.tasks.map((t) => `${t.person}: ${t.body}`).join(' · '))),
        h('td', String(g.tasks.length)),
        h('td', scopeLabel(g.scope)),
        h('td', g.existing ? h('span', `On the Timeline: ${fmtDay(g.existing.date, { day: 'numeric', month: 'short', year: 'numeric' })}`) : h('span.faint', 'New')),
        h('td', date),
        h('td', action));
      return { g, date, action, tr };
    });
    const msg = h('p.form-msg');
    const bulk = (v) => rows.filter((r) => r.g.existing).forEach((r) => { r.action.value = v; });
    const applyBtn = h('button.btn.primary', { type: 'button' }, 'Apply');
    const m = modal('Convert tasks to milestones', [
      h('p', `${groups.length} milestone${groups.length === 1 ? '' : 's'} named in ${groups.reduce((a, g) => a + g.tasks.length, 0)} tasks. Each becomes a deadline on the Timeline on the earliest due date of its tasks, and the tasks get linked to it.`),
      conflicts.length ? h('div.conflict-note',
        h('strong', `${conflicts.length} already on the Timeline.`), ' Choose for each: override its date and scope, add a separate new milestone, or leave it alone.',
        h('div.row',
          h('button.btn.small', { type: 'button', on: { click: () => bulk('update') } }, 'Override all'),
          h('button.btn.small', { type: 'button', on: { click: () => bulk('new') } }, 'New for all'),
          h('button.btn.small', { type: 'button', on: { click: () => bulk('skip') } }, 'Do nothing for all'))) : null,
      h('div.review-wrap', h('table.simple.review',
        h('thead', h('tr', ['Milestone', 'Tasks', 'Belongs to', 'Status', 'Date', 'Action'].map((x) => h('th', x)))),
        h('tbody', rows.map((r) => r.tr)))),
      msg,
      h('div.row.end', h('button.btn', { type: 'button', on: { click: () => m.close() } }, 'Cancel'), applyBtn),
    ], { wide: true });
    m.el.classList.add('review-modal');

    applyBtn.addEventListener('click', async () => {
      const undecided = rows.filter((r) => !r.action.value);
      const noDate = rows.filter((r) => r.action.value !== 'skip' && r.action.value && !r.date.value);
      rows.forEach((r) => r.tr.classList.toggle('invalid', undecided.includes(r) || noDate.includes(r)));
      if (undecided.length) { msg.textContent = `Choose what to do for ${undecided.map((r) => `“${r.g.title}”`).join(', ')}.`; return; }
      if (noDate.length) { msg.textContent = 'Every milestone you create or override needs a date.'; return; }
      applyBtn.disabled = true;
      const done = { created: 0, updated: 0, skipped: 0 };
      try {
        for (const r of rows) {
          const a = r.action.value;
          if (a === 'skip') { done.skipped++; continue; }
          const fields = { date: r.date.value, sequence: r.g.scope.sequence, shot_id: r.g.scope.shot_id };
          let target;
          if (a === 'update') {
            target = await api().milestones.update(r.g.existing.id, fields);
            done.updated++;
          } else {
            target = await api().milestones.create({ title: r.g.title, kind: 'deadline', notes: 'Created from tasks', ...fields });
            done.created++;
          }
          const i = milestones.findIndex((x) => x.id === target.id);
          if (i >= 0) milestones[i] = target; else milestones.push(target);
          for (const t of r.g.tasks) {
            if (t.milestone_id === target.id && t.milestone_title === target.title) continue;
            upsert(await api().todos.update(t.id, { milestone_id: target.id, milestone_title: target.title }));
          }
        }
        m.close();
        render();
        emit('tasks-changed');
        toast(`Timeline: ${done.created} created, ${done.updated} overridden, ${done.skipped} left alone`);
      } catch (e) {
        applyBtn.disabled = false;
        msg.textContent = `Stopped: ${isMissingTable(e) ? MIGRATION : errMsg(e)}`;
        render();
      }
    });
  }

  // ---------- data ----------
  async function load() {
    try {
      const [t, ms, sh, dl] = await Promise.all([api().todos.list(), api().milestones.list(), api().shots.list(), api().dailies.list()]);
      tasks = t; milestones = ms; shots = sh; dailies = dl; missing = false;
    } catch (e) {
      if (isMissingTable(e)) missing = true;
      else toast(`Could not load tasks: ${errMsg(e)}`, 'error', 8000);
    }
  }
  const unsubs = [
    api().subscribe('todos', (type, row, old) => {
      if (type === 'DELETE') tasks = tasks.filter((t) => t.id !== old.id);
      else {
        const mine = tasks.find((t) => t.id === row.id);
        if (mine && mine.updated_at === row.updated_at) return; // echo of our own save
        upsert(row);
      }
      render();
    }),
    api().subscribe('milestones', (type, row, old) => {
      milestones = type === 'DELETE' ? milestones.filter((m) => m.id !== old.id) : [...milestones.filter((m) => m.id !== row.id), row];
      render();
    }),
    on('team-changed', render),
  ];
  const ready = load().then(render);

  return {
    async enter() {
      await ready;
      history.replaceState(null, '', '#tasks');
      await load();
      render();
    },
    destroy() { unsubs.forEach((u) => u()); },
  };
}
