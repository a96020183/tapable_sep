'use strict';
// 規格 4：室內障礙物（新增）。只有 tier0(很近)＋正前方(dir=中央)＋(逼近或剛變近) 才報。
//  4a chair 進 tier0 正前方 → 報「前方有障礙物，椅子」
//  4b tier1 的 chair（近但非很近）→ 不得報
//  4c tier0 但非正前方（左前方）的 chair → 不得報（方向 gating）
//  4d 進 tier0 報一次後，站著不動（持續 tier0 正前方）→ 不重報（不誤觸發）
const { launch, boot, inj, getLive, setLive, check, dump, sleep } = require('./v2-common');
const { B } = require('./v2-common');

(async () => {
  const browser = await launch();
  const { page, pageErrors, ready } = await boot(browser);
  check('S4-0', '假模型啟動 ready', ready);

  // 4b: tier1 chair 正前方連注 4 幀 → 不報（先測，避免污染）
  await setLive(page, 'S4-B');
  for (let i = 0; i < 4; i++) { await inj(page, 'chair', 0.9, B.CHAIR_T1_MID); await sleep(120); }
  let lv = await getLive(page);
  check('S4-1', 'tier1（近但非很近）椅子連注 4 幀 → 不報', lv === 'S4-B', lv);

  // 4a: 同一 track 從 tier1 進 tier0 正前方 → enterNear → 報障礙物
  await inj(page, 'chair', 0.9, B.CHAIR_T0_MID);
  await sleep(200);
  lv = await getLive(page);
  check('S4-2', '進 tier0 + 正前方 → 報「前方有障礙物，椅子」',
    lv.includes('前方有障礙物') && lv.includes('椅子'), lv);

  // 4d: 續注同一 tier0 正前方（站著不動）→ 不重報
  await setLive(page, 'S4-D');
  await inj(page, 'chair', 0.9, B.CHAIR_T0_MID);
  await inj(page, 'chair', 0.9, B.CHAIR_T0_MID);
  lv = await getLive(page);
  check('S4-3', '持續 tier0 正前方（不動）→ 不重報（不誤觸發）', lv === 'S4-D', lv);

  // 4c: 全新 couch track，tier0 但在左前方（非正前）→ 方向 gating 擋下
  await sleep(3300);
  await setLive(page, 'S4-C');
  await inj(page, 'couch', 0.9, B.CHAIR_T0_LEFT); // hits1
  await inj(page, 'couch', 0.9, B.CHAIR_T0_LEFT); // hits2 solid, tier0, 但 dir0(左前) → 不報
  await inj(page, 'couch', 0.9, B.CHAIR_T0_LEFT);
  await sleep(200);
  lv = await getLive(page);
  check('S4-4', 'tier0 但非正前方（左前方）→ 方向 gating → 不報', lv === 'S4-C', lv);

  check('S4-9', '無未捕捉 JS 錯誤', pageErrors.length === 0, pageErrors.join(';') || '無');
  await browser.close();
  dump(__dirname + '/v2-spec4.json');
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
