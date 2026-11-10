'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Tools = require('./tools');
const Browser = require('./browser');
const LLM = require('./llm');
const Keys = require('./keys');
const Pdf = require('./pdf');
const Proof = require('./proof');
const Size = require('./size');
const Quick = require('./quick');
const Lang = require('./lang');
const Reveal = require('./reveal');
const Notify = require('./notify');
const Routines = require('./routines');
const Telegram = require('./telegram');
const WhatsApp = require('./whatsapp');
const Mobile = require('./mobile-bridge');
const Skills = require('./skills');
const Update = require('./update');
const Pictures = require('./pictures');

const APP_ID = 'com.openghost.app';
const ROOT = path.join(__dirname, '..');
// Windows takes the .ico; macOS and Linux take the .png.
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TITLE_BAR = { height: 36 };
// The window of frosted glass: what is behind the app shows through wherever the page leaves it clear. Windows 11 has
// acrylic for it (Windows 10 has none), macOS has the sidebar's own material, kept while the window is not the front one.
// Linux has nothing of the kind, so there the window stays as it was.
const WINDOWS_11 = process.platform === 'win32' && Number(require('node:os').release().split('.')[2]) >= 22000;
const GLASS = WINDOWS_11 ? { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
 : process.platform === 'darwin' ? { vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000' } : null;
const CLEAR = '#00000000';
// The theme picked in Settings → Appearance. The window is painted before the page loads,
// so these colors repeat --chat-bg and --titlebar-symbols from styles.css.
const THEMES = {
 choices: ['system', 'light', 'dark'],
 dark: { background: '#191919', symbols: '#9a9a9a' },
 light: { background: '#ffffff', symbols: '#5c5c5c' },
};
const STORE_KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/;

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
app.setAppUserModelId(APP_ID);
// Started from source on Windows (electron.exe, not the installed OpenGhost.exe). Windows shows an app's notifications
// only with a shortcut of the app's own in the Start menu, and Electron, before the first one, writes it there, named
// after the program that runs (Electron), with that program's icon: the taskbar and the Task Manager then show this
// window as Electron. So from source the app puts that shortcut there itself, with the ghost on it, and Electron, finding
// it right (the same program, folder, app id and activator), leaves it. The installed app is not concerned.
const SOURCE = process.platform === 'win32' && !app.isPackaged && path.basename(process.execPath).toLowerCase() === 'electron.exe'
 ? { name: 'Electron', clsid: '{A1AD4563-AF7F-46B0-A864-E1A5A84AA546}' } : null;
if (SOURCE) app.setToastActivatorCLSID(SOURCE.clsid);
// Windows and Linux show no menu bar: copying, pasting and undo work in the page by themselves. macOS delivers Cmd+C, Cmd+V,
// Cmd+A, Cmd+Z, Cmd+Q, Cmd+H and Cmd+M only through the menu at the top of the screen, so there the app keeps the standard
// app, edit and window menus.
Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);

const themeFile = () => path.join(app.getPath('userData'), 'theme.json');

function readTheme() {
 try {
  const { choice } = JSON.parse(fs.readFileSync(themeFile(), 'utf8'));
  if (THEMES.choices.includes(choice)) return choice;
 } catch {}
 return 'dark';
}

// 'system' lets the page and the sites in the built-in browser follow the computer; light and dark hold them to one look.
nativeTheme.themeSource = readTheme();
const look = () => THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
// The computer's own languages, most preferred first, for a page that has no language picked yet (i18n.js).
const languages = () => {
 try { return [`--openghost-languages=${app.getPreferredSystemLanguages().filter(code => /^[\w-]+$/.test(code)).join(',')}`]; } catch { return []; }
};

function createShortcut() {
 const link = path.join(app.getPath('desktop'), 'OpenGhost.lnk');
 const ok = shell.writeShortcutLink(link, 'create', {
  target: process.execPath,
  args: `"${ROOT}"`,
  cwd: ROOT,
  icon: ICON,
  iconIndex: 0,
  appUserModelId: APP_ID,
  description: 'OpenGhost',
 });
 console.log(ok ? `Shortcut: ${link}` : 'Could not create the shortcut');
}

const storeDir = () => path.join(app.getPath('userData'), 'store');
const writes = new Map();
// Where the chats without a project folder are kept (Settings → General). Read before the window is made, so the
// page is never shown one place and given another a moment later: the tools keep one chat out of another's folder by
// this path, and a chat works where the page says it works.
const CHATS_KEY = 'chats-folder';

function storeFile(key) {
 if (typeof key !== 'string' || !STORE_KEY.test(key)) throw new Error(`Bad store key: ${key}`);
 return path.join(storeDir(), `${key}.json`);
}

async function readStore(key) {
 try {
  return JSON.parse(await fs.promises.readFile(storeFile(key), 'utf8'));
 } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
}

function writeStore(key, value) {
 const file = storeFile(key), data = JSON.stringify(value);
 const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, data, 'utf8');
  await fs.promises.rename(temp, file);
 });
 writes.set(file, next);
 next.finally(() => { if (writes.get(file) === next) writes.delete(file); }).catch(() => {});
 return next;
}

