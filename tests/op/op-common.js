'use strict';
// 操作段（index.html demo 模式）Playwright 共用工具。依賴 window.__OP 測試掛鉤契約。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PORT = Number(process.env.OP_PORT || 4303);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEMO_URL = `${ORIGIN}/?machine=campus-document-kiosk&demo=1`;

async function launch() {
  return chromium.launch({ headless: true, channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] });
}

// 每個測試用獨立 context；封鎖 service worker 以免舊快取干擾實作者的最新檔。
async function newPage(browser, opts = {}) {
  const context = await browser.newContext(Object.assign({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } }, opts.context || {}));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('crash', () => errors.push('crash: renderer 崩潰'));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location() || {}).url || '';
    if (/favicon\.ico/.test(url)) return; // 瀏覽器自動請求 favicon 的 404，非頁面缺陷
    errors.push('console.error: ' + m.text() + (url ? ' @' + url : ''));
  });
  // 預設以 stub 取代 speechSynthesis：headless Edge 實際合成語音會讓 renderer 崩潰，且 speakLog 由頁面自行 push、不受影響。
  if (!opts.realSpeech) await page.addInitScript(SPEECH_STUB);
  // 預設關閉雲端 LLM 解析：既有回歸只驗裝置端規則式路徑，不打外網、可離線重現。
  // 雲端路徑另由 tests/op/op-llm.js 以攔截路由測試（opts.cloud = true）。
  if (!opts.cloud) await page.addInitScript(`try{localStorage.setItem('tapable.llm.cloud','0')}catch(e){}`);
  if (opts.init) await page.addInitScript(opts.init);
  return { context, page, errors };
}

// 覆蓋 speechSynthesis 的 stub：可控 speaking、計數 cancel／speak。
var SPEECH_STUB = `
window.__cancels = 0; window.__speaks = [];
Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
  speaking: true, pending: false, paused: false, onvoiceschanged: null,
  cancel: function () { window.__cancels++; },
  getVoices: function () { return []; },
  speak: function (u) { window.__speaks.push(u && u.text); },
  pause: function () {}, resume: function () {}
}});
window.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance || function (t) { this.text = t; };
`;

