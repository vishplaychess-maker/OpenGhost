'use strict';

// Control of the real computer: the mouse, the keyboard and a look at the screen, for working other apps (desktop/tools.js).
// Every action that affects the computer needs a ticket the renderer asks for only after the user has allowed that exact
// action on a card (chat.js, agent-tools.js). A ticket names the tool and its arguments, works once and soon expires, so
// no path in the agent loop can click or type on its own, in any approval mode, and a changed action is refused.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const INPUT = new Set(['move_mouse', 'left_click', 'right_click', 'type_text', 'press_key']);
const NAMES = new Set([...INPUT, 'take_screenshot']);
const TICKET = { seconds: 300, most: 300 };
const SCREEN = { width: 1600, quality: 72 };
const LOG = { bytes: 512 * 1024 };
const TEXT = { most: 10000 };
const HOLD = 30;

// Key names as a person writes them, onto the names of the automation library (nut.js).
const KEYS = {
 enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', space: 'Space', spacebar: 'Space',
 tab: 'Tab', backspace: 'Backspace', back: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
 home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
 up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
 caps: 'CapsLock', capslock: 'CapsLock', numlock: 'NumLock', print: 'Print', printscreen: 'Print', pause: 'Pause',
 menu: 'Menu', help: 'Help', clear: 'Clear',
 '-': 'Minus', '=': 'Equal', '[': 'LeftBracket', ']': 'RightBracket', '\\': 'Backslash', ';': 'Semicolon',
 "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Grave',
};
const MODIFIERS = {
 ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', option: 'LeftAlt',
 win: 'LeftSuper', windows: 'LeftSuper', super: 'LeftSuper', meta: 'LeftSuper', cmd: 'LeftSuper', command: 'LeftSuper',
};
let nut = null;
let loading = null;
let chain = Promise.resolve();
const tickets = new Map();

// Every action waits its turn: two chats' agents must not take the mouse from each other halfway.
function serial(work) {
 const next = chain.then(work, work);
 chain = next.then(() => {}, () => {});
 return next;
}

function library() {
 loading ||= Promise.resolve().then(() => {
  const loaded = require('@nut-tree-fork/nut-js');
  loaded.mouse.config.autoDelayMs = 12;
  loaded.mouse.config.mouseSpeed = 2500;
  loaded.keyboard.config.autoDelayMs = 8;
  nut = loaded;
  return loaded;
 }).catch(error => {
  loading = null;
  throw error;
 });
 return loading;
}

// The log lives beside the app's own data, under the profile folder: on this computer that is on the D: drive. What was
// typed is never written, only how much.
function log(line) {
 try {
  const dir = path.join(app.getPath('userData'), 'automation');
  const file = path.join(dir, 'automation.log');
  fs.mkdirSync(dir, { recursive: true });
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > LOG.bytes) fs.renameSync(file, path.join(dir, 'automation.old.log'));
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
 } catch {}
}

function permission() {
 if (process.platform === 'darwin') return 'Allow OpenGhost in System Settings → Privacy & Security → Accessibility (mouse and keyboard) and Screen Recording (screenshots), then start it again.';
 return '';
}

function trouble(error) {
 const text = String(error && error.message || error || 'unknown error').replace(/\s+/g, ' ').trim();
 const ask = permission();
 return `${text}${ask ? ` ${ask}` : ''}`;
}

const digest = (name, args) => crypto.createHash('sha256').update(JSON.stringify([name, args])).digest('hex');
const owner = sender => String(sender === undefined || sender === null ? '' : sender);

function prune() {
 const now = Date.now();
 for (const [token, row] of tickets) if (row.expires < now) tickets.delete(token);
 while (tickets.size >= TICKET.most) tickets.delete(tickets.keys().next().value);
}

