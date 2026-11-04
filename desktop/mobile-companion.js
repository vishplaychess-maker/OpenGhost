'use strict';

// Mobile remote access: a small web server on this computer that a phone pairs with by a QR code, so the agent of a
// chat of its own answers what is typed on the phone. The server is kept in the app and not in a window, as the
// WhatsApp session is: a message that comes is run through the page by the bridge (desktop/mobile-bridge.js), which
// makes the main window if there is none (unseen) and whose agent turn answers in that device's chat
// (mobile-agent.js in the page). While it is on, the app stays in the tray when its window is closed, as it does for
// routines, Telegram and WhatsApp.
//
// Where it listens: on 127.0.0.1 alone, unless the user turns on "allow my Wi-Fi", which adds the private addresses
// (10/8, 172.16/12, 192.168/16) of this computer's own interfaces. Nothing else is ever bound: an address that
// routes outside the building, a tunnel adapter's, or a link-local one, is passed over, and the whole server is shut
// when the feature is off. A phone on mobile data can therefore never be reached, and neither can anyone else — a
// plain `ws://` link has no certificate, so what it carries is kept to the loopback or to the user's own network.
//
// Who gets in: a pairing offer, made when the mobile icon is pressed, carries a random token and dies after five
// minutes unless a phone takes it up. A phone that pairs becomes a device with a token of its own, kept in
// `mobile-sessions/devices.json` under the app's data folder (the profile on the D: drive), so the same phone comes
// back without scanning again. A device new to the app is let in only when the user says yes at the desktop. From
// then on, every frame between the phone and the app is sealed with AES-256-GCM under a key drawn from that device's
// token, so words cannot be read or put in by anything else that can see the traffic. Sealing is not identity: with
// no certificate, a neighbour on the same Wi-Fi can still tell that a phone is talking to this computer. That is why
// the Wi-Fi setting starts off and says so in the settings page.
const { BrowserWindow, app, clipboard } = require('electron');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const Automation = require('./automation-tool');

const KEY = 'mobile';
const FOLDER = 'mobile-sessions';
// A QR code that is not scanned in five minutes is no longer offered; a phone that reaches the app and finds no one
// to answer it goes away; an agent turn the phone waits on is given up on after a while.
const QR_TTL = 5 * 60 * 1000;
const WAIT_TTL = 60 * 1000;
// The port the server takes when it is not set by hand.
const RANGE = { from: 3000, to: 4000 };
const MAX_FRAME = 64 * 1024;
const MAX_WORDS = 8000;
// How many phones may stand at the door without having said who they are.
const MAX_ANON = 4;
const INFO = Buffer.from('OpenGhost mobile v1');
const LOG = { bytes: 512 * 1024 };
// The files of the mobile web app (mobile/ in the project), served as they are read.
const ASSETS = {
 '/index.html': ['index.html', 'text/html; charset=utf-8'],
 '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
 '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
// The page a phone opens talks to nothing but the socket it came in on, and leaves no trail behind it. Its own
// address names the only place it may reach, so it cannot be turned into a way out to somewhere else.
const policyFor = where => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ws://${where}/ wss://${where}/`;

let host = null, loaded = null;
let settings = { enabled: false, port: 'auto', auto: 0, lan: false, screens: false };
let servers = [], wss = null, port = 0, running = false, failure = '';
let devices = [], offer = null, qr = '', qrText = '', qrAt = 0, qrEnds = 0;
let pending = null, anon = 0, restarting = null;
// A device's way in: its socket, its key once it is let through, and what it stands waiting for.
const links = new Map();
// One turn at a time per device, in the order they came.
const chains = new Map();

const uid = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const tokenize = () => crypto.randomBytes(24).toString('base64url');
const hash = value => crypto.createHash('sha256').update(String(value)).digest();
const same = (a, b) => {
 const left = Buffer.from(String(a)), right = Buffer.from(String(b));
 return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// The key a device's frames are sealed with: drawn from its token and its id, so two devices never share one.
function derive(token, id) {
 return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(token), 'utf8'), Buffer.from(String(id), 'utf8'), INFO, 32));
}

function seal(key, object) {
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
 const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(object), 'utf8')), cipher.final()]);
 return JSON.stringify({ s: `${iv.toString('base64url')}.${data.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}` });
}

