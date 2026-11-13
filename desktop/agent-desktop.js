'use strict';

// Reading and operating other programs through the operating system's own account of them: the accessibility tree, not
// the screen. This engine speaks to agent-desktop, the command line tool Vercel Labs ships for that (Apache-2.0).
//
// It is deliberately NOT a dependency. Its per-platform binaries are some 30 MB, and the installer has no business
// carrying them, so the program is looked for where a person who installed it would have it. When it is not there,
// that is said in one line with the command that puts it there.
//
// Nothing here goes through a shell. Every word the model writes becomes one argument, checked against what that
// command takes: an application called `Evil; rm -rf "/x` is a name to the program and not a second command. On
// Windows the shim npm leaves on the path can only be run with a shell, which concatenates rather than escapes
// arguments, so the engine resolves the native binary beside it and runs that. Refs — the addresses of elements, as
// `@s8f3k2p9:e12` — are matched to a shape and passed whole; the program re-identifies the element before it acts.
//
// What changes the computer needs a ticket, exactly as the mouse-and-keyboard engine does
// (desktop/automation-tool.js): the renderer asks for one only after the user has allowed that one action on a card,
// it names the tool and its arguments, works once, and soon expires. That pattern is repeated here rather than
// shared, because the other engine is a working safety path with no test of its own, and lifting its ticketing out
// from under it to serve a new tool was the riskier way to spend the same lines.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const OBSERVE = new Set(['desktop_status', 'desktop_apps', 'desktop_windows', 'desktop_snapshot', 'desktop_find', 'desktop_read', 'desktop_scroll']);
const ACT = new Set(['desktop_click', 'desktop_type', 'desktop_press', 'desktop_drag', 'desktop_window', 'desktop_launch', 'desktop_close']);
const NAMES = new Set([...OBSERVE, ...ACT]);
const REF = /^@[A-Za-z0-9_-]{1,64}:e[0-9]{1,7}$/;
const SURFACES = new Set(['window', 'focused', 'menu', 'menubar', 'sheet', 'popover', 'alert', 'desktop', 'taskbar', 'system-tray', 'quick-settings', 'notification-center', 'toolbar', 'dock', 'start-menu', 'action-center']);
const PROPS = new Set(['text', 'value', 'title', 'bounds', 'role', 'states']);
const STATES = new Set(['visible', 'enabled', 'checked', 'focused', 'expanded', 'selected']);
const SIDES = new Set(['up', 'down', 'left', 'right']);
// The window words the model may use, onto the commands the program really has.
const WINDOWS = { focus: 'focus-window', minimize: 'minimize', maximize: 'maximize', restore: 'restore', resize: 'resize-window', move: 'move-window' };

const MISSING = 'agent-desktop is not on this computer. Install it with: npm install -g agent-desktop';
const LIMIT = 24000;          // how much of a tree reaches the model
const TEXT = { most: 10000 }; // how much goes into a field at once
const TICKET = { seconds: 300, most: 300 };
const CALL = { ms: 30000 };

const owner = sender => String(sender === undefined || sender === null ? '' : sender);
const digest = (name, args) => crypto.createHash('sha256').update(JSON.stringify([name, args || {}])).digest('hex');
const word = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
const fail = error => ({ error });

// --- what the model asks for, as the program wants it --------------------------------------------------

// A key combo is checked before it is sent: `ctrl+` would be a modifier waiting for a key that never comes.
function combo(value) {
 const text = String(value || '');
 if (!/^[A-Za-z0-9+-]{2,40}$/.test(text) || text.startsWith('+') || text.endsWith('+') || text.includes('++')) return null;
 const parts = text.split('+');
 if (parts.length > 5 || parts.some(part => !part)) return null;
 return text.toLowerCase();
}

