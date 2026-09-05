'use strict';
/**
 * /api/intent —— 語音文字 → 結構化意圖 的伺服器端代理（Vercel Node.js Serverless Function，CommonJS）。
 *
 * 目的：讓公開 demo（https://a96020183.github.io/tapable_sep/）不必在瀏覽器保存任何 API key，
 * 也能走真 LLM。key 只存在 Vercel 環境變數 OPENAI_API_KEY，瀏覽器只看得到這支代理的網址。
 *
 * 介面：
 *   OPTIONS /api/intent            CORS 預檢（只回應白名單 Origin）
 *   GET     /api/intent?health=1   健康檢查 → {ok:true, model}（不呼叫上游、不檢查 key 是否有效）
 *   POST    /api/intent            JSON {transcript, state, services:[{id,name}], maxCopies, semesters:[…]}
 *                                  → {service, copies, action, semester}（不合法或未提及的欄位一律 null）
 *   其他方法                        405
 *
 * 環境變數：
 *   OPENAI_API_KEY     必要。缺少時 POST 回 500 {error:'server_not_configured'}。
 *   OPENAI_MODEL       預設 gpt-4o-mini。
 *   OPENAI_BASE_URL    預設 https://api.openai.com/v1；可換成任何 OpenAI 相容供應商。
 *   ALLOWED_ORIGINS    逗號分隔的 Origin 白名單；預設只有 https://a96020183.github.io。
 *
 * 已知限制：
 *   - 限流是「每個 function 實例」的記憶體內 token bucket；Vercel 冷啟動／多實例會各自計數，
 *     重啟即歸零。這是 demo 等級的防濫用，不是精確配額；真正的花費上限請在 OpenAI 後台設定。
 *   - 不記錄 key、不記錄上游完整回應；只在錯誤時記錄 HTTP 狀態碼與錯誤類別。
 */

const DEFAULT_ALLOWED_ORIGINS = ['https://a96020183.github.io'];
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const UPSTREAM_TIMEOUT_MS = 6000;   // 上游逾時 6 秒
const MAX_TRANSCRIPT_CHARS = 200;   // transcript 超過即截斷
const RATE_LIMIT_CAPACITY = 20;     // 每 IP 每分鐘最多 20 次
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_LIST_ITEMS = 50;          // services / semesters 清單上限，避免把超長 prompt 丟給上游
const MAX_ITEM_CHARS = 80;          // 清單中每個字串的長度上限
const ALLOWED_STATES = ['SERVICE', 'COPIES', 'SEMESTER', 'REVIEW'];
const ALLOWED_ACTIONS = ['CONFIRM', 'BACK'];

/* ---------- 工具函式（純函式，方便離線測試） ---------- */

/** 解析 Origin 白名單：環境變數 ALLOWED_ORIGINS（逗號分隔）優先，否則用預設值。 */
function parseAllowedOrigins(env) {
  const raw = env && typeof env.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  const list = raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS.slice();
}

/** Origin 是否在白名單內（完全比對，忽略尾端斜線）。 */
function isOriginAllowed(origin, allowed) {
  if (typeof origin !== 'string' || !origin) return false;
  return allowed.includes(origin.replace(/\/+$/, ''));
}

/** 取得用戶端 IP：Vercel 會填 x-forwarded-for（第一段為真實用戶端）。 */
function clientIp(req) {
  const h = req.headers || {};
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  const real = h['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * 記憶體內 token bucket 限流器。
 * 每個 key（IP）一個桶，容量 capacity，每 windowMs 補滿一桶（線性補充）。
 * now() 可注入以便測試。
 */
function createRateLimiter({ capacity = RATE_LIMIT_CAPACITY, windowMs = RATE_LIMIT_WINDOW_MS, now = Date.now } = {}) {
  const buckets = new Map();
  const refillPerMs = capacity / windowMs;
  return {
    /** 嘗試消耗一個 token；成功回 true，超額回 false。 */
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, updated: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + (t - b.updated) * refillPerMs);
      b.updated = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      // 簡單清理：桶數過多時丟掉已補滿的桶，避免記憶體無限成長
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (v.tokens >= capacity - 1e-9) buckets.delete(k);
      }
      return true;
    },
    size() { return buckets.size; }
  };
}

/** 把使用者傳入的字串清單清成安全的字串陣列（去空、截長、限量）。 */
function cleanStringList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().slice(0, MAX_ITEM_CHARS))
    .slice(0, MAX_LIST_ITEMS);
}

/** 把 services 清成 [{id,name}]。 */
function cleanServices(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.id === 'string' && s.id.trim())
    .map((s) => ({
      id: s.id.trim().slice(0, MAX_ITEM_CHARS),
      name: typeof s.name === 'string' ? s.name.trim().slice(0, MAX_ITEM_CHARS) : s.id.trim().slice(0, MAX_ITEM_CHARS)
    }))
    .slice(0, MAX_LIST_ITEMS);
}

