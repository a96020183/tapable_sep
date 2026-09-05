'use strict';
// op-start：入口頁（start/）契約 —— 語音導覽可播、逐字稿完整、播放失敗有替代路徑、連結指向正確。
const path = require('path');
const C = require('./op-common');

const START = C.ORIGIN + '/start/';

(async () => {
  const browser = await C.launch();
  try {
    // ---------- S1 導覽控制項與逐字稿 ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.goto(START);
      const btn = await page.locator('#intro-play').count();
      const described = await page.evaluate(() => (document.getElementById('intro-play') || {}).getAttribute && document.getElementById('intro-play').getAttribute('aria-describedby'));
      const transcript = await page.evaluate(() => (document.querySelector('.audio details') || {}).textContent || '');
      C.check('S1a', '入口頁有語音導覽播放鈕，並以 aria-describedby 指向說明', btn === 1 && described === 'intro-note', `按鈕=${btn} describedby=${described}`);
      C.check('S1b', '逐字稿與音檔內容一致（涵蓋開場、最後十公尺、感應貼紙、合成揭露四個重點）',
        /接管機台/.test(transcript) && /最後十公尺/.test(transcript) && /感應貼紙/.test(transcript) && /ElevenLabs/.test(transcript),
        `逐字稿長度=${transcript.length}`);
      const live = await page.evaluate(() => (document.getElementById('intro-state') || {}).getAttribute('role'));
      C.check('S1c', '播放狀態以 role="status" 播報，螢幕閱讀器聽得到', live === 'status', `role=${live}`);
      await page.context().close();
    }

    // ---------- S2 音檔真的存在且被快取清單涵蓋 ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      const res = await page.request.get(C.ORIGIN + '/start/audio/intro.mp3');
      const len = Number(res.headers()['content-length'] || 0);
      const type = res.headers()['content-type'] || '';
      C.check('S2a', '導覽音檔可取得且大小合理（>200KB、audio 型別）', res.ok() && len > 200000 && /audio|mpeg|octet/.test(type), `HTTP=${res.status()} 大小=${len} 型別=${type}`);
      const sw = await (await page.request.get(C.ORIGIN + '/sw.js')).text();
      C.check('S2b', 'Service Worker 預快取包含入口頁與導覽音檔（離線可播）', sw.includes('./start/audio/intro.mp3') && sw.includes('./start/index.html'), 'sw.js 預快取清單');
      await page.context().close();
    }

    // ---------- S3 音檔取不到時要有替代路徑，不能只是靜默 ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.route('**/start/audio/intro.mp3', route => route.abort('failed'));
      await page.goto(START);
      await page.click('#intro-play');
      await C.waitFor(page, `(document.getElementById('intro-state')||{}).textContent`, 5000);
      const msg = await page.evaluate(() => (document.getElementById('intro-state') || {}).textContent || '');
      const label = await page.evaluate(() => (document.getElementById('intro-play') || {}).textContent || '');
      C.check('S3a', '音檔載入失敗時明確導向逐字稿，且按鈕回到「播放」狀態', /逐字稿/.test(msg) && /播放/.test(label), `訊息=${msg} 按鈕=${label}`);
      const bad = ctx.errors.filter(e => !/Failed to load resource|net::ERR_/.test(e));
      C.check('S3b', '音檔失敗不產生未捕捉錯誤', bad.length === 0, bad.join(' | ').slice(0, 200));
      await page.context().close();
    }

    // ---------- S4 三個 demo 連結指向正確 ----------
    {
      const ctx = await C.newPage(browser);
      const page = ctx.page;
      await page.goto(START);
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('a.card')].map(a => a.getAttribute('href')));
      const ok = hrefs.some(h => /\.\.\/\?machine=campus-document-kiosk&demo=1/.test(h))
        && hrefs.includes('../vision/')
        && hrefs.includes('../vision/?marker=1');
      C.check('S4a', '入口頁三個 demo 連結為相對路徑且參數正確（換網域也不會壞）', ok, JSON.stringify(hrefs).slice(0, 200));
      await page.context().close();
    }
  } catch (e) {
    C.check('X', '腳本例外', false, e && e.stack || e);
  } finally {
    await C.finish(browser, path.join(__dirname, 'op-start.results.json'));
  }
})();
