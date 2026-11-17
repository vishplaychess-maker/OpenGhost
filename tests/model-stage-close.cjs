'use strict';
// The picker's closing state as a fail-safe: a close whose animation never runs (an occluded window) must not leave
// a visible, deaf list. Case A is the suspended close healed by the next open; B is the 1200 ms fallback; C is an
// ordinary close that must clear its fallback and finish exactly once.
const { app, shell } = require('electron'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync('D:/experiment/.tmp/og-close-');
for (const d of ['profile', 'session', 'workspace']) fs.mkdirSync(path.join(out, d), { recursive: true });
app.setName('OpenGhost close check');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'session'));
shell.writeShortcutLink = () => true;
delete process.env.OPENGHOST_UPDATE_AS;
const report = { out, checks: [], errors: [] };
let win, ended = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
function finish(error) {
  if (ended) return; ended = true;
  if (error) report.error = String(error.stack || error);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, error: report.error || null, rendererErrors: report.errors.slice(0, 5) }, null, 1));
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
setTimeout(() => finish(Error('close-state timeout')), 180000);
app.on('browser-window-created', (_e, w) => w.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); }));
let getWin = () => null;
const Update = require(path.join(root, 'desktop/update.js')), setup = Update.setup;
Update.setup = host => { getWin = host.window; return setup(host); };
require(path.join(root, 'desktop/main.js'));

app.whenReady().then(async () => {
  for (let n = 0; n < 300; n++) { win = getWin(); if (win && !win.webContents.isLoading()) break; await pause(40); }
  assert.ok(win, 'the application window');
  win.setContentSize(1280, 900); win.webContents.setBackgroundThrottling(false); win.show(); win.focus();
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async (code, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await js(code)) return; } throw Error('Not ready: ' + code.slice(0, 160)); };
  const check = async (name, code) => { assert.ok(await js(code), name); report.checks.push(name); };
  await wait(`typeof chat!=='undefined'&&!!library.home`);
  await js(`library.ready.then(()=>null)`);
  await wait(`!document.documentElement.classList.contains('is-splash')`);
  await js(`(()=>{const t=document.querySelector('.tour');[...t?.querySelectorAll('button')||[]].find(b=>/skip|пропуст|ignorer|salta/i.test(b.textContent))?.click()})()`);
  await wait(`!document.querySelector('.tour')`);

  // A provider of the test's own with two models, so a pick has somewhere to go.
  await js(`(() => {
    const think = { efforts: ['none','auto'], defaultEffort: 'auto', thinking: 'levels' };
    settings.keys.openrouter = 'fixture';
    settings.catalog.openrouter = [
      { id: 'openrouter:fixture-a', provider: 'openrouter', api: 'fixture-a', name: 'Fixture A', free: true, context: 128000, output: 4096, vision: true, tools: true, ...think },
      { id: 'openrouter:fixture-b', provider: 'openrouter', api: 'fixture-b', name: 'Fixture B', free: true, context: 128000, output: 4096, vision: true, tools: true, ...think },
    ];
    settings.freeOnly = false;
    settings.collect(); settings.onModels?.(); syncAll();
    chat.newChat(); chat.setModel('openrouter:fixture-a');
  })()`);
  await pause(400);

  const openPicker = async () => {
    await js(`modelStage.cancel?.(); if (modelStage.state === 'closing') modelStage.finish?.(); void 0`);
    await wait(`modelStage.state === 'closed'`);
    await js(`document.querySelector('.composer-model').button.click(), void 0`);
    await wait(`modelStage.state === 'open'`);
  };

  // A — a close suspended by an occluded window; the next open finishes it and the picker works.
  await openPicker();
  const stuck = await js(`(() => { modelStage.state = 'closing'; modelStage.root.style.pointerEvents = 'none'; modelStage.open();
    return { state: modelStage.state, pointerEvents: modelStage.root.style.pointerEvents }; })()`);
  report.caseA = stuck;
  assert.equal(stuck.state, 'open', 'open() heals a suspended close');
  assert.equal(stuck.pointerEvents, '', 'presses are taken again');
  report.checks.push('A suspended close is finished by the next open');
  await js(`[...document.querySelectorAll('.model-row[data-model]')].find(r => r.dataset.model === 'openrouter:fixture-b')?.click(), void 0`);
  await pause(1200);
  await check('A press after healing applies the selection', `chat.modelOf(chat.active) === 'openrouter:fixture-b'`);
  await js(`modelStage.cancel?.(); if (modelStage.state === 'closing') modelStage.finish?.(); void 0`);
  await wait(`modelStage.state === 'closed'`);

  // B — close whose animations never finish: the 1200 ms fallback finishes it, and the next open works.
  await openPicker();
  await js(`modelStage.close(); document.getAnimations().forEach(a => a.pause()); void 0`);
  await pause(1400);
  report.caseB = await js(`({ state: modelStage.state, pointerEvents: modelStage.root.style.pointerEvents, popover: modelStage.root.matches(':popover-open') })`);
  assert.equal(report.caseB.state, 'closed', 'the fallback finishes a close that cannot animate');
  assert.notEqual(report.caseB.pointerEvents, 'none', 'presses are restored');
  assert.equal(report.caseB.popover, false, 'the list is gone');
  report.checks.push('A close that cannot animate is finished after 1200 ms');
  await openPicker();
  report.checks.push('A later open works after the fallback');

  // C — an ordinary close clears its fallback and finishes once.
  await js(`modelStage.close(), void 0`);
  await wait(`modelStage.state === 'closed'`, 5000);
  await js(`(() => { window.__finishes = 0; const normal = modelStage.finish.bind(modelStage); modelStage.finish = function () { window.__finishes++; return normal(); }; })()`);
  await pause(1600);
  report.caseC = await js(`({ state: modelStage.state, finishes: window.__finishes })`);
  assert.equal(report.caseC.finishes, 0, 'no stray fallback after a normal close');
  assert.equal(report.caseC.state, 'closed', 'the picker stays closed');
  report.checks.push('An ordinary close leaves no fallback timer behind');

  finish(report.errors.length ? Error('renderer errors: ' + report.errors.join(' | ')) : null);
}).catch(finish);
