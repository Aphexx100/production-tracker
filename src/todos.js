import { h, toast, errMsg } from './util.js';
import { icon } from './icons.js';
import { state } from './state.js';

/** Compact per-person summary shown inside the grid cell. */
export function todoChips(todos) {
  if (!todos.length) return h('span.faint', '+ add');
  const wrap = h('div.todo-chips');
  for (const m of state.team) {
    const mine = todos.filter((t) => t.person === m.name);
    if (!mine.length) continue;
    const open = mine.filter((t) => !t.done).length;
    wrap.append(h(`span.chip${open ? '' : '.done'}`, { title: mine.map((t) => `${t.done ? '✓' : '•'} ${t.body}`).join('\n') },
      m.name, h('b', open ? String(open) : '✓')));
  }
  return wrap;
}

function todoItem(t, store, { showShot = false, onOpenShot } = {}) {
  const cb = h('input', { type: 'checkbox', checked: t.done, 'aria-label': `Done: ${t.body}` });
  cb.addEventListener('change', () => store.updateTodo(t.id, { done: cb.checked }));
  const body = h('span.todo-body', t.body);
  body.title = 'Double-click to edit';
  body.addEventListener('dblclick', () => {
    const input = h('input.todo-edit', { value: t.body, maxLength: 2000, 'aria-label': 'Edit to-do' });
    const done = (save) => {
      const v = input.value.trim();
      if (save && v && v !== t.body) store.updateTodo(t.id, { body: v });
      else input.replaceWith(body);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    body.replaceWith(input); input.focus(); input.select();
  });
  const shot = showShot && t.shot_id && store.shotsById().get(t.shot_id);
  const del = h('button.icon-btn.small', { type: 'button', title: 'Delete to-do', 'aria-label': 'Delete to-do' }, icon('x', 14));
  del.addEventListener('click', () => store.removeTodo(t.id));
  return h(`li.todo${t.done ? '.done' : ''}`, h('label.todo-check', cb), body,
    shot && h('button.shot-link', { type: 'button', title: 'Show shot in grid', on: { click: () => onOpenShot?.(shot.id) } }, shot.shot_name || 'untitled shot'),
    showShot && t.shot_id && !shot && h('span.faint', 'shot deleted'),
    del);
}

// Re-renders replace the inputs; remember which one to refocus.
let refocusKey = null;
function refocus(root) {
  if (!refocusKey) return;
  root.querySelector(`.todo-add[data-key="${CSS.escape(refocusKey)}"]`)?.focus();
  refocusKey = null;
}

function addInput(placeholder, onAdd, key) {
  const input = h('input.todo-add', { placeholder, maxLength: 2000, 'aria-label': placeholder, dataset: { key } });
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    input.disabled = true;
    refocusKey = key;
    try { await onAdd(v); input.value = ''; }
    catch { refocusKey = null; }
    finally { input.disabled = false; if (input.isConnected) input.focus(); }
  });
  return input;
}

/** Popover listing a shot's to-dos, grouped by person. */
export function openTodoPopover(anchor, shot, store) {
  document.querySelector('.todo-pop')?._close?.();
  const pop = h('div.todo-pop.popover', { role: 'dialog', 'aria-label': `To-dos for ${shot.shot_name || 'shot'}` });
  const render = () => {
    const todos = store.todos.filter((t) => t.shot_id === shot.id);
    pop.replaceChildren(h('header', h('strong', `To-dos · ${shot.shot_name || 'untitled shot'}`),
      h('button.icon-btn.small', { type: 'button', 'aria-label': 'Close', on: { click: close } }, icon('x', 14))));
    const body = h('div.todo-pop-body');
    for (const m of state.team) {
      const mine = todos.filter((t) => t.person === m.name);
      body.append(h('section.todo-person',
        h('h4', m.name, mine.length ? h('span.faint', ` ${mine.filter((t) => !t.done).length}/${mine.length}`) : null),
        h('ul.todo-list', mine.map((t) => todoItem(t, store))),
        addInput(`Add for ${m.name}…`, (v) => store.addTodo({ shot_id: shot.id, person: m.name, body: v }), `pop-${m.name}`)));
    }
    pop.append(body);
    refocus(pop);
  };
  const off = store.onChange(render);
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    off(); pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  pop._close = close;
  pop.addEventListener('keydown', onKey); // also while focus is inside, before the document listener is registered
  render();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(560, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  const below = r.bottom + 4;
  const height = Math.min(pop.scrollHeight, window.innerHeight * 0.7);
  pop.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 4) : below}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    pop.querySelector('.todo-add')?.focus();
  });
  return close;
}

/** Board: one column per team member, all to-dos (shot-linked and general). */
export function renderBoard(container, store, { onOpenShot }) {
  let showDone = false;
  const board = h('div.board');
  const toggle = h('label.check', h('input', { type: 'checkbox', on: { change: (e) => { showDone = e.target.checked; render(); } } }), 'Show completed');
  container.replaceChildren(h('div.board-bar', h('p.faint', 'Every to-do across the production. Add general to-dos here, or shot to-dos from the To-do column in the grid.'), toggle), board);

  function render() {
    board.replaceChildren();
    for (const m of state.team) {
      const mine = store.todos.filter((t) => t.person === m.name);
      const open = mine.filter((t) => !t.done);
      const shown = showDone ? mine : open;
      const order = new Map(store.shots.map((s, i) => [s.id, i]));
      shown.sort((a, b) => (a.done - b.done) || ((order.get(a.shot_id) ?? -1) - (order.get(b.shot_id) ?? -1)));
      board.append(h('section.board-col',
        h('header', h('h3', m.name), h('span.count', `${open.length} open`)),
        addInput(`General to-do for ${m.name}…`, (v) => store.addTodo({ shot_id: null, person: m.name, body: v }), `board-${m.name}`),
        shown.length ? h('ul.todo-list', shown.map((t) => todoItem(t, store, { showShot: true, onOpenShot })))
          : h('p.empty-small', 'Nothing open.')));
    }
    refocus(board);
  }
  const off = store.onChange(render);
  render();
  return off;
}

export function todoStore(apiRef, shotsRef) {
  const listeners = new Set();
  const store = {
    todos: [],
    get shots() { return shotsRef(); },
    shotsById: () => new Map(shotsRef().map((s) => [s.id, s])),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    changed() { listeners.forEach((fn) => fn()); },
    upsert(row) {
      const i = store.todos.findIndex((t) => t.id === row.id);
      if (i >= 0) store.todos[i] = row; else store.todos.push(row);
      store.changed();
    },
    drop(id) { store.todos = store.todos.filter((t) => t.id !== id); store.changed(); },
    async addTodo(row) {
      try { store.upsert(await apiRef().todos.create(row)); }
      catch (e) { toast(`Could not add to-do: ${errMsg(e)}`, 'error', 6000); throw e; }
    },
    async updateTodo(id, patch) {
      const prev = store.todos.find((t) => t.id === id);
      if (prev) store.upsert({ ...prev, ...patch });
      try { store.upsert(await apiRef().todos.update(id, patch)); }
      catch (e) { if (prev) store.upsert(prev); toast(`Could not update to-do: ${errMsg(e)}`, 'error', 6000); }
    },
    async removeTodo(id) {
      const prev = store.todos.find((t) => t.id === id);
      store.drop(id);
      try { await apiRef().todos.remove(id); }
      catch (e) { if (prev) store.upsert(prev); toast(`Could not delete to-do: ${errMsg(e)}`, 'error', 6000); }
    },
  };
  return store;
}
