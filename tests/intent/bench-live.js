'use strict';
// 規則式 vs 線上 LLM 代理：同一批口語句子的實測對照，用來重現 README「八句口語實測」那張表。
//
// 執行：node tests/intent/bench-live.js
// 需要網路（會呼叫本專案的代理 8 次）。結果會因模型與網路而略有差異，時間更會浮動；
// 這支腳本的用途是讓任何人都能自己驗證那張表，不是拿來當回歸測試。
const fs = require('fs');
const path = require('path');

const IDX = path.resolve(__dirname, '../..', 'index.html');
const src = fs.readFileSync(IDX, 'utf8');
const start = src.indexOf('function parseIntent2(');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const parseIntent2 = new Function(src.slice(start, end) + '; return parseIntent2;')();

const mTT = src.match(/globalThis\.TT=(\{[\s\S]*?\});/);
const TT = new Function('return ' + mTT[1])();
const machine = TT.machines['campus-document-kiosk'];
const nameOf = id => (machine.availableServices.find(s => s.id === id) || {}).name || id;

const API = 'https://tapable-intent.vercel.app/api/intent';
const services = machine.availableServices.filter(s => s.enabled).map(s => ({ id: s.id, name: s.name }));

const CASES = [
  { t: '幫我印一下我大學這幾年全部的分數', s: 'SERVICE' },
  { t: '我要那個給國外學校看的，要蓋鋼印的成績', s: 'SERVICE' },
  { t: '我要證明我還在念書的那張紙', s: 'SERVICE' },
  { t: '就這學期的分數就好', s: 'SERVICE' },
  { t: '嗯……好像不太對欸，我再看看好了', s: 'REVIEW' },
  { t: '對啦對啦就是那個', s: 'REVIEW' },
  { t: '應該沒問題吧，就這樣送出去', s: 'REVIEW' },
  { t: '今天天氣真好', s: 'SERVICE' }
];

const describe = (o, state) => {
  if (!o) return '認不出';
  if (o.unavailable) return `說明「${o.unavailable}」未提供`;
  if (state === 'SERVICE') return nameOf(o.service) + (o.copies ? `，${o.copies} 份` : '');
  if (state === 'REVIEW') return o.action === 'CONFIRM' ? '確認送出' : '返回上一步';
  return JSON.stringify(o);
};

(async () => {
  const rows = [];
  for (const c of CASES) {
    const rule = parseIntent2(c.t, c.s, machine);
    let cloud = null, ms = 0, err = '';
    const t0 = Date.now();
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://a96020183.github.io' },
        body: JSON.stringify({ transcript: c.t, state: c.s, services, maxCopies: 5, semesters: machine.semesters })
      });
      ms = Date.now() - t0;
      if (res.ok) { const j = await res.json(); cloud = (j.service || j.action || j.copies || j.semester) ? j : null; }
      else err = 'HTTP ' + res.status;
    } catch (e) { err = '連線失敗'; ms = Date.now() - t0; }
    rows.push({ ...c, rule: describe(rule, c.s), cloud: err || describe(cloud, c.s), ms });
    console.log(`${c.t}\n  規則式：${describe(rule, c.s)}\n  LLM  ：${err || describe(cloud, c.s)}（${ms}ms）`);
  }
  const md = ['| 使用者實際會說的話 | 只用規則式 | 加上 LLM |', '|---|---|---|']
    .concat(rows.map(r => `| ${r.t} | ${r.rule} | ${r.cloud} |`)).join('\n');
  fs.writeFileSync(path.join(__dirname, 'bench-table.md'), md + '\n', 'utf8');
  const times = rows.map(r => r.ms).filter(Boolean).sort((a, b) => a - b);
  console.log('\n往返中位數 ' + times[Math.floor(times.length / 2)] + 'ms，最慢 ' + times[times.length - 1] + 'ms');
})();
