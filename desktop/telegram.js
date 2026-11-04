'use strict';

// Telegram: the bot the user talks to from their phone, answered by the agent of a chat of its own. The bot is kept
// here, in the app and not in a window, so it goes on with the window minimized, closed to the tray, or not made yet:
// when a message comes, the main window is made if it is not there (unseen) and its page runs the agent turn in the
// Telegram chat (telegram-agent.js in the page). While the bot is on the app stays in the tray when its window is
// closed, as it does for routines.
//
// Kept in the store under `telegram`: { enabled, allowed: [user ids], token (sealed with the OS keychain) }. The token
// never reaches the disk in the clear where the system can encrypt it. Only messages from an allowed user id are
// answered; anyone else is ignored without a word.
const { ipcMain, BrowserWindow, safeStorage } = require('electron');

const KEY = 'telegram';
const TOKEN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
// A turn can take a while; the user waiting on the phone is told when the app no longer has one to give.
const TIMEOUT = 15 * 60 * 1000;
const TYPING = 4500;
const PIECE = 4000;

let host = null, state = { enabled: false, allowed: [], token: '' }, loaded = null;
let bot = null, running = false, me = '', error = '', ignored = 0;
let ready = null, epoch = 0;
// Messages from the page's point of view: on their way to it, and asked of it.
const waiting = [], pending = new Map();
// One message per Telegram chat at a time, in the order they came, so the agent's turns do not overtake one another.
const chains = new Map();

const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const mine = event => host.fromApp(event);
const who = name => name ? `@${name}` : '';

// The Telegram user ids the user allowed, as text: numbers parted by commas, spaces or semicolons. Null if one is not
// a number at all.
function cleanAllowed(value) {
 const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
 const out = [];
 for (const item of list) {
  const id = String(item).trim();
  if (!id) continue;
  if (!/^\d{1,20}$/.test(id)) return null;
  if (!out.includes(id)) out.push(id);
 }
 return out;
}

function openSecret(secret) {
 if (!secret) return '';
 if (typeof secret === 'string') return secret;
 try {
  return secret.sealed ? safeStorage.decryptString(Buffer.from(secret.value, 'base64')) : String(secret.value || '');
 } catch {
  return '';
 }
}

function sealSecret(token) {
 if (!token) return '';
 if (safeStorage.isEncryptionAvailable()) return { sealed: true, value: safeStorage.encryptString(token).toString('base64') };
 return { sealed: false, value: token };
}

function record() {
 return { version: 1, enabled: state.enabled, allowed: state.allowed, token: sealSecret(state.token) };
}

function view() {
 return { enabled: state.enabled, allowed: state.allowed.slice(), token: state.token, running, me, error, ignored };
}

function publish() {
 const data = view();
 for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('telegram:changed', data);
 host?.changed?.();
}

async function save() {
 try { await host.store.write(KEY, record()); } catch {}
}

// A failure's words for the settings: the API's own message when it has one, without its stack.
function why(failure) {
 const text = failure?.response?.description || failure?.message || String(failure || '');
 return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Telegram did not accept the bot.';
}

// The run goes to the main window's page, which is made, unseen, when the app has none.
function deliver(request) {
 waiting.push(request);
 if (ready && !ready.isDestroyed()) flush();
 else host.wake();
}

function flush() {
 while (waiting.length && ready && !ready.isDestroyed()) ready.send('telegram:ask', waiting.shift());
}

function ask(request) {
 return new Promise(resolve => {
  const timer = setTimeout(() => {
   if (pending.delete(request.id)) resolve({ failure: 'The agent took too long to answer. Try again.' });
  }, TIMEOUT);
  timer.unref?.();
  pending.set(request.id, { resolve, timer });
  deliver(request);
 });
}

function settle(id, text, failure) {
 const job = pending.get(id);
 if (!job) return;
 pending.delete(id);
 clearTimeout(job.timer);
 job.resolve({ text: typeof text === 'string' ? text : '', failure: typeof failure === 'string' ? failure : '' });
}

// A reply longer than one Telegram message is sent in parts, at a line's end where one is near.
function pieces(text) {
 const out = [];
 let rest = String(text || '').trim();
 while (rest.length > PIECE) {
  let cut = rest.lastIndexOf('\n', PIECE);
  if (cut < PIECE * 0.6) cut = rest.lastIndexOf(' ', PIECE);
  if (cut < PIECE * 0.6) cut = PIECE;
  out.push(rest.slice(0, cut));
  rest = rest.slice(cut).replace(/^\n+/, '');
 }
 if (rest) out.push(rest);
 return out;
}

async function tell(chatId, text) {
 const list = pieces(text);
 if (!list.length) return;
 for (const piece of list) {
  try {
   await bot?.telegram.sendMessage(chatId, piece, { link_preview_options: { is_disabled: true } });
  } catch {
   return;
  }
 }
}

async function stopBot() {
 epoch++;
 const old = bot;
 bot = null;
 running = false;
 if (!old) return;
 try { old.stop('telegram off'); } catch {}
}