/**
 * 正規化請求內容。回 {ok:true, ctx} 或 {ok:false, error}。
 * ctx = {transcript, state, services, serviceIds, maxCopies, semesters}
 */
function normalizeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  let transcript = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  if (!transcript) return { ok: false, error: 'transcript_required' };
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS);

  const state = typeof body.state === 'string' ? body.state.trim().toUpperCase() : '';
  if (!ALLOWED_STATES.includes(state)) return { ok: false, error: 'invalid_state' };

  let maxCopies = Number(body.maxCopies);
  if (!Number.isInteger(maxCopies) || maxCopies < 1) maxCopies = 5;
  if (maxCopies > 99) maxCopies = 99;

  const services = cleanServices(body.services);
  const semesters = cleanStringList(body.semesters);
  return {
    ok: true,
    ctx: { transcript, state, services, serviceIds: services.map((s) => s.id), maxCopies, semesters }
  };
}

/** 組 system prompt：明確列出可選 id、份數上限、學年期與允許的動作。 */
function buildSystemPrompt(ctx) {
  const lines = [
    '你是校園文件自動服務機的語音意圖解析器。使用者說的是台灣正體中文，內容可能有語音辨識錯字。',
    '只輸出一個 JSON 物件，鍵固定為 service、copies、action、semester；無法判斷或此步驟不適用的鍵一律填 null。不要輸出任何其他文字。',
    `目前步驟：${ctx.state}。`
  ];
  if (ctx.state === 'SERVICE') {
    lines.push(`可選文件（只能回傳其中一個 id，其他一律 null）：${JSON.stringify(ctx.services)}。`);
    lines.push(`若使用者同時說了份數，copies 填 1 到 ${ctx.maxCopies} 的整數；未提到填 null。`);
  } else if (ctx.state === 'COPIES') {
    lines.push(`copies 填 1 到 ${ctx.maxCopies} 的整數（中文數字請換成阿拉伯數字，例如「三份」→ 3）；其他鍵 null。`);
  } else if (ctx.state === 'REVIEW') {
    lines.push('使用者同意送出、確認、好、可以 → action 填 "CONFIRM"；想取消、返回、修改、不對 → action 填 "BACK"；其他鍵 null。action 只能是 CONFIRM 或 BACK。');
  } else if (ctx.state === 'SEMESTER') {
    lines.push(`可選學年期（只能回傳其中一個完整字串）：${JSON.stringify(ctx.semesters)}；其他鍵 null。`);
  }
  lines.push('範例輸出：{"service":null,"copies":null,"action":null,"semester":null}');
  return lines.join('\n');
}

/**
 * 伺服器端白名單驗證：不信任模型輸出，逐欄位檢查；不合法一律 null。
 * 也依 state 過濾：例如 REVIEW 步驟不得帶 service。
 */
function sanitizeIntent(raw, ctx) {
  const out = { service: null, copies: null, action: null, semester: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  if (ctx.state === 'SERVICE' && typeof raw.service === 'string' && ctx.serviceIds.includes(raw.service)) {
    out.service = raw.service;
  }
  if (ctx.state === 'SERVICE' || ctx.state === 'COPIES') {
    const n = typeof raw.copies === 'string' && /^\d+$/.test(raw.copies) ? Number(raw.copies) : raw.copies;
    if (Number.isInteger(n) && n >= 1 && n <= ctx.maxCopies) out.copies = n;
  }
  if (ctx.state === 'REVIEW' && typeof raw.action === 'string') {
    const a = raw.action.trim().toUpperCase();
    if (ALLOWED_ACTIONS.includes(a)) out.action = a;
  }
  if (ctx.state === 'SEMESTER' && typeof raw.semester === 'string' && ctx.semesters.includes(raw.semester)) {
    out.semester = raw.semester;
  }
  return out;
}

/** 意圖是否有任何有效欄位（供回應附帶 matched 旗標）。 */
function hasAnyField(intent) {
  return Object.values(intent).some((v) => v !== null);
}

/** 呼叫上游 chat.completions；回 {ok:true, intentRaw} 或 {ok:false, status, error}。 */
async function callUpstream(ctx, { fetchImpl, env, timeoutMs }) {
  const apiKey = env.OPENAI_API_KEY;
  const model = (env.OPENAI_MODEL && env.OPENAI_MODEL.trim()) || DEFAULT_MODEL;
  const baseUrl = ((env.OPENAI_BASE_URL && env.OPENAI_BASE_URL.trim()) || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(ctx) },
          { role: 'user', content: ctx.transcript }
        ]
      })
    });
    if (!res.ok) {
      // 只記狀態碼，不記 body（可能含帳號資訊）
      return { ok: false, status: res.status, error: res.status === 429 ? 'upstream_rate_limited' : 'upstream_error' };
    }
    let data;
    try { data = await res.json(); } catch { return { ok: false, status: 502, error: 'upstream_bad_json' }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') return { ok: false, status: 502, error: 'upstream_no_content' };
    let parsed;
    try { parsed = JSON.parse(content); } catch { return { ok: false, status: 502, error: 'upstream_not_json' }; }
    return { ok: true, intentRaw: parsed };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, status: 504, error: 'upstream_timeout' };
    return { ok: false, status: 502, error: 'upstream_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- HTTP 層 ---------- */

function sendJson(res, status, obj, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

/** 取得 query 參數（Vercel 會給 req.query；本地／測試時從 req.url 解析）。 */
function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    return Object.fromEntries(u.searchParams.entries());
  } catch { return {}; }
}