function plan(name, a = {}) {
 if (!NAMES.has(name)) return fail(`Unknown tool ${name}`);
 // Physical input is the program's `--headed` mode: it takes the foreground and moves the cursor. It is never taken
 // from what the model writes — only drag needs it, and there the engine says so itself.
 for (const key of ['headed', '--headed', 'xy', '--xy', 'force', '--force']) if (key in a && !(name === 'desktop_close' && key === 'force')) return fail(`"${key}" is not something you may pass`);
 const app = a.app === undefined ? null : word(a.app, 200);
 if (a.app !== undefined && !app) return fail('an application is named by one short word');
 const id = a.windowId === undefined ? null : word(a.windowId, 40);
 if (a.windowId !== undefined && !id) return fail('a window id comes from desktop_windows');
 const out = [];
 switch (name) {
  case 'desktop_status':
   return { args: ['status'] };
  case 'desktop_apps':
   out.push('list-apps'); if (app) out.push('--app', app); return { args: out };
  case 'desktop_windows':
   out.push('list-windows'); if (app) out.push('--app', app); return { args: out };
  case 'desktop_snapshot': {
   out.push('snapshot');
   if (app) out.push('--app', app);
   if (id) out.push('--window-id', id);
   if (a.surface !== undefined) {
    if (!SURFACES.has(a.surface)) return fail('that surface is not one the program knows');
    out.push('--surface', a.surface);
   }
   if (a.root !== undefined) {
    if (!REF.test(String(a.root))) return fail('a root must be a ref from a snapshot, as @s8f3k2p9:e3');
    out.push('--root', a.root);
   }
   if (a.maxDepth !== undefined) {
    const depth = whole(a.maxDepth, 1, 20);
    if (depth === null) return fail('a tree depth of 1 to 20');
    out.push('--max-depth', String(depth));
   }
   if (a.interactive === true) out.push('-i');
   if (a.compact === true) out.push('--compact');
   if (a.skeleton === true) out.push('--skeleton');
   return { args: out };
  }
  case 'desktop_find': {
   out.push('find');
   if (app) out.push('--app', app);
   if (id) out.push('--window-id', id);
   for (const [key, flag] of [['role', '--role'], ['name', '--name'], ['text', '--text']]) {
    if (a[key] === undefined) continue;
    const value = word(a[key], 200);
    if (!value) return fail(`${flag} wants a short piece of text`);
    out.push(flag, value);
   }
   return out.length > 1 ? { args: out } : fail('name something to find: a role, a name, or some text');
  }
  case 'desktop_read': {
   if (!REF.test(String(a.ref))) return fail('a ref must come from a snapshot, as @s8f3k2p9:e12');
   const state = a.kind === 'state';
   const allowed = state ? STATES : PROPS;
   if (a.property !== undefined && !allowed.has(a.property)) return fail(`the ${state ? 'states' : 'properties'} are ${[...allowed].join(', ')}`);
   out.push(state ? 'is' : 'get', a.ref);
   if (a.property !== undefined) out.push('--property', a.property);
   return { args: out };
  }
  case 'desktop_scroll': {
   if (!REF.test(String(a.ref))) return fail('a ref must come from a snapshot, as @s8f3k2p9:e12');
   const direction = a.direction === undefined ? 'down' : a.direction;
   if (!SIDES.has(direction)) return fail('scroll goes up, down, left or right');
   const amount = a.amount === undefined ? 3 : whole(a.amount, 1, 50);
   if (amount === null) return fail('between 1 and 50 units at a time');
   return { args: ['scroll', a.ref, '--direction', direction, '--amount', String(amount)] };
  }
  case 'desktop_click': {
   if (!REF.test(String(a.ref))) return fail('a ref must come from a snapshot, as @s8f3k2p9:e12');
   const action = a.action === undefined ? 'press' : a.action;
   // A double click has no semantic path: the program will only do it physically, which takes the foreground.
   if (action === 'double') return { args: ['double-click', a.ref, '--headed'], physical: true };
   if (action === 'right') return { args: ['right-click', a.ref] };
   if (action !== 'press') return fail('a click is press, right or double');
   return { args: ['click', a.ref] };
  }
  case 'desktop_type': {
   if (!REF.test(String(a.ref))) return fail('a ref must come from a snapshot, as @s8f3k2p9:e12');
   if (typeof a.text !== 'string' || !a.text.length) return fail('there is nothing to type');
   if (a.text.length > TEXT.most) return fail(`that is ${a.text.length} characters; ${TEXT.most} at most in one call`);
   return { args: ['type', a.ref, a.text] };
  }
  case 'desktop_press': {
   const keys = combo(a.combo);
   if (!keys) return fail('a combo is keys joined by +, as ctrl+s or return');
   out.push('press', keys);
   if (app) out.push('--app', app);
   if (id) out.push('--window-id', id);
   // The program refuses shortcuts it calls dangerous unless --force says otherwise. Nothing here ever says so.
   return { args: out };
  }
  case 'desktop_drag': {
   for (const key of ['from', 'to']) if (!REF.test(String(a[key]))) return fail(`${key} must be a ref from a snapshot`);
   return { args: ['drag', '--from', a.from, '--to', a.to, '--headed'], physical: true };
  }
  case 'desktop_window': {
   const command = WINDOWS[a.action];
   if (!command) return fail(`a window action is ${Object.keys(WINDOWS).join(', ')}`);
   out.push(command);
   if (id) out.push('--window-id', id);
   else if (app) out.push('--app', app);
   else if (a.action !== 'focus') return fail('say which window, by application or by window id');
   if (a.action === 'resize') {
    const width = whole(a.width, 200, 16384), height = whole(a.height, 200, 16384);
    if (width === null || height === null) return fail('a resize gives both a width and a height, 200 to 16384');
    out.push('--width', String(width), '--height', String(height));
   }
   if (a.action === 'move') {
    const x = whole(a.x, -32768, 32768), y = whole(a.y, -32768, 32768);
    if (x === null || y === null) return fail('a move gives both an x and a y');
    out.push('--x', String(x), '--y', String(y));
   }
   return { args: out };
  }
  case 'desktop_launch': {
   if (!app) return fail('an application is named by one short word');
   return { args: ['launch', app] };
  }
  case 'desktop_close': {
   if (!app) return fail('an application is named by one short word');
   out.push('close-app', app);
   // Quitting gently and terminating are different things; the second is only what the user asked for.
   if (a.force === true) out.push('--force');
   return { args: out };
  }
  default:
   return fail(`Unknown tool ${name}`);
 }
}