async function removeStore(key) {
 const file = storeFile(key);
 await (writes.get(file) || Promise.resolve()).catch(() => {});
 await fs.promises.rm(file, { force: true });
 // A chat deleted for good takes the pictures its agent showed with it.
 const chat = /^chats\/([a-z0-9-]+)$/.exec(key)?.[1];
 if (chat) await Pictures.forget(chat);
}

function external(url) {
 if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

// `unseen`: made for a routine that is due while the app waits in the tray; it shows only when the user opens the app.
function createWindow(unseen = false) {
 const size = Size.initial(1280, 840);
 const win = new BrowserWindow({
  width: size.width,
  height: size.height,
  minWidth: 500,
  minHeight: 540,
  show: false,
  title: 'OpenGhost',
  icon: ICON,
  backgroundColor: look().background,
  ...GLASS,
  // Linux window managers draw their own title bar; Windows and macOS get the app's own.
  ...(process.platform === 'linux' ? {} : {
   titleBarStyle: 'hidden',
   titleBarOverlay: { color: GLASS ? CLEAR : look().background, symbolColor: look().symbols, height: Math.round(TITLE_BAR.height * size.zoom) },
  }),
  webPreferences: {
   zoomFactor: size.zoom,
   additionalArguments: [...(GLASS ? ['--openghost-glass'] : []), ...languages()],
   preload: path.join(__dirname, 'preload.js'),
   contextIsolation: true,
   sandbox: true,
   spellcheck: true,
   webviewTag: true,
  },
 });
 win.unseen = unseen;
 win.once('ready-to-show', () => {
  win.drawn = true;
  if (!win.unseen) win.show();
 });
 Size.attach(win);
 win.webContents.on('will-attach-webview', (event, prefs, params) => {
  if (!Browser.guard(win.webContents, prefs, params)) event.preventDefault();
 });
 win.webContents.on('did-attach-webview', (event, guest) => Browser.adopt(win.webContents, guest));
 win.webContents.setWindowOpenHandler(({ url }) => {
  external(url);
  return { action: 'deny' };
 });
 win.webContents.on('will-navigate', (event, url) => {
  if (url === win.webContents.getURL()) return;
  event.preventDefault();
  external(url);
 });
 win.webContents.on('before-input-event', (event, input) => {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  // Cmd on macOS, Ctrl elsewhere.
  const command = input.meta || input.control;
  if (key === 'f12' || (command && input.shift && key === 'i') || (input.meta && input.alt && key === 'i')) {
   win.webContents.toggleDevTools();
   event.preventDefault();
  } else if (key === 'f5' || (command && !input.shift && key === 'r')) {
   win.webContents.reload();
   event.preventDefault();
  } else if (command && !input.alt && (key === '=' || key === '+' || key === '-' || key === '0')) {
   if (key === '0') Size.pick(win, 'auto');
   else Size.step(win, key === '-' ? -1 : 1);
   event.preventDefault();
  }
 });
 win.loadFile(path.join(ROOT, 'index.html'));
 return win;
}

ipcMain.handle('folder:pick', async event => {
 const win = BrowserWindow.fromWebContents(event.sender);
 const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
 if (result.canceled || !result.filePaths.length) return null;
 const folder = result.filePaths[0];
 await fs.promises.mkdir(folder, { recursive: true });
 return { path: folder, name: path.basename(folder) || folder };
});

ipcMain.handle('folder:reveal', (event, folder) => typeof folder === 'string' && shell.openPath(folder));
ipcMain.handle('folder:chats', () => Tools.CHATS);
// Chats without a project folder each keep a folder of their own under the chats folder. Pointing the app at another
// one takes what was already there along: a chat whose folder stayed behind would read as an empty one. Nothing is
// deleted, and a name already taken at the other end is left where it is and said so.
async function carry(from, to) {
 let names = [];
 try {
  names = await fs.promises.readdir(from, { withFileTypes: true });
 } catch {
  return { along: 0, left: [] };
 }
 let along = 0;
 const left = [];
 for (const entry of names.filter(item => item.isDirectory())) {
  const src = path.join(from, entry.name), dst = path.join(to, entry.name);
  if (await fs.promises.stat(dst, { throwIfNoEntry: false }) || path.resolve(src) === path.resolve(dst)) { left.push(entry.name); continue; }
  along += await fs.promises.cp(src, dst, { recursive: true, force: false, errorOnExist: true }).then(() => 1, () => { left.push(entry.name); return 0; });
 }
 return { along, left };
}
ipcMain.handle('folder:chats:set', async (event, dir) => {
 if (!fromApp(event)) return null;
 const next = Tools.chatsTo(dir);
 if (!next) return { failure: 'That is not a folder chats can be kept in.' };
 try {
  await fs.promises.mkdir(next, { recursive: true });
 } catch (error) {
  return { failure: `Nothing could be made there: ${error.message}` };
 }
 const from = Tools.CHATS;
 const carried = path.resolve(from) === path.resolve(next) ? { along: 0, left: [] } : await carry(from, next);
 Tools.setChats(next);
 await writeStore(CHATS_KEY, { version: 1, path: next });
 for (const each of BrowserWindow.getAllWindows()) if (!each.isDestroyed()) each.webContents.send('folder:chats', next);
 return { path: next, ...carried };
});
ipcMain.handle('folder:release', (event, folder) => fromApp(event) && Tools.release(folder));
ipcMain.handle('store:read', (event, key) => readStore(key));
// With the quick chat there are two windows over one store: each is told what the other has written.
const told = (event, key) => { for (const other of BrowserWindow.getAllWindows()) if (other.webContents !== event.sender && !other.isDestroyed()) other.webContents.send('store:changed', key); };
ipcMain.handle('store:write', (event, key, value) => writeStore(key, value).then(() => told(event, key)));
ipcMain.handle('store:remove', (event, key) => removeStore(key).then(() => told(event, key)));
// The page sends its background once it opens and whenever the theme changes: the title bar buttons sit on it,
// and the window shows it wherever the page has not painted yet, as while resizing.
ipcMain.on('window:titlebar', (event, color, symbols) => {
 const win = BrowserWindow.fromWebContents(event.sender);
 const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
 if (!win || !hex(color)) return;
 // The quick chat's window is the same page, which sends the same word, but it is clear and has no title bar: it
 // keeps no background of its own, and asking it for the buttons' colours is an error.
 if (win === Quick.window) return;
 if (!GLASS) win.setBackgroundColor(color);
 if (process.platform === 'linux' || typeof win.setTitleBarOverlay !== 'function') return;
 try { win.setTitleBarOverlay({ color: GLASS ? CLEAR : color, symbolColor: hex(symbols) ? symbols : look().symbols, height: Size.titleBar(win) }); } catch {}
});

const fromApp = event => event.sender.getType() === 'window' && event.senderFrame?.url.startsWith('file:');
// A press on a file or a folder in a list the agent has drawn (reveal.js says what is opened and what is only shown).
// The user's own folders where the system really keeps them, for paths the agent wrote by their usual names.
const knownFolders = () => Object.fromEntries([['Desktop', 'desktop'], ['Documents', 'documents'], ['Downloads', 'downloads'], ['Pictures', 'pictures'], ['Music', 'music'], ['Videos', 'videos']].map(([name, key]) => { try { return [name, app.getPath(key)]; } catch { return [name, '']; } }));
ipcMain.handle('path:open', (event, target) => fromApp(event) ? Reveal.open(target, shell, process.platform, knownFolders()) : 'missing');
ipcMain.handle('path:terminal', (event, target) => fromApp(event) ? Reveal.terminal(target, process.platform, knownFolders()) : 'missing');
ipcMain.handle('path:copy', async (event, target) => {
 if (!fromApp(event) || typeof target !== 'string') return false;
 clipboard.writeText((await Reveal.locate(target, knownFolders()))?.full || target);
 return true;
});
// macOS asks the user before an app first opens Desktop, Documents, Downloads or another disk, whatever the agent's own
// permission mode says; no app can answer for the user. With Full Disk Access given to OpenGhost once it no longer asks.
// Whether it is given can only be told by trying: the system's own record of permissions is readable with it alone.
const FULL_DISK = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
function diskAccess() {
 if (process.platform !== 'darwin') return null;
 try {
  // Opened, not only asked about: it is the opening that the system lets through or refuses.
  fs.closeSync(fs.openSync(path.join(app.getPath('home'), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'r'));
  return { full: true };
 } catch {
  return { full: false };
 }
}
ipcMain.handle('access:state', event => fromApp(event) ? diskAccess() : null);
// The system gives the access to an app only from its next start: switched on while the app runs, it stays refused
// until the app is opened again.
ipcMain.handle('access:restart', event => {
 if (!fromApp(event) || process.platform !== 'darwin') return;
 app.relaunch();
 app.quit();
});
ipcMain.handle('access:open', event => { if (fromApp(event) && process.platform === 'darwin') shell.openExternal(FULL_DISK); });

// The language the page speaks: the tray and the browser's menu follow it, and the quick chat's window is read anew.
ipcMain.handle('lang:set', (event, next) => {
 if (fromApp(event) && Lang.set(next)) Quick.relabel();
});

// What the About page shows: the app's version and what it runs on.
ipcMain.handle('app:about', event => fromApp(event) ? {
 version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
 platform: process.platform, arch: process.arch, system: process.getSystemVersion(),
} : null);

// Answers whether the app ends up dark: for 'system' only this side knows what the computer uses right now.
ipcMain.handle('theme:set', (event, choice) => {
 if (fromApp(event) && THEMES.choices.includes(choice) && nativeTheme.themeSource !== choice) {
  nativeTheme.themeSource = choice;
  fs.promises.writeFile(themeFile(), JSON.stringify({ choice })).catch(() => {});
 }
 return nativeTheme.shouldUseDarkColors;
});
ipcMain.handle('tool:run', (event, id, name, args, cwd, ticket) => fromApp(event) ? Tools.runTool(id, name, args, cwd, event.sender, ticket) : { error: 'Not allowed' });
ipcMain.handle('tool:authorize', (event, name, args) => fromApp(event) ? Tools.authorize(name, args, event.sender) : { error: 'Not allowed' });
ipcMain.on('browser:shown', (event, value) => { if (fromApp(event)) Browser.setShown(value); });
ipcMain.handle('tool:cancel', (event, id) => { if (fromApp(event)) Tools.cancel(id); });
ipcMain.handle('tool:environment', event => fromApp(event) ? Tools.environment() : null);
ipcMain.handle('tool:guide', (event, folder) => fromApp(event) ? Tools.guide(folder) : null);
// Agents sharing a folder (Desk in chat.js): which files a command changed, and the ports this computer listens on.
ipcMain.handle('tool:mark', (event, folder) => fromApp(event) ? Tools.mark(folder) : '');
ipcMain.handle('tool:changed', (event, token) => fromApp(event) ? Tools.changed(token) : []);
ipcMain.handle('tool:ports', event => fromApp(event) ? Tools.ports() : []);
ipcMain.handle('tool:changes', (event, token) => fromApp(event) ? Tools.changes(token) : { touched: [], added: [], removed: [] });
// What the app looks at itself before a step of the agent's plan is closed (desktop/proof.js).
ipcMain.handle('proof:facts', (event, file) => fromApp(event) ? Proof.facts(file) : { exists: false });
ipcMain.handle('proof:project', (event, cwd) => fromApp(event) ? Proof.project(cwd) : { checks: [], tests: false });
ipcMain.handle('proof:glimpse', (event, request) => fromApp(event) ? Proof.glimpse(request) : { ok: false, error: 'not allowed' });
// Skills (desktop/skills.js): those a chat can use, one's instructions, and one put in from a link; every window is told.
Skills.setup({ fromApp, chats: () => Tools.CHATS, changed: () => { for (const each of BrowserWindow.getAllWindows()) if (!each.isDestroyed()) each.webContents.send('skills:changed'); } });
ipcMain.handle('pdf:read', (event, source) => fromApp(event) ? Pdf.read(source) : { text: '', reason: 'unreadable' });
LLM.register(fromApp);
Keys.register(fromApp);
Size.setup(fromApp);
// The pictures the agent shows (desktop/pictures.js): one from the internet or a file, kept for its chat.
const picture = work => work.catch(error => ({ error: error.plain ? error.message : `The picture could not be kept: ${error.message}` }));
ipcMain.handle('pictures:web', (event, chat, url, page, sealed) => fromApp(event) ? picture(Pictures.fromWeb(chat, url, page, undefined, !!sealed)) : { error: 'Not allowed' });
ipcMain.handle('pictures:file', (event, chat, file, sealed) => fromApp(event) ? picture(Pictures.fromFile(chat, file, undefined, !!sealed)) : { error: 'Not allowed' });
// A chat with a password: its key for pictures while it is open, sealing or opening them all, and a fork's copies.
ipcMain.handle('pictures:unlock', (event, chat, raw) => { if (fromApp(event)) Pictures.unlock(chat, raw); });
ipcMain.handle('pictures:lock', (event, chat) => { if (fromApp(event)) Pictures.lock(chat); });
ipcMain.handle('pictures:reseal', (event, chat, raw, sealing) => fromApp(event) ? Pictures.reseal(chat, raw, !!sealing) : null);
ipcMain.handle('pictures:copy', (event, from, to) => fromApp(event) ? Pictures.copy(from, to) : null);
// The menu of a right click (edit-menu.js): what it chose is done by the window to where its keyboard is, as the keys would.
const EDITS = new Set(['cut', 'copy', 'paste', 'selectAll']);
ipcMain.handle('edit:do', (event, action) => { if (fromApp(event) && EDITS.has(action)) event.sender[action](); });
Pictures.register();

// The app keeps everything of a person in one folder, and Windows puts that folder under C:\Users\<name>\AppData.
// The move off it goes to a folder beside the app's own — the repository's parent while one is being worked on — and
// nowhere at all in a built app, where guessing would name some stranger's Program Files. On any machine an
// environment word says another place instead, and for a built app it is the only way the move is asked for.
// The old folder is only ever read from and nothing in it is deleted: the move is undone by taking away the word
// written below and starting again, and both copies stay whole until the new one is checked over by hand.
const MOVED = '.openghost-data-moved';
const DATA_HOME = dataHome();

// The place asked for, or none. A word said for it wins, so a folder already holding the data of a person is found
// again whatever the app is sitting in.
function dataHome() {
	const said = String(process.env.OPENGHOST_DATA_HOME || '').trim();
	if (said) return path.resolve(said);
	// Where the app lives while it is being worked on is its own folder; the place beside it is the one a person
	// would choose without being told.
	return app.isPackaged ? null : path.join(path.dirname(app.getAppPath()), '.openghost-data');
}
// What Chromium makes again by itself once its folder has moved: page parts, shader blobs, its own locks. Not carried
// over is not left behind — a cache is nothing a person lost.
const REGROWN = new Set(['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache', 'Shared Dictionary', 'Service Worker', 'blob_storage', 'DIPS', 'DIPS-wal', 'lockfile', 'declarative_performance_observer.db', 'declarative_performance_observer.db-journal']);

// Whether another OpenGhost holds this folder: Chromium keeps its lockfile to itself while it runs, and a folder read
// through a running program's locks can catch a chat half-written and carry the half over for good.
function inUse(where) {
 try {
  fs.closeSync(fs.openSync(path.join(where, 'lockfile'), 'r+'));
  return false;
 } catch (error) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
 }
}

// Every file that is not a cache, with the folders they hang in. Names back what was put down and how big it was.
function carry(from, to, at = '', done = []) {
 fs.mkdirSync(to, { recursive: true });
 for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
  if (REGROWN.has(entry.name)) continue;
  const source = path.join(from, entry.name), target = path.join(to, entry.name), name = at ? `${at}/${entry.name}` : entry.name;
  if (entry.isDirectory()) carry(source, target, name, done);
  else if (entry.isFile()) {
   fs.copyFileSync(source, target);
   done.push([name, fs.statSync(source).size]);
  }
 }
 return done;
}

