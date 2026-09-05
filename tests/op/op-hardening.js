'use strict';
// op-hardening：對抗測試修補的回歸（P1 雙擊連跳、P2-1～P2-6 語音／隱私／設定持久化）。
// 用法：OP_PORT=4311 node op-hardening.js（受測頁由 python -m http.server 於 tvd 目錄提供）
const path = require('path');
const C = require('./op-common');

// 可控 SpeechRecognition stub：__recDelay 控制 onresult 延遲；__recResults 非 null 時直接當作 e.results 回傳
const HARD_REC_STUB = `
window.__transcript = ''; window.__recDelay = 30; window.__recResults = null; window.__recStarts = 0; window.__recAborts = 0;
function FakeRecognition() { this.lang = ''; this.interimResults = false; this.continuous = false; }
FakeRecognition.prototype.start = function () {
  var self = this; window.__recStarts++;
  setTimeout(function () {
    if (self.__aborted) return;
    var results = window.__recResults !== null ? window.__recResults : [[{ transcript: window.__transcript, confidence: 0.9 }]];
    self.onresult && self.onresult({ results: results, resultIndex: 0 });
    self.onend && self.onend();
  }, window.__recDelay);
};
FakeRecognition.prototype.abort = function () { this.__aborted = true; window.__recAborts++; };
FakeRecognition.prototype.stop = function () { this.__aborted = true; };
window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
`;
const NO_REC_STUB = `
try { delete window.SpeechRecognition; } catch (e) {}
try { delete window.webkitSpeechRecognition; } catch (e) {}
window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
`;

const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const text = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent : null; }, sel);
// 以滑鼠在同一座標連點兩次（gapMs 內），模擬黏底按鈕列的雙擊連跳
async function doubleTap(page, selector, gapMs) {
  const box = await page.locator(selector).first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await C.sleep(gapMs);
  await page.mouse.click(x, y);
  return { x: Math.round(x), y: Math.round(y) };
}

