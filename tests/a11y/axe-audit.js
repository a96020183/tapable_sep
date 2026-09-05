'use strict';
/*
 * 無障礙自動檢測（axe-core，WCAG 2.1 A/AA）。
 *
 * 一個給視障者用的產品，自己的介面不能有無障礙缺陷 —— 這支腳本把這件事變成可重複驗證的。
 * 檢測範圍：入口頁、操作段的每一個步驟、鏡頭段。
 *
 * 需要網路（從 cdnjs 取 axe-core）。用法：
 *   python -m http.server 4302   # repo 根目錄
 *   OP_PORT=4302 node tests/a11y/axe-audit.js
 */
const path = require('path');
const fs = require('fs');
const C = require('../op/op-common');

const AXE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function analyse(page, label) {
  await page.addScriptTag({ url: AXE_CDN });
  await page.waitForFunction('typeof window.axe !== "undefined"', null, { timeout: 15000 });
  const res = await page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.map(v => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 3).map(n => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(0, 2).join(' ') }))
    }));
  }, TAGS);
  return { label, violations: res };
}

(async () => {
  const browser = await C.launch();
  const report = [];
  try {
    // 入口頁
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.ORIGIN + '/start/');
      report.push(await analyse(page, '入口頁 start/'));
      await page.context().close();
    }

    // 操作段：逐步驟檢測（每個步驟都是不同的畫面，必須各測一次）
    {
      const { page } = await C.newPage(browser, { init: C.RECOGNITION_STUB });
      await page.goto(C.DEMO_URL);
      await C.waitFor(page, '!!window.__OP', 10000);
      const seq = ['CONNECTED', 'LANGUAGE', 'ROLE', 'AUTH', 'SERVICE', 'COPIES', 'RANK', 'SEMESTER', 'REVIEW', 'PAYMENT_METHOD', 'PAYMENT_WAITING', 'PAYMENT_SUCCESS', 'PROCESSING', 'PRINTING', 'COMPLETED'];
      for (const s of seq) {
        if (s !== 'CONNECTED') { const ok = await C.goTo(page, s); if (!ok) { report.push({ label: '操作段 ' + s, violations: [{ id: 'SKIP', impact: null, help: '無法到達此步驟', nodes: [] }] }); continue; } }
        await C.sleep(200);
        report.push(await analyse(page, '操作段 ' + s));
      }
      // 隱私模式（黑屏）也要測：對比度規則在這個模式下最容易出事
      await C.dispatch(page, 'RESET'); await C.waitState(page, 'CONNECTED');
      await page.evaluate(() => { const p = document.getElementById('private'); if (p && !p.checked) { p.checked = true; p.dispatchEvent(new Event('change')); } });
      await C.goTo(page, 'SERVICE'); await C.sleep(200);
      report.push(await analyse(page, '操作段 SERVICE（隱私模式黑屏）'));
      await page.context().close();
    }

    // 鏡頭段（不開相機，只測靜態介面）
    {
      const { page } = await C.newPage(browser);
      await page.goto(C.ORIGIN + '/vision/');
      await C.sleep(600);
      report.push(await analyse(page, '鏡頭段 vision/'));
      await page.context().close();
    }
  } catch (e) {
    report.push({ label: '腳本例外', violations: [{ id: 'ERROR', impact: 'critical', help: String(e && e.stack || e), nodes: [] }] });
  } finally {
    await browser.close();
  }

  let total = 0;
  for (const r of report) {
    const real = r.violations.filter(v => v.id !== 'SKIP');
    total += real.length;
    if (!real.length) { console.log(`PASS | ${r.label} | 無 WCAG 2.1 A/AA 違規`); continue; }
    for (const v of real) {
      console.log(`FAIL | ${r.label} | ${v.id}（${v.impact}）| ${v.help}`);
      for (const n of v.nodes) console.log(`     ↳ ${n.target} :: ${n.summary}`.slice(0, 200));
    }
  }
  console.log(`SUMMARY | 檢測 ${report.length} 個畫面，違規 ${total} 項`);
  fs.writeFileSync(path.join(__dirname, 'axe-audit.results.json'), JSON.stringify(report, null, 2));
  process.exitCode = total ? 1 : 0;
})();
