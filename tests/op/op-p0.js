'use strict';
// op-p0：P0 驗收（1 待填、2 語音自動開啟、3 隱私模式朗讀、4 模擬按鈕與陪同者文案）
const path = require('path');
const C = require('./op-common');

// 蒐集 DOM 中「待填」出現處（排除 <script>；含 placeholder 屬性）。
const DOM_TAI_TIAN = () => {
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 3) {
      if (n.parentElement && n.parentElement.closest('script,style')) continue;
      if (n.textContent.includes('待填')) hits.push((n.parentElement.id ? '#' + n.parentElement.id : n.parentElement.tagName) + ':' + n.textContent.trim().slice(0, 40));
    } else if (n.getAttribute && (n.getAttribute('placeholder') || '').includes('待填')) hits.push((n.id ? '#' + n.id : n.tagName) + '[placeholder]');
  }
  return hits;
};

// 開啟設定對話框並設定核取方塊（#tts／#private 等）
async function setSetting(page, id, checked) {
  await page.click('#settings-open');
  const cur = await page.evaluate(i => document.getElementById(i).checked, id);
  if (cur !== checked) await page.click('#' + id);
  await page.click('#settings-close');
  await C.sleep(100);
}

(async () => {
  const browser = await C.launch();
  try {
    if (!(await C.guardOP(browser, [1, 2, 3, 4]))) return;
    // ---------- 1 待填 ----------
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      {
        const domHits = [];
        // 首頁先啟用語音（點開始操作），確保 speakLog 有內容
        await page.click('#main button[data-event=START]');
        await C.waitState(page, 'LANGUAGE');
        await page.evaluate(() => { const t = document.getElementById('tts'); if (!t.checked) { t.checked = true; t.dispatchEvent(new Event('change')); } });
        await C.dispatch(page, 'RESET');
        await C.sleep(300);
        await C.walkAll(page, async s => {
          const hits = await page.evaluate(DOM_TAI_TIAN);
          if (hits.length) domHits.push(s + ':' + hits.join(','));
          // 設定對話框內容亦屬 DOM，一併檢查（開啟一次即可）
        });
        await page.click('#settings-open');
        const dlgHits = await page.evaluate(DOM_TAI_TIAN);
        await page.click('#settings-close');
        if (dlgHits.length) domHits.push('settings:' + dlgHits.join(','));
        C.check(1, '首頁與所有步驟 DOM 不含「待填」', domHits.length === 0, domHits.length ? domHits.join(' ; ') : '走訪 CONNECTED→COMPLETED 及 ERROR、設定對話框皆無「待填」');
        const log = await page.evaluate(() => ({ log: (window.__OP.speakLog || []).slice(), copy: window.__OP.currentCopy }));
        const bad = log.log.filter(t => String(t).includes('待填'));
        const copyBad = typeof log.copy === 'string' && log.copy.includes('待填');
        C.check('1b', 'currentCopy／__OP.speakLog 不含「待填」', log.log.length > 0 && bad.length === 0 && !copyBad, `speakLog=${log.log.length} 筆, 含待填=${bad.length}${copyBad ? ', currentCopy 含待填' : ''}${log.log.length === 0 ? '（speakLog 為空，無法證明有朗讀）' : ''}`);
      }
      await page.context().close();
    }

    // ---------- 2 語音自動開啟 ----------
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      const before = await page.evaluate(() => window.__OP && window.__OP.speechEnabled);
      C.check('2a', '開頁時 __OP.speechEnabled 為 false', before === false, `speechEnabled=${before}`);
      await page.click('#main button[data-event=START]');
      await C.waitState(page, 'LANGUAGE');
      await C.sleep(200);
      const after = await page.evaluate(() => ({ en: window.__OP.speechEnabled, tts: document.getElementById('tts').checked, replay: document.getElementById('replay').disabled, stop: document.getElementById('speech-stop').disabled }));
      C.check('2b', '點「開始操作」後 speechEnabled 為 true、#tts 已勾選、replay／speech-stop 可用', after.en === true && after.tts === true && !after.replay && !after.stop, JSON.stringify(after));
      await setSetting(page, 'tts', false);
      const off = await page.evaluate(() => window.__OP.speechEnabled);
      await C.dispatch(page, 'CHOOSE_LANGUAGE'); await C.waitState(page, 'ROLE');
      await C.dispatch(page, 'CHOOSE_ROLE', 'student'); await C.waitState(page, 'AUTH');
      await C.sleep(200);
      const still = await page.evaluate(() => ({ en: window.__OP.speechEnabled, tts: document.getElementById('tts').checked, state: window.__OP.state }));
      C.check('2c', '手動取消勾選後再走兩步，不得自動重開', off === false && still.en === false && still.tts === false, `取消後=${off}, 走兩步後=${JSON.stringify(still)}`);
      await page.context().close();
    }

    // ---------- 3 隱私模式朗讀 ----------
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      await page.click('#main button[data-event=START]');
      await C.waitState(page, 'LANGUAGE');
      await page.evaluate(() => { const t = document.getElementById('tts'); if (!t.checked) { t.checked = true; t.dispatchEvent(new Event('change')); } });
      await setSetting(page, 'private', true);
      const pm = await page.evaluate(() => ({ pm: window.__OP.privateMode, cls: document.documentElement.classList.contains('private') }));
      C.check('3a', '切換 #private 後 privateMode 為 true', pm.pm === true && pm.cls, JSON.stringify(pm));
      await C.dispatch(page, 'CHOOSE_LANGUAGE'); await C.waitState(page, 'ROLE'); await C.sleep(400);
      const lenBeforeAuth = await page.evaluate(() => window.__OP.speakLog.length);
      await C.dispatch(page, 'CHOOSE_ROLE', 'student'); await C.waitState(page, 'AUTH'); await C.sleep(700);
      const authLog = await page.evaluate(() => window.__OP.speakLog.slice());
      C.check('3c', '隱私模式走到 AUTH：該步不得新增 speakLog', authLog.length === lenBeforeAuth, `AUTH 前=${lenBeforeAuth} 後=${authLog.length} 新增=${JSON.stringify(authLog.slice(lenBeforeAuth))}`);
      await C.goTo(page, 'SEMESTER');
      await C.sleep(400);
      const lenBeforeReview = await page.evaluate(() => window.__OP.speakLog.length);
      await C.dispatch(page, 'CHOOSE_SEMESTER', '114 學年度第 2 學期'); await C.waitState(page, 'REVIEW'); await C.sleep(700);
      const reviewLog = await page.evaluate(() => window.__OP.speakLog.slice());
      const added = reviewLog.slice(lenBeforeReview);
      const mentionsAmount = added.some(t => /20|二十|金額|元|NT/.test(String(t)));
      C.check('3b', '隱私模式走到 REVIEW：speakLog 有新增且提及金額', added.length > 0 && mentionsAmount, `新增=${added.length} 筆: ${JSON.stringify(added).slice(0, 300)}`);
      await page.context().close();
    }

    // ---------- 4 模擬按鈕、陪同者文案 ----------
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL);
      const companion = [];
      const scan = async s => {
        const t = await page.evaluate(() => { const m = document.getElementById('main').cloneNode(true); m.querySelectorAll('#help-message').forEach(e => e.remove()); return m.innerText; });
        if (t.includes('陪同者')) companion.push(s);
      };
      await C.walkAll(page, scan);
      C.check('4c', '全程 demo 引導文案（#main，排除 help 求助）無「陪同者」', companion.length === 0, companion.length ? '出現於: ' + companion.join(',') : '所有步驟皆無');
      await C.dispatch(page, 'RESET'); await C.sleep(200);
      await C.goTo(page, 'PAYMENT_WAITING');
      await C.sleep(200);
      const btn = page.locator('#main button.primary', { hasText: '模擬' });
      const detailsOpen = await page.evaluate(() => [...document.querySelectorAll('details')].some(d => d.open));
      const n = await btn.count();
      const visible = n > 0 && await btn.first().isVisible();
      if (visible) await btn.first().click();
      const ok1 = (await C.waitState(page, 'PAYMENT_SUCCESS', 3000)).ok;
      C.check('4a', 'PAYMENT_WAITING 主區有可見 primary「模擬」按鈕，未展開 details 即可點到並進入 PAYMENT_SUCCESS', visible && !detailsOpen && ok1, `count=${n} visible=${visible} detailsOpen=${detailsOpen} state=${await C.state(page)}`);
      const proc = await C.waitState(page, 'PROCESSING', 4000);
      await C.sleep(200);
      const btn2 = page.locator('#main button.primary', { hasText: '模擬' });
      const n2 = await btn2.count();
      const visible2 = n2 > 0 && await btn2.first().isVisible();
      if (visible2) await btn2.first().click();
      const ok2 = (await C.waitState(page, 'PRINTING', 3000)).ok;
      C.check('4b', 'PROCESSING 主區有可見 primary「模擬」按鈕，點後進入 PRINTING', proc.ok && visible2 && ok2, `toProcessing=${proc.ok} count=${n2} visible=${visible2} state=${await C.state(page)}`);
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-p0.results.json'));
  }
})();
