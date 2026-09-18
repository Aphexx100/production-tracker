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

  // security: stored markup must not run script
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('pt-demo-db-v1'));
    db.shots[0].description = '<img src=x onerror="window.__xss=1"><p>evil</p><script>window.__xss=2</script>';
    db.dailies[0].content = '<img src=x onerror="window.__xss=3"><p>x</p>';
    localStorage.setItem('pt-demo-db-v1', JSON.stringify(db));
  });
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