const needsTicket = name => ACT.has(name);

// --- the gate -------------------------------------------------------------------------------------------

const tickets = new Map();

function prune() {
 const now = Date.now();
 for (const [token, row] of tickets) if (row.expires < now) tickets.delete(token);
 while (tickets.size >= TICKET.most) tickets.delete(tickets.keys().next().value);
}

function authorize(name, args, sender) {
 if (!NAMES.has(name)) return { error: `Unknown tool ${name}` };
 if (!ACT.has(name)) return { error: `${name} does not need approval` };
 prune();
 const token = crypto.randomBytes(24).toString('hex');
 tickets.set(token, { hash: digest(name, args), owner: owner(sender), expires: Date.now() + TICKET.seconds * 1000 });
 return { ticket: token };
}

function consume(name, args, ticket, sender) {
 const row = tickets.get(String(ticket || ''));
 if (!row) return 'This desktop action was not approved. Ask the user to allow it first.';
 tickets.delete(String(ticket));
 if (row.expires < Date.now()) return 'The approval for this action has expired. Ask the user again.';
 if (row.owner !== owner(sender)) return 'This approval belongs to another window. Ask the user to allow the action here.';
 if (row.hash !== digest(name, args)) return 'The action changed after it was approved. Ask the user to allow the new action.';
 return '';
}

// --- what comes back ------------------------------------------------------------------------------------

