import { h, $, debounce, toast, errMsg, todayISO, fmtDay, fmtTime, htmlToText, confirmDialog } from './util.js';
import { icon } from './icons.js';
import { api, state, profileName } from './state.js';
import { createEditor } from './editor.js';
import { resolveHtml, stripImageUrls } from './media.js';

export function mountDailies(root) {
  let entries = [];
  let current = null;       // entry object being edited
  let editor = null;
  let dirty = false;
  let saving = null;
  let query = '';

  const list = h('nav.day-list', { 'aria-label': 'Daily summaries' });
  const search = h('input.search', { type: 'search', placeholder: 'Search summaries…', 'aria-label': 'Search summaries' });
  const newBtn = h('button.btn.primary.block', { type: 'button' }, icon('plus', 16), 'New daily summary');
  const side = h('aside.sidebar', h('div.side-top', newBtn, h('div.search-wrap', icon('search', 15), search)), list);

  const main = h('section.day-main', { 'aria-live': 'off' });
  root.append(h('div.dailies', side, main));

  // ---------- list ----------
  function renderList() {
    list.replaceChildren();
    const q = query.toLowerCase();
    const shown = entries.filter((e) => !q || `${e.title} ${e.day} ${htmlToText(e.content)}`.toLowerCase().includes(q));
    if (!shown.length) {
      list.append(h('p.empty-small', entries.length ? 'No matches.' : 'No summaries yet.'));
      return;
    }
    let month = '';
    for (const e of shown) {
      const m = fmtDay(e.day, { month: 'long', year: 'numeric' });
      if (m !== month) { month = m; list.append(h('div.month', m)); }
      const snippet = htmlToText(e.content).slice(0, 80);
      list.append(h(`button.day-item${current?.id === e.id ? '.active' : ''}`, {
        type: 'button', dataset: { id: e.id }, 'aria-current': current?.id === e.id ? 'true' : null,
        on: { click: () => open(e.id) },
      },
      h('span.day-date', fmtDay(e.day, { weekday: 'short', day: 'numeric', month: 'short' })),
      h('span.day-title', e.title || 'Untitled'),
      snippet && h('span.day-snippet', snippet)));
    }
  }

  // ---------- editor ----------
  const saveNow = async () => {
    if (!current || !editor || !dirty) return;
    const id = current.id;
    const content = stripImageUrls(editor.getHTML());
    dirty = false;
    setStatus('Saving…');
    saving = api().dailies.update(id, { content })
      .then((row) => { mergeEntry(row); if (current?.id === id) setStatus(savedLabel(row)); })
      .catch((e) => { dirty = true; setStatus('Not saved', true); toast(`Save failed: ${errMsg(e)}`, 'error', 6000); })
      .finally(() => { saving = null; });
    await saving;
  };
  const saveSoon = debounce(saveNow, 900);

  async function saveMeta(id, patch) {
    try {
      const row = await api().dailies.update(id, patch);
      mergeEntry(row);
      if (current?.id === id) setStatus(savedLabel(row));
      renderList();
    } catch (e) { toast(`Save failed: ${errMsg(e)}`, 'error', 6000); }
  }
  const saveTitle = debounce((id, v) => saveMeta(id, { title: v }), 600);

  function savedLabel(row) {
    return `Saved ${fmtTime(row.updated_at)}${row.updated_by ? ` · ${profileName(row.updated_by)}` : ''}`;
  }
  function setStatus(text, bad = false) {
    const s = $('.save-status', main);
    if (s) { s.textContent = text; s.classList.toggle('bad', bad); }
  }
  function mergeEntry(row) {
    const i = entries.findIndex((e) => e.id === row.id);
    if (i >= 0) entries[i] = { ...entries[i], ...row }; else entries.unshift(row);
    entries.sort((a, b) => b.day.localeCompare(a.day) || (b.created_at || '').localeCompare(a.created_at || ''));
    if (current?.id === row.id) current = entries.find((e) => e.id === row.id);
  }

  async function open(id) {
    saveSoon.cancel();
    saveTitle.flush();
    await saveNow();
    await saving;
    editor?.destroy(); editor = null;
    current = entries.find((e) => e.id === id) || null;
    if (!root.hidden) history.replaceState(null, '', `#dailies/${id || ''}`);
    renderList();
    main.replaceChildren();
    if (!current) { renderEmpty(); return; }

    const date = h('input.day-input', { type: 'date', value: current.day, 'aria-label': 'Date', required: true });
    date.addEventListener('change', () => { if (date.value) saveMeta(current.id, { day: date.value }); });
    const title = h('input.title-input', { value: current.title, placeholder: 'Title, e.g. “Harbour day 2”', 'aria-label': 'Title', maxLength: 200 });
    title.addEventListener('input', () => { current.title = title.value; saveTitle(current.id, title.value); });
    const del = h('button.icon-btn', { type: 'button', title: 'Delete this summary', 'aria-label': 'Delete this summary' }, icon('trash'));
    del.addEventListener('click', () => remove(current));
    const print = h('button.icon-btn', { type: 'button', title: 'Print / save as PDF', 'aria-label': 'Print' }, icon('print'));
    print.addEventListener('click', () => window.print());

    const head = h('header.day-head',
      h('div.day-head-row', date, title, h('div.spacer'), h('span.save-status', savedLabel(current)), print, del));
    const editorBox = h('div.editor-box');
    main.append(head, editorBox);

    const html = await resolveHtml(current.content);
    if (current?.id !== id) return;
    editor = createEditor(editorBox, {
      content: html,
      placeholder: 'Write the summary of the call… Paste screenshots straight in.',
      onUpdate: () => { dirty = true; setStatus('Editing…'); saveSoon(); },
      onBlur: () => { if (dirty) saveSoon.flush(); },
    });
    if (!current.content) editor.commands.focus();
  }

  function renderEmpty() {
    main.append(h('div.empty',
      h('h2', 'No summary selected'),
      h('p', 'Pick a day on the left, or start a new summary for today’s call.'),
      h('button.btn.primary', { type: 'button', on: { click: createNew } }, icon('plus', 16), 'New daily summary')));
  }

  async function createNew() {
    try {
      const row = await api().dailies.create({ day: todayISO(), title: '', content: '' });
      mergeEntry(row);
      await open(row.id);
      $('.title-input', main)?.focus();
    } catch (e) { toast(`Could not create: ${errMsg(e)}`, 'error', 6000); }
  }

  async function remove(entry) {
    if (!(await confirmDialog(`Delete the summary for ${fmtDay(entry.day)}${entry.title ? ` (“${entry.title}”)` : ''}? This cannot be undone.`))) return;
    try {
      dirty = false; saveSoon.cancel();
      await api().dailies.remove(entry.id);
      entries = entries.filter((e) => e.id !== entry.id);
      await open(entries[0]?.id);
      toast('Summary deleted');
    } catch (e) { toast(`Delete failed: ${errMsg(e)}`, 'error', 6000); }
  }

  newBtn.addEventListener('click', createNew);
  search.addEventListener('input', () => { query = search.value; renderList(); });

  // ---------- live updates from teammates ----------
  const unsub = api().subscribe('dailies', (type, row, old) => {
    if (type === 'DELETE') {
      entries = entries.filter((e) => e.id !== old.id);
      if (current?.id === old.id) { toast('This summary was deleted by someone else', 'error'); open(entries[0]?.id); }
      else renderList();
      return;
    }
    if (row.updated_by === state.me.id) return;
    const isCurrent = current?.id === row.id;
    const before = entries.find((e) => e.id === row.id);
    mergeEntry(row);
    renderList();
    if (isCurrent && before?.content !== row.content) {
      if (!dirty && !editor?.isFocused) {
        resolveHtml(row.content).then((html) => { if (current?.id === row.id) editor?.commands.setContent(html, { emitUpdate: false }); });
        setStatus(savedLabel(row));
      } else {
        toast(`${profileName(row.updated_by)} also edited this summary. Your version will overwrite theirs when saved.`, 'error', 8000);
      }
    }
  });

  window.addEventListener('beforeunload', (e) => { if (dirty) { saveSoon.flush(); e.preventDefault(); } });

  // ---------- init ----------
  (async () => {
    try {
      entries = await api().dailies.list();
    } catch (e) { toast(`Could not load summaries: ${errMsg(e)}`, 'error', 8000); }
    const want = location.hash.match(/^#dailies\/(.+)$/)?.[1];
    await open(entries.some((e) => e.id === want) ? want : entries[0]?.id);
  })();

  return {
    async leave() { saveSoon.cancel(); await saveNow(); },
    enter() { if (current) history.replaceState(null, '', `#dailies/${current.id}`); else history.replaceState(null, '', '#dailies'); },
    destroy() { unsub(); editor?.destroy(); },
  };
}