/** 取得 JSON body（Vercel 已解析 req.body；若為字串則自行 parse）。 */
function getBody(req) {
  const b = req.body;
  if (b === undefined || b === null) return null;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return null; }
  }
  return b;
}

/**
 * 建立 handler。所有外部依賴（fetch、env、時鐘、限流器）皆可注入，供離線測試。
 */
function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs || UPSTREAM_TIMEOUT_MS;
  const limiter = deps.limiter || createRateLimiter({ now: deps.now });
  const log = deps.log || ((msg) => console.warn(msg));

  return async function handler(req, res) {
    const allowed = parseAllowedOrigins(env);
    const origin = req.headers && req.headers.origin;
    const originOk = isOriginAllowed(origin, allowed);
    const cors = originOk ? corsHeaders(origin) : {};
    const method = (req.method || 'GET').toUpperCase();

    // CORS 預檢：非白名單 Origin 回 403（不附 CORS 標頭，瀏覽器會擋）
    if (method === 'OPTIONS') {
      if (!originOk) return sendJson(res, 403, { error: 'origin_not_allowed' });
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      return res.end();
    }

    // 健康檢查：不呼叫上游；只回目前設定的模型名稱與 key 是否已設定
    if (method === 'GET') {
      const q = getQuery(req);
      if (q.health === '1' || q.health === 'true') {
        const model = (env.OPENAI_MODEL && env.OPENAI_MODEL.trim()) || DEFAULT_MODEL;
        return sendJson(res, 200, { ok: true, model, configured: Boolean(env.OPENAI_API_KEY) }, cors);
      }
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS', ...cors });
    }

    if (method !== 'POST') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS', ...cors });
    }

    // POST：Origin 必須在白名單（沒有 Origin 標頭的 curl 測試也擋掉，避免被當公用代理）
    if (!originOk) return sendJson(res, 403, { error: 'origin_not_allowed' });

    // 限流（每 IP 每分鐘 20 次；記憶體內、單實例）
    if (!limiter.take(clientIp(req))) {
      return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60', ...cors });
    }

    if (!env.OPENAI_API_KEY) {
      log('[intent] OPENAI_API_KEY 未設定');
      return sendJson(res, 500, { error: 'server_not_configured' }, cors);
    }

    const norm = normalizeInput(getBody(req));
    if (!norm.ok) return sendJson(res, 400, { error: norm.error }, cors);
    const ctx = norm.ctx;

    const up = await callUpstream(ctx, { fetchImpl, env, timeoutMs });
    if (!up.ok) {
      // 只記錯誤類別與上游狀態碼；不記 key、不記完整回應、不記 transcript
      log(`[intent] upstream ${up.error} status=${up.status}`);
      const httpStatus = up.error === 'upstream_timeout' ? 504 : 502;
      return sendJson(res, httpStatus, { error: up.error }, cors);
    }

    const intent = sanitizeIntent(up.intentRaw, ctx);
    return sendJson(res, 200, { ...intent, matched: hasAnyField(intent), state: ctx.state }, cors);
  };
}

// Vercel 進入點（預設用真實 fetch 與 process.env）
const handler = createHandler();
module.exports = handler;
// 供測試與重用
module.exports.createHandler = createHandler;
module.exports.createRateLimiter = createRateLimiter;
module.exports.parseAllowedOrigins = parseAllowedOrigins;
module.exports.isOriginAllowed = isOriginAllowed;
module.exports.normalizeInput = normalizeInput;
module.exports.sanitizeIntent = sanitizeIntent;
module.exports.buildSystemPrompt = buildSystemPrompt;
module.exports.constants = {
  DEFAULT_MODEL, DEFAULT_BASE_URL, UPSTREAM_TIMEOUT_MS, MAX_TRANSCRIPT_CHARS,
  RATE_LIMIT_CAPACITY, RATE_LIMIT_WINDOW_MS, ALLOWED_STATES, ALLOWED_ACTIONS
};
