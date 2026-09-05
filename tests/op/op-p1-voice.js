'use strict';
// op-p1-voice：5 parseIntent 單元、6 語音流程（stub SpeechRecognition）、7 LLM 選用與退回
const path = require('path');
const C = require('./op-common');

const FAKE_KEY = 'sk-qa-fake-key-0000-NOT-REAL';

// 從頁面原始碼找出存放 LLM key 的 localStorage 鍵名（契約未指定，故由原始碼推得）。
async function detectKeyName(page) {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const re = /localStorage\.(?:getItem|setItem)\(\s*['"]([^'"]+)['"]/g;
  const names = new Set(); let m;
  while ((m = re.exec(html))) names.add(m[1]);
  const list = [...names];
  // 若為前綴串接（如 'x.llm.'+k），補上 'key'
  const cand = list.find(n => /key|token|llm|openai|api/i.test(n));
  const key = cand ? (/[._-]$/.test(cand) ? cand + 'key' : cand) : null;
  return { all: list, key };
}

// 依 #voice-start 流程：設定 transcript → 點擊 → 等 #voice-confirm 或 #voice-retry
async function speakAndWait(page, transcript) {
  await page.evaluate(t => { window.__transcript = t; }, transcript);
  await page.click('#voice-start');
  const r = await C.waitFor(page, `!!document.querySelector('#voice-confirm,#voice-retry')`, 5000);
  const info = await page.evaluate(() => {
    const heard = document.getElementById('heard');
    return {
      confirm: !!document.getElementById('voice-confirm'),
      heardText: heard ? heard.textContent : null,
      heardChildren: heard ? heard.querySelectorAll('*').length : -1,
      status: (document.getElementById('voice-status') || {}).textContent || ''
    };
  });
  return Object.assign({ appeared: r.ok }, info);
}

(async () => {
  const browser = await C.launch();
  try {
    if (!(await C.guardOP(browser, [5, 6, 7]))) return;
    // ---------- 5 parseIntent ----------
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      const has = await page.evaluate(() => !!(window.__OP && typeof window.__OP.parseIntent === 'function'));
      if (!has) C.check(5, '__OP.parseIntent 存在', false, '未暴露 parseIntent');
      else {
        const cases = [
          ['5a', '「我要在學證明」(SERVICE)→ service enrollment', '我要在學證明', 'SERVICE', r => r && r.service === 'enrollment'],
          ['5b', '「印英文在學證明兩份」(SERVICE)→ enrollment-en + copies 2', '印英文在學證明兩份', 'SERVICE', r => r && r.service === 'enrollment-en' && r.copies === 2],
          ['5c', '「歷年成績表」(SERVICE)→ history', '歷年成績表', 'SERVICE', r => r && r.service === 'history'],
          ['5d', '「成績名次證明」(SERVICE)→ rank', '成績名次證明', 'SERVICE', r => r && r.service === 'rank'],
          ['5e', 'COPIES「三份」→ copies 3', '三份', 'COPIES', r => r && r.copies === 3],
          ['5f', 'COPIES「2」→ copies 2', '2', 'COPIES', r => r && r.copies === 2],
          ['5g', 'REVIEW「確認」→ action CONFIRM', '確認', 'REVIEW', r => r && r.action === 'CONFIRM'],
          ['5h', 'REVIEW「取消」→ action BACK', '取消', 'REVIEW', r => r && r.action === 'BACK'],
          ['5i', 'SEMESTER「一一四學年第二學期」→ semester 含 114 與第 2', '一一四學年第二學期', 'SEMESTER', r => r && typeof r.semester === 'string' && /114/.test(r.semester) && /第\s?2/.test(r.semester)],
          ['5j', '不匹配「今天天氣很好」(SERVICE)→ null', '今天天氣很好', 'SERVICE', r => r === null],
          ['5k', '不匹配「今天天氣很好」(REVIEW)→ null', '今天天氣很好', 'REVIEW', r => r === null]
        ];
        for (const [id, desc, text, st, ok] of cases) {
          let r, err = null;
          try { r = await page.evaluate(([t, s]) => { const v = window.__OP.parseIntent(t, s); return v === undefined ? '__undefined__' : v; }, [text, st]); } catch (e) { err = e.message; }
          C.check(id, desc, !err && ok(r), err || JSON.stringify(r));
        }
      }
      await page.context().close();
    }

    // ---------- 6 語音流程 ----------
    {
      const { page } = await C.newPage(browser, { init: C.RECOGNITION_STUB });
      await page.goto(C.DEMO_URL);
      await C.goTo(page, 'SERVICE');
      await C.sleep(150);
      const vsService = await page.locator('#main #voice-start').count();
      // SERVICE：含 <b> 標籤字串，確認 #heard 為純文字
      const r1 = await speakAndWait(page, '我要在學證明<b>x</b>');
      const heardPlain = r1.heardText !== null && r1.heardText.includes('<b>') && r1.heardChildren === 0;
      C.check('6a', 'SERVICE 頁 #voice-start 存在；stub 結果後出現 #voice-confirm，#heard 為純文字（<b> 不成為元素）', vsService > 0 && r1.appeared && r1.confirm && heardPlain, `voice-start=${vsService} ${JSON.stringify(r1)}`);
      if (r1.confirm) await page.click('#voice-confirm');
      const toCopies = await C.waitState(page, 'COPIES', 3000);
      const svc = await page.evaluate(() => (document.querySelector('#main h1 + p') || {}).textContent || '');
      C.check('6b', 'SERVICE 語音確認後前進 COPIES（在學證明）', toCopies.ok && /在學證明/.test(svc), `state=${await C.state(page)} copy=${svc.slice(0, 60)}`);

      if (toCopies.ok) {
        await C.sleep(150);
        const vsCopies = await page.locator('#main #voice-start').count();
        const r2 = await speakAndWait(page, '三份');
        if (r2.confirm) await page.click('#voice-confirm');
        const toReview = await C.waitState(page, 'REVIEW', 3000);
        const copiesShown = await page.evaluate(() => document.getElementById('main').innerText);
        C.check('6c', 'COPIES 頁 #voice-start 存在；「三份」確認後前進 REVIEW 且份數為 3', vsCopies > 0 && r2.appeared && r2.confirm && toReview.ok && /份[\s\S]{0,6}3|3\s*份/.test(copiesShown), `voice-start=${vsCopies} ${JSON.stringify(r2)} state=${await C.state(page)}`);

        if (toReview.ok) {
          await C.sleep(150);
          const vsReview = await page.locator('#main #voice-start').count();
          const r3 = await speakAndWait(page, '確認');
          if (r3.confirm) await page.click('#voice-confirm');
          const toPay = await C.waitState(page, 'PAYMENT_METHOD', 3000);
          C.check('6d', 'REVIEW 頁 #voice-start 存在；「確認」確認後前進 PAYMENT_METHOD', vsReview > 0 && r3.appeared && r3.confirm && toPay.ok, `voice-start=${vsReview} ${JSON.stringify(r3)} state=${await C.state(page)}`);
        } else C.check('6d', 'REVIEW 語音流程', false, '前一步未到 REVIEW，略過');
      } else { C.check('6c', 'COPIES 語音流程', false, '前一步未到 COPIES，略過'); C.check('6d', 'REVIEW 語音流程', false, '前一步未到 COPIES，略過'); }
      await page.context().close();
    }

    // ---------- 7 LLM 選用 ----------
    {
      // 7a 無 key → 關鍵字比對
      const { page } = await C.newPage(browser, { init: C.RECOGNITION_STUB });
      await page.goto(C.DEMO_URL);
      const keyInfo = await detectKeyName(page);
      await C.goTo(page, 'SERVICE'); await C.sleep(150);
      // 待命文字或辨識後的 voice-status 任一顯示「關鍵字比對」即可（規格未限定時點）
      const st0 = await page.evaluate(() => (document.getElementById('voice-status') || {}).textContent || '(無 #voice-status)');
      const r0 = await speakAndWait(page, '歷年成績表');
      C.check('7a', 'localStorage 無 key 時 voice-status 顯示「關鍵字比對」', st0.includes('關鍵字比對') || r0.status.includes('關鍵字比對'), `待命=${st0.slice(0, 60)} ／ 辨識後=${r0.status.slice(0, 80)}`);
      await page.context().close();

      if (!keyInfo.key) {
        C.check('7b', 'LLM 解析（設 key + 攔截 /chat/completions）', false, `無法自原始碼推得 key 的 localStorage 鍵名；找到的鍵=${JSON.stringify(keyInfo.all)}`);
        C.check('7c', 'LLM 500 退回關鍵字比對', false, '同上');
        C.check('7d', 'key 不外洩', false, '同上');
      } else {
        // 7b 有 key、假 LLM 回應
        const ctx2 = await C.newPage(browser, { init: C.RECOGNITION_STUB + `try{localStorage.setItem(${JSON.stringify(keyInfo.key)},${JSON.stringify(FAKE_KEY)})}catch(e){}` });
        const p2 = ctx2.page;
        const reqs = [];
        let mode = 'ok';
        await p2.route('**/chat/completions**', async route => {
          const req = route.request();
          reqs.push({ url: req.url(), post: req.postData() || '', headers: req.headers() });
          if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'boom' } }) });
          const content = JSON.stringify({ service: 'enrollment-en', copies: 2, action: null, semester: null });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'fake', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }) });
        });
        await p2.goto(C.DEMO_URL);
        await C.goTo(p2, 'SERVICE'); await C.sleep(150);
        const stKey = await p2.evaluate(() => (document.getElementById('voice-status') || {}).textContent || '');
        const r = await speakAndWait(p2, '請幫我列印兩張英文的在學證明文件');
        await C.sleep(300);
        const stAfter = await p2.evaluate(() => (document.getElementById('voice-status') || {}).textContent || '');
        if (r.confirm) await p2.click('#voice-confirm');
        // service+copies 一併解析時可直接到 REVIEW（enrollment-en 無學年期），否則停在 COPIES
        const moved = await C.waitFor(p2, `['COPIES','REVIEW'].includes(window.__OP.state)`, 3000);
        const after = await p2.evaluate(() => ({ state: window.__OP.state, text: document.getElementById('main').innerText, checked: (document.querySelector('[name=copies]:checked') || {}).value }));
        const copiesOk = after.state === 'REVIEW' ? /份數\s*2/.test(after.text.replace(/\n/g, ' ')) : after.checked === '2';
        const llmShown = /LLM 解析/.test(stKey + stAfter);
        C.check('7b', '設 key 後攔截 /chat/completions 回假 JSON → 顯示「LLM 解析」且結果正確（enrollment-en、2 份）', reqs.length > 0 && llmShown && moved.ok && /英文在學證明/.test(after.text) && copiesOk, `key=${keyInfo.key} 請求數=${reqs.length} status後=${stAfter.slice(0, 60)} state=${after.state} 份數OK=${copiesOk} confirm=${r.confirm}`);

        // 7c 500 → 退回關鍵字比對、流程不中斷（重新走到 SERVICE）
        mode = 'fail';
        await C.dispatch(p2, 'RESET'); await C.waitState(p2, 'CONNECTED'); await C.goTo(p2, 'SERVICE'); await C.sleep(150);
        const before = reqs.length;
        const r2 = await speakAndWait(p2, '歷年成績表');
        await C.sleep(300);
        const st500 = await p2.evaluate(() => (document.getElementById('voice-status') || {}).textContent || '');
        if (r2.confirm) await p2.click('#voice-confirm');
        const toCopies2 = await C.waitState(p2, 'COPIES', 3000);
        const copyTxt2 = await p2.evaluate(() => document.getElementById('main').innerText);
        C.check('7c', '攔截回 500 → 退回關鍵字比對且流程不中斷（歷年成績表 → COPIES）', reqs.length > before && /關鍵字比對/.test(st500) && r2.confirm && toCopies2.ok && /歷年成績表/.test(copyTxt2), `請求數增加=${reqs.length - before} status=${st500.slice(0, 80)} confirm=${r2.confirm} state=${await C.state(p2)} errors=${ctx2.errors.length}`);

        // 7d key 不外洩：頁面 HTML、請求 URL／body 不得含 key（header 允許）
        const html = await p2.evaluate(() => document.documentElement.outerHTML);
        const inHtml = html.includes(FAKE_KEY);
        const inUrl = reqs.some(q => q.url.includes(FAKE_KEY));
        const inBody = reqs.some(q => q.post.includes(FAKE_KEY));
        const inHeader = reqs.some(q => Object.values(q.headers).some(v => String(v).includes(FAKE_KEY)));
        C.check('7d', 'key 僅出現在請求 header，不在頁面原始碼／URL／body', !inHtml && !inUrl && !inBody, `html=${inHtml} url=${inUrl} body=${inBody} header=${inHeader}`);
        await ctx2.context.close();
      }
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-p1-voice.results.json'));
  }
})();
