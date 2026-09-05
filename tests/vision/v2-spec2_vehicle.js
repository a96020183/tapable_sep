'use strict';
// 規格 2：逼近偵測 GROW=1.18。車輛只有「逼近(面積成長)」或「已很近(tier0)」才報。
//  2a 固定面積 tier1 車輛連續注入 → 不得一直報（核心修正）
//  2b 面積成長 >=18% 的 tier1 車輛 → 報（逼近）
//  2c 面積縮小（遠離）的車輛 → 不得報
const { launch, boot, inj, getLive, setLive, check, dump, sleep } = require('./v2-common');
const { B } = require('./v2-common');

(async () => {
  const browser = await launch();
  const { page, pageErrors, ready } = await boot(browser);
  check('S2-0', '假模型啟動 ready', ready);

  // 2a: 固定面積 tier1 的 car，連續 6 幀（高分、hits 早已 >=2）→ 全程靜默
  await setLive(page, 'S2-A');
  for (let i = 0; i < 6; i++) { await inj(page, 'car', 0.9, B.CAR_T1_MID); await sleep(120); }
  let lv = await getLive(page);
  check('S2-1', '固定面積 tier1 車輛連注 6 幀 → 完全不報（修正同向/靜止一直播報）', lv === 'S2-A', lv);

  // 2b: truck，先固定 tier1 暖機（不報），再注入成長版 → 逼近 → 報
  await sleep(3300);
  await setLive(page, 'S2-B');
  await inj(page, 'truck', 0.9, B.CAR_T1_MID);   // hits=1
  await inj(page, 'truck', 0.9, B.CAR_T1_MID);   // hits=2 solid，固定面積→不報
  lv = await getLive(page);
  check('S2-2', '暖機兩幀（面積不變）仍不報', lv === 'S2-B', lv);
  await inj(page, 'truck', 0.9, B.CAR_T1_GROW);  // 面積 1.27x → 逼近
  await sleep(200);
  lv = await getLive(page);
  check('S2-3', '面積成長 >=18% → 車輛逼近播報（卡車）', lv.includes('卡車'), lv);

  // 2c: motorcycle，面積逐步縮小（遠離）→ 不報
  await sleep(3300);
  await setLive(page, 'S2-C');
  await inj(page, 'motorcycle', 0.9, B.CAR_T1_BIG);   // hits=1 大
  await inj(page, 'motorcycle', 0.9, B.CAR_T1_SMALL); // hits=2 縮小
  await inj(page, 'motorcycle', 0.9, B.CAR_T1_SMALL); // 續縮/持平
  await sleep(200);
  lv = await getLive(page);
  check('S2-4', '面積縮小（遠離）的車輛 → 不報', lv === 'S2-C', lv);

  check('S2-9', '無未捕捉 JS 錯誤', pageErrors.length === 0, pageErrors.join(';') || '無');
  await browser.close();
  dump(__dirname + '/v2-spec2.json');
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
