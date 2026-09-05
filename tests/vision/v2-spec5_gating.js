'use strict';
// 規格 5：P0 gating —— score<0.66 或連續幀 hits<2 → 不報
const { launch, boot, inj, getLive, setLive, trackOf, check, dump, sleep } = require('./v2-common');
const { B } = require('./v2-common');

(async () => {
  const browser = await launch();
  const { page, pageErrors, ready } = await boot(browser);
  check('S5-0', '假模型啟動 ready', ready);

  // 低分：score 0.5 tier0 連兩幀（hits 會到 2 但分數不足）→ 不報
  await setLive(page, 'S5-A');
  await inj(page, 'car', 0.5, B.CAR_T0_MID);
  await inj(page, 'car', 0.5, B.CAR_T0_MID);
  let lv = await getLive(page);
  const tk = await trackOf(page, 'car');
  check('S5-1', 'score 0.5（<0.66）連兩幀 hits>=2 仍不報', lv === 'S5-A', `live=${lv} hits=${tk && tk.hits}`);

  // 單幀 hits<2：跨過 fresh 窗口重置後，高分只注入一次 → 不報
  await sleep(3300);
  await setLive(page, 'S5-B');
  await inj(page, 'car', 0.9, B.CAR_T0_MID);
  const tk2 = await trackOf(page, 'car');
  lv = await getLive(page);
  check('S5-2', 'score 0.9 但單幀（hits=1）→ 不報', lv === 'S5-B' && tk2.hits === 1, `live=${lv} hits=${tk2.hits}`);

  // 補上第二幀（hits=2 + 高分 + tier0）→ 這時才准報，證明 gating 開了才通
  await inj(page, 'car', 0.9, B.CAR_T0_MID);
  await sleep(200);
  lv = await getLive(page);
  check('S5-3', '高分+hits>=2+tier0 → gating 通過並播報汽車', lv.includes('汽車') && lv.includes('很近'), lv);

  check('S5-9', '無未捕捉 JS 錯誤', pageErrors.length === 0, pageErrors.join(';') || '無');
  await browser.close();
  dump(__dirname + '/v2-spec5.json');
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
