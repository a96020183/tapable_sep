'use strict';
// 組員兩回饋是否解掉 + 新 bug 獵捕
const { launch, boot, inj, injMany, getLive, setLive, trackOf, check, note, dump, sleep } = require('./v2-common');
const { B } = require('./v2-common');

(async () => {
  const browser = await launch();
  const { page, pageErrors, ready } = await boot(browser);
  check('FB-0', '假模型啟動 ready', ready);

  // 回饋(a)：同向移動/靜止物體一直播報 → 應只在第一次(或方向變)報、之後靜默
  //   最強證據：固定面積 tier1 車輛連注多幀 → 完全不報
  await setLive(page, 'FBA-1');
  for (let i = 0; i < 8; i++) { await inj(page, 'car', 0.9, B.CAR_T1_MID); await sleep(80); }
  let lv = await getLive(page);
  check('FB-a1', '(a)固定面積 tier1 車輛連注 8 幀 → 全程靜默', lv === 'FBA-1', lv);

  //   行人 tier0 站著不動：只報一次（進入時），之後靜默
  await sleep(3300);
  await inj(page, 'person', 0.9, B.PERSON_T1_MID);
  await inj(page, 'person', 0.9, B.PERSON_T1_MID);
  await inj(page, 'person', 0.9, B.PERSON_T0_MID); // 進入很近→報
  await sleep(150);
  const firstReport = await getLive(page);
  await setLive(page, 'FBA-2');
  for (let i = 0; i < 5; i++) { await inj(page, 'person', 0.9, B.PERSON_T0_MID); await sleep(80); }
  lv = await getLive(page);
  check('FB-a2', '(a)行人進入很近報一次後站著不動 → 之後靜默',
    firstReport.includes('行人') && lv === 'FBA-2', `first=${firstReport} after=${lv}`);

  // 回饋(b)：每 tick 單一播報 → 多物件同幀只出一句
  await sleep(3300);
  await setLive(page, 'FBB-1');
  await injMany(page, [
    { class: 'car', score: 0.9, bbox: B.CAR_T1_MID },
    { class: 'person', score: 0.9, bbox: B.PERSON_T1_MID },
  ]);
  await injMany(page, [
    { class: 'car', score: 0.9, bbox: B.CAR_T0_MID },
    { class: 'person', score: 0.9, bbox: B.PERSON_T0_MID },
  ]);
  await sleep(150);
  lv = await getLive(page);
  check('FB-b1', '(b)多物件同幀 → 只出一句（車輛，且不含行人字樣）',
    lv.includes('汽車') && !lv.includes('行人'), lv);

  // ---- 新 bug 獵捕 ----
  // BUG-1：同幀出現「同類多個實例」→ hits 於單一 evaluate 內累加，可能一幀就過 hits>=2 門檻
  await sleep(3300);
  await setLive(page, 'BUG-1');
  const preTk = await trackOf(page, 'bicycle');
  await injMany(page, [
    { class: 'bicycle', score: 0.9, bbox: B.CAR_T0_MID },
    { class: 'bicycle', score: 0.9, bbox: B.CAR_T0_MID },
  ]);
  await sleep(150);
  lv = await getLive(page);
  const tk = await trackOf(page, 'bicycle');
  const singleFrameAlarm = lv.includes('自行車');
  check('BUG-1', '同類多實例單幀就過 hits 門檻並播報（預期應需連續兩幀才報）',
    !singleFrameAlarm, `preTrack=${JSON.stringify(preTk)} live=${lv} hits=${tk && tk.hits}`);
  note('BUG-1-detail', '單一 evaluate 內同類 N 個 → hits += N，繞過「連續幀」語意',
    `hits=${tk && tk.hits}（一次 evaluate 兩個實例）singleFrameAlarm=${singleFrameAlarm}`);

  // BUG-2：同類多實例時 track 只保留「陣列最後一個」的位置/面積 → t.dir 每幀被覆寫成另一實例方向，
  //         導致下一幀 changed(dir!==t.dir) 恆真 → 冷卻期內仍每幀重複播報（方向抖動 chatter）
  await sleep(3300);
  await setLive(page, 'BUG-2');
  const pair = [
    { class: 'motorcycle', score: 0.9, bbox: [10, 60, 300, 340] },  // tier0 左前 (較危險)
    { class: 'motorcycle', score: 0.9, bbox: [540, 200, 90, 130] }, // tier2 右前 (較遠)
  ];
  await injMany(page, pair);
  await injMany(page, pair); // 第 2 幀觸發首次播報
  await sleep(120);
  const bug2first = await getLive(page);
  await setLive(page, 'BUG2-COOL');
  await injMany(page, pair); // 冷卻期內（<5s）同一組再注入
  await injMany(page, pair);
  await sleep(120);
  const bug2after = await getLive(page);
  const tk2 = await trackOf(page, 'motorcycle');
  const chatter = bug2after !== 'BUG2-COOL';
  check('BUG-2', '同類多實例（不同方向）→ 冷卻期內不應重複播報（方向抖動 chatter）',
    !chatter, `first=${bug2first} after=${bug2after} track=${JSON.stringify(tk2)}`);
  note('BUG-2-detail', '單一 evaluate 內 t.dir 被最後一實例覆寫，使下一幀 changed(dir 變) 恆真',
    `chatter=${chatter}`);

  // 混合壓力序列：確認整段無 pageerror
  await sleep(200);
  for (let i = 0; i < 5; i++) {
    await injMany(page, [
      { class: 'car', score: 0.9, bbox: B.CAR_T0_MID },
      { class: 'person', score: 0.9, bbox: B.PERSON_T0_MID },
      { class: 'chair', score: 0.9, bbox: B.CHAIR_T0_MID },
      { class: 'unknownthing', score: 0.9, bbox: [0, 0, 10, 10] }, // 不在 ZH → 應被略過
    ]);
    await sleep(60);
  }
  check('FB-err', '整段（含未知類別、多實例、壓力序列）無未捕捉 JS 錯誤',
    pageErrors.length === 0, pageErrors.join(';') || '無');

  await browser.close();
  dump(__dirname + '/v2-feedback.json');
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
