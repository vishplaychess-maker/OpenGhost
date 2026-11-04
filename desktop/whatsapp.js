'use strict';

// WhatsApp: the account the user talks to from their phone, answered by the agent of a chat of its own. The WhatsApp
// Web session is kept here, in the app and not in a window, so it goes on with the window minimized, closed to the
// tray, or not made yet: when a message comes, the main window is made if it is not there (unseen) and its page runs
// the agent turn in the WhatsApp chat (whatsapp-agent.js in the page). While it is on the app stays in the tray when
// its window is closed, as it does for routines and Telegram.
//
// Kept in the store under `whatsapp`: { enabled, allowed: [phone numbers] }. The WhatsApp credentials are Baileys'
// multi-file auth state, written to `whatsapp-auth` under the app's own data folder (the profile on the D: drive), not
// in the project. Only messages from an allowed number are answered; anyone else is ignored without a word, and group
// chats, broadcasts and the user's own messages are never answered.
const { ipcMain, BrowserWindow, app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'whatsapp';
const AUTH = 'whatsapp-auth';
// A turn can take a while; the user waiting on the phone is told when the app no longer has one to give.
const TIMEOUT = 15 * 60 * 1000;
const TYPING = 4500;
const PIECE = 4000;
const RETRY = 5000;
const LOG = { bytes: 512 * 1024 };

let host = null, state = { enabled: false, allowed: [] }, loaded = null;
let socket = null, status = 'off', me = '', error = '', ignored = 0;
let qrImage = '', qrAt = 0;
let lib = null, loading = null;
let ready = null, epoch = 0, retry = null;
// Messages from the page's point of view: on their way to it, and asked of it.
const waiting = [], pending = new Map();
// One message per WhatsApp number at a time, in the order they came, so the agent's turns do not overtake one another.
const chains = new Map();
// The ids of the last messages taken, so a reconnect does not answer the same message twice.
const seen = new Set();

const uid = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const mine = event => host.fromApp(event);

// The phone numbers the user allowed, as text: numbers parted by commas, semicolons or new lines, with a leading +,
// spaces, dashes or brackets allowed around them. Null if one is not a number at all.
function cleanAllowed(value) {
 const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/);
 const out = [];
 for (const item of list) {
  const raw = String(item).trim();
  if (!raw) continue;
  const digits = raw.replace(/[\s()+\-.]/g, '');
  if (!/^\d{6,15}$/.test(digits)) return null;
  if (!out.includes(digits)) out.push(digits);
 }
 return out;
}

function log(line) {
 try {
  const dir = path.join(app.getPath('userData'), 'whatsapp');
  const file = path.join(dir, 'whatsapp.log');
  fs.mkdirSync(dir, { recursive: true });
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > LOG.bytes) fs.renameSync(file, path.join(dir, 'whatsapp.old.log'));
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
 } catch {}
}

function why(failure) {
 const text = failure?.output?.payload?.message || failure?.message || String(failure || '');
 return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'WhatsApp did not accept the connection.';
}

function view() {
 return { enabled: state.enabled, allowed: state.allowed.slice(), status, running: status === 'connected', me, error, ignored, qr: qrImage, qrAt };
}

function publish() {
 const data = view();
 for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('whatsapp:changed', data);
 host?.changed?.();
}

async function save() {
 try { await host.store.write(KEY, { version: 1, enabled: state.enabled, allowed: state.allowed }); } catch {}
}

const folder = () => path.join(app.getPath('userData'), AUTH);

// Baileys is an ES module and is only loaded once auto-reply is turned on, so the app's start stays quick.
function library() {
 loading ||= import('@whiskeysockets/baileys').then(module => {
  lib = module;
  return module;
 }).catch(failure => {
  loading = null;
  throw failure;
 });
 return loading;
}

async function latestVersion() {
 let timer = null;
 const wait = new Promise(resolve => {
  timer = setTimeout(() => resolve(null), 4000);
  timer.unref?.();
 });
 try {
  const answer = await Promise.race([lib.fetchLatestBaileysVersion().catch(() => null), wait]);
  return answer?.version;
 } catch {
  return undefined;
 } finally {
  clearTimeout(timer);
 }
}

function scheduleRetry() {
 clearTimeout(retry);
 retry = setTimeout(() => {
  retry = null;
  if (state.enabled) start().catch(() => {});
 }, RETRY);
 retry.unref?.();
}

