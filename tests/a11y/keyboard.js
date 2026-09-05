'use strict';
/*
 * 純鍵盤操作驗收（WCAG 2.1.1 鍵盤可操作、2.1.2 無鍵盤陷阱、2.4.7 焦點可見）。
 *
 * 螢幕閱讀器使用者是以鍵盤／觸控手勢驅動的，滑鼠點得到不代表他們用得了。
 * 這支腳本全程不用 page.click()，只用 Tab／Enter／Space／方向鍵／Escape 走完整個流程。
 *
 * 用法：python -m http.server 4302 （repo 根目錄）＋ OP_PORT=4302 node tests/a11y/keyboard.js
 */
const path = require('path');
const C = require('../op/op-common');

const MAX_TAB = 40;

const active = page => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return null;
  return { tag: a.tagName, id: a.id, type: a.type || '', text: (a.textContent || a.value || '').trim().slice(0, 30) };
});

// 一直按 Tab，直到焦點落在符合條件的元素上；回傳按了幾次（找不到回 -1）
async function tabUntil(page, predicate) {
  for (let i = 0; i < MAX_TAB; i++) {
    await page.keyboard.press('Tab');
    const a = await active(page);
    if (a && predicate(a)) return i + 1;
  }
  return -1;
}

async function focusVisible(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { ok: false, why: '焦點在 body' };
    const s = getComputedStyle(a);
    const hasOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    const hasShadow = s.boxShadow && s.boxShadow !== 'none';
    const hasBorderChange = parseFloat(s.borderWidth || '0') > 0;
    return { ok: hasOutline || hasShadow || hasBorderChange, why: `outline=${s.outlineStyle}/${s.outlineWidth} shadow=${(s.boxShadow || '').slice(0, 30)}` };
  });
}

(async () => {
  const browser = await C.launch();
  try {
    // ---------- K1 只用鍵盤走完整個流程 ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.waitFor(page, '!!window.__OP', 10000);

      const steps = [
        { state: 'CONNECTED', pick: a => /開始操作/.test(a.text) },
        { state: 'LANGUAGE', pick: a => /中文|繁體/.test(a.text) },
        { state: 'ROLE', pick: a => /學生/.test(a.text) },
        { state: 'AUTH', pick: a => /Demo 身分/.test(a.text) },   // 身分步驟走 demo 身分，不輸入任何測試值
        { state: 'SERVICE', pick: a => /歷年成績表/.test(a.text) },
        { state: 'COPIES', pick: a => a.type === 'radio' },       // 單選鈕：Space 選取
        { state: 'REVIEW', pick: a => /確認申請|送出/.test(a.text) },
        { state: 'PAYMENT_METHOD', pick: a => /現金/.test(a.text) }
      ];

      let reached = [];
      let trapped = null;
      for (const step of steps) {
        const cur = await C.state(page);
        if (cur !== step.state) { trapped = `預期在 ${step.state}，實際在 ${cur}`; break; }
        const n = await tabUntil(page, step.pick);
        if (n < 0) { trapped = `${step.state}：按了 ${MAX_TAB} 次 Tab 仍找不到目標控制項`; break; }
        if (step.state === 'COPIES') {
          await page.keyboard.press('Space');                       // 選 1 份
          const n2 = await tabUntil(page, a => /確認份數/.test(a.text));
          if (n2 < 0) { trapped = 'COPIES：找不到「確認份數」'; break; }
        }
        await page.keyboard.press('Enter');
        // VERIFYING 是自動推進的過場：等它離開，不要把過場當成停滯
        await C.waitFor(page, `window.__OP && window.__OP.state !== '${step.state}' && window.__OP.state !== 'VERIFYING'`, 6000);
        await C.sleep(200);
        reached.push(await C.state(page));
      }
      C.check('K1a', '只用 Tab／Enter／Space，可從連線走到付款方式（不使用滑鼠）', !trapped, trapped || `經過：${reached.join(' → ')}`);

      // ---------- K2 焦點可見 ----------
      const vis = await focusVisible(page);
      C.check('K2a', '鍵盤焦點有可見樣式（WCAG 2.4.7）', vis.ok, vis.why);

      // ---------- K3 換頁後焦點移到步驟標題 ----------
      await C.dispatch(page, 'RESET'); await C.waitState(page, 'CONNECTED'); await C.sleep(300);
      const afterNav = await active(page);
      C.check('K3a', '換頁後焦點自動落在步驟標題，讀屏會從新畫面開頭讀起', afterNav && afterNav.id === 'step-title', JSON.stringify(afterNav));
      await page.context().close();
    }

    // ---------- K4 對話框：可開、可用 Escape 關、焦點歸位（無鍵盤陷阱） ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.waitFor(page, '!!window.__OP', 10000);
      const n = await tabUntil(page, a => a.id === 'settings-open' || /設定|偏好/.test(a.text));
      if (n < 0) {
        C.check('K4a', '可用鍵盤開啟設定對話框', false, `按了 ${MAX_TAB} 次 Tab 找不到設定入口`);
        C.check('K4b', 'Escape 可關閉對話框且焦點回到觸發元素', false, '同上');
      } else {
        const opener = await active(page);
        await page.keyboard.press('Enter');
        await C.sleep(300);
        const opened = await page.evaluate(() => !!document.getElementById('settings') && document.getElementById('settings').open);
        C.check('K4a', '可用鍵盤開啟設定對話框', opened, `觸發元素=${JSON.stringify(opener)} open=${opened}`);
        await page.keyboard.press('Escape');
        await C.sleep(300);
        const closed = await page.evaluate(() => !document.getElementById('settings').open);
        const back = await active(page);
        C.check('K4b', 'Escape 可關閉對話框，焦點回到原本的觸發元素（無鍵盤陷阱）', closed && back && back.id === opener.id, `closed=${closed} 焦點=${JSON.stringify(back)} 原本=${opener.id}`);
      }
      await page.context().close();
    }

    // ---------- K5 每個步驟都有 aria-live 播報 ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.goto(C.DEMO_URL);
      await C.waitFor(page, '!!window.__OP', 10000);
      const missing = [];
      for (const s of ['LANGUAGE', 'ROLE', 'AUTH', 'SERVICE', 'COPIES', 'REVIEW', 'PAYMENT_METHOD']) {
        const ok = await C.goTo(page, s);
        if (!ok) { missing.push(s + '(無法到達)'); continue; }
        await C.sleep(250);
        const live = await page.evaluate(() => (document.getElementById('announcer') || {}).textContent || '');
        if (!live.trim()) missing.push(s);
      }
      C.check('K5a', '每個步驟都會透過 aria-live 播報，螢幕閱讀器不會沉默', missing.length === 0, missing.length ? '沒有播報：' + missing.join('、') : '全部步驟皆有播報');
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'keyboard.results.json'));
  }
})();
