'use strict';
/*
 * 語音意圖解析（parseIntent2）單元測試 —— 純 Node，不需瀏覽器、不需伺服器。
 * 執行：node tests/intent/parseIntent2.test.js
 */
const fs = require('fs');
const path = require('path');

// 直接從 index.html 抽出「實際出貨」的 parseIntent2 來測，而不是測另一份副本 ——
// 這樣測試通過就代表使用者手上那份程式碼的行為，副本不會偷偷跟本體走鐘。
const HTML = path.join(__dirname, '..', '..', 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const start = src.indexOf('function parseIntent2(');
if (start < 0) { console.error('index.html 內找不到 parseIntent2'); process.exit(1); }
// 由函式開頭起算大括號配對，取出完整函式本體
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error('parseIntent2 括號不配對'); process.exit(1); }
const parseIntent2 = new Function(src.slice(start, end) + '; return parseIntent2;')();


// 與 index.html 內 TT.machines["campus-document-kiosk"] 一致的最小夾具（只留解析器會用到的欄位）
const machine = {
  machineId: 'campus-document-kiosk',
  availableServices: [
    { id: 'rank', name: '中文成績名次證明書', maxCopies: 5, enabled: true },
    { id: 'history', name: '中文歷年成績表', maxCopies: 5, enabled: true },
    { id: 'student-card', name: '學生證補發', maxCopies: 1, enabled: false },
    { id: 'english', name: '英文成績單', maxCopies: 5, enabled: true },
    { id: 'enrollment', name: '中文在學證明書', maxCopies: 5, enabled: true },
    { id: 'enrollment-en', name: '英文在學證明書', maxCopies: 5, enabled: true },
    { id: 'diploma', name: '中英文畢業證（明）書影本加蓋關防或鋼印', maxCopies: 5, enabled: false },
    { id: 'envelope', name: '成績單之信封彌封', maxCopies: 5, enabled: false },
    { id: 'semester-transcript', name: '中文學期成績單', maxCopies: 5, enabled: true },
    { id: 'weighted', name: '規整加權成績名次證明書', maxCopies: 5, enabled: false },
    { id: 'expected', name: '預期畢業（在學）證明', maxCopies: 5, enabled: false }
  ],
  semesters: ['114 學年度第 2 學期', '114 學年度第 1 學期', '113 學年度第 2 學期', '115 學年度第 1 學期']
};

let pass = 0, fail = 0;
const failures = [];
function check(name, transcript, state, expected, context, machineOverride) {
  const got = parseIntent2(transcript, state, machineOverride === undefined ? machine : machineOverride, context);
  let ok;
  if (expected === null) ok = got === null;
  else if (got === null) ok = false;
  else {
    ok = Object.keys(expected).every(k => got[k] === expected[k]);
    // 每個非 null 回傳都必須帶 parser 與合理的 confidence
    if (ok) ok = got.parser === 'rules' && typeof got.confidence === 'number' && got.confidence >= 0 && got.confidence <= 1;
  }
  if (ok) pass++; else { fail++; failures.push({ name, transcript, state, expected, got }); }
}

// ===== 正規化 =====
check('全形數字＋全形標點', '在學證明，２份！', 'SERVICE', { service: 'enrollment', copies: 2 });
check('空白與標點不影響', '我 要 在學 證明 。', 'SERVICE', { service: 'enrollment' });
check('中文數字 兩份', '在學證明兩份', 'SERVICE', { service: 'enrollment', copies: 2 });
check('中文數字 二張', '成績單二張', 'SERVICE', { service: 'history', copies: 2 });
check('阿拉伯數字 3份', '歷年成績表3份', 'SERVICE', { service: 'history', copies: 3 });

// ===== SERVICE：同義詞表 =====
check('在學證明 → enrollment', '我要申請在學證明', 'SERVICE', { service: 'enrollment' });
check('英文在學 → enrollment-en（英文優先）', '英文在學證明', 'SERVICE', { service: 'enrollment-en' });
check('在學證明 英文版 → enrollment-en', '我要在學證明英文版的', 'SERVICE', { service: 'enrollment-en' });
check('中文在學證明 不被英文覆蓋', '中文在學證明書', 'SERVICE', { service: 'enrollment' });
check('成績名次 → rank', '成績名次證明書一份', 'SERVICE', { service: 'rank', copies: 1 });
check('名次證明 → rank', '我要名次證明', 'SERVICE', { service: 'rank' });
check('英文成績 → english', '英文成績單', 'SERVICE', { service: 'english' });
check('英文歷年成績 → english（英文優先）', '英文的歷年成績表', 'SERVICE', { service: 'english' });
check('學期成績 → semester-transcript', '學期成績', 'SERVICE', { service: 'semester-transcript' });
check('學期成績單 → semester-transcript（非 history）', '我要學期成績單', 'SERVICE', { service: 'semester-transcript' });
check('歷年成績 → history', '歷年成績', 'SERVICE', { service: 'history' });
check('歷年成績表 → history', '請給我歷年成績表', 'SERVICE', { service: 'history' });
check('評審案例：我要印成績單 → history', '我要印成績單', 'SERVICE', { service: 'history' });
check('單說「成績」→ history', '成績', 'SERVICE', { service: 'history' });
check('服務＋份數同時抓取', '幫我印歷年成績表兩份', 'SERVICE', { service: 'history', copies: 2 });
check('份數超過 maxCopies 時只回服務、不帶 copies', '在學證明八份', 'SERVICE', { service: 'enrollment', copies: undefined });