// A move is kept only when every file came over with the bytes it went with. A folder left by a move that did not
// finish is written into again, so this is asked after every try and not only the first.
function short(where, copied) {
 const gaps = [];
 for (const [name, size] of copied) {
  let came = 0;
  try { came = fs.statSync(path.join(where, ...name.split('/'))).size; } catch {}
  if (came !== size) gaps.push(`${name} (${came} of ${size} bytes)`);
 }
 return gaps;
}

function moveDataHome() {
 // Nothing to do where no place was asked for: off Windows, and in a built app that was not told where to go.
 if (process.platform !== 'win32' || !DATA_HOME) return;
 // A folder asked for on the command line is a word said on purpose, and the move stands down before it.
 if (process.argv.some(arg => String(arg).startsWith('--user-data-dir'))) return;
 const from = app.getPath('userData');
 if (path.resolve(from).toLowerCase() === path.resolve(DATA_HOME).toLowerCase()) return;
 // One word says a move was finished. After it the app only takes the new folder and carries nothing again, so a chat
 // written where the data now lives is never overwritten by its older self from the other drive.
 if (fs.existsSync(path.join(DATA_HOME, MOVED))) {
  app.setPath('userData', DATA_HOME);
  return;
 }
 // A folder that already holds something, with no word that a move finished, is a profile from somewhere else and not
 // ours to write into: the chats it holds that the live one has done with would come back wearing the older date.
 let already = 0;
 try { already = fs.readdirSync(DATA_HOME).length; } catch {}
 if (already) {
  console.error(`OpenGhost stayed on ${from}: ${DATA_HOME} already holds ${already} entries and this app did not put them there. Empty it, or name another folder, and start again.`);
  return;
 }
 if (!fs.existsSync(from)) return;
 if (inUse(from)) {
  console.error(`OpenGhost stayed on ${from}: another OpenGhost has that folder open. Quit it and start again to move the data.`);
  return;
 }
 try {
  const copied = carry(from, DATA_HOME);
  const gaps = short(DATA_HOME, copied);
  if (gaps.length) throw new Error(`${gaps.length} of ${copied.length} files did not come over: ${gaps.slice(0, 3).join(', ')}`);
  fs.writeFileSync(path.join(DATA_HOME, MOVED), `moved from ${from} on ${new Date().toISOString()}\n`);
  app.setPath('userData', DATA_HOME);
  // Windows locks the providers' keys to this person's login and not to the folder they sit in, and the word that
  // unlocks them came over with them as Local State. If a provider asks to be signed in again, that is the reason and
  // only that: nothing of the chats, the settings or the models moved wrong.
  console.log(`OpenGhost moved ${copied.length} files of its data to ${DATA_HOME}. ${from} is left exactly as it was, to be removed by hand once the new folder is checked over.`);
 } catch (error) {
  // Nothing of the old folder was written to, so a move that did not finish costs only the retry.
  console.error(`OpenGhost stayed on ${from}: the move did not finish (${error.message}).`);
 }
}

