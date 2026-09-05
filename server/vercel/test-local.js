'use strict';
/**
 * 離線單元測試：不需要 API key、不連網。
 * 把 fetch 換成假函式，驗證 CORS 判斷、方法判斷、白名單驗證、逾時處理、限流。
 * 執行：node test-local.js
 */

const assert = require('node:assert/strict');
const intent = require('./api/intent.js');
const { createHandler, createRateLimiter, sanitizeIntent, normalizeInput, parseAllowedOrigins, isOriginAllowed, buildSystemPrompt } = intent;

const ORIGIN = 'https://a96020183.github.io';

/* ---------- 假的 req / res ---------- */
function makeReq({ method = 'POST', origin = ORIGIN, body, url = '/api/intent', ip = '1.2.3.4', query } = {}) {
  const headers = { 'x-forwarded-for': ip };
  if (origin !== null) headers.origin = origin;
  return { method, headers, body, url, query };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (s) => { res.body = s || ''; res.ended = true; };
  res.json = () => (res.body ? JSON.parse(res.body) : null);
  return res;
}

/** 假 fetch：回傳指定的 chat.completions JSON 內容 */
function fakeFetchReturning(intentObj, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(intentObj) } }] })
    };
  };
  fn.calls = calls;
  return fn;
}

/** 假 fetch：永遠不回應，直到 signal 被 abort 才丟 AbortError（模擬逾時） */
function fakeFetchHanging() {
  return (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  });
}

const ENV = { OPENAI_API_KEY: 'sk-test-placeholder-not-a-real-key', OPENAI_MODEL: 'gpt-4o-mini' };
const CTX_SERVICE = { transcript: '我要英文在學證明兩份', state: 'SERVICE', services: [{ id: 'enrollment', name: '在學證明' }, { id: 'enrollment-en', name: '英文在學證明' }], maxCopies: 5, semesters: [] };