// A number out of a JID: `919876543210:12@s.whatsapp.net` → `919876543210`. A LID is not a phone number, so the phone
// JID beside it is preferred; with none, the digits it gives simply match no allowed number.
function numberFrom(jid) {
 return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function senderNumber(message) {
 const key = message?.key || {};
 const all = [key.remoteJidAlt, key.senderPn, key.participantAlt, key.remoteJid];
 const phone = all.find(item => String(item || '').endsWith('@s.whatsapp.net'));
 return numberFrom(phone || all.find(Boolean));
}

function unwrap(message) {
 let inner = message || {};
 for (let step = 0; step < 3; step++) {
  const next = inner.ephemeralMessage || inner.viewOnceMessage || inner.viewOnceMessageV2 || inner.documentWithCaptionMessage;
  if (!next?.message) break;
  inner = next.message;
 }
 return inner;
}

function textOf(message) {
 const inner = unwrap(message);
 return String(
  inner.conversation
  || inner.extendedTextMessage?.text
  || inner.imageMessage?.caption
  || inner.videoMessage?.caption
  || inner.documentMessage?.caption
  || ''
 ).trim();
}

async function showQr(code) {
 try {
  qrImage = await require('qrcode').toDataURL(code, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
  qrAt = Date.now();
 } catch (failure) {
  qrImage = '';
  error = `The QR code could not be drawn: ${why(failure)}`;
 }
}

async function onUpdate(current, mineEpoch, update) {
 if (mineEpoch !== epoch || current !== socket) return;
 const { connection, lastDisconnect, qr } = update || {};
 if (qr) {
  await showQr(qr);
  if (mineEpoch !== epoch) return;
  status = 'qr';
  log('qr shown');
  publish();
  return;
 }
 if (connection === 'connecting') {
  if (status === 'starting' || status === 'off') {
   status = 'starting';
   publish();
  }
  return;
 }
 if (connection === 'open') {
  status = 'connected';
  qrImage = '';
  qrAt = 0;
  error = '';
  me = numberFrom(current.user?.id) || String(current.user?.name || '');
  log(`connected as ${me || 'unknown'}`);
  publish();
  return;
 }
 if (connection === 'close') {
  const code = lastDisconnect?.error?.output?.statusCode;
  socket = null;
  qrImage = '';
  qrAt = 0;
  if (code === lib?.DisconnectReason?.loggedOut) {
   status = 'loggedOut';
   error = 'This WhatsApp device was unlinked. Turn auto-reply off and on again, then scan the new QR code.';
   log('logged out');
   publish();
   return;
  }
  if (!state.enabled) {
   status = 'off';
   publish();
   return;
  }
  status = 'reconnecting';
  error = code ? `The connection closed (${code}). Reconnecting…` : '';
  log(`closed: ${code || 'unknown'}`);
  publish();
  scheduleRetry();
 }
}

async function onMessages(current, mineEpoch, event) {
 if (mineEpoch !== epoch || current !== socket || !state.enabled) return;
 if (event?.type !== 'notify') return;
 for (const message of event.messages || []) {
  if (mineEpoch !== epoch) return;
  const key = message?.key || {};
  if (!message?.message || key.fromMe) continue;
  const jid = String(key.remoteJid || '');
  // Group chats, broadcast lists, the status feed and channels are never answered.
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
  const id = String(key.id || '');
  if (id && seen.has(id)) continue;
  if (id) {
   seen.add(id);
   if (seen.size > 500) seen.delete(seen.values().next().value);
  }
  const number = senderNumber(message);
  if (!number) continue;
  if (!state.allowed.includes(number)) {
   ignored++;
   log(`ignored ${number}`);
   continue;
  }
  const text = textOf(message.message);
  if (!text) continue;
  log(`message from ${number}: ${text.length} characters`);
  enqueue(current, mineEpoch, { id: uid(), number, jid, name: String(message.pushName || '').trim(), text });
 }
}

// The run goes to the main window's page, which is made, unseen, when the app has none.
function deliver(request) {
 waiting.push(request);
 if (ready && !ready.isDestroyed()) flush();
 else host.wake();
}

function flush() {
 while (waiting.length && ready && !ready.isDestroyed()) ready.send('whatsapp:ask', waiting.shift());
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

// A reply longer than one WhatsApp message is sent in parts, at a line's end where one is near.
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

async function tell(current, jid, text) {
 for (const piece of pieces(text)) {
  try {
   await current.sendMessage(jid, { text: piece });
  } catch (failure) {
   log(`send failed: ${why(failure)}`);
   return;
  }
 }
}

function enqueue(current, mineEpoch, request) {
 const turn = async () => {
  if (mineEpoch !== epoch) return;
  const typing = setInterval(() => { current.sendPresenceUpdate('composing', request.jid).catch(() => {}); }, TYPING);
  typing.unref?.();
  try {
   current.sendPresenceUpdate('composing', request.jid).catch(() => {});
   const answer = await ask(request);
   if (answer.failure) await tell(current, request.jid, answer.failure);
   else await tell(current, request.jid, answer.text || 'The agent finished without a reply.');
  } finally {
   clearInterval(typing);
   current.sendPresenceUpdate('paused', request.jid).catch(() => {});
  }
 };
 const before = chains.get(request.number) || Promise.resolve();
 const next = before.then(turn, turn).finally(() => { if (chains.get(request.number) === next) chains.delete(request.number); });
 chains.set(request.number, next);
}

async function stopSocket() {
 epoch++;
 clearTimeout(retry);
 retry = null;
 const old = socket;
 socket = null;
 qrImage = '';
 qrAt = 0;
 if (!old) return;
 try { await old.end(undefined); } catch {}
}

function dropPending(reason) {
 waiting.length = 0;
 for (const [id, job] of pending) {
  clearTimeout(job.timer);
  job.resolve({ failure: reason });
  pending.delete(id);
 }
}

async function start() {
 await stopSocket();
 error = '';
 me = '';
 if (!state.enabled) {
  status = 'off';
  publish();
  return;
 }
 status = 'starting';
 publish();
 const mineEpoch = ++epoch;
 try {
  await library();
 } catch (failure) {
  if (mineEpoch !== epoch) return;
  status = 'error';
  error = `The WhatsApp library could not be loaded: ${why(failure)}`;
  log(`unavailable: ${why(failure)}`);
  publish();
  return;
 }
 if (mineEpoch !== epoch) return;
 let auth;
 try {
  fs.mkdirSync(folder(), { recursive: true, mode: 0o700 });
  auth = await lib.useMultiFileAuthState(folder());
 } catch (failure) {
  if (mineEpoch !== epoch) return;
  status = 'error';
  error = `The WhatsApp sign-in could not be read: ${why(failure)}`;
  log(`auth failed: ${why(failure)}`);
  publish();
  return;
 }
 if (mineEpoch !== epoch) return;
 const version = await latestVersion();
 if (mineEpoch !== epoch) return;
 let fresh;
 try {
  fresh = lib.makeWASocket({
   version,
   auth: auth.state,
   logger: require('pino')({ level: 'silent' }),
   printQRInTerminal: false,
   browser: ['OpenGhost', 'Chrome', '1.0.0'],
   syncFullHistory: false,
   markOnlineOnConnect: false,
   generateHighQualityLinkPreview: false,
  });
 } catch (failure) {
  status = 'error';
  error = `The WhatsApp connection could not be made: ${why(failure)}`;
  log(`socket failed: ${why(failure)}`);
  publish();
  return;
 }
 socket = fresh;
 log('starting');
 fresh.ev.on('creds.update', () => { auth.saveCreds().catch(failure => log(`save failed: ${why(failure)}`)); });
 fresh.ev.on('connection.update', update => { onUpdate(fresh, mineEpoch, update).catch(() => {}); });
 fresh.ev.on('messages.upsert', event => { onMessages(fresh, mineEpoch, event).catch(() => {}); });
}

async function update(changes = {}) {
 let restart = false, refused = '';
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
 if (restart) {
  if (state.enabled) await start();
  else {
   dropPending('WhatsApp auto-reply was turned off.');
   await stopSocket();
   status = 'off';
   error = '';
   me = '';
   log('turned off');
   publish();
  }
 } else publish();
 return refused ? { ...view(), refused } : view();
}

module.exports = {
 // host: { store: { read, write }, fromApp, window() — the main window if there is one, wake() — makes it, unseen, if
 // there is none, changed?() — the tray follows whether the app is to stay }.
 setup(options) {
  host = options;
  loaded = host.store.read(KEY).then(raw => {
   const allowed = cleanAllowed(raw?.allowed);
   state = { enabled: !!raw?.enabled, allowed: allowed || [] };
   return start();
  }).catch(() => {});
  ipcMain.handle('whatsapp:get', async event => { if (!mine(event)) return null; await loaded; return view(); });
  ipcMain.handle('whatsapp:set', async (event, changes) => {
   if (!mine(event) || !changes || typeof changes !== 'object') return null;
   await loaded;
   return update(changes);
  });
  ipcMain.handle('whatsapp:qr', async event => { if (!mine(event)) return null; await loaded; return { qr: qrImage, at: qrAt }; });
  ipcMain.on('whatsapp:answer', (event, id, text, failure) => {
   if (!mine(event) || event.sender !== ready) return;
   settle(id, text, failure);
  });
  // The main window's page has read its library and can run the agent; it says so each time it is loaded.
  ipcMain.on('whatsapp:ready', event => {
   if (!mine(event) || event.sender !== host.window()?.webContents) return;
   ready = event.sender;
   flush();
  });
 },
 // The main window's page is gone or being read anew: what was on its way waits for a page that says it is ready.
 unready() {
  ready = null;
 },
 // Whether the app is to stay in the tray with its window closed: auto-reply is on.
 get alive() {
  return state.enabled;
 },
 stop() {
  dropPending('OpenGhost is closing.');
  stopSocket().catch(() => {});
 },
};