// One ticket for one action: the renderer asks after the user has allowed it, and the action must come back unchanged.
function authorize(name, args, sender) {
 if (!NAMES.has(name)) return { error: `Unknown tool ${name}` };
 if (!INPUT.has(name)) return { error: `${name} does not need approval` };
 prune();
 const token = crypto.randomBytes(24).toString('hex');
 tickets.set(token, { hash: digest(name, args), owner: owner(sender), expires: Date.now() + TICKET.seconds * 1000 });
 return { ticket: token };
}

function consume(name, args, ticket, sender) {
 const row = tickets.get(String(ticket || ''));
 if (!row) return 'This mouse or keyboard action was not approved. Ask the user to allow it first.';
 tickets.delete(String(ticket));
 if (row.expires < Date.now()) return 'The approval for this action has expired. Ask the user again.';
 if (row.owner !== owner(sender)) return 'This approval belongs to another window. Ask the user to allow the action here.';
 if (row.hash !== digest(name, args)) return 'The action changed after it was approved. Ask the user to allow the new action.';
 return '';
}

// "Ctrl+Shift+S", "Enter", "F5", "Alt+Tab" → the keys to hold, the last one being the key itself.
function combination(value) {
 const parts = String(value || '').split('+').map(part => part.trim()).filter(Boolean);
 if (!parts.length) return { error: 'key is empty' };
 if (parts.length > 5) return { error: 'a shortcut has at most four modifiers and one key' };
 const keys = [], seen = new Set();
 for (const part of parts.slice(0, -1)) {
  const modifier = MODIFIERS[part.toLowerCase()];
  if (!modifier) return { error: `"${part}" is not a modifier. Use Ctrl, Shift, Alt or Win before the key.` };
  if (seen.has(modifier)) return { error: `"${part}" is given twice` };
  seen.add(modifier);
  keys.push(modifier);
 }
 const last = parts[parts.length - 1], lower = last.toLowerCase();
 if (MODIFIERS[lower]) return { error: `"${last}" is a modifier; name the key to press with it, as in Ctrl+${last}` };
 let key = KEYS[lower] || (last.length === 1 && /[a-z]/i.test(last) ? last.toUpperCase() : null) || (/^f([1-9]|1\d|2[0-4])$/i.test(last) ? last.toUpperCase() : null) || (/^[0-9]$/.test(last) ? `Num${last}` : null);
 if (!key) return { error: `Unknown key "${last}". Use a letter, a digit, F1 to F24, Enter, Escape, Tab, Space, Backspace, Delete, Insert, Home, End, PageUp, PageDown, an arrow, or a punctuation key.` };
 if (!(key in nut.Key)) return { error: `Unknown key "${last}"` };
 keys.push(key);
 return { keys, label: [...keys.slice(0, -1).map(name => Object.keys(MODIFIERS).find(alias => MODIFIERS[alias] === name)), key].join('+') };
}

async function screenSize() {
 const { screen } = await library();
 return { width: await screen.width(), height: await screen.height() };
}

async function point(args) {
 const x = Math.round(Number(args.x)), y = Math.round(Number(args.y));
 if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('x and y must be numbers in screen pixels'), { plain: true });
 const size = await screenSize();
 if (x < 0 || x >= size.width || y < 0 || y >= size.height) {
  throw Object.assign(new Error(`x must be 0 to ${size.width - 1} and y 0 to ${size.height - 1} on this screen; take a screenshot to see where things are`), { plain: true });
 }
 return { x, y };
}

async function moveMouse(args) {
 const { mouse } = await library();
 const at = await point(args);
 await mouse.setPosition(at);
 return { x: at.x, y: at.y };
}

