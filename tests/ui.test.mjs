// End-to-end smoke test of the built app in demo mode (no Supabase needed).
// Run `npm run build` first; `npm run check` does both.
import { preview } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await preview({ root, preview: { port: 5199, strictPort: true }, logLevel: 'silent' });
const URL_ = 'http://localhost:5199/?demo';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/Berlin' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let passed = 0;
const ok = (name) => { passed++; console.log('  ok', name); };

async function pasteImage(selector) {
  await page.evaluate(async (sel) => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 30;
    const g = c.getContext('2d'); g.fillStyle = '#f5a524'; g.fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'ref.png', { type: 'image/png' }));
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, selector);
}

try {
  await page.goto(URL_);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL_);

  // ---- dailies ----
  await page.waitForSelector('.day-item');
  assert.equal(await page.locator('.day-item').count(), 2);
  await page.locator('.day-item').nth(1).click();
  await page.waitForFunction(() => document.querySelector('.title-input')?.value === 'Harbour day 1');
  ok('daily list opens selected day on the right');

  await page.click('text=New daily summary');
  await page.waitForFunction(() => document.querySelectorAll('.day-item').length === 3);
  await page.fill('.title-input', 'Unit call');
  await page.click('.editor-surface .ProseMirror');
  await page.keyboard.type('Rain cover ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('needed');
  await pasteImage('.editor-surface .ProseMirror');
  await page.waitForSelector('.editor-surface img[data-path]');
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => /Saved/.test(document.querySelector('.save-status')?.textContent));
  await page.reload();
  await page.waitForSelector('.day-item');
  await page.locator('.day-item', { hasText: 'Unit call' }).click();
  await page.waitForSelector('.editor-surface strong');
  assert.equal(await page.textContent('.editor-surface strong'), 'needed');
  const src = await page.getAttribute('.editor-surface img[data-path]', 'src');
  assert.ok(src.startsWith('blob:'), 'image resolves after reload');
  ok('new summary: title, bold text, pasted image persist across reload');

  await page.fill('.search', 'rain cover');
  assert.equal(await page.locator('.day-item').count(), 1);
  await page.fill('.search', '');
  ok('summary search');

  // ---- shots ----
  await page.click('#tab-shots');
  await page.waitForSelector('tr.shot-row');
  assert.equal(await page.locator('tr.shot-row').count(), 4);

  const cell = (row, key) => page.locator('tr.shot-row').nth(row).locator(`td[data-key="${key}"]`);
  await cell(0, 'lens').click();
  await page.keyboard.type('85mm Master Prime');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('tr.shot-row td[data-key="lens"]').textContent === '85mm Master Prime');
  ok('type-to-edit a cell, Enter saves');

  assert.match(await page.getAttribute('th[data-key="scene"] .th-btn', 'title'), /^Scene: Scene number from the script/);
  assert.match(await page.getAttribute('th[data-key="sequence"] .th-btn', 'title'), /group of scenes/);
  const missing = await page.$$eval('th[data-key] .th-btn', (els) => els.filter((e) => /undefined/.test(e.title)).length);
  assert.equal(missing, 0);
  ok('column headers explain themselves on hover');

  await cell(0, 'frame_out').dblclick();
  await page.fill('.cell-input', '1048');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('tr.shot-row td[data-key="duration"]').textContent.startsWith('48 f'));
  assert.match(await cell(0, 'duration').textContent(), /00:00:02:00/);
  ok('frame out edit recalculates length + timecode');

  await cell(0, 'frame_out').click();
  await page.keyboard.type('900');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast.error');
  assert.ok((await cell(0, 'duration').textContent()).startsWith('48 f'), 'invalid edit reverted');
  ok('invalid frame range rejected and reverted');

  // keyboard navigation + delete
  await cell(1, 'comments').click();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row')[1].querySelector('td[data-key="comments"]').textContent === '');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getAttribute('td.sel', 'data-key'), 'priority');
  ok('arrow navigation and Delete clears cell');

  // rich description with image
  await cell(2, 'description').dblclick();
  await page.waitForSelector('.rich-pop .ProseMirror:focus');
  await page.keyboard.type(' Storyboard attached.');
  await pasteImage('.rich-pop .ProseMirror');
  await page.waitForSelector('.rich-pop img[data-path]');
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('tr.shot-row:nth-child(3) td[data-key="description"] img[src^="blob:"]');
  assert.match(await cell(2, 'description').textContent(), /Storyboard attached/);
  ok('description: rich edit with pasted image');

  // to-dos
  await cell(0, '_todo').click();
  await page.waitForSelector('.todo-pop');
  await page.fill('.todo-add[data-key="pop-Micael"]', 'Clean plate');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.todo-pop .todo-body:has-text("Clean plate")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.todo-pop', { state: 'detached' });
  assert.match(await cell(0, '_todo').textContent(), /Micael1/);
  ok('to-do added for Micael from the grid');

  await page.click('.seg-btn:has-text("To-dos by person")');
  await page.waitForSelector('.board-col');
  assert.equal(await page.locator('.board-col h3').allTextContents().then((x) => x.join(',')), 'Mihai,Miguel,Rafael,Micael,Sascha');
  const mic = page.locator('.board-col', { has: page.locator('h3', { hasText: 'Micael' }) });
  assert.match(await mic.textContent(), /Clean plate/);
  await mic.locator('input[type=checkbox]').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.board-col')].find((c) => c.querySelector('h3').textContent === 'Micael').textContent.includes('0 open'));
  await page.click('.seg-btn:has-text("Shots")');
  await page.waitForSelector('tr.shot-row');
  ok('to-do board per person; completing updates counts');

  // filters, add, paste from spreadsheet
  await page.click('.status-chip:has-text("Approved")');
  assert.equal(await page.locator('tr.shot-row').count(), 1);
  await page.click('.status-filter .link-btn');
  assert.equal(await page.locator('tr.shot-row').count(), 4);
  ok('status filter');

  await page.click('button:has-text("Add shot")');
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row').length === 5);
  assert.equal(await cell(4, 'shot_name').textContent(), 'SQ020_0020');
  ok('add shot auto-increments name');

  await cell(4, 'lens').click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '40mm\tStatic\n50mm\tDolly\n');
    document.querySelector('.grid-scroll').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.click('.modal button.danger'); // confirm creating 1 overflow shot
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row').length === 6);
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row')[5].querySelector('td[data-key="movement"]').textContent === 'Dolly');
  assert.equal(await cell(4, 'lens').textContent(), '40mm');
  ok('paste block from Excel fills cells and adds rows');

  await page.reload();
  await page.waitForSelector('tr.shot-row');
  assert.equal(await page.locator('tr.shot-row').count(), 6);
  assert.equal(await cell(0, 'lens').textContent(), '85mm Master Prime');
  ok('shot edits persist across reload');

  // ---- references ----
  await page.click('#tab-references');
  await page.waitForSelector('section.seq[data-seq="SQ010"]');
  assert.deepEqual(await page.$$eval('section.seq', (els) => els.map((e) => e.dataset.seq)), ['SQ010', 'SQ020', '']);
  const seq = (code) => page.locator(`section.seq[data-seq="${code}"]`);
  assert.equal(await seq('SQ010').locator('.ref-card').count(), 1);
  ok('references grouped in sequence containers (from shots + sequences)');

  async function dropOn(code, files, uri) {
    await page.evaluate(async ({ code, files, uri }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        let blob;
        if (f.type === 'image/png') {
          const c = document.createElement('canvas'); c.width = 64; c.height = 36;
          c.getContext('2d').fillStyle = '#3af'; c.getContext('2d').fillRect(0, 0, 64, 36);
          blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        } else blob = new Blob([new Uint8Array(2048)], { type: f.type });
        dt.items.add(new File([blob], f.name, { type: f.type }));
      }
      if (uri) dt.setData('text/uri-list', uri);
      const el = document.querySelector(`section.seq[data-seq="${code}"]`);
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { code, files, uri });
  }

  await dropOn('SQ010', [{ name: 'mood.png', type: 'image/png' }, { name: 'script pages.pdf', type: 'application/pdf' }, { name: 'previs.mp4', type: 'video/mp4' }]);
  await page.waitForFunction(() => document.querySelectorAll('section.seq[data-seq="SQ010"] .ref-card').length === 4, null, { timeout: 20000 });
  const groups = await seq('SQ010').locator('.kind-title').allTextContents();
  assert.deepEqual(groups.map((g) => g.replace(/\s*\d+$/, '')), ['Movies', 'Pictures', 'PDFs', 'Links']);
  await page.waitForSelector('section.seq[data-seq="SQ010"] .kind-group:has-text("Pictures") img[src^="blob:"]');
  ok('drag & drop upload sorts files into Movies / Pictures / PDFs with thumbnails');

  await dropOn('SQ020', [], 'https://vimeo.com/123456');
  await page.waitForFunction(() => document.querySelector('section.seq[data-seq="SQ020"]').textContent.includes('vimeo.com/123456'));
  ok('dropping a web link adds it to Links');

  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(60 * 1024 * 1024)], 'huge_script.pdf', { type: 'application/pdf' }));
    const el = document.querySelector('section.seq[data-seq=""]');
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.modal:has-text("File too large to upload")');
  assert.match(await page.textContent('.modal'), /50 MB per file.*huge_script\.pdf · 60 MB/s);
  assert.equal(await page.locator('section.seq[data-seq=""] .upload-item').count(), 0, 'nothing uploaded');
  await page.click('.modal button:has-text("Add as link instead")');
  assert.equal(await page.inputValue('.modal input[aria-label="Link title"]'), 'huge_script');
  await page.fill('.modal input[aria-label="Link URL"]', 'drive.google.com/file/d/abc');
  await page.click('.modal button:has-text("Add link")');
  await page.waitForFunction(() => document.querySelector('section.seq[data-seq=""]').textContent.includes('huge_script'));
  ok('too-large file refused before upload, offered as link instead');

  await seq('SQ010').locator('.ref-card', { hasText: 'mood' }).click();
  await page.waitForSelector('.viewer-stage img[src^="blob:"]');
  await page.waitForFunction(() => document.querySelector('.viewer-stage img').complete);
  const geo = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const img = r('.viewer-stage img'); const prev = r('.viewer-nav.prev'); const next = r('.viewer-nav.next');
    const modal = document.querySelector('.viewer-modal');
    const body = modal.querySelector('.modal-body');
    return {
      imgMid: img.top + img.height / 2, prevMid: prev.top + prev.height / 2, nextMid: next.top + next.height / 2,
      prevVisible: prev.bottom <= innerHeight && prev.top >= 0,
      modalH: modal.getBoundingClientRect().height, modalW: modal.getBoundingClientRect().width, vh: innerHeight, vw: innerWidth,
      caption: document.querySelector('.viewer-caption').textContent,
      scrolls: body.scrollHeight > body.clientHeight + 1 || modal.scrollHeight > modal.clientHeight + 1,
    };
  });
  assert.ok(Math.abs(geo.prevMid - geo.imgMid) < 2 && Math.abs(geo.nextMid - geo.imgMid) < 2, JSON.stringify(geo));
  assert.ok(geo.prevVisible && !geo.scrolls && geo.modalH > geo.vh * 0.9 && geo.modalW > geo.vw * 0.9, JSON.stringify(geo));
  assert.doesNotMatch(geo.caption, /null|undefined/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer-stage', { state: 'detached' });
  ok('viewer fills the window, arrows centered on the picture, no scrolling');

  await page.click('.kind-chip:has-text("PDFs")');
  assert.equal(await seq('SQ010').locator('.ref-card').count(), 1);
  await page.click('.kind-filter .link-btn');
  assert.equal(await seq('SQ010').locator('.ref-card').count(), 4);
  ok('file type filter');

  const pdfCard = seq('SQ010').locator('.ref-card', { hasText: 'script pages' });
  await pdfCard.hover();
  await pdfCard.locator('.ref-menu').click();
  await page.click('.ctx-menu button:has-text("Edit / move")');
  await page.selectOption('.modal select', 'SQ020');
  await page.click('.modal button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('section.seq[data-seq="SQ020"]').textContent.includes('script pages'));
  ok('move a reference to another sequence');

  const vid = seq('SQ010').locator('.ref-card', { hasText: 'previs' });
  await vid.hover();
  await vid.locator('.ref-menu').click();
  await page.click('.ctx-menu button:has-text("Delete")');
  await page.click('.modal button.danger');
  await page.waitForFunction(() => document.querySelectorAll('section.seq[data-seq="SQ010"] .ref-card').length === 2);
  ok('delete a reference');

  await page.reload();
  await page.waitForSelector('section.seq[data-seq="SQ010"] .ref-card');
  assert.equal(await seq('SQ010').locator('.ref-card').count(), 2);
  ok('references persist across reload');

  // cross-links between shot tracker and references
  await seq('SQ020').locator('button:has-text("Shots")').click();
  await page.waitForSelector('#pane-shots:not([hidden]) tr.shot-row');
  assert.deepEqual([...new Set(await page.locator('tr.shot-row td[data-key="sequence"] > span').allTextContents())], ['SQ020']);
  assert.equal(await page.locator('tr.shot-row').count(), 3); // SQ020_0010 + two added earlier
  assert.match(await page.textContent('.seq-filter'), /SQ020/);
  await page.click('.seq-filter');
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row').length === 6);
  ok('"Shots" on a sequence filters the shot tracker to it');

  const clip = page.locator('tr.shot-row').first().locator('.seq-ref');
  assert.equal((await clip.textContent()).trim(), '2');
  await clip.click();
  await page.waitForSelector('#pane-references:not([hidden]) section.seq.flash[data-seq="SQ010"]');
  assert.match(page.url(), /#references\/SQ010$/);
  ok('paperclip in the Seq column jumps to that sequence’s references');

  // sequences shared between References and the shot tracker
  await page.click('.refs .sidebar button:has-text("New sequence")');
  assert.equal(await page.locator('.modal input').count(), 1, 'only a name field');
  await page.fill('.modal input', 'Rooftop escape');
  await page.click('.modal button:has-text("Create")');
  await page.waitForSelector('section.seq[data-seq="Rooftop escape"]');
  ok('new sequence asks only for a name');

  await page.click('#tab-shots');
  await page.waitForSelector('#pane-shots:not([hidden]) tr.shot-row');
  const seqCell = page.locator('tr.shot-row').nth(3).locator('td[data-key="sequence"]');
  await seqCell.click();
  await seqCell.click();
  await page.waitForSelector('select.cell-input');
  const opts = await page.$$eval('select.cell-input option', (o) => o.map((x) => x.textContent));
  assert.ok(opts.includes('Rooftop escape') && opts.includes('SQ010 — Harbour at dawn') && opts.at(-1).includes('New sequence'), opts.join('|'));
  await page.selectOption('select.cell-input', 'Rooftop escape');
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row')[3].querySelector('td[data-key="sequence"] > span')?.textContent === 'Rooftop escape');
  ok('sequence created in References is selectable in the Seq dropdown');

  await seqCell.click();
  await seqCell.click();
  await page.waitForSelector('select.cell-input');
  await page.selectOption('select.cell-input', '__new_sequence__');
  await page.waitForSelector('.modal input');
  await page.fill('.modal input', 'SQ040');
  await page.click('.modal button:has-text("Create")');
  await page.waitForFunction(() => document.querySelectorAll('tr.shot-row')[3].querySelector('td[data-key="sequence"] > span')?.textContent === 'SQ040');
  await page.click('#tab-references');
  await page.waitForSelector('section.seq[data-seq="SQ040"]');
  assert.ok(await page.locator('section.seq[data-seq="Rooftop escape"]').count(), 'unused sequence stays');
  ok('new sequence can be created from the shot tracker and appears in References');

  // ---- timeline ----
  await page.click('#tab-timeline');
  await page.waitForSelector('.tl-row[data-key="seq:SQ010"]');
  const demoDb = () => page.evaluate(() => JSON.parse(localStorage.getItem('pt-demo-db-v1')));
  const keys = await page.$$eval('.tl-row', (els) => els.map((e) => e.dataset.key));
  assert.equal(keys[0], 'project');
  assert.ok(keys.includes('seq:SQ010') && keys.includes('seq:SQ020') && keys.includes('seq:Rooftop escape'), keys.join('|'));
  assert.ok(await page.locator('.tl-row[data-key="project"] .tl-ms.deadline:has-text("Picture lock")').count());
  assert.ok(await page.locator('.tl-dline').count(), 'project deadline drawn across all rows');
  assert.ok(await page.locator('.tl-chip:has-text("Picture lock")').count(), 'upcoming chip');
  ok('timeline lists project, sequences, milestones and deadlines');

  await page.locator('.tl-row[data-key="seq:SQ010"] .caret').click();
  await page.waitForSelector('.tl-row.tl-shot');
  const shotKeys = await page.$$eval('.tl-row.tl-shot .tl-shot-name', (els) => els.map((e) => e.textContent));
  assert.deepEqual(shotKeys, ['SQ010_0010', 'SQ010_0020', 'SQ010_0030']);
  ok('sequence expands into its shots');

  async function dragBy(locator, dx, where = 'center') {
    const b = await locator.boundingBox();
    const y = b.y + b.height / 2;
    const x0 = where === 'right' ? b.x + b.width - 2 : where === 'left' ? b.x + 2 : b.x + b.width / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + dx / 2, y, { steps: 3 });
    await page.mouse.move(x0 + dx, y, { steps: 3 });
    await page.mouse.up();
  }
  const dw = 14; // week zoom
  const seqBefore = (await demoDb()).sequences.find((q) => q.code === 'SQ010');
  await dragBy(page.locator('.tl-row[data-key="seq:SQ010"] .tl-bar'), 3 * dw);
  await page.waitForFunction((prev) => {
    const q = JSON.parse(localStorage.getItem('pt-demo-db-v1')).sequences.find((x) => x.code === 'SQ010');
    return q.start_date !== prev;
  }, seqBefore.start_date);
  const seqAfter = (await demoDb()).sequences.find((q) => q.code === 'SQ010');
  const plus = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
  assert.equal(seqAfter.start_date, plus(seqBefore.start_date, 3));
  assert.equal(seqAfter.end_date, plus(seqBefore.end_date, 3));
  ok('drag a sequence bar moves both dates');

  const shot1 = (await demoDb()).shots.find((s) => s.shot_name === 'SQ010_0010');
  await dragBy(page.locator('.tl-row.tl-shot').first().locator('.tl-bar'), 2 * dw, 'right');
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem('pt-demo-db-v1')).shots.find((s) => s.id === id).end_date !== null
    && JSON.parse(localStorage.getItem('pt-demo-db-v1')).shots.find((s) => s.id === id).updated_at, shot1.id);
  await page.waitForTimeout(200);
  const shot1b = (await demoDb()).shots.find((s) => s.id === shot1.id);
  assert.equal(shot1b.end_date, plus(shot1.end_date, 2));
  assert.equal(shot1b.start_date, shot1.start_date);
  ok('drag the end of a shot bar changes only its end date');

  const emptyTrack = page.locator('.tl-row.tl-shot').nth(2).locator('.tl-track');
  const tb = await emptyTrack.boundingBox();
  const todayX = (await page.locator('.tl-today').boundingBox()).x;
  await page.mouse.move(todayX + 1, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(todayX + 1 + 4 * dw, tb.y + tb.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('pt-demo-db-v1')).shots.find((s) => s.shot_name === 'SQ010_0030').start_date);
  const planned = (await demoDb()).shots.find((s) => s.shot_name === 'SQ010_0030');
  const todayIso = await page.evaluate(() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); });
  assert.equal(planned.start_date, todayIso);
  assert.equal(planned.end_date, plus(todayIso, 4));
  ok('drag across an empty shot row plans its dates');

  await page.locator('.tl-row[data-key="project"] .tl-track').dblclick({ position: { x: 300, y: 17 } });
  await page.click('.ctx-menu button:has-text("Add deadline here")');
  await page.fill('.modal input[aria-label="Title"]', 'Final sound mix');
  await page.click('.modal button:has-text("Add")');
  await page.waitForSelector('.tl-row[data-key="project"] .tl-ms.deadline:has-text("Final sound mix")');
  ok('double-click a row to add a deadline');

  await page.click('.tl-toolbar button:has-text("Milestone")');
  await page.fill('.modal input[aria-label="Title"]', 'Hair & makeup test');
  const shot2 = (await demoDb()).shots.find((s) => s.shot_name === 'SQ010_0020');
  await page.selectOption('.modal select[aria-label="Belongs to"]', `shot:${shot2.id}`);
  await page.click('.modal button:has-text("Add")');
  const shot2Row = page.locator('.tl-row.tl-shot', { has: page.locator('.tl-shot-name', { hasText: 'SQ010_0020' }) });
  await shot2Row.locator('.tl-ms.milestone:has-text("Hair & makeup test")').waitFor();
  ok('milestone can belong to a single shot');

  await page.locator('.tl-ms:has-text("Final sound mix")').click();
  await page.check('.modal input[type=checkbox]');
  await page.click('.modal button:has-text("Save")');
  await page.waitForSelector('.tl-ms.done:has-text("Final sound mix")');
  await page.uncheck('.tl-toolbar input[type=checkbox]');
  await page.waitForFunction(() => !document.querySelector('.tl-ms.done'));
  await page.check('.tl-toolbar input[type=checkbox]');
  ok('mark a deadline as met; hide completed');

  await page.click('.seg-btn:has-text("Days")');
  await page.waitForSelector('.tl-tick b');
  await page.click('.seg-btn:has-text("Months")');
  await page.click('.seg-btn:has-text("Weeks")');
  ok('zoom days / weeks / months');

  await page.locator('.tl-shot-name', { hasText: 'SQ010_0030' }).click();
  await page.waitForSelector('#pane-shots:not([hidden]) td.sel');
  assert.equal(await page.locator('tr.sel-row td[data-key="shot_name"]').textContent(), 'SQ010_0030');
  ok('shot name on the timeline opens it in the shot tracker');

  await page.click('#pane-shots .shot-toolbar button:has-text("More")');
  await page.click('.ctx-menu button:has-text("Show / hide columns")');
  await page.waitForSelector('.col-list');
  assert.ok(await page.locator('.col-list label:has-text("Start")').count() && await page.locator('.col-list label:has-text("End")').count());
  await page.keyboard.press('Escape');
  ok('shot tracker offers Start / End columns');

  // ---- tasks: call summary -> AI task list -> tasks -> milestones ----
  await page.click('#tab-dailies');
  await page.click('#pane-dailies button:has-text("New daily summary")');
  await page.waitForFunction(() => document.activeElement?.classList.contains('title-input'));
  await page.fill('.title-input', 'Production meeting');
  await page.click('.editor-surface .ProseMirror');
  await page.keyboard.type('Mihai books the fog machine by 2026-10-02 for the SQ010 VFX turnover.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Rafael: roto SQ010_0020 for the Final grade deadline.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Weather held all day.');
  await page.click('#pane-dailies button:has-text("Convert to task list")');
  await page.waitForSelector('.review-modal table.review tbody tr');
  const reviewRows = await page.$$eval('.review-modal tbody tr', (trs) => trs.map((tr) => ({
    person: tr.querySelector('select[aria-label="Person"]').value,
    body: tr.querySelector('input[aria-label="Task"]').value,
    due: tr.querySelector('input[aria-label="Due date"]').value,
    ms: tr.querySelector('input[aria-label="Milestone"]').value,
    shot: tr.querySelector('select[aria-label="Shot"]').selectedOptions[0].textContent,
  })));
  assert.deepEqual(reviewRows.map((r) => [r.person, r.due, r.ms, r.shot]), [
    ['Mihai', '2026-10-02', 'SQ010 VFX turnover', '—'],
    ['Rafael', '', 'Final grade', 'SQ010_0020'],
  ]);
  assert.match(await page.textContent('.review-modal'), /demo pattern matcher/);
  ok('“Convert to task list” proposes action items with person, due date, milestone and shot for review');

  await page.fill('.review-modal tbody tr:nth-child(2) input[aria-label="Task"]', 'Roto Mara on SQ010_0020');
  await page.click('.review-modal button:has-text("Create 2 tasks")');
  await page.waitForSelector('#pane-tasks:not([hidden]) .task');
  const col = (name) => page.locator(`.tasks-board .board-col[data-person="${name}"]`);
  const mihaiTask = col('Mihai').locator('.task', { hasText: 'fog machine' });
  assert.match(await mihaiTask.textContent(), /2 Oct/);
  assert.equal(await mihaiTask.locator('.tchip.ms.deadline').textContent(), '⚑ SQ010 VFX turnover');
  assert.equal(await mihaiTask.locator('.tchip.src').count(), 1);
  const rafTask = col('Rafael').locator('.task', { hasText: 'Roto Mara' });
  assert.equal(await rafTask.locator('.tchip.ms.pending').textContent(), '◇ Final grade');
  assert.equal(await rafTask.locator('.tchip.shot').textContent(), 'SQ010_0020');
  ok('tasks land in the per-person lists, linked to the existing milestone, the shot and the call');

  // running it again on the same call flags duplicates
  await page.click('#tab-dailies');
  await page.click('#pane-dailies button:has-text("Convert to task list")');
  await page.waitForSelector('.review-modal tr.dup');
  assert.equal(await page.locator('.review-modal tr.dup').count(), 2);
  assert.ok(await page.locator('.review-modal button:has-text("Create 0 tasks")').isDisabled());
  await page.click('.review-modal button:has-text("Cancel")');
  ok('re-running on the same call marks already created tasks');

  await page.click('#tab-tasks');
  await page.click('button:has-text("Convert to milestones")');
  await page.waitForSelector('.review-modal .conflict-note');
  const groupRows = page.locator('.review-modal tbody tr');
  assert.equal(await groupRows.count(), 2);
  const conflictRow = page.locator('.review-modal tr.conflict');
  assert.match(await conflictRow.textContent(), /SQ010 VFX turnover/);
  await page.click('.review-modal button:has-text("Apply")');
  assert.match(await page.textContent('.review-modal .form-msg'), /Choose what to do for “SQ010 VFX turnover”/);
  await conflictRow.locator('select').selectOption('update');
  await page.click('.review-modal button:has-text("Apply")');
  assert.match(await page.textContent('.review-modal .form-msg'), /needs a date/);
  await page.locator('.review-modal tr:not(.conflict) input[type=date]').fill('2026-10-20');
  await page.click('.review-modal button:has-text("Apply")');
  await page.waitForSelector('.toast:has-text("1 created, 1 overridden, 0 left alone")');
  let db = await page.evaluate(() => JSON.parse(localStorage.getItem('pt-demo-db-v1')));
  const vfx = db.milestones.find((m) => m.title === 'SQ010 VFX turnover');
  const grade = db.milestones.find((m) => m.title === 'Final grade');
  const rotoShot = db.shots.find((s) => s.shot_name === 'SQ010_0020');
  assert.equal(vfx.date, '2026-10-02', 'override takes the task due date');
  assert.deepEqual([grade.date, grade.kind, grade.shot_id], ['2026-10-20', 'deadline', rotoShot.id]);
  assert.equal(db.todos.find((t) => t.body === 'Roto Mara on SQ010_0020').milestone_id, grade.id);
  assert.equal(await rafTask.locator('.tchip.ms.deadline').textContent(), '⚑ Final grade');
  ok('“Convert to milestones” asks about existing ones, overrides or creates, and links the tasks');

  await page.click('button:has-text("Convert to milestones")');
  await page.waitForSelector('.review-modal .conflict-note');
  assert.equal(await page.locator('.review-modal tr.conflict').count(), 2, 'both are now already listed');
  await page.click('.review-modal button:has-text("Do nothing for all")');
  await page.click('.review-modal button:has-text("Apply")');
  await page.waitForSelector('.toast:has-text("0 created, 0 overridden, 2 left alone")');
  db = await page.evaluate(() => JSON.parse(localStorage.getItem('pt-demo-db-v1')));
  assert.equal(db.milestones.filter((m) => m.title === 'Final grade').length, 1);
  ok('already listed milestones: “do nothing” leaves the timeline unchanged');

  await page.click('#tab-timeline');
  await page.waitForSelector('.tl-ms:has-text("Final grade")');
  assert.match(await page.textContent('.tl-ms:has-text("Final grade")'), /0\/1 tasks/);
  await page.locator('.tl-ms:has-text("Final grade")').click();
  assert.match(await page.textContent('.modal .ms-tasks'), /Rafael: Roto Mara/);
  await page.keyboard.press('Escape');
  ok('timeline milestones show their linked tasks');

  await page.click('#tab-tasks');
  await mihaiTask.locator('.tchip.src').click();
  await page.waitForFunction(() => document.querySelector('#pane-dailies:not([hidden]) .title-input')?.value === 'Production meeting');
  ok('a task links back to the call it came from');

  await page.click('#tab-tasks');
  await col('Sascha').locator('.todo-add').fill('Send call sheet');
  await col('Sascha').locator('.todo-add').press('Enter');
  const sendTask = col('Sascha').locator('.task', { hasText: 'Send call sheet' });
  await sendTask.locator('input[type=checkbox]').click();
  await page.waitForFunction(() => !document.querySelector('.tasks-board .board-col[data-person="Sascha"]').textContent.includes('Send call sheet'));
  ok('add a task by hand and complete it');

  // security: stored markup must not run script
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('pt-demo-db-v1'));
    db.shots[0].description = '<img src=x onerror="window.__xss=1"><p>evil</p><script>window.__xss=2</script>';
    db.dailies[0].content = '<img src=x onerror="window.__xss=3"><p>x</p>';
    localStorage.setItem('pt-demo-db-v1', JSON.stringify(db));
  });
  await page.goto(`${URL_}#shots`);
  await page.reload();
  await page.waitForSelector('tr.shot-row');
  await page.fill('.search', 'evil');
  await page.click('#tab-dailies');
  await page.fill('.sidebar .search', 'x');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  ok('stored HTML is sanitized (no script execution)');

  // CSP present
  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  assert.match(csp, /script-src 'self'(;|$)/);
  ok('content security policy set');

  // mobile width: no horizontal page scroll
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await page.waitForSelector('.day-item');
  const over = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.grid-scroll, .tb'))
    .map((e) => `${e.tagName}.${e.className}`));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow: ${over.slice(0, 5).join(', ')}`);
  ok('phone width without page overflow');

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  assert.deepEqual(real, [], `console errors: ${real.join(' | ')}`);
  ok('no console errors');
  console.log(`ui: ${passed} checks passed`);
} catch (e) {
  await page.screenshot({ path: 'test-results/ui-failure.png', fullPage: false }).catch(() => {});
  console.error(e, errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