// ===== SERVICE：未提供的服務 → unavailable =====
check('評審案例：畢業證書 → unavailable', '我要畢業證書', 'SERVICE', { service: null, unavailableId: 'diploma', unavailable: '中英文畢業證（明）書影本加蓋關防或鋼印' });
check('畢業證明 → unavailable', '畢業證明', 'SERVICE', { service: null, unavailableId: 'diploma' });
check('學生證補發 → unavailable', '學生證補發', 'SERVICE', { service: null, unavailableId: 'student-card', unavailable: '學生證補發' });
check('信封 → unavailable', '成績單要信封彌封', 'SERVICE', { service: null, unavailableId: 'envelope' });
check('規整加權 → unavailable', '規整加權成績名次證明', 'SERVICE', { service: null, unavailableId: 'weighted' });
check('預期畢業 → unavailable（不可誤判為在學）', '預期畢業（在學）證明', 'SERVICE', { service: null, unavailableId: 'expected' });
check('unavailable 回傳物件的 service 必為 null', '畢業證書', 'SERVICE', { service: null });
check('成績單信封 → envelope（不是 history）', '成績單信封', 'SERVICE', { service: null, unavailableId: 'envelope' });
check('精確命中優先於模糊命中（信心值 0.9）', '我要英文在學證明三份', 'SERVICE', { service: 'enrollment-en', copies: 3, confidence: 0.9 });

// ===== SERVICE：模糊比對（1 個錯字／漏字） =====
check('異體字 証', '在學証明', 'SERVICE', { service: 'enrollment' });
check('簡體 学', '在学證明', 'SERVICE', { service: 'enrollment' });
check('錯一字 名→明', '在學證名書', 'SERVICE', { service: 'enrollment' });
check('漏一字 在學證', '我要在學證', 'SERVICE', { service: 'enrollment' });
check('錯字 成績名次證書', '成績名次證書', 'SERVICE', { service: 'rank' });
check('簡體 成绩单', '我要成绩单', 'SERVICE', { service: 'history' });

// ===== SERVICE：閒聊不得誤判 =====
check('閒聊：今天天氣很好', '今天天氣很好', 'SERVICE', null);
check('閒聊：你好嗎', '你好嗎', 'SERVICE', null);
check('閒聊：請問幾點關門', '請問幾點關門', 'SERVICE', null);
check('閒聊：我還在學校 不是在學證明', '我還在學校', 'SERVICE', null);
check('空字串', '   ', 'SERVICE', null);
check('undefined 輸入', undefined, 'SERVICE', null);

// ===== COPIES =====
check('COPIES 一份就好 → 1', '一份就好', 'COPIES', { copies: 1 });
check('COPIES 兩份 → 2', '兩份', 'COPIES', { copies: 2 });
check('COPIES 三 → 3', '三', 'COPIES', { copies: 3 });
check('COPIES 4張 → 4', '我要4張', 'COPIES', { copies: 4 });
check('COPIES 全形５份 → 5', '５份', 'COPIES', { copies: 5 });
check('COPIES 六份 超過上限 → null', '六份', 'COPIES', null);
check('COPIES 十份 → null', '十份', 'COPIES', null);
check('COPIES 依 context.maxCopies（學生證上限 1）', '兩份', 'COPIES', null, { maxCopies: 1 });
check('COPIES 閒聊 → null', '你好嗎', 'COPIES', null);
check('COPIES 零份 → null', '零份', 'COPIES', null);