moveDataHome();

if (process.argv.includes('--create-shortcut')) {
 app.whenReady().then(() => {
  createShortcut();
  app.quit();
 });
} else if (!app.requestSingleInstanceLock()) {
 app.quit();
} else {
 let win = null;
 // Out of sight (minimized, or behind other windows) a page is slowed down: its clocks wake rarely, after a while once
 // a minute. While an agent is at work in the window it is not: the agent goes on as fast as on screen. Once no agent
 // works it is slowed down again, at once if the window is on screen; a window out of sight is let be until it is back,
 // as changing the setting wakes a hidden page (as desktop/quick.js says) and it would then not sleep.
 let working = false;
 const keepAwake = () => {
  if (!win || win.isDestroyed()) return;
  const slowed = win.webContents.getBackgroundThrottling();
  if (working) { if (slowed) win.webContents.setBackgroundThrottling(false); return; }
  if (!slowed && win.isVisible() && !win.isMinimized()) win.webContents.setBackgroundThrottling(true);
 };
 ipcMain.on('app:working', (event, on) => {
  if (!win || event.sender !== win.webContents) return;
  working = !!on;
  keepAwake();
 });
 // The main window, made if the app has been waiting in the tray without it; `then` gets it once its page is there.
 // `unseen`: made for a routine, it is not shown, and one that is there already is left where it is.
 const showMain = (then, unseen = false) => {
  const fresh = !win;
  if (!win) {
   win = createWindow(unseen);
   const contents = win.webContents;
   win.on('closed', () => {
    win = null;
    Routines.unready();
    Telegram.unready();
    WhatsApp.unready();
    Mobile.unready();
    // With the quick chat on, a routine on, the Telegram bot on, WhatsApp auto-reply on, or a phone able to reach the
    // app, the app goes on in the tray, and an agent at work in the quick chat is not stopped: only what this window
    // asked for is. Otherwise closing the window ends everything and the app.
    if (Quick.on || Routines.alive || Telegram.alive || WhatsApp.alive || Mobile.alive) { LLM.cancelFrom(contents); return; }
    Tools.cancelAll();
    LLM.cancelAll();
    Pdf.cancelAll();
    Proof.cancelAll();
    app.quit();
   });
  }
  if (fresh) {
   win.webContents.on('did-finish-load', () => Notify.paint());
   // Read anew, the page takes no routine, Telegram, WhatsApp or mobile message until it says it is ready again.
   win.webContents.on('did-start-loading', () => { Routines.unready(); Telegram.unready(); WhatsApp.unready(); Mobile.unready(); });
   win.on('restore', keepAwake);
   win.on('show', keepAwake);
  }
  if (!unseen) {
   if (win.isMinimized()) win.restore();
   // A window made unseen and not drawn yet is shown once it is (createWindow); one already drawn, at once.
   const was = win.unseen;
   win.unseen = false;
   if (!fresh && (!was || win.drawn)) { win.show(); win.focus(); }
  }
  if (!then) return;
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => then(win));
  else then(win);
 };
 app.on('second-instance', () => showMain());
 app.on('activate', () => showMain());
 // The button on the page shown after a sign-in in the browser (chatgpt.js).
 app.on('openghost:show', () => showMain());
 app.whenReady().then(() => {
  try {
   Tools.setChats(JSON.parse(fs.readFileSync(storeFile(CHATS_KEY), 'utf8'))?.path);
  } catch {}
  if (SOURCE) {
   shell.writeShortcutLink(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${SOURCE.name}.lnk`), 'create', {
    target: process.execPath, cwd: path.dirname(process.execPath), args: `"${ROOT}"`, icon: ICON, iconIndex: 0,
    appUserModelId: APP_ID, toastActivatorClsid: SOURCE.clsid, description: SOURCE.name,
   });
  }
  Pictures.serve();
  // A notification pressed opens the app on its chat; one of the quick chat's opens there too, as the chat is in the
  // list with the others.
  Notify.setup({ fromApp, icon: ICON, window: () => win, open: key => showMain(main => main.webContents.send('notify:open', key)) });
  // A routine due with no window: the window is made unseen and its page runs it. While a routine is on the app keeps
  // its place in the tray, the quick chat on or not.
  Routines.setup({ store: { read: readStore, write: writeStore }, fromApp, window: () => win, wake: () => showMain(null, true), changed: () => Quick.retray() });
  Lang.load();
  Browser.setup();
  Keys.load();
  Quick.setup({
   fromApp, glass: GLASS, look, external, showMain, zoom: display => Size.zoom(display), icon: ICON, trayIcon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'), stay: () => Routines.alive || Telegram.alive || WhatsApp.alive || Mobile.alive,
   preload: path.join(__dirname, 'preload.js'), page: path.join(ROOT, 'index.html'), languages,
  });
  // The Telegram bot (desktop/telegram.js): a message makes the main window unseen if it is not there and its page runs
  // the agent turn. While the bot is on the app keeps its place in the tray.
  Telegram.setup({ store: { read: readStore, write: writeStore }, fromApp, window: () => win, wake: () => showMain(null, true), changed: () => Quick.retray() });
  // WhatsApp (desktop/whatsapp.js): the WhatsApp Web session kept in the app, answered by the agent of a chat of its own.
  // A message makes the main window unseen if it is not there; while auto-reply is on the app stays in the tray.
  WhatsApp.setup({ store: { read: readStore, write: writeStore }, fromApp, window: () => win, wake: () => showMain(null, true), changed: () => Quick.retray() });
  // Mobile remote access (desktop/mobile-companion.js, its window-facing side in desktop/mobile-bridge.js): a phone
  // pairs by a QR code and the agent answers it. A message makes the main window unseen if it is not there; while it
  // listens the app stays in the tray, since a phone can only reach an app that is running.
  Mobile.setup({ store: { read: readStore, write: writeStore }, fromApp, window: () => win, wake: () => showMain(null, true), changed: () => Quick.retray() });
  // A new version of the app (desktop/update.js), put in only while no agent works, here or in the quick chat.
  Update.setup({ fromApp, window: () => win, busy: () => working || Quick.working });
  if (!Quick.startHidden) showMain();
 });
 app.on('window-all-closed', () => { if (!Quick.on && !Routines.alive && !Telegram.alive && !WhatsApp.alive && !Mobile.alive) app.quit(); });
 app.on('before-quit', event => {
  Telegram.stop();
  WhatsApp.stop();
  Mobile.stop();
  Tools.cancelAll();
  Proof.cancelAll();
  if (!writes.size) return;
  event.preventDefault();
  Promise.allSettled([...writes.values()]).then(() => app.quit());
 });
}