/* ---------- 測試框架（極簡） ---------- */
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  console.log('intent.js 離線測試');

  /* ---- CORS ---- */
  await test('CORS：預設白名單只含 github.io', () => {
    assert.deepEqual(parseAllowedOrigins({}), [ORIGIN]);
    assert.equal(isOriginAllowed(ORIGIN, parseAllowedOrigins({})), true);
    assert.equal(isOriginAllowed('https://evil.example', parseAllowedOrigins({})), false);
    assert.equal(isOriginAllowed('https://a96020183.github.io.evil.example', parseAllowedOrigins({})), false);
    assert.equal(isOriginAllowed(undefined, parseAllowedOrigins({})), false);
  });
  await test('CORS：ALLOWED_ORIGINS 環境變數可覆寫（逗號分隔、去尾斜線）', () => {
    const allowed = parseAllowedOrigins({ ALLOWED_ORIGINS: 'http://localhost:8080/, https://foo.example' });
    assert.deepEqual(allowed, ['http://localhost:8080', 'https://foo.example']);
    assert.equal(isOriginAllowed('http://localhost:8080', allowed), true);
    assert.equal(isOriginAllowed(ORIGIN, allowed), false);
  });
  await test('CORS：OPTIONS 白名單 Origin 回 204 + CORS 標頭', async () => {
    const h = createHandler({ env: ENV, fetch: fakeFetchReturning({}) });
    const res = makeRes();
    await h(makeReq({ method: 'OPTIONS' }), res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.match(res.headers['access-control-allow-methods'], /POST/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
  await test('CORS：OPTIONS 非白名單 Origin 回 403、不帶 CORS 標頭', async () => {
    const h = createHandler({ env: ENV, fetch: fakeFetchReturning({}) });
    const res = makeRes();
    await h(makeReq({ method: 'OPTIONS', origin: 'https://evil.example' }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
  await test('CORS：POST 非白名單 Origin 回 403，且不呼叫上游', async () => {
    const f = fakeFetchReturning({ service: 'enrollment' });
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ origin: 'https://evil.example', body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(f.calls.length, 0);
  });
  await test('CORS：POST 無 Origin 標頭（curl 直打）回 403', async () => {
    const f = fakeFetchReturning({});
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ origin: null, body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(f.calls.length, 0);
  });

  /* ---- 方法 ---- */
  await test('方法：PUT / DELETE / PATCH 回 405 並帶 Allow', async () => {
    const h = createHandler({ env: ENV, fetch: fakeFetchReturning({}) });
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      const res = makeRes();
      await h(makeReq({ method: m, body: CTX_SERVICE }), res);
      assert.equal(res.statusCode, 405, m);
      assert.match(res.headers.allow, /POST/);
    }
  });
  await test('方法：GET 沒有 health 參數回 405', async () => {
    const h = createHandler({ env: ENV, fetch: fakeFetchReturning({}) });
    const res = makeRes();
    await h(makeReq({ method: 'GET', url: '/api/intent' }), res);
    assert.equal(res.statusCode, 405);
  });
  await test('健康檢查：GET ?health=1 回 {ok:true, model}，不呼叫上游，不需 Origin', async () => {
    const f = fakeFetchReturning({});
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ method: 'GET', origin: null, url: '/api/intent?health=1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, model: 'gpt-4o-mini', configured: true });
    assert.equal(f.calls.length, 0);
    assert.equal(res.headers['cache-control'], 'no-store');
    // Vercel 風格的 req.query 也要能用
    const res2 = makeRes();
    await h(makeReq({ method: 'GET', origin: null, query: { health: '1' } }), res2);
    assert.equal(res2.statusCode, 200);
  });
  await test('健康檢查：未設 key 時 configured=false，仍回 200', async () => {
    const h = createHandler({ env: {}, fetch: fakeFetchReturning({}) });
    const res = makeRes();
    await h(makeReq({ method: 'GET', origin: null, url: '/api/intent?health=1' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().configured, false);
  });

  /* ---- 輸入驗證 ---- */
  await test('輸入：缺 transcript / 非法 state / 非物件 body 回 400', async () => {
    const h = createHandler({ env: ENV, fetch: fakeFetchReturning({}) });
    for (const [body, err] of [
      [{ state: 'SERVICE' }, 'transcript_required'],
      [{ transcript: 'hi', state: 'PAYMENT' }, 'invalid_state'],
      ['not json', 'invalid_body'],
      [undefined, 'invalid_body'],
      [[1, 2], 'invalid_body']
    ]) {
      const res = makeRes();
      await h(makeReq({ body }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.json().error, err);
    }
  });
  await test('輸入：transcript 超過 200 字截斷後才送上游', async () => {
    const f = fakeFetchReturning({});
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ body: { ...CTX_SERVICE, transcript: '長'.repeat(500) } }), res);
    assert.equal(res.statusCode, 200);
    const sent = JSON.parse(f.calls[0].opts.body);
    assert.equal(sent.messages[1].content.length, 200);
  });
  await test('輸入：body 為 JSON 字串也能解析', async () => {
    const f = fakeFetchReturning({ service: 'enrollment' });
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ body: JSON.stringify(CTX_SERVICE) }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().service, 'enrollment');
  });
  await test('輸入：未設 OPENAI_API_KEY 回 500 server_not_configured', async () => {
    const f = fakeFetchReturning({});
    const h = createHandler({ env: {}, fetch: f, log: () => {} });
    const res = makeRes();
    await h(makeReq({ body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, 'server_not_configured');
    assert.equal(f.calls.length, 0);
  });

  /* ---- 上游請求內容 ---- */
  await test('上游：呼叫 {BASE_URL}/chat/completions，temperature 0、max_tokens 80、json_object、帶 Bearer', async () => {
    const f = fakeFetchReturning({});
    const h = createHandler({ env: { ...ENV, OPENAI_BASE_URL: 'https://compat.example/v1/' }, fetch: f });
    await h(makeReq({ body: CTX_SERVICE }), makeRes());
    const [{ url, opts }] = f.calls;
    assert.equal(url, 'https://compat.example/v1/chat/completions');
    assert.equal(opts.headers.Authorization, `Bearer ${ENV.OPENAI_API_KEY}`);
    const sent = JSON.parse(opts.body);
    assert.equal(sent.model, 'gpt-4o-mini');
    assert.equal(sent.temperature, 0);
    assert.equal(sent.max_tokens, 80);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(sent.messages[0].role, 'system');
  });
  await test('上游：system prompt 列出 service id、份數上限、學年期與 CONFIRM/BACK', () => {
    const p1 = buildSystemPrompt(normalizeInput(CTX_SERVICE).ctx);
    assert.match(p1, /enrollment-en/);
    assert.match(p1, /1 到 5/);
    const p2 = buildSystemPrompt(normalizeInput({ transcript: '好', state: 'REVIEW' }).ctx);
    assert.match(p2, /CONFIRM/); assert.match(p2, /BACK/);
    const p3 = buildSystemPrompt(normalizeInput({ transcript: 'x', state: 'SEMESTER', semesters: ['114 學年度第 2 學期'] }).ctx);
    assert.match(p3, /114 學年度第 2 學期/);
  });

  /* ---- 白名單驗證（sanitizeIntent） ---- */
  await test('白名單：service 不在清單 → null；在清單 → 保留', () => {
    const ctx = normalizeInput(CTX_SERVICE).ctx;
    assert.equal(sanitizeIntent({ service: 'transcript' }, ctx).service, null);
    assert.equal(sanitizeIntent({ service: 'enrollment-en' }, ctx).service, 'enrollment-en');
  });
  await test('白名單：copies 必須為 1..maxCopies 整數（0、6、2.5、負數、字串亂碼 → null；"3" 字串接受）', () => {
    const ctx = normalizeInput({ transcript: 'x', state: 'COPIES', maxCopies: 5 }).ctx;
    for (const bad of [0, 6, 2.5, -1, 'abc', null, true, [3], {}]) assert.equal(sanitizeIntent({ copies: bad }, ctx).copies, null, String(bad));
    assert.equal(sanitizeIntent({ copies: 3 }, ctx).copies, 3);
    assert.equal(sanitizeIntent({ copies: '3' }, ctx).copies, 3);
    assert.equal(sanitizeIntent({ copies: 5 }, ctx).copies, 5);
  });
  await test('白名單：action 只能 CONFIRM/BACK（大小寫正規化），其他 → null', () => {
    const ctx = normalizeInput({ transcript: 'x', state: 'REVIEW' }).ctx;
    assert.equal(sanitizeIntent({ action: 'CONFIRM' }, ctx).action, 'CONFIRM');
    assert.equal(sanitizeIntent({ action: 'back' }, ctx).action, 'BACK');
    assert.equal(sanitizeIntent({ action: 'PAY' }, ctx).action, null);
    assert.equal(sanitizeIntent({ action: 'RESET' }, ctx).action, null);
  });
  await test('白名單：semester 必須在清單內', () => {
    const ctx = normalizeInput({ transcript: 'x', state: 'SEMESTER', semesters: ['114 學年度第 2 學期', '114 學年度第 1 學期'] }).ctx;
    assert.equal(sanitizeIntent({ semester: '114 學年度第 2 學期' }, ctx).semester, '114 學年度第 2 學期');
    assert.equal(sanitizeIntent({ semester: '113 學年度第 1 學期' }, ctx).semester, null);
  });
  await test('白名單：依 state 過濾欄位（REVIEW 步驟不得帶 service/copies/semester）', () => {
    const ctx = normalizeInput({ transcript: 'x', state: 'REVIEW', services: [{ id: 'enrollment' }], semesters: ['114 學年度第 2 學期'] }).ctx;
    const out = sanitizeIntent({ service: 'enrollment', copies: 2, action: 'CONFIRM', semester: '114 學年度第 2 學期' }, ctx);
    assert.deepEqual(out, { service: null, copies: null, action: 'CONFIRM', semester: null });
  });
  await test('白名單：模型輸出非物件（陣列、字串、null）→ 全 null', () => {
    const ctx = normalizeInput(CTX_SERVICE).ctx;
    for (const raw of [null, 'x', [1], 42]) assert.deepEqual(sanitizeIntent(raw, ctx), { service: null, copies: null, action: null, semester: null });
  });
  await test('端對端：模型回不合法欄位，回應全部清成 null，matched=false', async () => {
    const f = fakeFetchReturning({ service: 'hacked', copies: 99, action: 'DROP', semester: 'nope', extra: 'ignored' });
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { service: null, copies: null, action: null, semester: null, matched: false, state: 'SERVICE' });
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
  await test('端對端：合法結果照實回傳，matched=true', async () => {
    const f = fakeFetchReturning({ service: 'enrollment-en', copies: 2, action: null, semester: null });
    const h = createHandler({ env: ENV, fetch: f });
    const res = makeRes();
    await h(makeReq({ body: CTX_SERVICE }), res);
    assert.deepEqual(res.json(), { service: 'enrollment-en', copies: 2, action: null, semester: null, matched: true, state: 'SERVICE' });
  });

  /* ---- 逾時與上游錯誤 ---- */
  await test('逾時：上游無回應超過 timeout → 504 upstream_timeout（且 log 不含 key）', async () => {
    const logs = [];
    const h = createHandler({ env: ENV, fetch: fakeFetchHanging(), timeoutMs: 50, log: (m) => logs.push(m) });
    const res = makeRes();
    const t0 = Date.now();
    await h(makeReq({ body: CTX_SERVICE }), res);
    assert.ok(Date.now() - t0 < 2000, '應在 timeout 後很快返回');
    assert.equal(res.statusCode, 504);
    assert.equal(res.json().error, 'upstream_timeout');
    assert.ok(logs.length === 1 && !logs[0].includes(ENV.OPENAI_API_KEY));
  });
  await test('上游錯誤：HTTP 500 → 502 upstream_error；HTTP 429 → 502 upstream_rate_limited', async () => {
    const quiet = () => {};
    let res = makeRes();
    await createHandler({ env: ENV, fetch: fakeFetchReturning({}, { status: 500 }), log: quiet })(makeReq({ body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 502); assert.equal(res.json().error, 'upstream_error');
    res = makeRes();
    await createHandler({ env: ENV, fetch: fakeFetchReturning({}, { status: 429 }), log: quiet })(makeReq({ body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 502); assert.equal(res.json().error, 'upstream_rate_limited');
  });
  await test('上游錯誤：回傳非 JSON 內容 → 502 upstream_not_json；fetch 拋錯 → 502 upstream_unreachable', async () => {
    const quiet = () => {};
    const badContent = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json {' } }] }) });
    let res = makeRes();
    await createHandler({ env: ENV, fetch: badContent, log: quiet })(makeReq({ body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 502); assert.equal(res.json().error, 'upstream_not_json');
    const throwing = async () => { throw new Error('ECONNREFUSED'); };
    res = makeRes();
    await createHandler({ env: ENV, fetch: throwing, log: quiet })(makeReq({ body: CTX_SERVICE }), res);
    assert.equal(res.statusCode, 502); assert.equal(res.json().error, 'upstream_unreachable');
  });

  /* ---- 限流 ---- */
  await test('限流：token bucket 第 21 次拒絕，一分鐘後補滿', () => {
    let t = 0;
    const lim = createRateLimiter({ capacity: 20, windowMs: 60000, now: () => t });
    for (let i = 0; i < 20; i++) assert.equal(lim.take('ip-a'), true, `第 ${i + 1} 次`);
    assert.equal(lim.take('ip-a'), false);
    assert.equal(lim.take('ip-b'), true, '不同 IP 各自計數');
    t = 3000; // 3 秒補 1 個
    assert.equal(lim.take('ip-a'), true);
    assert.equal(lim.take('ip-a'), false);
    t = 60000 + 3000;
    for (let i = 0; i < 20; i++) assert.equal(lim.take('ip-a'), true);
    assert.equal(lim.take('ip-a'), false);
  });
  await test('限流：handler 第 21 次 POST 回 429 + Retry-After，且不呼叫上游；健康檢查不受限', async () => {
    let t = 0;
    const f = fakeFetchReturning({ service: 'enrollment' });
    const h = createHandler({ env: ENV, fetch: f, now: () => t });
    for (let i = 0; i < 20; i++) {
      const res = makeRes();
      await h(makeReq({ body: CTX_SERVICE, ip: '9.9.9.9' }), res);
      assert.equal(res.statusCode, 200, `第 ${i + 1} 次`);
    }
    const res = makeRes();
    await h(makeReq({ body: CTX_SERVICE, ip: '9.9.9.9' }), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, 'rate_limited');
    assert.equal(res.headers['retry-after'], '60');
    assert.equal(f.calls.length, 20);
    const other = makeRes();
    await h(makeReq({ body: CTX_SERVICE, ip: '8.8.8.8' }), other);
    assert.equal(other.statusCode, 200, '其他 IP 不受影響');
    const health = makeRes();
    await h(makeReq({ method: 'GET', origin: null, url: '/api/intent?health=1', ip: '9.9.9.9' }), health);
    assert.equal(health.statusCode, 200);
  });
  await test('限流：x-forwarded-for 取第一段為用戶端 IP', async () => {
    let t = 0;
    const h = createHandler({ env: ENV, fetch: fakeFetchReturning({}), now: () => t });
    for (let i = 0; i < 20; i++) await h(makeReq({ body: CTX_SERVICE, ip: '5.5.5.5, 10.0.0.1' }), makeRes());
    const res = makeRes();
    await h(makeReq({ body: CTX_SERVICE, ip: '5.5.5.5, 10.0.0.2' }), res);
    assert.equal(res.statusCode, 429);
  });

  /* ---- 摘要 ---- */
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n結果：${passed}/${results.length} 通過`);
  process.exit(passed === results.length ? 0 : 1);
})();
