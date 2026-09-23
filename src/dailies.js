import { h, $, debounce, toast, errMsg, todayISO, fmtDay, fmtTime, htmlToText, confirmDialog, modal, LOCALE } from './util.js';
import { icon } from './icons.js';
import { api, state, profileName } from './state.js';
import { createEditor } from './editor.js';
import { resolveHtml, stripImageUrls } from './media.js';
import { convertDailyToTasks } from './extract.js';
import { TRANSCRIPT_ACCEPT, readTranscriptFile, wordCount, summaryToHtml } from './transcript.js';
import { sanitize } from './sanitize.js';
import { isMissingTable } from './sequences.js';

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

  async function open(id, { focusTitle = false } = {}) {
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
    const toTasks = h('button.btn.small', { type: 'button', title: 'Let Claude find the action items in this call and turn them into tasks' }, icon('checklist', 14), 'Convert to task list');
    toTasks.addEventListener('click', async () => {
      await flushAll();
      convertDailyToTasks(current, toTasks);
    });

    const fileInput = h('input', { type: 'file', accept: TRANSCRIPT_ACCEPT, hidden: true, 'aria-hidden': 'true' });
    fileInput.addEventListener('change', () => { uploadTranscript(fileInput.files[0]); fileInput.value = ''; });
    const uploadBtn = h('button.btn.small', { type: 'button', title: 'Attach the transcript of the call (.txt, .vtt, .srt, .json). It is kept with the day and used by the AI buttons.' },
      icon('upload', 14), 'Upload transcript');
    uploadBtn.addEventListener('click', () => fileInput.click());
    const summariseBtn = h('button.btn.small.ai-btn', { type: 'button', title: 'Let Claude draft the summary from the transcript' }, icon('sparkle', 14), 'Summarise with AI');
    summariseBtn.addEventListener('click', () => summarise(summariseBtn));
    const transcriptChip = h('span.transcript-chip');
    const aiBox = h('div.ai-group', h('span.ai-lbl', 'AI'), uploadBtn, summariseBtn, toTasks, transcriptChip, fileInput);
    print.addEventListener('click', () => window.print());

    const head = h('header.day-head',
      h('div.day-head-row', date, title, h('div.spacer'), h('span.save-status', savedLabel(current)), print, del),
      aiBox);
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
    renderTranscript();
    if (focusTitle) $('.title-input', main)?.focus();
    else if (!current.content) editor.commands.focus();
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
      await open(row.id, { focusTitle: true });
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


  // ---------- AI helpers (transcript + summary) ----------
  async function flushAll() {
    saveSoon.cancel(); saveTitle.flush();
    await saveNow(); await saving;
  }

  function renderTranscript() {
    const chip = $('.transcript-chip', main);
    const btn = $('.ai-btn', main);
    if (!chip) return;
    const has = !!current?.transcript;
    if (btn) {
      btn.disabled = !has && !htmlToText(current?.content || '');
      btn.title = has ? 'Let Claude draft the summary from the transcript' : 'Upload a transcript first, or write rough notes — then Claude turns them into a summary';
    }
    if (!has) { chip.replaceChildren(); return; }
    const words = wordCount(current.transcript);
    chip.replaceChildren(
      h('button.chip-main', { type: 'button', title: 'Show the transcript', on: { click: showTranscript } },
        icon('doc', 12), current.transcript_name || 'transcript', h('span.faint', ` · ${words.toLocaleString(LOCALE)} words`)),
      h('button.icon-btn.small', { type: 'button', title: 'Remove the transcript', 'aria-label': 'Remove the transcript', on: { click: removeTranscript } }, icon('x', 12)));
  }

  function showTranscript() {
    modal(current.transcript_name || 'Transcript',
      h('pre.transcript-view', current.transcript), { wide: true });
  }

  async function uploadTranscript(file) {
    if (!file || !current) return;
    let parsed;
    try { parsed = await readTranscriptFile(file); }
    catch (e) { toast(errMsg(e), 'error', 8000); return; }
    if (current.transcript && !(await confirmDialog(`Replace the transcript “${current.transcript_name || ''}” with “${parsed.name}”?`, 'Replace'))) return;
    await saveTranscript(parsed.text, parsed.name, `Transcript attached: ${parsed.name} (${wordCount(parsed.text).toLocaleString(LOCALE)} words)`);
  }

  async function removeTranscript() {
    if (!(await confirmDialog('Remove the transcript from this day? The written summary stays.', 'Remove'))) return;
    await saveTranscript(null, null, 'Transcript removed');
  }

  async function saveTranscript(text, name, okMsg) {
    const id = current.id;
    try {
      const row = await api().dailies.update(id, { transcript: text, transcript_name: name });
      mergeEntry(row);
      if (current?.id === id) { current.transcript = row.transcript; current.transcript_name = row.transcript_name; renderTranscript(); }
      toast(okMsg);
    } catch (e) {
      toast(isMissingTable(e)
        ? 'Transcripts need supabase/008_transcripts.sql. An admin must run it once in the Supabase SQL Editor.'
        : `Not saved: ${errMsg(e)}`, 'error', 9000);
    }
  }

  async function summarise(button) {
    if (!current) return;
    const label = button.innerHTML;
    button.disabled = true; button.textContent = 'Reading the call…';
    let result;
    try {
      await flushAll();
      result = await api().ai.summariseDaily(current.id);
    } catch (e) {
      toast(errMsg(e), 'error', 10000);
      return;
    } finally { button.disabled = false; button.innerHTML = label; }
    const summary = result.summary;
    if (!summary?.sections?.length) { toast('Claude found nothing to summarise in this call.', 'error', 6000); return; }
    previewSummary(summary, result.model);
  }

  function previewSummary(summary, model) {
    const html = summaryToHtml(summary);
    const preview = h('div.prose.summary-preview');
    preview.innerHTML = sanitize(html);
    const hasText = !!htmlToText(current.content || '');
    const mode = h('select', { 'aria-label': 'Where to put it' },
      h('option', { value: 'replace' }, hasText ? 'Replace the current summary' : 'Use as the summary'),
      h('option', { value: 'append' }, 'Add below what is there'));
    const useTitle = h('input', { type: 'checkbox', checked: !current.title, 'aria-label': 'Use the suggested title' });
    const dlg = modal('Summary draft', [
      h('p.faint', `Drafted by ${model || 'Claude'} from ${current.transcript_name ? `“${current.transcript_name}”` : 'your notes'}. Check it before keeping it — you can edit everything afterwards.`),
      summary.title ? h('label.check.title-suggest', useTitle, `Title: “${summary.title}”`) : null,
      h('div.review-wrap', preview),
      h('div.row.end', mode, h('button.btn', { type: 'button', on: { click: () => dlg.close() } }, 'Cancel'),
        h('button.btn.primary', { type: 'button', on: { click: () => apply() } }, 'Keep this summary')),
    ], { wide: true });
    dlg.el.classList.add('review-modal');

    async function apply() {
      dlg.close();
      if (mode.value === 'replace') editor.commands.setContent(html, { emitUpdate: false });
      else editor.commands.insertContentAt(editor.state.doc.content.size, html);
      dirty = true;
      setStatus('Editing…');
      await saveNow();
      if (summary.title && useTitle.checked) {
        current.title = summary.title;
        const input = $('.title-input', main);
        if (input) input.value = summary.title;
        await saveMeta(current.id, { title: summary.title });
      }
      toast('Summary added — edit it as you like');
    }
  }

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
  const ready = (async () => {
    try {
      entries = await api().dailies.list();
    } catch (e) { toast(`Could not load summaries: ${errMsg(e)}`, 'error', 8000); }
    const want = location.hash.match(/^#dailies\/(.+)$/)?.[1];
    await open(entries.some((e) => e.id === want) ? want : entries[0]?.id);
  })();

  return {
    async revealDaily(id) { await ready; if (entries.some((e) => e.id === id)) await open(id); },
    async leave() { saveSoon.cancel(); await saveNow(); },
    enter() { if (current) history.replaceState(null, '', `#dailies/${current.id}`); else history.replaceState(null, '', '#dailies'); },
    destroy() { unsub(); editor?.destroy(); },
  };
}