async function startBot() {
 await stopBot();
 error = '';
 me = '';
 if (!state.enabled || !state.token) {
  running = false;
  publish();
  return;
 }
 if (!TOKEN.test(state.token)) {
  running = false;
  error = 'That does not look like a Telegram bot token.';
  publish();
  return;
 }
 let fresh;
 try {
  const { Telegraf } = require('telegraf');
  fresh = new Telegraf(state.token);
 } catch (failure) {
  running = false;
  error = `The Telegram library could not be loaded: ${why(failure)}`;
  publish();
  return;
 }
 const mineEpoch = ++epoch;
 bot = fresh;
 fresh.catch(failure => {
  if (mineEpoch !== epoch) return;
  running = false;
  error = why(failure);
  publish();
 });
 fresh.on('message', ctx => onMessage(fresh, ctx, mineEpoch).catch(() => {}));
 try {
  const info = await fresh.telegram.getMe();
  if (mineEpoch !== epoch) return;
  fresh.botInfo = info;
  me = who(info.username) || info.first_name || '';
  await fresh.launch({ dropPendingUpdates: true });
  if (mineEpoch !== epoch) {
   try { fresh.stop('telegram restarted'); } catch {}
   return;
  }
  running = true;
  error = '';
 } catch (failure) {
  if (mineEpoch !== epoch) return;
  running = false;
  error = why(failure);
  me = '';
  try { fresh.stop('telegram failed'); } catch {}
  if (bot === fresh) bot = null;
 }
 publish();
}

async function onMessage(fresh, ctx, mineEpoch) {
 const from = ctx.from, message = ctx.message;
 if (!from || from.is_bot || !state.enabled || mineEpoch !== epoch) return;
 const userId = String(from.id);
 if (!state.allowed.includes(userId)) {
  ignored++;
  return;
 }
 const text = String(message.text || message.caption || '').trim();
 if (!text) return;
 const chatId = ctx.chat?.id;
 if (!chatId) return;
 const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
 const request = { id: uid(), userId, name, username: from.username || '', chatId, text };
 const turn = async () => {
  const typing = setInterval(() => { fresh.telegram.sendChatAction(chatId, 'typing').catch(() => {}); }, TYPING);
  typing.unref?.();
  try {
   fresh.telegram.sendChatAction(chatId, 'typing').catch(() => {});
   const answer = await ask(request);
   if (answer.failure) await tell(chatId, answer.failure);
   else await tell(chatId, answer.text || 'The agent finished without a reply.');
  } finally {
   clearInterval(typing);
  }
 };
 const before = chains.get(userId) || Promise.resolve();
 const next = before.then(turn, turn).finally(() => { if (chains.get(userId) === next) chains.delete(userId); });
 chains.set(userId, next);
}

async function update(changes = {}) {
 let restart = false, refused = '';
 if ('token' in changes) {
  const token = String(changes.token || '').trim();
  if (token && !TOKEN.test(token)) refused = 'token';
  else if (token !== state.token) {
   state.token = token;
   restart = true;
  }
 }
 if ('allowed' in changes) {
  const allowed = cleanAllowed(changes.allowed);
  if (!allowed) refused = 'allowed';
  else if (allowed.join() !== state.allowed.join()) state.allowed = allowed;
 }
 if ('enabled' in changes) {
  const enabled = !!changes.enabled;
  if (enabled !== state.enabled) {
   state.enabled = enabled;
   restart = true;
  }
 }
 await save();
 if (restart) await startBot();
 else publish();
 return refused ? { ...view(), refused } : view();
}

module.exports = {
 // host: { store: { read, write }, fromApp, window() — the main window if there is one, wake() — makes it, unseen, if
 // there is none, changed?() — the tray follows whether the app is to stay }.
 setup(options) {
  host = options;
  loaded = host.store.read(KEY).then(raw => {
   const allowed = cleanAllowed(raw?.allowed);
   state = { enabled: !!raw?.enabled, allowed: allowed || [], token: openSecret(raw?.token) };
   return startBot();
  }).catch(() => {});
  ipcMain.handle('telegram:get', async event => { if (!mine(event)) return null; await loaded; return view(); });
  ipcMain.handle('telegram:set', async (event, changes) => {
   if (!mine(event) || !changes || typeof changes !== 'object') return null;
   await loaded;
   return update(changes);
  });
  ipcMain.on('telegram:answer', (event, id, text, failure) => {
   if (!mine(event) || event.sender !== ready) return;
   settle(id, text, failure);
  });
  // The main window's page has read its library and can run the agent; it says so each time it is loaded.
  ipcMain.on('telegram:ready', event => {
   if (!mine(event) || event.sender !== host.window()?.webContents) return;
   ready = event.sender;
   flush();
  });
 },
 // The main window's page is gone or being read anew: what was on its way waits for a page that says it is ready.
 unready() {
  ready = null;
 },
 // Whether the app is to stay in the tray with its window closed: the bot is on.
 get alive() {
  return state.enabled && !!state.token;
 },
 stop() {
  for (const [id, job] of pending) {
   clearTimeout(job.timer);
   job.resolve({ failure: 'OpenGhost is closing.' });
   pending.delete(id);
  }
  waiting.length = 0;
  stopBot().catch(() => {});
 },
};
