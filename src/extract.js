// "Convert to task list": ask Claude (via the extract-tasks Edge Function)
// for the action items in a daily summary, let the user review them, then
// create the tasks.
import { h, modal, toast, errMsg, fmtDay } from './util.js';
import { api, state, emit } from './state.js';

const norm = (s) => String(s || '').trim().toLowerCase();

export async function convertDailyToTasks(daily, button) {
  const label = button?.innerHTML;
  if (button) { button.disabled = true; button.textContent = 'Reading the call…'; }
  let result;
  try {
    result = await api().ai.extractTasks(daily.id);
  } catch (e) {
    toast(errMsg(e), 'error', 10000);
    return;
  } finally {
    if (button) { button.disabled = false; button.innerHTML = label; }
  }
  const [existing, milestones, shots] = await Promise.all([
    api().todos.list().catch(() => []),
    api().milestones.list().catch(() => []),
    api().shots.list().catch(() => []),
  ]);
  review(daily, result, { existing, milestones, shots });
}

function review(daily, result, { existing, milestones, shots }) {
  const proposals = result.tasks || [];
  if (!proposals.length) {
    toast('No action items found in this summary.', 'info', 6000);
    return;
  }
  // Same call: same person + text, or the same quoted sentence (text may have been edited since).
  const fromThisCall = existing.filter((t) => t.daily_id === daily.id);
  const already = new Set([
    ...fromThisCall.map((t) => `${t.person}|${norm(t.body)}`),
    ...fromThisCall.filter((t) => t.source_quote).map((t) => `quote|${norm(t.source_quote)}`),
  ]);
  const listId = `ms-titles-${Math.random().toString(36).slice(2)}`;
  const rows = proposals.map((p) => {
    const dup = already.has(`${p.person}|${norm(p.body)}`) || (p.source_quote && already.has(`quote|${norm(p.source_quote)}`));
    const include = h('input', { type: 'checkbox', checked: !dup, 'aria-label': 'Create this task' });
    const person = h('select', { 'aria-label': 'Person' }, h('option', { value: '' }, '— choose —'), state.team.map((m) => h('option', { value: m.name }, m.name)));
    person.value = p.person || '';
    const body = h('input', { value: p.body, maxLength: 2000, 'aria-label': 'Task' });
    const due = h('input', { type: 'date', value: p.due_date || '', 'aria-label': 'Due date' });
    const ms = h('input', { value: p.milestone_title || '', maxLength: 200, list: listId, placeholder: '—', 'aria-label': 'Milestone' });
    ms.setAttribute('list', listId);
    const shot = h('select', { 'aria-label': 'Shot' }, h('option', { value: '' }, '—'), shots.map((s) => h('option', { value: s.id }, s.shot_name || 'untitled')));
    shot.value = shots.find((s) => s.shot_name === p.shot_name)?.id || '';
    const tr = h(`tr${dup ? '.dup' : ''}`,
      h('td', include),
      h('td', person),
      h('td.task-cell', body, p.source_quote ? h('div.quote', `“${p.source_quote}”`) : null, dup ? h('div.quote', 'Already added from this call') : null),
      h('td', due), h('td', ms), h('td', shot));
    return { p, include, person, body, due, ms, shot, tr };
  });

  const createBtn = h('button.btn.primary', { type: 'button' });
  const msg = h('p.form-msg');
  const count = () => rows.filter((r) => r.include.checked).length;
  const refresh = () => { createBtn.textContent = `Create ${count()} task${count() === 1 ? '' : 's'}`; createBtn.disabled = !count(); };
  rows.forEach((r) => r.include.addEventListener('change', refresh));
  refresh();

  const m = modal(`Tasks from ${fmtDay(daily.day)}${daily.title ? ` · ${daily.title}` : ''}`, [
    h('p.faint', `${proposals.length} action item${proposals.length === 1 ? '' : 's'} found by ${result.model || 'Claude'}. Check them before creating: fix names, dates and wording, untick anything that is not a task.`),
    h(`datalist#${listId}`, milestones.map((x) => h('option', { value: x.title }))),
    h('div.review-wrap', h('table.simple.review',
      h('thead', h('tr', ['', 'Person', 'Task', 'Due', 'Milestone', 'Shot'].map((x) => h('th', x)))),
      h('tbody', rows.map((r) => r.tr)))),
    msg,
    h('div.row.end', h('button.btn', { type: 'button', on: { click: () => m.close() } }, 'Cancel'), createBtn),
  ], { wide: true });
  m.el.classList.add('review-modal');

  createBtn.addEventListener('click', async () => {
    const chosen = rows.filter((r) => r.include.checked);
    const missing = chosen.filter((r) => !r.person.value || !r.body.value.trim());
    rows.forEach((r) => r.tr.classList.toggle('invalid', missing.includes(r)));
    if (missing.length) { msg.textContent = 'Choose a person and enter the task text for every ticked row.'; return; }
    const payload = chosen.map((r) => {
      const title = r.ms.value.trim();
      const linked = title ? milestones.find((x) => norm(x.title) === norm(title)) : null;
      return {
        person: r.person.value, body: r.body.value.trim(), due_date: r.due.value || null,
        shot_id: r.shot.value || null, daily_id: daily.id,
        milestone_title: title || null, milestone_id: linked?.id || null,
        source_quote: r.p.source_quote ? r.p.source_quote.slice(0, 1000) : null,
      };
    });
    createBtn.disabled = true;
    try {
      const created = await api().todos.createMany(payload);
      m.close();
      toast(`${created.length} task${created.length === 1 ? '' : 's'} created`);
      emit('tasks-changed');
      emit('navigate', { tab: 'tasks' });
    } catch (e) {
      createBtn.disabled = false;
      msg.textContent = `Could not create tasks: ${errMsg(e)}`;
    }
  });
}
