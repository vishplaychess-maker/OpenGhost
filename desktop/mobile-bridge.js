'use strict';

// The window-facing side of mobile remote access. The server (desktop/mobile-companion.js) keeps the pairing, the
// devices and the sealed sockets; what a phone's message becomes — a turn of the agent in that device's chat, and the
// answer sent back — goes through here, which is the only file that speaks to a window.
//
// Only the app's own windows are answered, and one at a time: the main window's page says it is ready once its
// library has been read, and until then — or once it goes away — what a phone asked for waits. A message that comes
// while the app has no window makes one, unseen, as Telegram's and WhatsApp's do, so a phone is answered with the
// window closed.
const { ipcMain } = require('electron');
const Companion = require('./mobile-companion');

// An agent turn can run a while; the phone waiting on it is told when the app no longer has an answer to give.
const TIMEOUT = 15 * 60 * 1000;

let host = null, ready = null;
// On their way to the page, and the turns it is working on.
const queue = [], asking = new Map();

const mine = event => host?.fromApp(event);

function deliver(request) {
 queue.push(request);
 if (ready && !ready.isDestroyed()) flush();
 else host.wake();
}

function flush() {
 while (queue.length && ready && !ready.isDestroyed()) ready.send('mobile:ask', queue.shift());
}

function ask(request) {
 return new Promise(resolve => {
  const timer = setTimeout(() => {
   if (asking.delete(request.id)) resolve({ failure: 'The agent took too long to answer. Try again.' });
  }, TIMEOUT);
  timer.unref?.();
  asking.set(request.id, { resolve, timer });
  deliver(request);
 });
}

function settle(id, text, failed) {
 const job = asking.get(id);
 if (!job) return;
 asking.delete(id);
 clearTimeout(job.timer);
 job.resolve({ text: typeof text === 'string' ? text.slice(0, 200000) : '', failure: typeof failed === 'string' ? failed : '' });
}

// The turns a phone is waiting on will not be answered: the page went, or the server was turned off.
function drop(reason) {
 queue.length = 0;
 for (const [id, job] of asking) {
  clearTimeout(job.timer);
  job.resolve({ failure: reason });
  asking.delete(id);
 }
}

module.exports = {
 // host: { store: { read, write }, fromApp, window() — the main window if there is one, wake() — makes it, unseen, if
 // there is none, changed?() — the tray follows whether the app is to stay }.
 setup(options) {
  host = options;
  Companion.setup({ ...options, ask, drop });
  ipcMain.handle('mobile:get', async event => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.view();
  });
  ipcMain.handle('mobile:set', async (event, changes) => {
   if (!mine(event) || !changes || typeof changes !== 'object') return null;
   await Companion.ready();
   return Companion.update(changes);
  });
  // The QR code the mobile icon calls for, and giving one up again before a phone takes it up.
  ipcMain.handle('mobile:pair', async event => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.pair();
  });
  ipcMain.handle('mobile:unpair', async event => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.unpair();
  });
  ipcMain.handle('mobile:refresh', async event => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.refresh();
  });
  // The user's yes or no to a phone standing at the door.
  ipcMain.handle('mobile:approve', async (event, id, yes) => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.approve(String(id || ''), !!yes);
  });
  ipcMain.handle('mobile:disconnect', async (event, id) => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.disconnect(String(id || ''));
  });
  ipcMain.handle('mobile:revoke', async (event, id) => {
   if (!mine(event)) return null;
   await Companion.ready();
   return Companion.revoke(String(id || ''));
  });
  // Only the two links the app itself offers go into the clipboard.
  ipcMain.handle('mobile:copy', async (event, text) => (mine(event) ? Companion.copy(text) : false));
  ipcMain.on('mobile:answer', (event, id, text, failed) => {
   if (!mine(event) || event.sender !== ready) return;
   settle(id, text, failed);
  });
  // The main window's page has read its library and can run the agent; it says so each time it is loaded.
  ipcMain.on('mobile:ready', event => {
   if (!mine(event) || event.sender !== host.window()?.webContents) return;
   ready = event.sender;
   flush();
  });
 },
 // The main window's page is gone or being read anew: what was on its way waits for a page that says it is ready.
 unready() {
  ready = null;
 },
 // Whether the app is to stay in the tray with its window closed: a phone can only reach it while it runs.
 get alive() {
  return Companion.alive;
 },
 stop() {
  drop('OpenGhost is closing.');
  Companion.stop();
 },
};
