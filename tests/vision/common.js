'use strict';
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:' + (process.env.VISION_PORT || 4303) + '/vision/';

async function launch(extraArgs) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'].concat(extraArgs || []);
  return chromium.launch({ headless: true, channel: 'msedge', args });
}

// stubs injected before page scripts run
const STUBS = `
window.__vibes = []; window.__tones = []; window.__cancels = 0; window.__gum = 0; window.__streams = [];
Object.defineProperty(navigator, 'vibrate', { value: function (p) { window.__vibes.push(p); return true; } });
window.AudioContext = function () {
  this.state = 'running'; this.currentTime = 0; this.destination = {};
  this.resume = function () { return Promise.resolve(); };
  this.createOscillator = function () {
    return { frequency: { value: 0 }, connect: function () {}, start: function () { window.__tones.push(this.frequency.value); }, stop: function () {} };
  };
  this.createGain = function () { return { gain: { value: 0 }, connect: function () {} }; };
};
window.webkitAudioContext = window.AudioContext;
Object.defineProperty(window, 'speechSynthesis', { value: {
  speaking: true, pending: false, onvoiceschanged: null,
  cancel: function () { window.__cancels++; },
  getVoices: function () { return []; },
  speak: function () { window.__speaks = (window.__speaks || 0) + 1; }
}});
(function(){
  var orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = function (c) {
    window.__gum++;
    return orig(c).then(function (s) { window.__streams.push(s); return s; });
  };
})();
`;

// replaces the real detector with a controllable fake (call AFTER page load, BEFORE clicking start)
const FAKE_MODEL = `
window.__dets = [];
window.cocoSsd = { load: function () { return Promise.resolve({
  detect: function () { return Promise.resolve((window.__dets || []).map(function (d) { return { class: d.class, score: d.score, bbox: d.bbox.slice() }; })); }
}); } };
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(page, fn, timeoutMs, pollMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.evaluate(fn);
    if (v) return { ok: true, value: v, ms: Date.now() - t0 };
    await sleep(pollMs || 200);
  }
  return { ok: false, ms: timeoutMs };
}

const results = [];
function check(id, desc, pass, detail) {
  results.push({ id, desc, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' | ' + desc + (detail !== undefined ? ' | ' + detail : ''));
}
function note(id, desc, detail) {
  results.push({ id, desc, pass: 'note', detail: detail === undefined ? '' : String(detail) });
  console.log('NOTE | ' + id + ' | ' + desc + (detail !== undefined ? ' | ' + detail : ''));
}
function dump(file) {
  require('fs').writeFileSync(file, JSON.stringify(results, null, 2));
}

module.exports = { launch, BASE, STUBS, FAKE_MODEL, sleep, waitFor, check, note, dump, results };
