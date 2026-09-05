'use strict';
// op-r2-ux：第二輪 UX 改版驗收（TDD，先於實作撰寫）。契約 R2-1 ～ R2-8。
// 用法：OP_PORT=4302 node op-r2-ux.js（預設 4302；受測頁由 python -m http.server 於 tvd 目錄提供）
process.env.OP_PORT = process.env.OP_PORT || '4302';
const path = require('path');
const C = require('./op-common');

// R2-2：以 stub 取代 navigator.vibrate 與 AudioContext（不可依賴真裝置）；頁面自身的 __OP.feedbackLog 才是斷言對象
const FEEDBACK_STUB = `
window.__vib = []; window.__ac = 0;
Object.defineProperty(navigator, 'vibrate', { configurable: true, writable: true, value: function (p) { window.__vib.push(p); return true; } });
(function () {
  function node() { return { type: 'sine', frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(n) { return n; }, disconnect() {}, start() {}, stop() {}, onended: null }; }
  function FakeAC() { window.__ac++; this.currentTime = 0; this.state = 'running'; this.destination = node(); this.sampleRate = 44100; }
  FakeAC.prototype.createOscillator = node; FakeAC.prototype.createGain = node; FakeAC.prototype.createBuffer = function () { return { getChannelData() { return new Float32Array(1); } }; };
  FakeAC.prototype.createBufferSource = node;
  FakeAC.prototype.resume = FakeAC.prototype.close = FakeAC.prototype.suspend = function () { return Promise.resolve(); };
  window.AudioContext = FakeAC; window.webkitAudioContext = FakeAC;
})();
`;

const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// 使用者可見文字：所有文字節點（排除 script／style／noscript）＋ placeholder／aria-label 屬性
const VISIBLE_TEXT_FN = () => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let n; while ((n = w.nextNode())) out.push(n.nodeValue);
  document.querySelectorAll('[placeholder],[aria-label],[title]').forEach(el => out.push(el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || ''));
  return out.join('\n');
};
const captionInfo = () => {
  const c = document.getElementById('caption'), s = document.getElementById('caption-say'), h = document.getElementById('caption-heard');
  return { has: !!c, role: c && c.getAttribute('role'), live: c && c.getAttribute('aria-live'), sayIn: !!(s && c && c.contains(s)), heardIn: !!(h && c && c.contains(h)), say: s ? s.textContent : null, heard: h ? h.textContent : null, heardChildren: h ? h.querySelectorAll('*').length : -1, visible: !!(c && c.getClientRects().length) };
};

