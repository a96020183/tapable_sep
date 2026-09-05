'use strict';
// op-p2：8 ?stage=1 大字、9 點空白停止語音／滑動導航、10 無錯誤／320px／按鈕尺寸
const path = require('path');
const C = require('./op-common');

async function swipe(page, dir) {
  const box = await page.locator('#main').boundingBox();
  const y = box.y + Math.min(box.height - 10, 200);
  const x1 = dir === 'next' ? box.x + box.width - 30 : box.x + 30;
  const x2 = dir === 'next' ? box.x + 30 : box.x + box.width - 30;
  await page.mouse.move(x1, y); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x1 + (x2 - x1) * i / 6, y);
  await page.mouse.up();
}

(async () => {
  const browser = await C.launch();
  try {
    // ---------- 8 ?stage=1（不依賴 __OP） ----------
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.DEMO_URL + '&stage=1');
      const cls = await page.evaluate(() => document.documentElement.className);
      C.check(8, '?stage=1 → html 有 class large', /\blarge\b/.test(cls), `html.class="${cls}"`);
      await page.context().close();
    }
    if (!(await C.guardOP(browser, [9, 10]))) return;

    // ---------- 9 點空白停止語音、滑動導航 ----------
    {
      const { page } = await C.newPage(browser); // 預設已注入 SPEECH_STUB（speaking=true、cancel 計數）
      await page.goto(C.DEMO_URL);
      await C.sleep(200);
      const c0 = await page.evaluate(() => window.__cancels);
      // 點 #main 內非按鈕的空白處（h1 下方的段落文字）
      const p = page.locator('#main p.note').first();
      await p.click({ position: { x: 5, y: 5 } });
      await C.sleep(150);
      const c1 = await page.evaluate(() => window.__cancels);
      C.check('9a', '語音進行中（speaking=true）點 #main 空白處 → speechSynthesis.cancel 被呼叫', c1 > c0, `cancel 次數 ${c0} → ${c1}`);

      // 點按鈕不觸發：在 PAYMENT_WAITING 點 #help（showHelp 不會停語音）
      await C.goTo(page, 'PAYMENT_WAITING'); await C.sleep(400);
      const c2 = await page.evaluate(() => window.__cancels);
      const helpCount = await page.locator('#main #help').count();
      if (helpCount) await page.click('#main #help');
      await C.sleep(150);
      const c3 = await page.evaluate(() => window.__cancels);
      C.check('9b', '點按鈕（#help）不觸發「點空白停止語音」', helpCount > 0 && c3 === c2, `help=${helpCount} cancel 次數 ${c2} → ${c3}`);

      // 滑動導航（pointer 序列）仍可用
      await C.dispatch(page, 'RESET'); await C.waitState(page, 'CONNECTED'); await C.sleep(200);
      await swipe(page, 'next');
      const s1 = await C.waitState(page, 'LANGUAGE', 2000);
      await C.sleep(200);
      await swipe(page, 'next');
      const s2 = await C.waitState(page, 'ROLE', 2000);
      await C.sleep(200);
      await swipe(page, 'back');
      const s3 = await C.waitState(page, 'LANGUAGE', 2000);
      C.check('9c', '滑動導航仍可用：左滑 CONNECTED→LANGUAGE→ROLE，右滑回 LANGUAGE', s1.ok && s2.ok && s3.ok, `next=${s1.ok} next=${s2.ok} back=${s3.ok} state=${await C.state(page)}`);
      await page.context().close();
    }

    // ---------- 10 無錯誤、320px、按鈕尺寸 ----------
    {
      const { page, errors } = await C.newPage(browser, { context: { viewport: { width: 320, height: 640 } } });
      await page.goto(C.DEMO_URL);
      const overflow = [], small = [];
      await C.walkAll(page, async s => {
        const r = await page.evaluate(() => {
          const de = document.documentElement;
          const sw = Math.max(de.scrollWidth, document.body.scrollWidth), cw = de.clientWidth;
          const smalls = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && !b.closest('dialog:not([open])')).map(b => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.id).trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(b => b.w > 0 && (b.h < 44 || b.w < 44));
          return { sw, cw, smalls };
        });
        if (r.sw > r.cw) overflow.push(`${s}:${r.sw}>${r.cw}`);
        if (r.smalls.length) small.push(`${s}:${JSON.stringify(r.smalls)}`);
      });
      // 設定對話框內按鈕亦檢查
      await page.click('#settings-open');
      const dlgSmall = await page.evaluate(() => [...document.querySelectorAll('dialog[open] button')].map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(b => b.h < 44 || b.w < 44));
      await page.click('#settings-close');
      if (dlgSmall.length) small.push('settings:' + JSON.stringify(dlgSmall));
      C.check('10a', '全流程無 pageerror／console.error', errors.length === 0, errors.length ? errors.slice(0, 5).join(' ; ') : '走訪全部狀態無錯誤');
      C.check('10b', '320px 視窗不橫向捲動', overflow.length === 0, overflow.length ? overflow.join(',') : '所有狀態 scrollWidth<=clientWidth');
      C.check('10c', '可見 button 尺寸皆 ≥44px', small.length === 0, small.length ? small.join(' ; ').slice(0, 400) : '所有狀態可見按鈕皆 ≥44×44');
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-p2.results.json'));
  }
})();
