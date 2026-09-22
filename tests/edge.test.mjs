// Tests the extract-tasks Edge Function under Node: real Anthropic SDK and
// schema helper, mocked Supabase and Claude responses (no network, no cost).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../supabase/functions/extract-tasks/index.ts', import.meta.url), 'utf8')
  .replace(/"npm:(@?[^@"]+(?:\/[^@"]+)?)@[^/"]+(\/[^"]*)?"/g, (_, pkg, sub = '') => `"${pkg}${sub}"`);
mkdirSync(new URL('./.tmp/', import.meta.url), { recursive: true });
const tmp = new URL('./.tmp/extract-tasks.ts', import.meta.url);
writeFileSync(tmp, src);
const fn = await import(tmp.href);

let passed = 0;
const ok = (name) => { passed++; console.log('  ok', name); };

// ---- pure helpers
assert.equal(fn.htmlToText('<h2>Notes</h2><ul><li><p>Mihai: book fog &amp; smoke</p></li></ul><p><img src="x" data-path="a">done</p>'),
  'Notes\n- Mihai: book fog & smoke\n[image] done');
const clean = fn.sanitize([
  { person: 'mihai', body: ' Book fog machine ', due_date: '2026-10-02', shot_name: 'sq010_0010', milestone_title: 'vfx turnover', source_quote: 'q' },
  { person: 'Bob', body: 'x', due_date: 'friday', shot_name: 'nope', milestone_title: '  New cut  ', source_quote: '' },
  { person: null, body: '   ', due_date: null, shot_name: null, milestone_title: null, source_quote: '' },
], ['Mihai', 'Sascha'], ['SQ010_0010'], [{ title: 'VFX turnover' }]);
assert.deepEqual(clean, [
  { person: 'Mihai', body: 'Book fog machine', due_date: '2026-10-02', shot_name: 'SQ010_0010', milestone_title: 'VFX turnover', source_quote: 'q' },
  { person: null, body: 'x', due_date: null, shot_name: null, milestone_title: 'New cut', source_quote: '' },
]);
ok('model output is checked against real team, shot and milestone names');

// ---- handler with mocks
const DAILY = '11111111-1111-1111-1111-111111111111';
function fakeSupabase({ approved = true, content = '<p>Mihai books the fog machine for Friday for VFX turnover.</p>' } = {}) {
  const tables = {
    dailies: { data: { id: DAILY, day: '2026-09-21', title: 'Harbour day 3', content } },
    team_members: { data: [{ name: 'Mihai' }, { name: 'Sascha' }] },
    shots: { data: [{ shot_name: 'SQ010_0010' }] },
    milestones: { data: [{ title: 'VFX turnover', date: '2026-10-06', kind: 'deadline' }] },
  };
  const chain = (t) => {
    const q = { select: () => q, eq: () => q, order: () => q, maybeSingle: () => Promise.resolve(tables[t]), then: (r, j) => Promise.resolve(tables[t]).then(r, j) };
    return q;
  };
  return { rpc: async () => ({ data: approved, error: null }), from: chain };
}
let lastRequest = null;
const fakeClaude = (result) => () => ({ messages: { parse: async (params) => { lastRequest = params; return result; } } });
const req = (body, auth = 'Bearer token') => new Request('https://x/functions/v1/extract-tasks', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const env = (extra = {}) => (n) => ({ ANTHROPIC_API_KEY: 'sk-test', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', ...extra })[n];
const good = {
  stop_reason: 'end_turn', model: 'claude-opus-5', usage: { input_tokens: 900, output_tokens: 120 },
  parsed_output: { tasks: [{ person: 'Mihai', body: 'Book the fog machine', due_date: '2026-09-25', shot_name: null, milestone_title: 'VFX turnover', source_quote: 'Mihai books the fog machine' }] },
};

let res = await fn.handle(req({ daily_id: DAILY }), { env: env(), supabase: () => fakeSupabase(), anthropic: fakeClaude(good) });
assert.equal(res.status, 200);
let body = await res.json();
assert.deepEqual(body.tasks.map((t) => [t.person, t.due_date, t.milestone_title]), [['Mihai', '2026-09-25', 'VFX turnover']]);
assert.equal(lastRequest.model, 'claude-opus-5');
assert.equal(lastRequest.output_config.format.type, 'json_schema');
assert.equal(lastRequest.output_config.format.schema.properties.tasks.items.additionalProperties, false);
const prompt = lastRequest.messages[0].content;
assert.match(prompt, /Call date: 2026-09-21/);
assert.match(prompt, /- Mihai\n- Sascha/);
assert.match(prompt, /VFX turnover \(deadline, 2026-10-06\)/);
assert.match(prompt, /<notes>\nMihai books the fog machine/);
ok('sends notes, team, shots and milestones to claude-opus-5 with a strict JSON schema');

res = await fn.handle(req({ daily_id: DAILY }), { env: env(), supabase: () => fakeSupabase({ approved: false }), anthropic: () => { throw new Error('must not call Claude'); } });
assert.equal(res.status, 403);
res = await fn.handle(req({ daily_id: DAILY }, ''), { env: env(), supabase: () => fakeSupabase(), anthropic: fakeClaude(good) });
assert.equal(res.status, 401);
res = await fn.handle(req({ daily_id: DAILY }), { env: env({ ANTHROPIC_API_KEY: undefined }), supabase: () => fakeSupabase(), anthropic: fakeClaude(good) });
assert.equal(res.status, 500);
assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
res = await fn.handle(req({ daily_id: 'nope' }), { env: env(), supabase: () => fakeSupabase(), anthropic: fakeClaude(good) });
assert.equal(res.status, 400);
ok('refuses unapproved users, missing login, missing secret, bad input — before calling Claude');

res = await fn.handle(req({ daily_id: DAILY }), { env: env(), supabase: () => fakeSupabase({ content: '<p>' + 'x'.repeat(200_001) + '</p>' }), anthropic: () => { throw new Error('no'); } });
assert.equal(res.status, 413);
res = await fn.handle(req({ daily_id: DAILY }), { env: env(), supabase: () => fakeSupabase(), anthropic: fakeClaude({ ...good, stop_reason: 'refusal', parsed_output: null }) });
assert.equal(res.status, 422);
res = await fn.handle(req({ daily_id: DAILY }), { env: env(), supabase: () => fakeSupabase(), anthropic: fakeClaude({ ...good, stop_reason: 'max_tokens' }) });
assert.equal(res.status, 422);
const { default: Anthropic } = await import('@anthropic-ai/sdk');
res = await fn.handle(req({ daily_id: DAILY }), {
  env: env(), supabase: () => fakeSupabase(),
  anthropic: () => ({ messages: { parse: async () => { throw new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'bad key', new Headers()); } } }),
});
assert.equal(res.status, 502);
assert.match((await res.json()).error, /API key was rejected/);
res = await fn.handle(new Request('https://x', { method: 'OPTIONS' }), { env: env(), supabase: fakeSupabase, anthropic: fakeClaude(good) });
assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
ok('too-long notes, refusal, truncation, bad API key and CORS preflight handled');

console.log(`edge: ${passed} checks passed`);
