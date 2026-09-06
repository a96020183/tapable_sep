'use strict';
// op-llm：預設雲端意圖解析（自架代理）路徑。以攔截路由取代真實網路，離線亦可重現。
// 契約：預設開啟 → 呼叫 /api/intent；失敗／逾時／格式不符 → 退回裝置端規則式；設定面板可關閉。
const path = require('path');
const C = require('./op-common');

const PROXY_GLOB = '**/api/intent**';

async function speakAndWait(page, transcript) {
  await page.evaluate(t => { window.__transcript = t; }, transcript);
  await page.click('#voice-start');
  const r = await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 8000);
  const info = await page.evaluate(() => ({
    confirm: !!document.getElementById('voice-confirm'),
    heard: (document.getElementById('heard') || {}).textContent || '',
    status: (document.getElementById('voice-status') || {}).textContent || ''
  }));
  return Object.assign({ appeared: r.ok }, info);
}

// cloud:true → 不注入「關閉雲端」的 initScript，走預設路徑
async function cloudPage(browser, handler) {
  const ctx = await C.newPage(browser, { init: C.RECOGNITION_STUB, cloud: true });
  const reqs = [];
  await ctx.page.route(PROXY_GLOB, async route => {
    // 頁面載入的健康檢查暖機是 GET，不算解析請求；契約只看 POST
    if (route.request().method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    reqs.push({ url: route.request().url(), post: route.request().postData() || '' });
    return handler(route, reqs.length);
  });
  ctx.reqs = reqs;
  return ctx;
}
// 瀏覧器對失敗請求本來就會寫一行 console error（Failed to load resource / net::ERR_）。
// 那是網路層的既有行為，不是頁面缺陷；此處只看頁面自己拋出的錯誤。
const pageErrors = errs => errs.filter(e => !/Failed to load resource|net::ERR_/.test(e));
const jsonBody = obj => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

(async () => {
  const browser = await C.launch();
  try {
    // ---------- L1 預設就會呼叫代理，且結果套用 ----------
    {
      const ctx = await cloudPage(browser, route => route.fulfill(jsonBody({ service: 'english', copies: 3, action: null, semester: null })));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      // 這句話裡沒有任何服務關鍵字，規則式必定認不出，因此命中只可能來自代理
      const r = await speakAndWait(page, '我要那個給國外學校看的文件');
      const usedProxy = ctx.reqs.length > 0;
      let bodyOk = false;
      try { const b = JSON.parse(ctx.reqs[0].post || '{}'); bodyOk = b.state === 'SERVICE' && Array.isArray(b.services) && b.services.length > 0 && typeof b.transcript === 'string'; } catch {}
      C.check('L1a', '預設路徑會 POST /api/intent，且帶 state 與可選服務清單', usedProxy && bodyOk, `請求數=${ctx.reqs.length} body=${(ctx.reqs[0] || {}).post || ''}`.slice(0, 200));
      C.check('L1b', '代理回傳的意圖顯示為「LLM 解析」並解析成英文成績單', /LLM 解析/.test(r.status) && /英文成績單/.test(r.heard), `status=${r.status.slice(0, 60)} heard=${r.heard.slice(0, 80)}`);
      if (r.confirm) await page.click('#voice-confirm');
      const moved = await C.waitFor(page, `['COPIES','REVIEW'].includes(window.__OP.state)`, 4000);
      const after = await page.evaluate(() => ({ state: window.__OP.state, text: document.getElementById('main').innerText, checked: (document.querySelector('[name=copies]:checked') || {}).value }));
      const copiesOk = after.state === 'REVIEW' ? /份數\s*3/.test(after.text.replace(/\n/g, ' ')) : after.checked === '3';
      C.check('L1c', '套用後前進且份數 3 生效', moved.ok && copiesOk, `state=${after.state} checked=${after.checked}`);
      C.check('L1d', '無 pageerror／console.error', pageErrors(ctx.errors).length === 0, pageErrors(ctx.errors).join(' | ').slice(0, 200));
      await page.context().close();
    }

    // ---------- L2 代理故障 → 退回規則式，流程不中斷 ----------
    {
      const ctx = await cloudPage(browser, route => route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_error"}' }));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      const r = await speakAndWait(page, '歷年成績表');
      C.check('L2a', '代理回 502 → 顯示「關鍵字比對」而非錯誤', /關鍵字比對/.test(r.status) && r.confirm, `status=${r.status.slice(0, 80)}`);
      if (r.confirm) await page.click('#voice-confirm');
      const toCopies = await C.waitState(page, 'COPIES', 4000);
      C.check('L2b', '退回規則式後流程照常前進 COPIES', toCopies.ok, `state=${await C.state(page)}`);
      C.check('L2c', '代理故障不產生未捕捉錯誤', pageErrors(ctx.errors).length === 0, pageErrors(ctx.errors).join(' | ').slice(0, 200));
      await page.context().close();
    }

    // ---------- L3 代理逾時／斷線 → 退回規則式 ----------
    {
      const ctx = await cloudPage(browser, route => route.abort('connectionfailed'));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      const r = await speakAndWait(page, '我要在學證明');
      C.check('L3a', '連線失敗（等同離線）→ 退回規則式並解析成功', /關鍵字比對/.test(r.status) && /在學證明/.test(r.heard), `status=${r.status.slice(0, 80)} heard=${r.heard.slice(0, 80)}`);
      C.check('L3b', '離線時無未捕捉錯誤', pageErrors(ctx.errors).length === 0, pageErrors(ctx.errors).join(' | ').slice(0, 200));
      await page.context().close();
    }

    // ---------- L4 代理回傳不合法內容 → 不得套用 ----------
    {
      const ctx = await cloudPage(browser, route => route.fulfill(jsonBody({ service: 'diploma', copies: 99, action: 'DROP_TABLE', semester: '<script>x</script>' })));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      const r = await speakAndWait(page, '我要那個給國外學校看的文件');
      const state = await C.state(page);
      C.check('L4a', '代理回未開放服務／越界份數 → 前端仍擋下，停在 SERVICE', state === 'SERVICE' && !r.confirm, `state=${state} confirm=${r.confirm} status=${r.status.slice(0, 60)}`);
      C.check('L4b', '不合法回傳不產生未捕捉錯誤', pageErrors(ctx.errors).length === 0, pageErrors(ctx.errors).join(' | ').slice(0, 200));
      await page.context().close();
    }

    // ---------- L5 設定面板可關閉；關閉後完全不連外 ----------
    {
      const ctx = await cloudPage(browser, route => route.fulfill(jsonBody({ service: 'english', copies: 1, action: null, semester: null })));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      const box = await page.locator('#llm-cloud').count();
      await page.evaluate(() => {
        const c = document.getElementById('llm-cloud');
        if (c && c.checked) { c.checked = false; c.onchange(); }
      });
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      const before = ctx.reqs.length;
      const r = await speakAndWait(page, '歷年成績表');
      C.check('L5a', '設定面板有「使用內建雲端意圖解析」開關', box > 0, `count=${box}`);
      C.check('L5b', '關閉後不再發出任何 /api/intent 請求', ctx.reqs.length === before, `關閉前=${before} 關閉後=${ctx.reqs.length}`);
      C.check('L5c', '關閉後仍能以裝置端規則式完成辨識', /關鍵字比對/.test(r.status) && r.confirm, `status=${r.status.slice(0, 80)}`);
      const persisted = await page.evaluate(() => { try { return localStorage.getItem('tapable.llm.cloud'); } catch { return 'ERR'; } });
      C.check('L5d', '關閉狀態寫入 localStorage（重開仍為關閉）', persisted === '0', `值=${persisted}`);
      await page.context().close();
    }

    // ---------- L7 解析期間不得對螢幕閱讀器靜默（對抗測試 P1-1）----------
    {
      let release;
      const gate = new Promise(r => { release = r; });
      const ctx = await cloudPage(browser, async route => { await gate; return route.fulfill(jsonBody({ service: 'english', copies: 1 })); });
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      await page.evaluate(() => { window.__transcript = '我要那個給國外學校看的文件'; });
      await page.click('#voice-start');
      // 停在「解析中」這個瞬間取樣：代理回應還沒放行
      await C.waitFor(page, `/正在解析/.test((document.getElementById('voice-status')||{}).textContent||'')`, 5000);
      const mid = await page.evaluate(() => ({
        announcer: (document.getElementById('announcer') || {}).textContent || '',
        caption: (document.getElementById('caption-heard') || {}).textContent || '',
        cancel: (document.getElementById('voice-cancel') || {}).textContent || '',
        startDisabled: !!(document.getElementById('voice-start') || {}).disabled
      }));
      C.check('L7a', '解析期間以 aria-live 播報「正在解析」，讀屏使用者不會遇到沉默', /正在解析/.test(mid.announcer), `announcer=${mid.announcer.slice(0, 60)}`);
      C.check('L7b', '解析期間字幕列不再宣稱「聆聽中」（實際上已停止聆聽）', !/聆聽中/.test(mid.caption) && /正在解析/.test(mid.caption), `caption=${mid.caption.slice(0, 60)}`);
      C.check('L7c', '解析期間按鈕改為「取消解析」，且語音鍵停用避免重複送出', /取消解析/.test(mid.cancel) && mid.startDisabled, `按鈕=${mid.cancel} 停用=${mid.startDisabled}`);
      release();
      await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 5000);
      const after = await page.evaluate(() => ({ disabled: !!(document.getElementById('voice-start') || {}).disabled }));
      C.check('L7d', '解析結束後語音鍵恢復可用', after.disabled === false, `停用=${after.disabled}`);
      await page.context().close();
    }

    // ---------- L8 逾時與「雲端沒回應」的文案分流 ----------
    {
      const ctx = await cloudPage(browser, async route => { await new Promise(r => setTimeout(r, 4000)); return route.fulfill(jsonBody({ service: 'english' })); });
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      await page.evaluate(() => { window.__transcript = '歷年成績表'; });
      const t0 = Date.now();
      await page.click('#voice-start');
      await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 8000);
      const elapsed = Date.now() - t0;
      const status = await page.evaluate(() => (document.getElementById('voice-status') || {}).textContent || '');
      C.check('L8a', '代理超過 2.5 秒未回應即放棄，不讓使用者空等（實測 < 3.5 秒收斂）', elapsed < 3500, `耗時=${elapsed}ms`);
      C.check('L8b', '逾時後仍以規則式完成辨識，流程不中斷', /關鍵字比對/.test(status), `status=${status.slice(0, 70)}`);
      await page.context().close();
    }
    {
      const ctx = await cloudPage(browser, route => route.abort('connectionfailed'));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      await page.evaluate(() => { window.__transcript = '我要那個給國外學校看的文件'; });
      await page.click('#voice-start');
      await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 8000);
      const status = await page.evaluate(() => (document.getElementById('voice-status') || {}).textContent || '');
      C.check('L8c', '雲端連不上且規則式也判不出時，明說是「雲端無法連線」而非「沒有找到對應選項」', /雲端解析暫時無法連線/.test(status), `status=${status.slice(0, 80)}`);
      await page.context().close();
    }

    // ---------- L6 身分輸入步驟永遠不送出語音 ----------
    {
      const ctx = await cloudPage(browser, route => route.fulfill(jsonBody({ service: 'english' })));
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'AUTH'); await C.sleep(150);
      const hasVoice = await page.locator('#main #voice-start').count();
      C.check('L6a', '身分輸入步驟不提供語音輸入入口，逐字稿無從送出', hasVoice === 0 && ctx.reqs.length === 0, `voice-start=${hasVoice} 請求數=${ctx.reqs.length}`);
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-llm.results.json'));
  }
})();
