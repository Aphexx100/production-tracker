import { h, $, $$, toast, errMsg, fmtTime, modal, confirmDialog, lsGet, lsSet } from './util.js';
import { icon } from './icons.js';
import { api, state, emit, isAdmin, profileName } from './state.js';
import { askSequenceName, saveSequence, isMissingTable, MIGRATION_HINT } from './sequences.js';

// Display order and labels of the file-type groups inside a sequence.
export const KINDS = [
  { id: 'video', label: 'Movies', icon: 'film' },
  { id: 'image', label: 'Pictures', icon: 'image' },
  { id: 'pdf', label: 'PDFs', icon: 'note' },
  { id: 'link', label: 'Links', icon: 'link' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'doc', label: 'Documents', icon: 'doc' },
  { id: 'model', label: '3D & scenes', icon: 'cube' },
  { id: 'other', label: 'Other files', icon: 'file' },
];
const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[KINDS.length - 1];

const DOC_EXT = /^(docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|pages|numbers|key|fdx|fountain|celtx)$/;
const MODEL_EXT = /^(fbx|obj|abc|usd|usda|usdc|usdz|gltf|glb|blend|ma|mb|c4d|max|hip|hipnc|stl|ply|exr|uasset|umap)$/;

export function detectKind(file) {
  const ext = extOf(file.name);
  const t = file.type || '';
  if (t.startsWith('video/') || /^(mov|mp4|m4v|mkv|webm|avi|mxf|r3d|braw)$/.test(ext)) return 'video';
  if (t.startsWith('image/') && ext !== 'exr' || /^(jpe?g|png|gif|webp|avif|heic|tiff?|bmp|psd|svg)$/.test(ext)) return 'image';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('audio/') || /^(wav|mp3|aiff?|flac|m4a|ogg)$/.test(ext)) return 'audio';
  if (MODEL_EXT.test(ext)) return 'model';
  if (DOC_EXT.test(ext)) return 'doc';
  return 'other';
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

// Browsers can only preview what they can decode; everything else downloads.
const canPreviewImage = (r) => r.kind === 'image' && /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)$/.test(r.mime || '');
const canPlay = (r) => (r.kind === 'video' || r.kind === 'audio') && /^(video|audio)\//.test(r.mime || '');

/** Per-file upload limit (admin setting; Supabase free plan = 50 MB). */
export function uploadLimitBytes() {
  const mb = Number(state.settings?.max_upload_mb) || 50;
  return mb * 1024 * 1024;
}

// ---------- thumbnails (made in the browser at upload time) ----------
const THUMB_EDGE = 480;

async function canvasToWebp(draw, w, h) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  draw(c.getContext('2d'), c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/webp', 0.8));
}

async function imageThumb(file) {
  const bmp = await createImageBitmap(file);
  try { return await canvasToWebp((g, w, h) => g.drawImage(bmp, 0, 0, w, h), bmp.width, bmp.height); }
  finally { bmp.close?.(); }
}

function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const done = (blob) => { clearTimeout(timer); URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); resolve(blob); };
    const timer = setTimeout(() => done(null), 8000);
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 3); };
    v.onseeked = async () => {
      try { done(await canvasToWebp((g, w, h) => g.drawImage(v, 0, 0, w, h), v.videoWidth, v.videoHeight)); }
      catch { done(null); }
    };
    v.onerror = () => done(null);
    v.src = url;
  });
}

async function makeThumb(file, kind) {
  try {
    if (kind === 'image' && /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(file.type)) return await imageThumb(file);
    if (kind === 'video') return await videoThumb(file);
  } catch { /* no thumbnail, the card shows an icon */ }
  return null;
}

