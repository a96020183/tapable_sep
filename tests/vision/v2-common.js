'use strict';
// v2 共用：事件引擎改版驗證。伺服器在 4188（tvd 目錄）。
const c = require('./common');
const BASE = 'http://127.0.0.1:' + (process.env.VISION_PORT || 4303) + '/vision/';

// 畫布 640x480：area = w*h/307200；cx=(x+w/2)/640
// tier0「很近」a>=.30；tier1「近」a>=.11；tier2「中距離」a>=.035；tier3「遠」
const B = {
  CAR_T0_MID:   [120, 40, 400, 300],  // area .390  cx .500 dir1(正前)
  CAR_T0_RIGHT: [398, 40, 240, 400],  // area .3125 cx .809 dir2(右前)
  CAR_T1_MID:   [220, 100, 200, 200], // area .130  cx .500 dir1
  CAR_T1_GROW:  [210, 90, 230, 220],  // area .1647 cx .508 dir1 (較 CAR_T1_MID 成長 1.27x)
  CAR_T1_BIG:   [210, 90, 230, 220],  // area .1647
  CAR_T1_SMALL: [220, 100, 200, 180], // area .117  (較 BIG 縮小=遠離)

  PERSON_T1_MID:   [200, 100, 240, 160], // area .125  cx .500
  PERSON_T0_MID:   [100, 40, 440, 300],  // area .4297 cx .500
  PERSON_T1_SMALL: [200, 110, 230, 170], // area .1273 cx .492
  PERSON_T1_GROW:  [190, 100, 260, 210], // area .1777 cx .500 (成長 1.40x, 仍 tier1)

  CHAIR_T1_MID:  [220, 150, 200, 170], // area .1107 cx .500 dir1
  CHAIR_T0_MID:  [170, 90, 300, 320],  // area .3125 cx .500 dir1(正前)
  CHAIR_T0_LEFT: [42, 80, 300, 310],   // area .3027 cx .300 dir0(左前, 非正前)
};

async function boot(browser) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(c.STUBS);
  await page.goto(BASE + '?nospeech=1');
  await page.evaluate(c.FAKE_MODEL);
  await page.click('#start');
  const r = await c.waitFor(page, () => window.__V && window.__V.ready === true, 8000, 150);
  return { page, pageErrors, ready: r.ok };
}

const inj = (page, cls, score, bbox) => page.evaluate(d => window.__V.evaluate([d]), { class: cls, score, bbox });
const injMany = (page, arr) => page.evaluate(a => window.__V.evaluate(a), arr);
const getLive = page => page.evaluate(() => document.getElementById('live').textContent);
const setLive = (page, s) => page.evaluate(t => { document.getElementById('live').textContent = t; }, s);
const trackOf = (page, cls) => page.evaluate(x => window.__V.track(x), cls);

module.exports = Object.assign({}, c, { BASE, B, boot, inj, injMany, getLive, setLive, trackOf });