// The frame a phone sends back. Nothing it says is trusted: the shape is checked where it is used, and a frame that
// does not open is dropped without a word.
function unseal(key, raw) {
 try {
  const box = String(JSON.parse(raw)?.s || '');
  const [iv, data, tag] = box.split('.');
  if (!iv || !data || !tag) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
 } catch {
  return null;
 }
}

function log(line) {
 try {
  const dir = folder();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'mobile.log');
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > LOG.bytes) fs.renameSync(file, path.join(dir, 'mobile.old.log'));
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
 } catch {}
}

function why(thing) {
 return String(thing?.message || thing || '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'The connection failed.';
}

const folder = () => path.join(app.getPath('userData'), FOLDER);
const devicesFile = () => path.join(folder(), 'devices.json');

// The addresses the server may stand on: this computer alone, or this computer and the private network it is joined
// to once the user asks for it.
function isPrivate(address) {
 return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(String(address));
}

function binds() {
 const out = ['127.0.0.1'];
 if (!settings.lan) return out;
 for (const list of Object.values(os.networkInterfaces())) {
  for (const item of list || []) {
   if (item.family === 'IPv4' && !item.internal && isPrivate(item.address) && !out.includes(item.address)) out.push(item.address);
  }
 }
 return out;
}

// The address a phone is told to use. On a phone, 127.0.0.1 is the phone and not this computer, so a real pairing
// needs the Wi-Fi setting on; with it off the link is only good for a browser on this same computer.
function entrance() {
 const lan = binds().find(address => address !== '127.0.0.1');
 return lan || '127.0.0.1';
}

const link = () => (port ? `http://${entrance()}:${port}/` : '');
const socketUrl = () => (port ? `ws://${entrance()}:${port}/ws` : '');

function view() {
 return {
  enabled: settings.enabled, lan: settings.lan, screens: settings.screens, port: settings.port,
  running, portUsed: port, url: link(), ws: socketUrl(), error: failure, qr, qrText, qrAt, qrEnds,
  pairing: !!offer, waiting: pending ? { id: pending.id, name: pending.name, model: pending.model, address: pending.address } : null,
  devices: devices.map(device => {
   const link = online(device.id);
   return { id: device.id, name: device.name, model: device.model, added: device.added, lastSeen: device.lastSeen, lastAddress: device.lastAddress, online: !!link, sealed: link ? !link.plain : null };
  }),
 };
}

function publish() {
 const data = view();
 for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('mobile:changed', data);
 host?.changed?.();
}

async function save() {
 try { await host.store.write(KEY, { version: 1, ...settings }); } catch {}
}

function saveDevices() {
 try {
  fs.mkdirSync(folder(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(devicesFile(), JSON.stringify({ version: 1, devices }), { mode: 0o600 });
 } catch (error) {
  log(`devices not kept: ${why(error)}`);
 }
}

function loadDevices() {
 try {
  const raw = JSON.parse(fs.readFileSync(devicesFile(), 'utf8'));
  devices = (Array.isArray(raw?.devices) ? raw.devices : []).filter(device =>
   device && typeof device.id === 'string' && /^[a-z0-9]{1,20}$/i.test(device.id) && typeof device.token === 'string' && device.token.length >= 16
  ).map(device => ({
   id: device.id, token: device.token, name: String(device.name || '').slice(0, 60), model: String(device.model || '').slice(0, 60),
   added: Number(device.added) || Date.now(), lastSeen: Number(device.lastSeen) || 0, lastAddress: String(device.lastAddress || '').slice(0, 60),
  }));
 } catch {
  devices = [];
 }
}

// A frame to one device, sealed once it is through the door and in the clear only while it is not.
function send(socket, key, object) {
 if (!socket || socket.readyState !== 1) return;
 try { socket.send(key ? seal(key, object) : JSON.stringify(object)); } catch {}
}

function tell(link, object) {
 send(link.ws, link.key, object);
}

function close(link, code = 1000) {
 try { link.ws.close(code); } catch {}
 try { link.ws.terminate(); } catch {}
}

// —— the pairing offer ————————————————————————————————————————————————————

function expireOffer() {
 if (!offer) return;
 offer = null;
 qr = '';
 qrText = '';
 qrAt = 0;
 qrEnds = 0;
}

async function pair() {
 if (!running) return { ...view(), error: failure || 'Mobile access is not listening.' };
 expireOffer();
 const token = tokenize();
 const made = { id: uid(), hash: hash(token), token, ends: Date.now() + QR_TTL };
 // The offer is its own from this moment: five minutes, whether or not the picture of it takes a moment to draw.
 offer = made;
 qrAt = made.ends - QR_TTL;
 qrEnds = made.ends;
 // The token goes in the part of the address a browser never sends on: the page reads it and gives it to the server
 // itself, so it stays out of any record of what was asked for.
 qrText = `${link()}#p=${made.id}:${token}`;
 log('pairing offered');
 try {
  const drawn = await require('qrcode').toDataURL(qrText, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
  // Stopped while the picture was being drawn: no picture of an offer nobody is making is shown.
  if (offer !== made) return view();
  qr = drawn;
 } catch (error) {
  qr = '';
  failure = `The QR code could not be drawn: ${why(error)}`;
 }
 publish();
 return view();
}

function unpair() {
 expireOffer();
 log('pairing stopped');
 publish();
 return view();
}

// The offer's token is only ever held beside its hash; the phone names the offer, and the hash settles the match.
function takeOffer(id, token) {
 if (!offer || offer.id !== id) return null;
 if (Date.now() > offer.ends) { expireOffer(); return null; }
 if (token.length !== 32 || !crypto.timingSafeEqual(hash(token), offer.hash)) return null;
 const taken = { id: offer.id, token };
 expireOffer();
 return taken;
}

// —— letting a phone through ——————————————————————————————————————————————

function online(id) {
 const link = links.get(id);
 return link && link.state === 'ready' ? link : null;
}

// A phone at the door becomes this app's record of it, under the id the pairing offer was made with — which is the
// id the phone already holds, so both sides can draw the same key before the first word is sealed.
function admit(entry) {
 const record = { id: entry.id, token: entry.token, name: entry.name, model: entry.model, added: Date.now(), lastSeen: 0, lastAddress: '' };
 devices.push(record);
 saveDevices();
 granted(entry.link, record, 'paired');
}

// The door opens: the phone's frames are sealed from now on — unless its browser will not do that work for the
// address it came from, and then it has said so and nothing is pretended — one socket talks for a device at a time,
// and the app remembers where and when it last heard from it.
function granted(link, record, words) {
 const stale = links.get(record.id);
 if (stale && stale !== link) close(stale, 1008);
 link.key = link.plain ? null : derive(record.token, record.id);
 link.state = 'ready';
 link.device = record.id;
 settled(link);
 links.set(record.id, link);
 deviceOf(record.id, link.address);
 tell(link, { type: 'paired', device: record.id, name: record.name || 'OpenGhost', plain: !link.key });
 log(`${words} ${record.name || record.model || 'a phone'} as ${record.id}${link.key ? '' : ' (unsealed)'}`);
 publish();
}

function refuse(entry, reason) {
 const link = entry?.link;
 if (!link) return;
 tell(link, { type: 'refused', reason });
 log(`refused ${entry.name || entry.model || 'a phone'}: ${reason}`);
 setTimeout(() => close(link, 1008), 400);
 if (pending === entry) pending = null;
 publish();
}

function approve(id, yes) {
 const entry = pending?.id === id ? pending : null;
 if (!entry) return view();
 pending = null;
 if (yes && entry.link && entry.link.state === 'waiting') admit({ ...entry });
 else refuse(entry, 'The connection was not allowed.');
 return view();
}

// The record of a device that is now talking, so the settings page can say when and from where.
function deviceOf(id, address) {
 const record = devices.find(device => device.id === id);
 if (!record) return null;
 record.lastSeen = Date.now();
 record.lastAddress = String(address || '').slice(0, 60);
 saveDevices();
 return record;
}

// A phone that has said who it is is no longer standing anonymous at the door.
function settled(link) {
 if (link.anon) {
  link.anon = false;
  anon = Math.max(0, anon - 1);
 }
}

function hello(link, frame) {
 if (link.state !== 'hello' || frame?.type !== 'hello') return;
 const token = String(frame.token || '').slice(0, 64);
 // A browser only seals what it trusts the address of: it says whether it can, and the app works to it.
 link.plain = frame.sealed === false;
 const described = {
  link, address: link.address, token,
  name: String(frame.name || '').slice(0, 60),
  model: String(frame.model || '').slice(0, 60),
 };
 if (frame.offer) {
  const taken = takeOffer(String(frame.offer).slice(0, 24), token);
  if (!taken) { refuse({ ...described, token: '' }, 'That pairing code has gone. Ask for a new QR code.'); return; }
  described.token = taken.token;
  pending = { ...described, id: taken.id };
  link.state = 'waiting';
  tell(link, { type: 'waiting' });
  log('phone waiting to be allowed');
  publish();
  // No one is at the desk to answer: the phone is not kept waiting for it.
  setTimeout(() => { if (pending?.link === link) approve(pending.id, false); }, WAIT_TTL);
  return;
 }
 const id = String(frame.device || '').slice(0, 20);
 const record = devices.find(device => device.id === id);
 if (!record || !same(token, record.token)) { refuse({ ...described, token: '' }, 'This phone is not paired with OpenGhost.'); return; }
 // A phone that comes back with the token it was given is the one that stood at the door before: it need not be
 // asked of the user again, and it need not scan anything.
 granted(link, record, 'known phone');
}

// —— the agent's turn —————————————————————————————————————————————————————

// The turn goes over the bridge (desktop/mobile-bridge.js), which keeps the queue of them, wakes the app's window when
// there is none, and waits for the page's answer. What comes back is either the agent's words or the reason there are
// none.
function ask(request) {
 return host?.ask ? host.ask(request) : Promise.resolve({ failure: 'OpenGhost is not ready to answer yet.' });
}

function abandoned(reason) {
 host?.drop?.(reason);
}

function receive(link, frame) {
 if (link.state !== 'ready' || !link.device) return;
 const type = String(frame?.type || '');
 if (type === 'ping') { tell(link, { type: 'pong', at: Date.now() }); return; }
 if (type === 'screenshot') { capture(link, String(frame?.id || '').slice(0, 24)); return; }
 if (type !== 'message') return;
 const said = String(frame?.text || '').trim().slice(0, MAX_WORDS);
 const record = devices.find(device => device.id === link.device);
 if (!said) { tell(link, { type: 'reply', id: String(frame?.id || ''), failure: 'Nothing was written.' }); return; }
 log(`message from ${record?.name || record?.id || 'a phone'}: ${said.length} characters`);
 enqueue(link, record, { id: uid(), text: said, device: link.device, name: record?.name || record?.model || '' });
}

// The screen, for a phone that asked for it — the same capture the agent's take_screenshot tool makes, and refused
// while the setting is off, since a screen a phone can see is a screen a phone can read.
async function capture(link, id) {
 if (!settings.screens) { tell(link, { type: 'screenshot', id, failure: 'The desktop has not allowed its screen to be seen from a phone.' }); return; }
 try {
  const result = await Automation.run('mobile', 'take_screenshot', {}, null, null);
  if (result?.error || !result?.image) tell(link, { type: 'screenshot', id, failure: result?.error || 'The screen could not be read.' });
  else tell(link, { type: 'screenshot', id, image: result.image, width: result.width, height: result.height });
 } catch (error) {
  tell(link, { type: 'screenshot', id, failure: why(error) });
 }
}

function enqueue(link, record, request) {
 const turn = async () => {
  const socket = link;
  tell(socket, { type: 'thinking' });
  const answer = await ask(request);
  if (links.get(request.device) !== socket) return;
  tell(socket, answer.failure ? { type: 'reply', id: request.id, failure: answer.failure } : { type: 'reply', id: request.id, text: answer.text || 'The agent finished without a reply.' });
 };
 const before = chains.get(request.device) || Promise.resolve();
 const next = before.then(turn, turn).finally(() => { if (chains.get(request.device) === next) chains.delete(request.device); });
 chains.set(request.device, next);
}

// —— the server ———————————————————————————————————————————————————————————

function addressOf(request) {
 const socket = request.socket;
 const raw = String(socket?.remoteAddress || '').replace(/^::ffff:/, '');
 return raw === '::1' ? '127.0.0.1' : raw;
}

// Only this computer, or — once the Wi-Fi setting is on — a phone on the same private network. Nothing else gets
// past the door, whatever address the server happens to stand on.
function acceptable(from) {
 if (from === '127.0.0.1') return true;
 return settings.lan && isPrivate(from);
}

// The Host header must name the address the server was asked for: a site in a browser cannot point its own name at
// a server standing on this computer.
function named(request) {
 const header = String(request.headers?.host || '').split(':')[0];
 if (!header) return false;
 if (header === 'localhost') return binds().includes('127.0.0.1');
 return binds().includes(header);
}

function deny(response, code, text) {
 response.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
 response.end(text);
}

function asset(response, type, body, host) {
 response.writeHead(200, {
  'content-type': type, 'cache-control': 'no-store', 'content-security-policy': policyFor(host),
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
 });
 response.end(body);
}

function serve(request, response) {
 const from = addressOf(request);
 if (!acceptable(from)) { deny(response, 403, 'Not reachable from here.'); return; }
 if (!named(request)) { deny(response, 421, 'This address does not belong to OpenGhost.'); return; }
 const url = new URL(request.url, 'http://127.0.0.1');
 if (url.pathname !== '/' && !(url.pathname in ASSETS)) { deny(response, 404, 'Nothing here.'); return; }
 const wanted = ASSETS[url.pathname] || ASSETS['/index.html'];
 let body;
 try {
  body = fs.readFileSync(path.join(app.getAppPath(), 'mobile', wanted[0]));
 } catch (error) {
  deny(response, 500, 'The page could not be read.');
  log(`asset failed: ${why(error)}`);
  return;
 }
 asset(response, wanted[1], body, String(request.headers?.host || '127.0.0.1'));
}

function attach(request, socket, head) {
 const from = addressOf(request);
 if (!acceptable(from) || !named(request)) { socket.destroy(); return; }
 if (new URL(request.url, 'http://127.0.0.1').pathname !== '/ws') { socket.destroy(); return; }
 if (anon >= MAX_ANON) { socket.destroy(); return; }
 anon++;
 const link = { ws: null, key: null, state: 'hello', device: null, address: from, anon: true };
 wss.handleUpgrade(request, socket, head, ws => {
  link.ws = ws;
  ws.on('message', (data, binary) => {
   if (binary || data.length > MAX_FRAME) return;
   if (link.state === 'hello') {
    let frame = null;
    try { frame = JSON.parse(String(data)); } catch { return; }
    hello(link, frame);
    return;
   }
   const opened = unseal(link.key, data);
   if (opened) receive(link, opened);
  });
  const gone = () => {
   if (link.anon) {
    link.anon = false;
    anon = Math.max(0, anon - 1);
   }
   if (link.device && links.get(link.device) === link) links.delete(link.device);
   if (pending?.link === link) pending = null;
   if (link.state === 'ready') { log(`phone ${link.device} let go`); publish(); }
  };
  ws.on('close', gone);
  ws.on('error', gone);
  // A hello that never comes is a phone that went away without saying so.
  setTimeout(() => { if (link.state === 'hello') close(link, 1011); }, WAIT_TTL);
  tell(link, { type: 'welcome' });
 });
}

function listenOne(portWanted, address) {
 return new Promise((resolve, reject) => {
  const server = http.createServer(serve);
  server.on('upgrade', (request, socket, head) => { attach(request, socket, head); });
  server.on('error', reject);
  server.listen(portWanted, address, () => resolve(server));
 });
}

function chosen() {
 if (settings.port !== 'auto') {
  const number = Number(settings.port);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? [number] : [];
 }
 const out = [];
 // The number it answered on last time comes first: a phone keeps its pairing under the address it read, so a new
 // number each run would send every returning phone back to the QR code.
 if (settings.auto >= RANGE.from && settings.auto <= RANGE.to) out.push(settings.auto);
 for (let step = 0; step < 24; step++) out.push(RANGE.from + crypto.randomInt(RANGE.to - RANGE.from + 1));
 out.push(0);
 return out;
}

async function stopServer() {
 const old = wss, list = servers;
 wss = null;
 servers = [];
 running = false;
 port = 0;
 for (const link of [...links.values()]) close(link, 1001);
 links.clear();
 anon = 0;
 expireOffer();
 pending = null;
 if (old) try { old.close(); } catch {}
 await Promise.all(list.map(server => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(() => resolve());
 })));
}

async function start() {
 if (restarting) await restarting.catch(() => {});
 const work = (async () => {
  await stopServer();
  if (!settings.enabled) {
   running = false;
   failure = '';
   publish();
   return;
  }
  const where = binds();
  const tries = chosen();
  if (!tries.length) {
   failure = 'The port named is not one a server can use.';
   log(failure);
   publish();
   return;
  }
  let last = null;
  for (const portWanted of tries) {
   const list = [];
   // The first one asked for the port; the rest follow it. A phone is told one address and one port, so every
   // address the app stands on must answer on the same number.
   let wanted = portWanted;
   try {
    for (const address of where) {
     const server = await listenOne(wanted, address);
     if (!list.length) wanted = server.address().port;
     list.push(server);
    }
   } catch (error) {
    for (const server of list) { try { server.close(); } catch {} }
    last = error;
    continue;
   }
   servers = list;
   wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
   running = true;
   port = list[0].address().port;
   // Kept for the next run, so a phone that paired before finds the same address and need not read another code.
   if (settings.port === 'auto' && port !== settings.auto) { settings.auto = port; save(); }
   failure = '';
   log(`listening on ${where.join(', ')} port ${port}`);
   publish();
   return;
  }
  failure = `Nothing could listen on that port: ${why(last)}`;
  log(failure);
  publish();
 })();
 restarting = work;
 try { await work; } finally { if (restarting === work) restarting = null; }
}

async function update(changes = {}) {
 let restart = false, refused = '';
 if ('enabled' in changes) {
  const enabled = !!changes.enabled;
  if (enabled !== settings.enabled) {
   settings.enabled = enabled;
   restart = true;
  }
 }
 if ('lan' in changes) {
  const lan = !!changes.lan;
  if (lan !== settings.lan) {
   settings.lan = lan;
   restart = true;
  }
 }
 if ('screens' in changes) settings.screens = !!changes.screens;
 if ('port' in changes) {
  const raw = changes.port;
  const number = raw === 'auto' || raw === '' || raw === null || raw === undefined ? 'auto' : Number(raw);
  const wanted = number === 'auto' || (Number.isInteger(number) && number >= 1024 && number <= 65535);
  if (!wanted) refused = 'port';
  else if (String(number) !== String(settings.port)) {
   settings.port = number;
   restart = true;
  }
 }
 await save();
 if (restart) {
  abandoned('Mobile access was changed.');
  for (const link of links.values()) close(link, 1012);
  if (settings.enabled) await start();
  else {
   await stopServer();
   log('turned off');
   publish();
  }
 } else publish();
 return refused ? { ...view(), refused } : view();
}

function forget(id) {
 const link = links.get(id);
 if (link) close(link, 1008);
 links.delete(id);
 const before = devices.length;
 devices = devices.filter(device => device.id !== id);
 if (devices.length !== before) {
  saveDevices();
  log(`phone ${id} revoked`);
 }
 publish();
 return view();
}

module.exports = {
 // host: { store: { read, write }, wake() — makes the main window, unseen, when there is none, changed?() — the tray
 // follows whether the app is to stay, ask(request) — run this message through the agent and wait for the answer,
 // drop(reason) — the turns waiting on the page will never be answered }.
 setup(options) {
  host = options;
  loaded = host.store.read(KEY).then(raw => {
   settings = {
    enabled: !!raw?.enabled,
    lan: !!raw?.lan,
    screens: !!raw?.screens,
    port: raw?.port === 'auto' || raw?.port === undefined || raw?.port === null ? 'auto' : raw.port,
    auto: Number(raw?.auto) || 0,
   };
   loadDevices();
   return start();
  }).catch(() => {});
 },
 // Whether the app is to stay in the tray with its window closed: a phone can only reach it while it runs.
 get alive() {
  return settings.enabled;
 },
 ready() {
  return loaded;
 },
 view,
 // What the settings page changes: whether it is on, the port, whether a phone on the Wi-Fi may reach it, and
 // whether a paired phone may see the screen.
 update,
 // A pairing offer for the QR code, and giving one up before a phone takes it up.
 pair,
 unpair,
 // The QR code is offered again if it ran out while the window watched.
 refresh() {
  return offer && Date.now() < offer.ends ? view() : pair();
 },
 // The user's answer to a phone standing at the door.
 approve,
 disconnect(id) {
  const link = links.get(String(id || ''));
  if (link) {
   tell(link, { type: 'gone' });
   close(link, 1000);
   log(`phone ${link.device} disconnected`);
   publish();
  }
  return view();
 },
 // A phone's way back is taken from it: it is let go now and cannot come back without a QR code of its own.
 revoke: forget,
 // The links the Copy link button offers: the page a phone opens, the pairing address a camera reads, and the socket
 // it talks over. Nothing else goes on the clipboard.
 copy(text) {
  const wanted = String(text || '');
  if (wanted !== link() && wanted !== qrText && wanted !== socketUrl()) return false;
  clipboard.writeText(wanted);
  return true;
 },
 stop() {
  abandoned('OpenGhost is closing.');
  for (const link of links.values()) close(link, 1001);
  stopServer().catch(() => {});
 },
};