// 覆蓋 SpeechRecognition 的 stub：start() 後以 window.__transcript 觸發 onresult。
const RECOGNITION_STUB = `
window.__transcript = '';
window.__recStarts = 0;
function FakeRecognition() { this.lang = ''; this.interimResults = false; this.continuous = false; }
FakeRecognition.prototype.start = function () {
  var self = this; window.__recStarts++;
  setTimeout(function () {
    if (self.__aborted) return;
    var t = window.__transcript;
    self.onresult && self.onresult({ results: [[{ transcript: t, confidence: 0.9 }]], resultIndex: 0 });
    self.onend && self.onend();
  }, 30);
};
FakeRecognition.prototype.abort = function () { this.__aborted = true; };
FakeRecognition.prototype.stop = function () { this.__aborted = true; };
window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(page, fn, timeoutMs = 5000, pollMs = 100) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(fn);
    if (last) return { ok: true, value: last, ms: Date.now() - t0 };
    await sleep(pollMs);
  }
  return { ok: false, value: last, ms: timeoutMs };
}

const hasOP = page => page.evaluate(() => !!(window.__OP && typeof window.__OP.dispatch === 'function'));
// __OP 未暴露時，把所有編號記為 FAIL 並回傳 false（呼叫端應直接結束）。
async function guardOP(browser, ids) {
  const { page, context } = await newPage(browser);
  await page.goto(DEMO_URL);
  const ok = await hasOP(page);
  await context.close();
  if (!ok) ids.forEach(id => check(id, '前置條件：demo=1 暴露 window.__OP', false, '目前建置未暴露 window.__OP（無 dispatch），本項無法執行'));
  return ok;
}
const state = page => page.evaluate(() => window.__OP && window.__OP.state);
const dispatch = (page, ev, val) => page.evaluate(([e, v]) => window.__OP.dispatch(e, v), [ev, val]);
const waitState = (page, s, ms = 6000) => waitFor(page, `window.__OP && window.__OP.state === ${JSON.stringify(s)}`, ms);

// 透過 __OP.dispatch 走到指定狀態（含 VERIFYING／PAYMENT_SUCCESS 的自動轉場）。
async function goTo(page, target, opts = {}) {
  const service = opts.service || 'rank', copies = opts.copies || 1;
  const steps = [
    ['CONNECTED', 'START', undefined, 'LANGUAGE'],
    ['LANGUAGE', 'CHOOSE_LANGUAGE', undefined, 'ROLE'],
    ['ROLE', 'CHOOSE_ROLE', 'student', 'AUTH'],
    ['AUTH', 'DEMO_AUTH', undefined, 'SERVICE'],
    ['SERVICE', 'CHOOSE_SERVICE', service, 'COPIES'],
    ['COPIES', 'CHOOSE_COPIES', copies, null],
    ['RANK', 'CHOOSE_RANK', '在校各學期系科所名次', 'SEMESTER'],
    ['SEMESTER', 'CHOOSE_SEMESTER', '114 學年度第 2 學期', 'REVIEW'],
    ['REVIEW', 'CONFIRM', undefined, 'PAYMENT_METHOD'],
    ['PAYMENT_METHOD', 'CASH', undefined, 'PAYMENT_WAITING'],
    ['PAYMENT_WAITING', 'SIM_PAID', undefined, 'PAYMENT_SUCCESS'], // 走 demo 模擬事件，讓 PaymentAdapter 狀態同步為 PAID
    ['PAYMENT_SUCCESS', null, null, 'PROCESSING'],
    ['PROCESSING', 'PRINT_READY', undefined, 'PRINTING'],
    ['PRINTING', 'COLLECT', undefined, 'COMPLETED']
  ];
  const order = steps.map(s => s[0]).concat('COMPLETED');
  for (let guard = 0; guard < 30; guard++) {
    const cur = await state(page);
    if (cur === target) return true;
    if (order.indexOf(cur) > order.indexOf(target) || order.indexOf(cur) < 0) return false;
    const step = steps.find(s => s[0] === cur);
    if (!step) return false;
    if (step[1]) await dispatch(page, step[1], step[2]);
    if (opts.onStep) await opts.onStep(cur);
    if (step[3]) await waitState(page, step[3]);
    else await waitFor(page, `window.__OP && window.__OP.state !== 'COPIES'`, 3000);
  }
  return (await state(page)) === target;
}

// 走完整流程（含 ERROR 分支），每個狀態呼叫 visit(state)。
async function walkAll(page, visit) {
  const seq = ['LANGUAGE', 'ROLE', 'AUTH', 'SERVICE', 'COPIES', 'RANK', 'SEMESTER', 'REVIEW', 'PAYMENT_METHOD', 'PAYMENT_WAITING', 'PAYMENT_SUCCESS', 'PROCESSING', 'PRINTING', 'COMPLETED'];
  await visit(await state(page));
  for (const s of seq) {
    await goTo(page, s);
    await sleep(350);
    await visit(await state(page));
    if (s === 'PAYMENT_WAITING') {
      await dispatch(page, 'FAIL', 'unavailable'); await sleep(350); await visit(await state(page));
      await dispatch(page, 'RESUME'); await waitState(page, 'PAYMENT_WAITING');
    }
  }
}

// 逐行輸出 PASS|FAIL | 編號 | 說明 | 證據
const results = [];
function check(id, desc, pass, detail) {
  const d = detail === undefined ? '' : String(detail).replace(/\s+/g, ' ').slice(0, 400);
  results.push({ id, desc, pass: !!pass, detail: d });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${desc} | ${d}`);
}
function summary(file) {
  const pass = results.filter(r => r.pass).length, fail = results.length - pass;
  console.log(`SUMMARY | pass=${pass} fail=${fail}`);
  if (file) fs.writeFileSync(file, JSON.stringify({ pass, fail, results }, null, 2));
  return { pass, fail };
}

// 關閉瀏覽器並輸出總結；關閉逾時 5 秒即強制結束，避免 renderer 崩潰後卡住。
async function finish(browser, file) {
  const r = summary(file);
  await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
  process.exit(r.fail ? 1 : 0);
}

module.exports = { finish, PORT, ORIGIN, DEMO_URL, launch, newPage, SPEECH_STUB, RECOGNITION_STUB, sleep, waitFor, hasOP, guardOP, state, dispatch, waitState, goTo, walkAll, check, summary, results };