// ---------- view ----------
export function mountReferences(root) {
  let refs = [];
  let seqMeta = [];
  let shotSeqs = new Map(); // sequence -> shot count
  let query = '';
  const kindFilter = new Set(lsGet('pt-ref-kinds', []));
  const collapsed = new Set(lsGet('pt-ref-collapsed', []));
  const uploads = new Map(); // sequence -> [{name, progress, el}]
  let active = null;
  let missing = false; // 002_references.sql not run yet

  const nav = h('nav.seq-nav', { 'aria-label': 'Sequences' });
  const newSeqBtn = h('button.btn.primary.block', { type: 'button', on: { click: newSequence } }, icon('plus', 16), 'New sequence');
  const search = h('input.search', { type: 'search', placeholder: 'Search references…', 'aria-label': 'Search references' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderMain(); renderNav(); });
  const side = h('aside.sidebar', h('div.side-top', newSeqBtn, h('div.search-wrap', icon('search', 15), search)), nav);

  const kindBar = h('div.kind-filter', { role: 'group', 'aria-label': 'Filter by file type' });
  const list = h('div.seq-list');
  const main = h('section.refs-main', h('div.refs-bar', kindBar, h('span.faint.refs-hint', 'Drag files or links onto a sequence to add them.')), list);
  root.append(h('div.refs', side, main));

  // ---------- data helpers ----------
  function sequences() {
    const codes = new Set([...seqMeta.map((s) => s.code), ...shotSeqs.keys(), ...refs.map((r) => r.sequence)]);
    codes.delete('');
    const order = new Map(seqMeta.map((s) => [s.code, s.sort_order]));
    const list_ = [...codes].sort((a, b) =>
      (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b, undefined, { numeric: true }));
    list_.push(''); // General
    return list_;
  }
  const meta = (code) => seqMeta.find((s) => s.code === code);
  const seqLabel = (code) => code || 'General';
  const matches = (r) => (!kindFilter.size || kindFilter.has(r.kind)) &&
    (!query || `${r.title} ${r.file_name || ''} ${r.notes} ${r.url || ''} ${r.sequence}`.toLowerCase().includes(query));
  const refsOf = (code) => refs.filter((r) => r.sequence === code);

  // ---------- rendering ----------
  function renderKindBar() {
    kindBar.replaceChildren(...KINDS.map((k) => {
      const on = kindFilter.has(k.id);
      const b = h(`button.kind-chip${on ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(on) }, icon(k.icon, 14), k.label);
      b.addEventListener('click', () => {
        if (on) kindFilter.delete(k.id); else kindFilter.add(k.id);
        lsSet('pt-ref-kinds', [...kindFilter]); renderKindBar(); renderMain(); renderNav();
      });
      return b;
    }), ...(kindFilter.size ? [h('button.link-btn', { type: 'button', on: { click: () => { kindFilter.clear(); lsSet('pt-ref-kinds', []); renderKindBar(); renderMain(); renderNav(); } } }, 'All types')] : []));
  }

  function renderNav() {
    nav.replaceChildren(...sequences().map((code) => {
      const n = refsOf(code).filter(matches).length;
      const m = meta(code);
      return h(`button.seq-item${active === code ? '.active' : ''}`, {
        type: 'button', dataset: { seq: code }, on: { click: () => reveal(code) },
      },
      h('span.seq-code', seqLabel(code)),
      m?.title ? h('span.seq-title', m.title) : null,
      h('span.seq-count', { title: `${n} reference${n === 1 ? '' : 's'}` }, String(n)));
    }));
  }

  function renderMain() {
    if (missing) {
      list.replaceChildren(h('div.setup-note', h('h2', 'References are not set up yet'), h('p', MIGRATION_HINT)));
      newSeqBtn.disabled = true;
      return;
    }
    const scroll = list.scrollTop;
    list.replaceChildren(...sequences().map(renderSection));
    list.scrollTop = scroll;
    resolveThumbs();
  }

  function renderSection(code) {
    const m = meta(code);
    const all = refsOf(code);
    const shown = all.filter(matches);
    const shotsN = shotSeqs.get(code) || 0;
    const isCollapsed = collapsed.has(code);

    const titleInput = h('input.seq-title-input', {
      value: m?.title || '', placeholder: code ? 'Add a title, e.g. “Harbour chase”' : 'References not tied to one sequence',
      'aria-label': `Title for ${seqLabel(code)}`, maxLength: 200, readOnly: !code,
    });
    titleInput.addEventListener('change', () => saveSeq(code, { title: titleInput.value.trim() }));
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });

    const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    fileInput.addEventListener('change', () => { uploadFiles(code, [...fileInput.files]); fileInput.value = ''; });

    const head = h('header.seq-head',
      h('button.icon-btn.small.collapse', {
        type: 'button', 'aria-expanded': String(!isCollapsed), 'aria-label': isCollapsed ? 'Expand' : 'Collapse',
        on: { click: () => { if (collapsed.has(code)) collapsed.delete(code); else collapsed.add(code); lsSet('pt-ref-collapsed', [...collapsed]); renderMain(); } },
      }, isCollapsed ? '▸' : '▾'),
      h('h2.seq-name', seqLabel(code)),
      titleInput,
      h('span.faint.seq-stats', `${all.length} reference${all.length === 1 ? '' : 's'}${code ? ` · ${shotsN} shot${shotsN === 1 ? '' : 's'}` : ''}`),
      h('div.spacer'),
      code ? h('button.btn.small', { type: 'button', title: `Show the shots of ${code} in the shot tracker`, on: { click: () => emit('navigate', { tab: 'shots', sequence: code }) } }, icon('film', 14), 'Shots') : null,
      h('button.btn.small', { type: 'button', on: { click: () => addLink(code) } }, icon('link', 14), 'Add link'),
      h('button.btn.small.primary', { type: 'button', on: { click: () => fileInput.click() } }, icon('upload', 14), 'Upload'),
      fileInput,
      code && isAdmin() && !all.length && !shotsN && m
        ? h('button.icon-btn.small', { type: 'button', title: 'Delete this empty sequence', 'aria-label': 'Delete sequence', on: { click: () => deleteSeq(code) } }, icon('trash', 14))
        : null);

    const section = h(`section.seq${isCollapsed ? '.collapsed' : ''}`, { dataset: { seq: code }, id: `seq-${cssId(code)}` }, head);
    const queue = h('div.upload-queue');
    for (const u of uploads.get(code) || []) queue.append(u.el);
    section.append(queue);

    if (!isCollapsed) {
      const body = h('div.seq-body');
      if (!shown.length) {
        body.append(h('div.drop-hint', all.length ? 'No references match the filters.' : 'Drop movies, pictures, PDFs or links here'));
      }
      for (const k of KINDS) {
        const items = shown.filter((r) => r.kind === k.id);
        if (!items.length) continue;
        body.append(h('div.kind-group',
          h('h3.kind-title', icon(k.icon, 15), `${k.label}`, h('span.faint', ` ${items.length}`)),
          h('div.ref-grid', items.map(renderCard))));
      }
      section.append(body);
    }
    wireDrop(section, code);
    return section;
  }

  function renderCard(r) {
    const k = kindOf(r.kind);
    let thumb;
    if (r.thumb_path || canPreviewImage(r)) {
      thumb = h('div.ref-thumb', h('img', { alt: '', loading: 'lazy', dataset: { refPath: r.thumb_path || r.storage_path } }),
        r.kind === 'video' ? h('span.play-badge', '▶') : null);
    } else if (r.kind === 'link') {
      let host = '';
      try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { /* invalid url is blocked by the DB */ }
      thumb = h('div.ref-thumb.icon', icon('link', 30), h('span.host', host));
    } else {
      thumb = h('div.ref-thumb.icon', icon(k.icon, 30), h('span.host', (extOf(r.file_name) || k.label).toUpperCase()));
    }
    const title = r.title || r.file_name || r.url || 'Untitled';
    const menuBtn = h('button.icon-btn.small.ref-menu', { type: 'button', title: 'Actions', 'aria-label': `Actions for ${title}` }, icon('more', 16));
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(menuBtn, r); });
    const card = h('article.ref-card', { tabIndex: 0, dataset: { id: r.id }, title: r.notes || title },
      thumb,
      h('div.ref-info',
        h('div.ref-title', title),
        h('div.ref-meta', [r.size_bytes != null ? fmtSize(r.size_bytes) : null, profileName(r.created_by), fmtTime(r.created_at)].filter(Boolean).join(' · ')),
        r.notes ? h('div.ref-notes', r.notes) : null),
      menuBtn);
    card.addEventListener('click', () => openRef(r));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRef(r); });
    return card;
  }

  async function resolveThumbs() {
    const imgs = $$('img[data-ref-path]', list);
    if (!imgs.length) return;
    try {
      const urls = await api().refFiles.urls(imgs.map((i) => i.dataset.refPath));
      for (const img of imgs) img.src = urls[img.dataset.refPath] || '';
    } catch { /* thumbnails are optional */ }
  }

  const cssId = (code) => (code || '_general').replace(/[^\w-]/g, '_');

  function reveal(code) {
    active = code;
    history.replaceState(null, '', `#references/${encodeURIComponent(code)}`);
    if (collapsed.has(code)) { collapsed.delete(code); lsSet('pt-ref-collapsed', [...collapsed]); renderMain(); }
    renderNav();
    const el = $(`#seq-${cssId(code)}`, list);
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  }

  // ---------- drag & drop ----------
  function wireDrop(section, code) {
    let depth = 0;
    section.addEventListener('dragenter', (e) => {
      if (!isExternalDrag(e)) return;
      e.preventDefault(); depth++; section.classList.add('drop-on');
    });
    section.addEventListener('dragover', (e) => { if (isExternalDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    section.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; section.classList.remove('drop-on'); } });
    section.addEventListener('drop', (e) => {
      if (!isExternalDrag(e)) return;
      e.preventDefault(); depth = 0; section.classList.remove('drop-on');
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) { uploadFiles(code, files); return; }
      const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      const urls = raw.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map(normalizeUrl).filter(Boolean);
      if (urls.length) urls.forEach((u) => createLink(code, u, '', ''));
      else toast('Nothing to add: drop files or a web link', 'error');
    });
  }
  const isExternalDrag = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');

  // Dropping outside a sequence must not navigate away from the app.
  const stopStray = (e) => { if (!e.target.closest?.('.seq')) e.preventDefault(); };
  root.addEventListener('dragover', stopStray);
  root.addEventListener('drop', stopStray);

  // ---------- actions ----------
  async function uploadFiles(code, all) {
    // Refuse files over the project limit before sending a single byte.
    const limit = uploadLimitBytes();
    const tooBig = all.filter((f) => f.size > limit);
    const files = all.filter((f) => f.size <= limit);
    if (tooBig.length) explainTooBig(code, tooBig, limit);
    if (!files.length) return;
    const q = uploads.get(code) || [];
    uploads.set(code, q);
    const jobs = files.map((file) => {
      const bar = h('span.bar');
      const label = h('span.upload-name', `${file.name} · ${fmtSize(file.size)}`);
      const job = { file, el: h('div.upload-item', label, h('span.track', bar)), bar };
      q.push(job);
      return job;
    });
    renderMain();
    // Two at a time: fast for many small files without flooding the connection.
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await uploadOne(code, job);
        q.splice(q.indexOf(job), 1);
        job.el.remove();
      }
    };
    await Promise.all([worker(), worker()]);
    if (!q.length) uploads.delete(code);
    renderMain(); renderNav();
  }

  function explainTooBig(code, files, limit) {
    const m = modal(files.length === 1 ? 'File too large to upload' : 'Files too large to upload', [
      h('p', `The upload limit for this project is ${fmtSize(limit)} per file. Not uploaded:`),
      h('ul.too-big', files.map((f) => h('li', h('strong', f.name), ` · ${fmtSize(f.size)}`))),
      h('p', h('strong', 'What you can do:')),
      h('ul.tips',
        h('li', 'Make the file smaller. For a PDF: Acrobat › File › Save as Other › Reduced Size PDF. For a movie: export a lower-bitrate review copy (e.g. H.264, 1080p).'),
        h('li', 'Put the file on Google Drive, Dropbox or Frame.io, share it with the team only, and add it here as a link.'),
        h('li', isAdmin()
          ? 'Raise the limit: on a paid Supabase plan, increase Storage › Settings › Upload file size limit, then set the same number in Admin › Upload limit.'
          : 'Ask an admin whether the upload limit can be raised (needs a paid Supabase plan).')),
      h('div.row.end',
        h('button.btn', { type: 'button', on: { click: () => m.close() } }, 'Close'),
        h('button.btn.primary', { type: 'button', on: { click: () => { m.close(); addLink(code, files[0].name.replace(/\.[^.]+$/, '')); } } }, icon('link', 14), 'Add as link instead')),
    ]);
  }

  async function uploadOne(code, job) {
    const { file } = job;
    const kind = detectKind(file);
    const setP = (p) => { job.bar.style.width = `${Math.round(p * 100)}%`; };
    let path = null;
    let thumbPath = null;
    try {
      path = await api().refFiles.upload(file, extOf(file.name), setP);
      const thumb = await makeThumb(file, kind);
      if (thumb) thumbPath = await api().refFiles.upload(thumb, 'webp').catch(() => null);
      const row = await api().refs.create({
        sequence: code, kind, title: file.name.replace(/\.[^.]+$/, ''),
        storage_path: path, thumb_path: thumbPath, file_name: file.name,
        mime: file.type || null, size_bytes: file.size,
      });
      upsert(row);
    } catch (e) {
      job.el.classList.add('failed');
      toast(`${file.name}: ${errMsg(e)}`, 'error', 8000);
      api().refFiles.remove([path, thumbPath]).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  async function createLink(code, url, title, notes) {
    try {
      upsert(await api().refs.create({ sequence: code, kind: 'link', url, title: title || url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), notes }));
      renderMain(); renderNav();
    } catch (e) { toast(`Could not add link: ${errMsg(e)}`, 'error', 6000); }
  }

  function addLink(code, presetTitle = '') {
    const url = h('input', { type: 'text', inputMode: 'url', autocomplete: 'url', placeholder: 'https://… or drive.google.com/…', required: true, 'aria-label': 'Link URL' });
    const title = h('input', { value: presetTitle, placeholder: 'Optional, e.g. “Location scout video”', maxLength: 300, 'aria-label': 'Link title' });
    const notes = h('textarea', { rows: 3, maxLength: 4000, 'aria-label': 'Notes' });
    const msg = h('p.form-msg');
    const m = modal(`Add link to ${seqLabel(code)}`, h('form.form', {
      on: { submit: async (e) => {
        e.preventDefault();
        const u = normalizeUrl(url.value);
        if (!u) { msg.textContent = 'Enter a web address starting with http:// or https://'; return; }
        m.close();
        await createLink(code, u, title.value.trim(), notes.value.trim());
      } },
    }, h('label', 'URL', url), h('label', 'Title', title), h('label', 'Notes', notes), msg,
    h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'Add link'))));
    url.focus();
  }

  function editRef(r) {
    const title = h('input', { value: r.title, maxLength: 300, 'aria-label': 'Title' });
    const notes = h('textarea', { rows: 4, maxLength: 4000, 'aria-label': 'Notes' });
    notes.value = r.notes || '';
    const seqSel = h('select', { 'aria-label': 'Sequence' }, sequences().map((c) => h('option', { value: c }, seqLabel(c))));
    seqSel.value = r.sequence;
    const url = r.kind === 'link' ? h('input', { type: 'text', inputMode: 'url', value: r.url, 'aria-label': 'URL' }) : null;
    const m = modal('Edit reference', h('form.form', {
      on: { submit: async (e) => {
        e.preventDefault();
        const patch = { title: title.value.trim(), notes: notes.value.trim(), sequence: seqSel.value };
        if (url) {
          const u = normalizeUrl(url.value);
          if (!u) { toast('Enter a valid http(s) address', 'error'); return; }
          patch.url = u;
        }
        try { upsert(await api().refs.update(r.id, patch)); m.close(); renderMain(); renderNav(); }
        catch (err) { toast(`Not saved: ${errMsg(err)}`, 'error', 6000); }
      } },
    }, h('label', 'Title', title), url && h('label', 'URL', url), h('label', 'Sequence', seqSel), h('label', 'Notes', notes),
    r.file_name ? h('p.faint', `${r.file_name} · ${fmtSize(r.size_bytes)} · ${r.mime || 'unknown type'}`) : null,
    h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'Save'))));
    title.focus();
  }

  async function deleteRef(r) {
    if (!(await confirmDialog(`Delete “${r.title || r.file_name || r.url}”? ${r.storage_path ? 'The file is removed from storage. ' : ''}This cannot be undone.`))) return;
    try {
      await api().refs.remove(r.id);
      refs = refs.filter((x) => x.id !== r.id);
      await api().refFiles.remove([r.storage_path, r.thumb_path]).catch(() => {});
      renderMain(); renderNav();
      toast('Reference deleted');
    } catch (e) { toast(`Delete failed: ${errMsg(e)}`, 'error', 6000); }
  }

  async function download(r) {
    try {
      const u = await api().refFiles.downloadUrl(r.storage_path, r.file_name);
      const a = h('a', { href: u, download: r.file_name || '', rel: 'noopener' });
      document.body.append(a); a.click(); a.remove();
    } catch (e) { toast(`Download failed: ${errMsg(e)}`, 'error', 6000); }
  }

  function openMenu(anchor, r) {
    document.querySelector('.ctx-menu')?.remove();
    const canDelete = r.created_by === state.me.id || isAdmin();
    const items = [
      { label: r.kind === 'link' ? 'Open link' : 'Open', icon: 'search', run: () => openRef(r) },
      r.storage_path && { label: 'Download', icon: 'download', run: () => download(r) },
      { label: 'Edit / move…', icon: 'settings', run: () => editRef(r) },
      canDelete && { label: 'Delete', icon: 'trash', danger: true, run: () => deleteRef(r) },
    ].filter(Boolean);
    const m = h('div.ctx-menu.popover', { role: 'menu' },
      items.map((it) => h(`button.menu-item${it.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem', on: { click: () => { m.remove(); it.run(); } } }, icon(it.icon, 15), it.label)));
    document.body.append(m);
    const rect = anchor.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(rect.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${rect.bottom + m.offsetHeight > window.innerHeight ? rect.top - m.offsetHeight : rect.bottom + 2}px`;
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true));
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') m.remove(); });
    m.querySelector('button')?.focus();
  }

  // ---------- viewer ----------
  async function openRef(r) {
    if (r.kind === 'link') { window.open(r.url, '_blank', 'noopener,noreferrer'); return; }
    if (r.kind === 'pdf') {
      // Open synchronously (popup blockers), then point the tab at the signed URL.
      const w = window.open('', '_blank');
      try {
        const u = (await api().refFiles.urls([r.storage_path]))[r.storage_path];
        if (w) { w.opener = null; w.location.href = u; } else window.location.assign(u);
      } catch (e) { w?.close(); toast(`Could not open: ${errMsg(e)}`, 'error'); }
      return;
    }
    if (!canPreviewImage(r) && !canPlay(r)) { download(r); return; }
    openViewer(r);
  }

  function openViewer(start) {
    const group = refs.filter((x) => x.sequence === start.sequence && matches(x) && (canPreviewImage(x) || canPlay(x)));
    let i = Math.max(0, group.findIndex((x) => x.id === start.id));
    const stage = h('div.viewer-stage');
    const caption = h('div.viewer-caption');
    const prev = h('button.icon-btn.viewer-nav.prev', { type: 'button', 'aria-label': 'Previous' }, '‹');
    const next = h('button.icon-btn.viewer-nav.next', { type: 'button', 'aria-label': 'Next' }, '›');
    // Arrows sit in the same frame as the media, so they stay centered on it.
    const m = modal(seqLabel(start.sequence), h('div.viewer', h('div.viewer-frame', prev, stage, next), caption), { wide: true, onClose: () => document.removeEventListener('keydown', onKey) });
    m.el.classList.add('viewer-modal');

    async function show() {
      const r = group[i];
      const u = (await api().refFiles.urls([r.storage_path]))[r.storage_path];
      if (canPlay(r)) {
        stage.replaceChildren(r.kind === 'audio'
          ? h('audio', { src: u, controls: true, autoplay: true })
          : h('video', { src: u, controls: true, autoplay: true, playsInline: true }));
      } else stage.replaceChildren(h('img', { src: u, alt: r.title || r.file_name || '' }));
      caption.replaceChildren(...[h('strong', r.title || r.file_name), ` · ${kindOf(r.kind).label} · ${fmtSize(r.size_bytes)} · ${i + 1} / ${group.length}`,
        r.notes ? h('p', r.notes) : null,
        h('button.btn.small', { type: 'button', on: { click: () => download(r) } }, icon('download', 14), 'Download')].filter(Boolean));
      prev.hidden = next.hidden = group.length < 2;
    }
    const go = (d) => { i = (i + d + group.length) % group.length; show(); };
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    show().catch((e) => toast(`Could not open: ${errMsg(e)}`, 'error'));
  }

  // ---------- sequences ----------
  async function saveSeq(code, patch) {
    if (!code) return;
    try {
      const row = await api().sequences.upsert({ code, ...(meta(code) ? {} : { sort_order: nextOrder() }), ...patch });
      const i = seqMeta.findIndex((s) => s.code === code);
      if (i >= 0) seqMeta[i] = row; else seqMeta.push(row);
      renderNav();
    } catch (e) { toast(`Not saved: ${errMsg(e)}`, 'error', 6000); }
  }
  const nextOrder = () => Math.max(0, ...seqMeta.map((s) => s.sort_order)) + 1;

  async function newSequence() {
    const c = await askSequenceName();
    if (!c) return;
    if (!sequences().includes(c)) {
      const row = await saveSequence(c, seqMeta);
      if (!row) return;
      seqMeta.push(row);
    }
    renderMain(); reveal(c);
  }

  async function deleteSeq(code) {
    if (!(await confirmDialog(`Delete the empty sequence ${code}?`))) return;
    try {
      await api().sequences.remove(code);
      seqMeta = seqMeta.filter((s) => s.code !== code);
      renderMain(); renderNav();
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  function upsert(row) {
    const i = refs.findIndex((r) => r.id === row.id);
    if (i >= 0) refs[i] = row; else refs.push(row);
  }

  // ---------- live updates ----------
  const rerender = () => { renderMain(); renderNav(); };
  const unsubRefs = api().subscribe('refs', (type, row, old) => {
    if (type === 'DELETE') refs = refs.filter((r) => r.id !== old.id);
    else upsert(row);
    rerender();
  });
  const unsubSeq = api().subscribe('sequences', (type, row, old) => {
    if (type === 'DELETE') seqMeta = seqMeta.filter((s) => s.code !== old.code);
    else { const i = seqMeta.findIndex((s) => s.code === row.code); if (i >= 0) seqMeta[i] = row; else seqMeta.push(row); }
    if (!document.activeElement?.matches('.seq-title-input')) rerender();
  });

  async function loadShots() {
    try {
      const shots = await api().shots.list();
      shotSeqs = new Map();
      for (const s of shots) if (s.sequence) shotSeqs.set(s.sequence, (shotSeqs.get(s.sequence) || 0) + 1);
    } catch { /* counts are informational */ }
  }

  // ---------- init ----------
  renderKindBar();
  const ready = (async () => {
    try {
      [refs, seqMeta] = await Promise.all([api().refs.list(), api().sequences.list(), loadShots()]);
    } catch (e) {
      if (isMissingTable(e)) {
        missing = true;
      }
      toast(`Could not load references: ${errMsg(e)}`, 'error', 8000);
    }
    rerender();
  })();

  return {
    async enter() {
      await ready;
      await loadShots(); rerender();
      const want = location.hash.match(/^#references\/(.*)$/);
      if (want) reveal(decodeURIComponent(want[1]));
      else history.replaceState(null, '', '#references');
    },
    async reveal(code) { await ready; reveal(code); },
    destroy() { unsubRefs(); unsubSeq(); },
  };
}
