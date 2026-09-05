'use strict';
// 規格 1：每個 tick 只播報一件事，取最高優先（車輛>行人>障礙物）。
const { launch, boot, injMany, getLive, setLive, check, dump, sleep } = require('./v2-common');
const { B } = require('./v2-common');

(async () => {
  const browser = await launch();
  const { page, pageErrors, ready } = await boot(browser);
  check('S1-0', '假模型啟動 ready', ready);

  // 第 1 幀：都在但 tier1/hits=1 → 全不報，只建立 track
  await setLive(page, 'S1-WARM');
  await injMany(page, [
    { class: 'car', score: 0.9, bbox: B.CAR_T1_MID },
    { class: 'person', score: 0.9, bbox: B.PERSON_T1_MID },
    { class: 'chair', score: 0.9, bbox: B.CHAIR_T1_MID },
  ]);
  let lv = await getLive(page);
  check('S1-1', '暖機幀（多物件 hits=1）→ 不報', lv === 'S1-WARM', lv);

  // 第 2 幀：三者同時皆符合播報條件（都進 tier0）→ 只應出現車輛一句
  await injMany(page, [
    { class: 'car', score: 0.9, bbox: B.CAR_T0_MID },
    { class: 'person', score: 0.9, bbox: B.PERSON_T0_MID },
    { class: 'chair', score: 0.9, bbox: B.CHAIR_T0_MID },
  ]);
  await sleep(200);
  lv = await getLive(page);
  check('S1-2', '多物件同幀 → 只播報最高優先(車輛)', lv.includes('汽車'), lv);
  check('S1-3', '同幀不夾帶行人/障礙物（單一播報）',
    !lv.includes('行人') && !lv.includes('障礙物') && !lv.includes('有人靠近'), lv);
  check('S1-4', '車輛播報內容正確（正前方/很近）', lv === '注意，正前方有汽車，很近。', lv);

  // 第 2 組：只有 行人 + 障礙物（無車輛）→ 行人優先於障礙物
  await sleep(3300);
  await setLive(page, 'S1-WARM2');
  await injMany(page, [
    { class: 'person', score: 0.9, bbox: B.PERSON_T1_MID },
    { class: 'chair', score: 0.9, bbox: B.CHAIR_T1_MID },
  ]);
  await injMany(page, [
    { class: 'person', score: 0.9, bbox: B.PERSON_T0_MID },
    { class: 'chair', score: 0.9, bbox: B.CHAIR_T0_MID },
  ]);
  await sleep(200);
  lv = await getLive(page);
  check('S1-5', '行人+障礙物同幀 → 行人優先', lv.includes('行人') && !lv.includes('障礙物'), lv);

  check('S1-9', '無未捕捉 JS 錯誤', pageErrors.length === 0, pageErrors.join(';') || '無');
  await browser.close();
  dump(__dirname + '/v2-spec1.json');
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