// ===== REVIEW =====
check('REVIEW 確認', '確認', 'REVIEW', { action: 'CONFIRM' });
check('REVIEW 好的', '好的', 'REVIEW', { action: 'CONFIRM' });
check('REVIEW 對', '對', 'REVIEW', { action: 'CONFIRM' });
check('REVIEW 沒問題', '沒問題', 'REVIEW', { action: 'CONFIRM' });
check('REVIEW OK 全形大寫', 'ＯＫ', 'REVIEW', { action: 'CONFIRM' });
check('REVIEW 可以', '可以', 'REVIEW', { action: 'CONFIRM' });
check('REVIEW 不對 → BACK', '不對', 'REVIEW', { action: 'BACK' });
check('REVIEW 取消 → BACK', '取消', 'REVIEW', { action: 'BACK' });
check('REVIEW 等一下 → BACK', '等一下', 'REVIEW', { action: 'BACK' });
check('REVIEW 錯了 → BACK', '錯了', 'REVIEW', { action: 'BACK' });
check('REVIEW 不好 → BACK（否定優先）', '不好', 'REVIEW', { action: 'BACK' });
check('REVIEW 不確定 → BACK（否定優先）', '不確定', 'REVIEW', { action: 'BACK' });
check('REVIEW 閒聊：今天天氣很好 → null', '今天天氣很好', 'REVIEW', null);
check('REVIEW 閒聊：你好嗎 → null', '你好嗎', 'REVIEW', null);
check('REVIEW 問句：可以幫我看一下嗎 → null', '可以幫我看一下嗎', 'REVIEW', null);
check('REVIEW 問句：請問確定了嗎 → null', '請問確定了嗎', 'REVIEW', null);

// ===== SEMESTER =====
check('SEMESTER 114 第2', '114學年度第2學期', 'SEMESTER', { semester: '114 學年度第 2 學期' });
check('SEMESTER 中文數字整句', '一一四學年度第二學期', 'SEMESTER', { semester: '114 學年度第 2 學期' });
check('SEMESTER 一百一十四', '一百一十四學年度第一學期', 'SEMESTER', { semester: '114 學年度第 1 學期' });
check('SEMESTER 114-2', '114-2', 'SEMESTER', { semester: '114 學年度第 2 學期' });
check('SEMESTER 114下', '114下', 'SEMESTER', { semester: '114 學年度第 2 學期' });
check('SEMESTER 115上', '115上學期', 'SEMESTER', { semester: '115 學年度第 1 學期' });
check('SEMESTER 113 第二', '113 第 2', 'SEMESTER', { semester: '113 學年度第 2 學期' });
check('SEMESTER 不存在的 113 第1 → null', '113學年度第1學期', 'SEMESTER', null);
check('SEMESTER 只有年度 → null', '114學年度', 'SEMESTER', null);
// 句首先出現的「上個學期」不可以搶走年度後面明講的「下學期」
check('SEMESTER 上下同句以年度之後為準', '就上個學期啦，一百一十四學年度那個下學期', 'SEMESTER', { semester: '114 學年度第 2 學期' });
check('SEMESTER 年度之後講上學期', '我要114學年度的上學期', 'SEMESTER', { semester: '114 學年度第 1 學期' });
check('SEMESTER 閒聊 → null', '今天天氣很好', 'SEMESTER', null);

// ===== 其他狀態 =====
check('未支援狀態 → null', '確認', 'PAYMENT_METHOD', null);
check('machine 為 null 時 SERVICE → null', '在學證明', 'SERVICE', null, undefined, null);
check('machine 為 null 時 SEMESTER → null', '114學年度第2學期', 'SEMESTER', null, undefined, null);
check('machine 為 null 時 REVIEW 仍可用', '確認', 'REVIEW', { action: 'CONFIRM' }, undefined, null);

// ===== 選用：與 index.html 的資料交叉比對（唯讀；檔案不存在則略過） =====
try {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(/globalThis\.TT=(\{.*?\});\r?\n/);
  if (!m) { fail++; failures.push({ name: '交叉比對：找不到 index.html 的 globalThis.TT 資料' }); }
  else {
    // 物件字面值（key 未加引號），不是嚴格 JSON，用 Function 取值
    const live = new Function('return ' + m[1])().machines['campus-document-kiosk'];
    const liveIds = live.availableServices.map(s => `${s.id}:${s.enabled}`).sort().join(',');
    const fixIds = machine.availableServices.map(s => `${s.id}:${s.enabled}`).sort().join(',');
    const sameSem = JSON.stringify(live.semesters) === JSON.stringify(machine.semesters);
    if (liveIds === fixIds && sameSem) pass++; else { fail++; failures.push({ name: '夾具與 index.html 資料不一致', liveIds, fixIds, sameSem }); }
  }
} catch { /* 讀不到就略過，不影響其他案例 */ }

const total = pass + fail;
for (const f of failures) console.log('FAIL', JSON.stringify(f, null, 0));
console.log(`parseIntent2 tests: ${pass}/${total} passed`);
process.exit(fail ? 1 : 0);