// Only a result that never landed may be sent again. Anything else may have clicked, typed or submitted once
// already, and a repeat of `toggle` undoes itself.
const retryable = envelope => envelope?.error?.disposition?.delivery === 'not_delivered' && envelope.error?.disposition?.retry === 'safe';

function explain(envelope) {
 const error = envelope?.error || {};
 const code = String(error.code || 'ERROR');
 const parts = [code];
 if (error.message) parts.push(String(error.message).slice(0, 300));
 if (error.suggestion) parts.push(`what to do: ${String(error.suggestion).slice(0, 300)}`);
 const disposition = error.disposition || null;
 parts.push(disposition && disposition.delivery === 'not_delivered'
  ? 'nothing was sent; it is safe to try again'
  : 'do not repeat it — read the live state first');
 return parts.join('. ');
}

// A whole tree is more than the model can hold: what is kept is the start and the end, with the cut said plainly.
function shown(text) {
 const clean = String(text || '').replace(/\r\n/g, '\n').trim();
 if (clean.length <= LIMIT) return clean;
 const room = Math.floor(LIMIT / 2);
 const omitted = clean.length - room * 2;
 return `${clean.slice(0, room)}\n\n[… ${omitted} characters of the tree omitted — ask for a smaller part with root, maxDepth or interactive …]\n\n${clean.slice(-room)}`;
}

// --- where it lives and where it is written down --------------------------------------------------------

// The place asked for: the worked-on app keeps its records beside itself, and a built app beside its own data. Never
// on another drive than the one the person chose.
function logDir({ packaged, repo, userData }) {
 return path.join(packaged ? userData : repo, 'agent-logs');
}

const log = (dir, row, kind = 'calls') => {
 try {
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  // What was typed is a person's words: its length and digest go down, not its content.
  const safe = { ...row, at: new Date().toISOString() };
  if (safe.args && typeof safe.args.text === 'string') safe.args = { ...safe.args, text: `${safe.args.text.length} chars ${digest('text', safe.args.text).slice(0, 12)}` };
  fs.appendFileSync(path.join(dir, `${kind}-${day}.jsonl`), `${JSON.stringify(safe)}\n`);
 } catch { /* a log that will not write is not a reason to lose the action */ }
};

// A record of an answer moving to another model, in a file of its own: someone asking why a reply came from a model
// they did not choose should not have to read every tool call of the day to find it.
function logLine(row) {
 log(logDir({ packaged: app.isPackaged, repo: app.getAppPath(), userData: app.getPath('userData') }), row, 'fallback');
}

// --- finding the program ---------------------------------------------------------------------------------

let found = null;

// The npm shim on Windows can only be run through a shell, which joins arguments instead of escaping them, so the
// native binary beside it is looked for and run directly. Elsewhere the name on the path is a real program.
function candidates() {
 const said = String(process.env.AGENT_DESKTOP_BIN || '').trim();
 if (said) return [said];
 if (process.platform !== 'win32') return ['agent-desktop'];
 const exe = `agent-desktop-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe`;
 const from = [];
 try {
  const where = spawnSyncSafe('where', ['agent-desktop']);
  for (const line of where.split('\n')) {
   const clean = line.trim();
   // D:\npm-global\agent-desktop.cmd → D:\npm-global\node_modules\agent-desktop\bin\<exe>
   if (clean) from.push(path.join(path.dirname(clean), 'node_modules', 'agent-desktop', 'bin', exe));
  }
 } catch { /* nothing on the path; the plain name is tried below */ }
 return [...from, 'agent-desktop'];
}

function spawnSyncSafe(exe, args) {
 try {
  const child = require('node:child_process').spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  return String(child.stdout || '');
 } catch { return ''; }
}