async function click(button) {
 const { mouse } = await library();
 if (button === 'left') await mouse.leftClick();
 else await mouse.rightClick();
 return { button };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function typeText(args) {
 const text = args.text;
 if (typeof text !== 'string' || !text) return { error: 'text is empty' };
 if (text.length > TEXT.most) return { error: `text is longer than ${TEXT.most} characters; type it in parts` };
 const { keyboard, Key } = await library();
 const lines = text.replace(/\r\n?/g, '\n').split('\n');
 for (const [k, line] of lines.entries()) {
  if (k) await tap(keyboard, Key, 'Enter');
  for (const [n, piece] of line.split('\t').entries()) {
   if (n) await tap(keyboard, Key, 'Tab');
   if (piece) await keyboard.type(piece);
  }
 }
 return { chars: text.length };
}

async function tap(keyboard, Key, name) {
 await keyboard.pressKey(Key[name]);
 try { await wait(HOLD); } finally { await keyboard.releaseKey(Key[name]); }
}

async function pressKey(args) {
 const combo = combination(args.key);
 if (combo.error) return { error: combo.error };
 const { keyboard, Key } = await library();
 const keys = combo.keys.map(name => Key[name]);
 await keyboard.pressKey(...keys);
 try { await wait(HOLD); } finally { await keyboard.releaseKey(...[...keys].reverse()); }
 return { key: combo.label };
}

async function screenshot() {
 const { screen } = await library();
 const shot = await screen.grab();
 if (!shot?.width || !shot?.height) return { error: 'The screen could not be read' };
 const size = { width: shot.width, height: shot.height };
 const scale = Math.min(1, SCREEN.width / size.width);
 // nut.js hands its own image: BGR bytes unless it says otherwise. Electron reads BGRA on Windows and Linux and RGBA
 // on a Mac, so only the odd one out has red and blue swapped.
 const bgra = process.platform !== 'darwin', rgb = shot.colorMode === 1;
 let buffer = Buffer.from(shot.data.buffer, shot.data.byteOffset, shot.data.byteLength);
 if (rgb === bgra) {
  buffer = Buffer.from(buffer);
  for (let i = 0; i < buffer.length; i += 4) { const blue = buffer[i]; buffer[i] = buffer[i + 2]; buffer[i + 2] = blue; }
 }
 let image = nativeImage.createFromBitmap(buffer, size);
 if (image.isEmpty()) return { error: 'The screen could not be turned into a picture' };
 if (scale < 1) image = image.resize({ width: Math.round(size.width * scale), quality: 'good' });
 const jpeg = image.toJPEG(SCREEN.quality), shown = image.getSize();
 return { image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: shown.width, height: shown.height, screen: size, bytes: jpeg.length };
}

const ACTIONS = { move_mouse: moveMouse, left_click: () => click('left'), right_click: () => click('right'), type_text: typeText, press_key: pressKey, take_screenshot: screenshot };

// `args` came from the model as JSON. Input actions are refused without the ticket the approval card's Allow produced.
async function run(id, name, args, ticket, sender) {
 if (!NAMES.has(name)) return { error: `Unknown tool ${name}` };
 if (INPUT.has(name)) {
  const refused = consume(name, args, ticket, sender);
  if (refused) {
   log(`${name} refused: ${refused}`);
   return { error: refused };
  }
 }
 try {
  await library();
 } catch (error) {
  log(`${name} unavailable: ${error && error.message || error}`);
  return { error: `Desktop control is not available: ${trouble(error)}` };
 }
 return serial(async () => {
  const started = Date.now();
  try {
   const result = await ACTIONS[name](args || {});
   const detail = result.error ? `failed: ${result.error}` : name === 'type_text' ? `${result.chars} characters` : name === 'take_screenshot' ? `${result.screen.width}×${result.screen.height}` : JSON.stringify({ ...result, image: undefined });
   log(`${name} ${detail}`);
   return result;
  } catch (error) {
   const message = trouble(error);
   log(`${name} failed: ${error && error.message || error}`);
   return { error: message };
  } finally {
   if (process.env.OPENGHOST_AUTOMATION_TRACE) log(`${name} took ${Date.now() - started} ms`);
  }
 });
}

module.exports = { NAMES, INPUT, authorize, run };
