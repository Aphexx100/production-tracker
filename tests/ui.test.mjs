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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer-stage', { state: 'detached' });
  ok('picture opens in the viewer');

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