// One `--version` for each place it might be, remembered once per run: the answer is what every later call uses.
async function resolve() {
 if (found) return found;
 for (const candidate of candidates()) {
  if (candidate.includes('%') || /[\r\n]/.test(candidate)) continue;
  const answer = await call(candidate, ['--version'], { ms: 8000 }).catch(() => null);
  if (!answer || answer.missing || answer.code !== 0) continue;
  found = { exe: candidate, version: String(answer.out).trim().replace(/^agent-desktop\s*/, '') || 'unknown' };
  return found;
 }
 return null;
}

function call(exe, args, { ms = CALL.ms } = {}) {
 return new Promise(resolve => {
  let child;
  try {
   child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
   resolve({ missing: error.code === 'ENOENT', code: -1, out: '', err: error.message });
   return;
  }
  let out = '', err = '';
  const stop = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone already */ } }, ms);
  child.stdout.on('data', part => { out += part; });
  child.stderr.on('data', part => { err += part; });
  child.on('error', error => { clearTimeout(stop); resolve({ missing: error.code === 'ENOENT', code: -1, out, err: error.message }); });
  child.on('close', code => { clearTimeout(stop); resolve({ missing: false, code, out, err }); });
 });
}

async function status() {
 const where = await resolve();
 if (!where) return { present: false, hint: MISSING };
 const answer = await call(where.exe, ['status'], { ms: 10000 });
 let data = null;
 try { data = JSON.parse(answer.out).data || null; } catch { /* the version is still worth saying */ }
 return { present: true, version: where.version, exe: where.exe, platform: data?.platform || process.platform, permissions: data?.permissions || null, surfaces: data?.supported_surfaces || [] };
}

// --- doing it --------------------------------------------------------------------------------------------

async function run(name, args, { ticket = '', sender, id = '' } = {}) {
 if (!NAMES.has(name)) return { error: `Unknown tool ${name}` };
 if (ACT.has(name)) {
  const refusal = consume(name, args, ticket, sender);
  if (refusal) return { error: refusal };
 }
 const asked = plan(name, args);
 if (asked.error) return { error: `Error: ${asked.error}` };
 const where = await resolve();
 // getAppPath is the app's own folder while it is being worked on, and the built app has no such folder to write in.
 const dir = logDir({ packaged: app.isPackaged, repo: app.getAppPath(), userData: app.getPath('userData') });
 if (!where) { log(dir, { tool: name, ok: false, missing: true }); return { error: `Error: ${MISSING}` }; }
 const started = Date.now();
 // The program offers a --trace file of its own, but it insists the path be a private, owner-only, single-link file
 // and refuses otherwise; that is its own machine's rule, not something this app should bet every call on. What the
 // agent asked for and what came back is written here instead, in calls-<day>.jsonl.
 const answer = await call(where.exe, asked.args, { ms: CALL.ms });
 let envelope = null;
 try { envelope = JSON.parse(answer.out); } catch { /* what comes back is not always JSON */ }
 const done = {
  tool: name, ok: envelope?.ok === true, code: envelope ? (envelope.error?.code || 'OK') : `exit ${answer.code}`,
  ms: Date.now() - started, physical: asked.physical === true, id: String(id || ''),
  args: args && typeof args === 'object' ? args : {},
 };
 log(dir, done);
 if (envelope === null) {
  if (answer.missing) return { error: `Error: ${MISSING}` };
  const text = shown(`${answer.out}\n${answer.err}`.trim());
  return { text: text || 'agent-desktop gave no answer at all.' };
 }
 if (!envelope.ok) return { error: `Error: ${explain(envelope)}` };
 // A snapshot's tree is the whole point of the call; everything else is a short answer.
 const body = JSON.stringify(envelope.data ?? envelope, null, 1);
 const note = envelope.data?.complete === false ? '\n\n(the tree was cut short — ask for a smaller part)' : '';
 return { text: shown(body) + note };
}

module.exports = { NAMES, OBSERVE, ACT, MISSING, LIMIT, TEXT, plan, needsTicket, authorize, consume, retryable, explain, shown, logDir, log, logLine, resolve, status, run };