(async () => {
  const browser = await C.launch();
  try {
    const ALL = ['R2-1a', 'R2-1b', 'R2-1c', 'R2-1d', 'R2-2a', 'R2-2b', 'R2-2c', 'R2-2d', 'R2-2e', 'R2-3a', 'R2-3b', 'R2-3c', 'R2-3d', 'R2-4a', 'R2-4b', 'R2-4c', 'R2-4d', 'R2-4e', 'R2-5a', 'R2-5b', 'R2-6a', 'R2-6b', 'R2-6c', 'R2-7a', 'R2-7b', 'R2-8a', 'R2-8b', 'R2-8c', 'R2-8d'];
    if (!(await C.guardOP(browser, ALL))) return;

    // ================= A. 390×844 全流程走訪：R2-1(非空)、R2-2、R2-6、R2-7、R2-8(錯誤／按鈕／TapThrough) =================
    {
      const { page, errors } = await C.newPage(browser, { init: FEEDBACK_STUB + C.RECOGNITION_STUB });
      await page.goto(C.DEMO_URL);
      await C.sleep(300);
      const emptyCaption = [], visited = [], smallBtns = [], badPrimary = [], tapThrough = [];
      const PRIMARY_STATES = ['CONNECTED', 'LANGUAGE', 'REVIEW', 'PAYMENT_METHOD', 'PRINTING', 'COMPLETED'];
      await C.walkAll(page, async s => {
        visited.push(s);
        const r = await page.evaluate(([st, primaryStates]) => {
          const cap = document.getElementById('caption-say');
          const say = cap ? cap.textContent.trim() : null;
          const smalls = [...document.querySelectorAll('button')].filter(b => b.getClientRects().length && !b.closest('dialog:not([open])')).map(b => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.id).trim().slice(0, 16), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(b => b.w > 0 && (b.h < 44 || b.w < 44));
          let primary = null;
          if (primaryStates.includes(st)) {
            const p = document.querySelector('#main .primary, #action-bar .primary, button.primary');
            const inBar = !!(p && p.closest('#action-bar'));
            const bb = p ? p.getBoundingClientRect() : null;
            primary = { found: !!p, inBar, bottom: bb ? Math.round(bb.bottom) : null, h: bb ? Math.round(bb.height) : null, ih: window.innerHeight, text: p ? p.textContent.trim().slice(0, 16) : '' };
          }
          const vis = (function () { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); let n; while ((n = w.nextNode())) out.push(n.nodeValue); return out.join('\n'); })();
          return { say, smalls, primary, tapThrough: /TapThrough/i.test(vis) };
        }, [s, PRIMARY_STATES]);
        if (!r.say) emptyCaption.push(s + (r.say === null ? '(無 #caption-say)' : '(空)'));
        if (r.smalls.length) smallBtns.push(`${s}:${JSON.stringify(r.smalls)}`);
        if (r.primary && !(r.primary.found && r.primary.inBar && r.primary.bottom <= r.primary.ih && r.primary.h >= 52)) badPrimary.push(`${s}:${JSON.stringify(r.primary)}`);
        if (r.tapThrough) tapThrough.push(s);
      });
      const endState = await C.state(page);

      // ---- R2-1 字幕列（結構、非空） ----
      const cap = await page.evaluate(captionInfo);
      C.check('R2-1a', '常駐 #caption[role=status][aria-live=polite]，內含 #caption-say 與 #caption-heard', cap.has && cap.role === 'status' && cap.live === 'polite' && cap.sayIn && cap.heardIn, JSON.stringify({ has: cap.has, role: cap.role, live: cap.live, sayIn: cap.sayIn, heardIn: cap.heardIn, visible: cap.visible }));
      C.check('R2-1b', '任何步驟切換後 #caption-say 非空（含 AUTH／VERIFYING／ERROR）', emptyCaption.length === 0, emptyCaption.length ? '空白於：' + emptyCaption.join(',') : `走訪 ${visited.length} 個狀態皆非空`);

      // ---- R2-2 雙重反饋 ----
      const fb = await page.evaluate(() => ({ isArr: Array.isArray(window.__OP && window.__OP.feedbackLog), log: (window.__OP && window.__OP.feedbackLog) || [], vib: window.__vib.length, ac: window.__ac }));
      const log = fb.isArr ? fb.log : [];
      const shape = log.every(e => e && ['vibrate', 'tone'].includes(e.type) && typeof e.state === 'string');
      C.check('R2-2a', '__OP.feedbackLog 為陣列，元素形如 {type:vibrate|tone, detail, state}', fb.isArr && log.length > 0 && shape, `isArray=${fb.isArr} 筆數=${log.length} 形狀正確=${shape} stub.vibrate呼叫=${fb.vib} stub.AudioContext建立=${fb.ac}`);
      const stepStates = [...new Set(visited)].filter(s => s !== 'CONNECTED');
      const noVib = stepStates.filter(s => !log.some(e => e.type === 'vibrate' && e.state === s));
      C.check('R2-2b', '進入每個新步驟至少一次 vibrate（以 feedbackLog.state 對應）', fb.isArr && stepStates.length >= 10 && noVib.length === 0, noVib.length ? '缺 vibrate：' + noVib.join(',') : `檢查 ${stepStates.length} 個步驟皆有 vibrate`);
      const has = (t, s) => log.some(e => e.type === t && e.state === s);
      C.check('R2-2c', '進入 COMPLETED 有 tone（成功音）與 vibrate', has('tone', 'COMPLETED') && has('vibrate', 'COMPLETED'), `tone=${has('tone', 'COMPLETED')} vibrate=${has('vibrate', 'COMPLETED')}`);
      C.check('R2-2d', '進入 PRINTING（列印完成）有 tone 與 vibrate', has('tone', 'PRINTING') && has('vibrate', 'PRINTING'), `tone=${has('tone', 'PRINTING')} vibrate=${has('vibrate', 'PRINTING')}`);
      C.check('R2-2e', '進入 ERROR 有 tone（低音）', visited.includes('ERROR') && has('tone', 'ERROR'), `visited ERROR=${visited.includes('ERROR')} tone=${has('tone', 'ERROR')} detail=${JSON.stringify((log.find(e => e.type === 'tone' && e.state === 'ERROR') || {}).detail)}`);

      // ---- R2-6 完成頁 ----
      const done = await page.evaluate(() => {
        const h = document.querySelector('.done-hero');
        const t = h ? h.textContent : (document.getElementById('main') || {}).textContent || '';
        const btn = [...document.querySelectorAll('button')].find(b => /再辦一件/.test(b.textContent) && b.getClientRects().length);
        return { state: window.__OP.state, hero: !!h, text: t.replace(/\s+/g, ' ').slice(0, 200), again: !!btn };
      });
      C.check('R2-6a', 'COMPLETED 存在 .done-hero，文字含「文件已印出」與取件位置（取出口／出口）', done.state === 'COMPLETED' && done.hero && /文件已印出/.test(done.text) && /取出口|出口/.test(done.text), `state=${done.state} hero=${done.hero} text=${done.text.slice(0, 120)}`);
      C.check('R2-6b', 'COMPLETED 存在文字含「再辦一件」的可見按鈕', done.again, `again=${done.again}`);
      if (done.again) {
        await page.locator('button', { hasText: '再辦一件' }).first().click();
        const back = await C.waitFor(page, `['LANGUAGE','CONNECTED'].includes(window.__OP.state)`, 3000);
        C.check('R2-6c', '點「再辦一件」後回到 LANGUAGE 或 CONNECTED', back.ok, `state=${await C.state(page)}`);
      } else C.check('R2-6c', '點「再辦一件」後回到 LANGUAGE 或 CONNECTED', false, '無「再辦一件」按鈕，略過');

      // ---- R2-7 主按鈕拇指區 ----
      C.check('R2-7a', '390×844：主要 .primary 位於 #action-bar 內', !badPrimary.some(x => /"inBar":false|"found":false/.test(x)), badPrimary.length ? badPrimary.join(' ; ').slice(0, 380) : `狀態 ${PRIMARY_STATES.join('/')} 皆在 #action-bar`);
      C.check('R2-7b', '390×844：主要 .primary 底邊 ≤ innerHeight 且高度 ≥ 52', badPrimary.length === 0, badPrimary.length ? badPrimary.join(' ; ').slice(0, 380) : '各狀態主按鈕皆在首屏內且 ≥52px');

      // ---- R2-8 品質（此頁） ----
      C.check('R2-8a', '全流程無 pageerror／console.error（favicon 404 除外）', errors.length === 0, errors.length ? errors.slice(0, 5).join(' ; ') : `走訪 ${visited.length} 狀態無錯誤，終態=${endState}`);
      C.check('R2-8c', '所有可見 button 尺寸 ≥ 44px（含 #dev-panel summary 不計）', smallBtns.length === 0, smallBtns.length ? smallBtns.join(' ; ').slice(0, 380) : '各狀態可見按鈕皆 ≥44×44');
      C.check('R2-8d', '使用者可見文字不含「TapThrough」', tapThrough.length === 0, tapThrough.length ? '出現於：' + tapThrough.join(',') : '全部狀態未出現');
      await page.context().close();
    }

    // ================= B. R2-1 字幕內容：speakLog 一致、我聽到 =================
    {
      const { page } = await C.newPage(browser, { init: C.RECOGNITION_STUB });
      await page.goto(C.DEMO_URL);
      await C.sleep(200);
      // 點「開始操作」按鈕（使用者手勢）→ autoEnableSpeech → speakLog 開始累積
      const startBtn = page.locator('#main button[data-event=START]');
      if (await startBtn.count()) await startBtn.first().click();
      await C.waitState(page, 'LANGUAGE');
      await C.sleep(500); // Speech.speak 延遲 150ms 才 push speakLog
      const r1 = await page.evaluate(() => ({ enabled: window.__OP.speechEnabled, log: window.__OP.speakLog.slice(-1)[0] || null, say: (document.getElementById('caption-say') || {}).textContent || null }));
      C.check('R2-1c', '語音開啟時 #caption-say 與 __OP.speakLog 末筆一致（LANGUAGE）', r1.enabled && r1.log !== null && r1.say !== null && norm(r1.say) === norm(r1.log), `speechEnabled=${r1.enabled} speakLog末筆=${norm(r1.log).slice(0, 60)} caption=${norm(r1.say).slice(0, 60)}`);

      await C.goTo(page, 'SERVICE'); await C.sleep(200);
      const transcript = '我要在學證明<b>x</b>';
      await page.evaluate(t => { window.__transcript = t; }, transcript);
      const vs = await page.locator('#voice-start').count();
      if (vs) await page.click('#voice-start');
      await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 5000);
      await C.sleep(200);
      const heard = await page.evaluate(captionInfo);
      const ok = heard.heard !== null && /^我聽到：/.test(norm(heard.heard)) && heard.heard.includes(transcript) && heard.heardChildren === 0;
      C.check('R2-1d', '辨識後 #caption-heard 為「我聽到：<逐字稿>」純文字（<b> 不成為元素）', vs > 0 && ok, `voice-start=${vs} heard=${JSON.stringify(heard.heard && heard.heard.slice(0, 80))} children=${heard.heardChildren}`);
      await page.context().close();
    }

    // ================= C. R2-3 手機外框、R2-4 開發者面板、R2-5 開場 =================
    {
      const frameInfo = () => {
        const f = document.querySelector('.phone-frame');
        const vis = !!(f && f.getClientRects().length && getComputedStyle(f).visibility !== 'hidden');
        return { exists: !!f, visible: vis, wrapsMain: !!(f && f.querySelector('#main')), statusBar: !!(f && f.querySelector('.status-bar')), html: document.documentElement.className, w: window.innerWidth };
      };
      // stage=1 @390
      let ctx = await C.newPage(browser);
      await ctx.page.goto(C.DEMO_URL + '&stage=1'); await C.sleep(200);
      const f1 = await ctx.page.evaluate(frameInfo);
      C.check('R2-3a', 'stage=1（390px）：可見 .phone-frame 包住 #main 且含 .status-bar', f1.visible && f1.wrapsMain && f1.statusBar, JSON.stringify(f1));
      C.check('R2-3b', 'stage=1 時 html 仍有 class large', /\blarge\b/.test(f1.html), `html.class="${f1.html}"`);
      await ctx.context.close();
      // 寬 1200 無 stage
      ctx = await C.newPage(browser, { context: { viewport: { width: 1200, height: 900 } } });
      await ctx.page.goto(C.DEMO_URL); await C.sleep(200);
      const f2 = await ctx.page.evaluate(frameInfo);
      C.check('R2-3c', '視窗 1200px 無 stage：可見 .phone-frame 包住 #main 且含 .status-bar', f2.visible && f2.wrapsMain && f2.statusBar, JSON.stringify(f2));
      await ctx.context.close();
      // 390 無 stage：R2-3d、R2-4、R2-5
      ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.goto(C.DEMO_URL); await C.sleep(200);
      const f3 = await page.evaluate(frameInfo);
      C.check('R2-3d', '視窗 390px 無 stage：.phone-frame 不存在或不可見', !f3.visible, JSON.stringify(f3));

      const dev = await page.evaluate(() => {
        const d = document.getElementById('dev-panel');
        const demoPanel = document.getElementById('demo-panel'), prog = document.querySelector('.machine-progress');
        const hits = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
        let n; while ((n = w.nextNode())) if (/Demo controls/.test(n.nodeValue)) { const range = document.createRange(); range.selectNodeContents(n); const rects = [...range.getClientRects()]; hits.push(rects.length ? rects.map(r => `top=${Math.round(r.top)}`).join('/') : 'unrendered'); }
        const firstScreenVisible = hits.some(h => h !== 'unrendered' && h.split('/').some(t => { const v = Number(t.replace('top=', '')); return v >= 0 && v < window.innerHeight; }));
        return { isDetails: !!(d && d.tagName === 'DETAILS'), open: d ? d.open : null, demoIn: !!(d && demoPanel && d.contains(demoPanel)), progIn: !!(d && prog && d.contains(prog)), hits, firstScreenVisible, scrollY: window.scrollY, versionInputs: document.querySelectorAll('[name=version]').length };
      });
      const vis = await page.evaluate(VISIBLE_TEXT_FN);
      C.check('R2-4a', '#dev-panel 為 <details>，內含 #demo-panel 與 .machine-progress', dev.isDetails && dev.demoIn && dev.progIn, JSON.stringify({ isDetails: dev.isDetails, demoIn: dev.demoIn, progIn: dev.progIn }));
      C.check('R2-4b', '#dev-panel 預設收合（open=false）', dev.isDetails && dev.open === false, `open=${dev.open}`);
      C.check('R2-4c', '首屏（不捲動）看不到「Demo controls」字樣', !dev.firstScreenVisible, `scrollY=${dev.scrollY} 文字節點=${JSON.stringify(dev.hits)}`);
      C.check('R2-4d', '「實測值輸入」與 name=version 的 A/B 切換不存在', !/實測值輸入/.test(vis) && dev.versionInputs === 0, `實測值輸入=${/實測值輸入/.test(vis)} version inputs=${dev.versionInputs}`);
      const daiIdx = vis.indexOf('待填');
      C.check('R2-4e', '全頁使用者可見文字（含設定對話框、placeholder）不含「待填」', daiIdx < 0, daiIdx < 0 ? '未出現' : '出現於：' + norm(vis.slice(Math.max(0, daiIdx - 30), daiIdx + 30)));

      const open = await page.evaluate(() => {
        const hs = [...document.querySelectorAll('#main h1, #main h2')].map(h => h.textContent.trim());
        return { state: window.__OP.state, hs, tap: document.querySelectorAll('.tap-anim').length };
      });
      const joined = open.hs.join(' ');
      C.check('R2-5a', 'CONNECTED 頁 h1／h2 含「NFC 已感應」與「校園文件自動服務機」', open.state === 'CONNECTED' && /NFC 已感應/.test(joined) && /校園文件自動服務機/.test(joined), `state=${open.state} headings=${JSON.stringify(open.hs)}`);
      C.check('R2-5b', 'CONNECTED 頁存在 .tap-anim 元素', open.tap > 0, `.tap-anim 數=${open.tap}`);
      await ctx.context.close();
    }

    // ================= D. R2-8b 320px 不橫向捲動（全流程） =================
    {
      const { page } = await C.newPage(browser, { context: { viewport: { width: 320, height: 640 } } });
      await page.goto(C.DEMO_URL);
      const overflow = [];
      await C.walkAll(page, async s => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        if (r.sw > r.iw) overflow.push(`${s}:${r.sw}>${r.iw}`);
      });
      C.check('R2-8b', '320px 視窗 documentElement.scrollWidth ≤ innerWidth（全流程）', overflow.length === 0, overflow.length ? overflow.join(',') : '所有狀態皆無橫向溢出');
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-r2-ux.results.json'));
  }
})();
