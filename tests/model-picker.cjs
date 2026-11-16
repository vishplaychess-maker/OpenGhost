'use strict';
// The model picker on a catalogue saved by an earlier shape of the app: entries that name a model and a company but
// carry no picker id. The shelf is laid out by company, and a press on one of those models must choose it.
// A private profile and loopback-only catalogue: no key, model or network of the application's own is used.
const { app, shell } = require('electron'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync('D:/experiment/.tmp/og-picker-');
for (const d of ['profile', 'session', 'workspace']) fs.mkdirSync(path.join(out, d), { recursive: true });
app.setName('OpenGhost picker check');
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
setTimeout(() => finish(Error('picker timeout')), 180000);
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
  const wait = async (code, ms = 30000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await js(code)) return; await pause(50); } throw Error('Not ready: ' + code.slice(0, 160)); };
  const check = async (name, code) => { assert.ok(await js(code), name); report.checks.push(name); };
  await wait(`typeof chat!=='undefined'&&!!library.home`);
  await js(`library.ready.then(()=>null)`);
  await wait(`!document.documentElement.classList.contains('is-splash')`);
  await js(`(()=>{const t=document.querySelector('.tour');[...t?.querySelectorAll('button')||[]].find(b=>/skip|пропуст|ignorer|salta/i.test(b.textContent))?.click()})()`);
  await wait(`!document.querySelector('.tour')`);

  // A catalogue as an earlier shape saved it: the model and the company, and the api to call, but no picker id.
  // The anchor is a second provider so the custom models stand under company rows, the way the report saw them.
  await js(`(() => {
    const think = { efforts: ['none','auto'], defaultEffort: 'auto', thinking: 'levels' };
    settings.keys.local = 'http://127.0.0.1:9';
    settings.catalog.local = [{ id: 'local:anchor', provider: 'local', api: 'anchor', name: 'Anchor', free: true, context: 32768, vision: true, tools: true, ...think }];
    settings.keys.custom = 'fixture';
    settings.hand.custom.address = 'http://127.0.0.1:9/v1';
    // The shelf the report saw: Anthropic 5, DeepSeek 1, Google 3, Moonshot AI 1, OpenAI 4 — 14 models over the
    // twelve a provider needs before it is laid out by company.
    const row = (api, name, group) => ({ api, name, group, free: true, context: 128000, output: 65536, vision: true, tools: true, ...think });
    settings.catalog.custom = [
      row('claude-fable-5', 'Claude Fable 5', 'Anthropic'),
      row('claude-fable-5-1', 'Claude Fable 5.1', 'Anthropic'),
      row('claude-fable-5-2', 'Claude Fable 5.2', 'Anthropic'),
      row('claude-haiku-5-5', 'Claude Haiku 5.5', 'Anthropic'),
      row('claude-opus-5-5', 'Claude Opus 5.5', 'Anthropic'),
      row('deepseek-v4-1-flash-1017', 'DeepSeek V4.1 Flash 1017', 'DeepSeek'),
      row('gemini-3-8-flash', 'Gemini 3.8 Flash', 'Google'),
      row('gemini-4-argon', 'Gemini 4 Argon', 'Google'),
      row('gemini-4-carbon', 'Gemini 4 Carbon', 'Google'),
      row('kimi-k3-1-pro', 'Kimi K3.1 Pro', 'Moonshot AI'),
      row('gpt-6-1-sol', 'GPT-6.1 Sol', 'OpenAI'),
      row('gpt-6-1-terra', 'GPT-6.1 Terra', 'OpenAI'),
      row('gpt-6-astra', 'GPT-6 Astra', 'OpenAI'),
      row('gpt-6-luna', 'GPT-6 Luna', 'OpenAI'),
      { name: 'Nameless', group: 'Nowhere', free: true, context: 128000, vision: true, ...think },
    ];
    settings.freeOnly = true;
    settings.collect(); settings.onModels?.(); syncAll();
    chat.setModel('local:anchor');
  })()`);
  await pause(400);

  await js(`document.querySelector('.composer-model').button.click(), void 0`);
  await wait(`modelStage.state==='open'`);
  await check('The free shelf keeps the custom models under their companies', `(()=>{const c=[...document.querySelectorAll('.model-row.is-company')].map(r=>r.dataset.company);
    return c.includes('custom/Anthropic/free')&&c.includes('custom/DeepSeek/free')})()`);
  await js(`[...document.querySelectorAll('.model-row.is-company')].find(r=>r.dataset.company==='custom/DeepSeek/free')?.click(), void 0`);
  await wait(`!![...document.querySelectorAll('.model-row.is-sub')].find(r=>/DeepSeek V4\\.1 Flash 1017/.test(r.textContent))`);
  await check('A model named by a saved catalogue is offered by the id the picker selects by',
    `[...document.querySelectorAll('.model-row.is-sub')].find(r=>/DeepSeek V4\\.1 Flash 1017/.test(r.textContent))?.dataset.model==='custom:deepseek-v4-1-flash-1017'`);
  await check('An entry with nothing to select by is not offered',
    `![...document.querySelectorAll('.model-row')].some(r=>/Nameless/.test(r.textContent))`);
  await check('Every offered row names a model the settings know',
    `[...document.querySelectorAll('.model-row[data-model]')].every(r=>!!settings.find(r.dataset.model))`);

  await js(`[...document.querySelectorAll('.model-row.is-sub')].find(r=>/DeepSeek V4\\.1 Flash 1017/.test(r.textContent)).click(), void 0`);
  await wait(`modelStage.state==='closed'`);
  await check('A press on a company-row model applies the selection', `chat.modelOf(chat.active)==='custom:deepseek-v4-1-flash-1017'&&settings.model==='custom:deepseek-v4-1-flash-1017'`);
  await check('The composer names the model that was chosen', `/DeepSeek V4\\.1 Flash 1017/.test(document.querySelector('.composer-model')?.getAttribute('label')||'')`);

  // Opening again: the company of the chat's model stands open, and its row is the selected one.
  await js(`document.querySelector('.composer-model').button.click(), void 0`);
  await wait(`modelStage.state==='open'`);
  await check('The chosen model’s company opens on the row that is in use',
    `document.querySelector('.model-row.is-company[data-company="custom/DeepSeek/free"]')?.getAttribute('aria-expanded')==='true'
     && document.querySelector('.model-row.is-sub[data-model="custom:deepseek-v4-1-flash-1017"]')?.getAttribute('aria-selected')==='true'`);
  await js(`modelStage.cancel(), void 0`);

  finish(report.errors.length ? Error('renderer errors: ' + report.errors.join(' | ')) : null);
}).catch(finish);
