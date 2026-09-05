'use strict';
// 依序執行 op-p0 / op-p1-voice / op-p2 / op-hardening / op-llm，彙整 pass/fail 與失敗清單到 op-summary.json
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const scripts = ['op-p0.js', 'op-p1-voice.js', 'op-p2.js', 'op-hardening.js', 'op-llm.js', 'op-start.js'];
const failures = []; let pass = 0, fail = 0;
for (const s of scripts) {
  console.log(`=== ${s} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { encoding: 'utf8', timeout: 240000 });
  process.stdout.write(r.stdout || ''); if (r.stderr) process.stderr.write(r.stderr);
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(PASS|FAIL) \| ([^|]+) \| ([^|]+) \| ?(.*)$/);
    if (!m) continue;
    if (m[1] === 'PASS') pass++; else { fail++; failures.push(`${m[2].trim()}：${m[3].trim()}｜${m[4].trim()}`); }
  }
  if (r.error) { fail++; failures.push(`${s}：執行失敗 ${r.error.message}`); }
}
const out = { pass, fail, failures };
fs.writeFileSync(path.join(__dirname, 'op-summary.json'), JSON.stringify(out, null, 2));
console.log('TOTAL | ' + JSON.stringify(out));