(async () => {
  const browser = await C.launch();
  try {
    const ALL = ['H1a', 'H1b', 'H1c', 'H1d', 'H2-1', 'H2-2a', 'H2-2b', 'H2-3a', 'H2-3b', 'H2-4', 'H2-5', 'H2-6'];
    if (!(await C.guardOP(browser, ALL))) return;

    // ================= P1 雙擊連跳 =================
    {
      const { page, errors } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'COPIES', { service: 'history' }); // history 無名次／學年期：COPIES 直達 REVIEW
      await C.sleep(400);
      const pos = await doubleTap(page, '#action-bar button.primary', 100);
      await C.sleep(300);
      const s1 = await C.state(page);
      C.check('H1a', '雙擊「確認份數」（150ms 內）→ 停在 REVIEW，不跳到 PAYMENT_METHOD', s1 === 'REVIEW', `state=${s1} 座標=${JSON.stringify(pos)}`);

      // 冷卻結束後單擊仍正常
      await C.sleep(400);
      const pos2 = await doubleTap(page, '#action-bar button.primary', 100);
      await C.sleep(300);
      const s2 = await C.state(page);
      C.check('H1b', '雙擊「確認申請」→ 停在 PAYMENT_METHOD，不跳到 PAYMENT_WAITING', s2 === 'PAYMENT_METHOD', `state=${s2} 座標=${JSON.stringify(pos2)}`);

      await C.sleep(400);
      await page.locator('#action-bar button.primary').first().click();
      const s3 = await C.waitState(page, 'PAYMENT_WAITING', 2000);
      C.check('H1c', '冷卻結束後單擊主按鈕仍可前進（PAYMENT_METHOD→PAYMENT_WAITING）且無 pageerror', s3.ok && errors.length === 0, `state=${await C.state(page)} errors=${errors.join(' ; ') || '無'}`);
      await page.context().close();
    }
    {
      // 鍵盤：Enter 連按兩次不拋錯，且不會越過 REVIEW 以外的步驟（第一次送出後焦點移到標題，第二次 Enter 無作用）
      const { page, errors } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'COPIES', { service: 'history' });
      await C.sleep(300);
      await page.focus('#action-bar button.primary');
      await page.keyboard.press('Enter');
      await C.sleep(60);
      await page.keyboard.press('Enter');
      await C.sleep(300);
      const s = await C.state(page);
      const focused = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
      C.check('H1d', '鍵盤 Enter 連按兩次：無 pageerror，state 為 REVIEW 或 PAYMENT_METHOD（鍵盤不受指標冷卻影響）', errors.length === 0 && ['REVIEW', 'PAYMENT_METHOD'].includes(s), `state=${s} 焦點=${focused} errors=${errors.join(' ; ') || '無'}`);
      await page.context().close();
    }

    // ================= P2-1 聆聽中被 abort → UI 顯示已停止 =================
    {
      const { page, errors } = await C.newPage(browser, { init: HARD_REC_STUB });
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE');
      await C.sleep(200);
      await page.evaluate(() => { window.__recDelay = 10000; });
      await page.click('#voice-start');
      await C.sleep(100);
      const listening = await text(page, '#voice-status');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await C.sleep(150);
      const r = await page.evaluate(() => ({ status: (document.getElementById('voice-status') || {}).textContent, heard: (document.getElementById('caption-heard') || {}).textContent, result: (document.getElementById('voice-result') || {}).innerHTML, aborts: window.__recAborts }));
      C.check('H2-1', '聆聽中派發 visibilitychange（hidden）→ #voice-status／#caption-heard 顯示已取消，#voice-result 清空', /聆聽中|正在聆聽/.test(norm(listening)) && /已取消|已停止/.test(norm(r.status)) && /已取消|已停止/.test(norm(r.heard)) && norm(r.result) === '' && r.aborts >= 1 && errors.length === 0, JSON.stringify({ before: norm(listening).slice(0, 30), status: norm(r.status).slice(0, 40), heard: norm(r.heard).slice(0, 40), result: r.result, aborts: r.aborts }));
      await page.context().close();
    }

    // ================= P2-2 手動關閉語音跨重整保留 =================
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      await page.click('#main button[data-event=START]');
      await C.waitState(page, 'LANGUAGE');
      const on = await page.evaluate(() => window.__OP.speechEnabled);
      await page.click('#settings-open');
      await page.click('#tts');
      await page.click('#settings-close');
      const stored = await page.evaluate(() => { try { return localStorage.getItem('tapable.tts.off'); } catch (e) { return 'ERR'; } });
      await page.reload();
      await C.waitFor(page, `!!(window.__OP && window.__OP.state === 'CONNECTED')`, 5000);
      await page.click('#main button[data-event=START]');
      await C.waitState(page, 'LANGUAGE');
      await C.sleep(200);
      const after = await page.evaluate(() => ({ en: window.__OP.speechEnabled, tts: document.getElementById('tts').checked }));
      C.check('H2-2a', '取消 #tts 後寫入 tapable.tts.off，reload 再點「開始操作」→ speechEnabled 仍為 false', on === true && stored === '1' && after.en === false && after.tts === false, `啟用前=${on} stored=${stored} reload後=${JSON.stringify(after)}`);
      await page.click('#settings-open');
      await page.click('#tts');
      await page.click('#settings-close');
      const cleared = await page.evaluate(() => ({ key: localStorage.getItem('tapable.tts.off'), en: window.__OP.speechEnabled }));
      C.check('H2-2b', '使用者再勾回 #tts → 清除 tapable.tts.off 且 speechEnabled 為 true', cleared.key === null && cleared.en === true, JSON.stringify(cleared));
      await page.context().close();
    }

    // ================= P2-3 隱私模式按鈕標籤同步 =================
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'REVIEW');
      await C.sleep(300);
      const t0 = await text(page, '#review-private');
      await page.click('#settings-open');
      await page.click('#private');
      await page.click('#settings-close');
      await C.sleep(100);
      const t1 = await text(page, '#review-private');
      const pm1 = await page.evaluate(() => window.__OP.privateMode);
      C.check('H2-3a', '在 REVIEW 由設定切到隱私模式 → #review-private 文字變「關閉隱私模式」', norm(t0) === '啟用隱私模式' && pm1 === true && norm(t1) === '關閉隱私模式', `前=${norm(t0)} 後=${norm(t1)} privateMode=${pm1}`);
      await page.click('#private-exit');
      await C.sleep(100);
      const t2 = await text(page, '#review-private');
      const pm2 = await page.evaluate(() => window.__OP.privateMode);
      C.check('H2-3b', '按橫幅「關閉隱私模式」→ #review-private 文字回到「啟用隱私模式」', pm2 === false && norm(t2) === '啟用隱私模式', `後=${norm(t2)} privateMode=${pm2}`);
      await page.context().close();
    }

    // ================= P2-4 e.results 為空不拋錯 =================
    {
      const { page, errors } = await C.newPage(browser, { init: HARD_REC_STUB });
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'COPIES');
      await C.sleep(200);
      await page.evaluate(() => { window.__recResults = []; });
      await page.click('#voice-start');
      await C.sleep(400);
      const r = await page.evaluate(() => ({ status: (document.getElementById('voice-status') || {}).textContent, heard: (document.getElementById('caption-heard') || {}).textContent, state: window.__OP.state }));
      C.check('H2-4', 'stub 回傳 {results:[]} → 無 pageerror，#voice-status 顯示失敗文案，state 不變', errors.length === 0 && /沒有成功辨識/.test(norm(r.status)) && r.state === 'COPIES', JSON.stringify({ status: norm(r.status).slice(0, 40), heard: norm(r.heard).slice(0, 40), state: r.state, errors: errors.slice(0, 3) }));
      await page.context().close();
    }

    // ================= P2-5 無 SpeechRecognition API =================
    {
      const { page, errors } = await C.newPage(browser, { init: NO_REC_STUB });
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE');
      await C.sleep(200);
      const r = await page.evaluate(() => { const b = document.getElementById('voice-start'); return { has: !!b, disabled: b ? b.disabled : null, status: (document.getElementById('voice-status') || {}).textContent, api: !!(window.SpeechRecognition || window.webkitSpeechRecognition) }; });
      C.check('H2-5', '刪除 SpeechRecognition 後 #voice-start disabled 且 #voice-status 顯示無法使用網頁語音辨識', !r.api && r.has && r.disabled === true && /無法使用網頁語音辨識/.test(norm(r.status)) && errors.length === 0, JSON.stringify({ api: r.api, disabled: r.disabled, status: norm(r.status).slice(0, 40) }));
      await page.context().close();
    }

    // ================= P2-6 超長逐字稿截斷 =================
    {
      const { page, errors } = await C.newPage(browser, { init: HARD_REC_STUB });
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE');
      await C.sleep(200);
      await page.evaluate(() => { window.__transcript = '嗯'.repeat(6000); });
      await page.click('#voice-start');
      await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 5000);
      await C.sleep(100);
      const r = await page.evaluate(() => ({ heard: (document.getElementById('heard') || {}).textContent || '', cap: (document.getElementById('caption-heard') || {}).textContent || '' }));
      C.check('H2-6', '6000 字逐字稿 → #caption-heard 與 #heard 長度 ≤ 130 且含「…」', r.cap.length > 0 && r.cap.length <= 130 && r.heard.length <= 130 && /…/.test(r.cap) && errors.length === 0, `caption長度=${r.cap.length} heard長度=${r.heard.length} 開頭=${r.cap.slice(0, 12)}`);
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-hardening.results.json'));
  }
})();
