(() => {
'use strict';

// The phone's side of OpenGhost. The link a QR code leads here carries its pairing code in the part of the address a
// browser never sends on: the code is read from it and given to the desktop itself, so it stays out of any record of
// what was asked for. Once the desktop has allowed this phone, its id and its code are kept on the phone, so the same
// link opens the door again without a scan. From then on every word between the two is sealed with AES-GCM under a key
// drawn from that code, so what is said cannot be read or put in by anything else that can see the traffic.
//
// A browser only lets a page do that work where it trusts the address it came from. On this computer (127.0.0.1) it
// does; on an address from the Wi-Fi it may not, and then the page says so plainly instead of pretending: what is
// written goes over the network as it is. OpenGhost keeps to 127.0.0.1 until "allow my Wi-Fi" is turned on for it.
const KEEP = 'openghost.mobile';
const INFO = new TextEncoder().encode('OpenGhost mobile v1');
const SEALED = !!(window.crypto?.subtle && window.crypto?.getRandomValues);
const RETRY = [700, 1500, 3000, 6000, 12000];

const $ = id => document.getElementById(id);
const talk = { socket: null, key: null, device: '', token: '', timer: 0, tries: 0, id: 0, waiting: false };

const kept = () => { try { return JSON.parse(localStorage.getItem(KEEP)) || {}; } catch { return {}; } };
const remember = value => { try { localStorage.setItem(KEEP, JSON.stringify(value)); } catch {} };
const forget = () => { try { localStorage.removeItem(KEEP); } catch {} };

// base64url, in chunks: a half-million bytes spread over one call is more than a phone's engine will take.
function base(bytes) {
 let text = '';
 for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode.apply(null, bytes.subarray(at, at + 8192));
 return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase(text) {
 const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
 const bytes = new Uint8Array(raw.length);
 for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
 return bytes;
}

function row(kind, words) {
 const el = document.createElement('div');
 el.className = 'row ' + kind;
 el.textContent = words;
 $('rows').append(el);
 $('talk').scrollTop = $('talk').scrollHeight;
 return el;
}

function tone(kind, words) {
 const el = $('state');
 el.dataset.tone = kind;
 el.textContent = words;
}

function notice(words) {
 const el = $('notice');
 el.hidden = !words;
 el.textContent = words || '';
}

// Three faces the page wears: writing to the agent, waiting for someone to say yes at the desktop, and having
// nothing to do until a QR code is scanned.
function ready(forWriting) {
 $('send').hidden = !forWriting;
 $('screen').hidden = !forWriting;
 $('forget').hidden = !forWriting;
 $('pair').hidden = forWriting || !talk.waiting;
 $('hint').hidden = forWriting || talk.waiting;
}

// —— the key, and the sealing of a frame ——————————————————————————————————

async function keyFor(token, device) {
 const base64 = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), 'HKDF', false, ['deriveKey']);
 return crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(device), info: INFO },
  base64, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
 );
}

async function seal(object) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const whole = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, talk.key, new TextEncoder().encode(JSON.stringify(object))));
 return JSON.stringify({ s: `${base(iv)}.${base(whole.subarray(0, whole.length - 16))}.${base(whole.subarray(whole.length - 16))}` });
}

async function open(text) {
 const parts = String(JSON.parse(text)?.s || '').split('.');
 if (parts.length !== 3) return null;
 // What the app sends has the check mark cut off the end; a browser wants it back on, where its own encrypt puts it.
 const data = unbase(parts[1]), mark = unbase(parts[2]), whole = new Uint8Array(data.length + mark.length);
 whole.set(data);
 whole.set(mark, data.length);
 const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase(parts[0]), tagLength: 128 }, talk.key, whole));
 return JSON.parse(new TextDecoder().decode(plain));
}

// —— what the desktop says ————————————————————————————————————————————————

async function framed(event) {
 let frame = null;
 try { frame = JSON.parse(event.data); } catch { return; }
 if (talk.key && frame && typeof frame === 'object' && frame.s) {
  try { frame = await open(event.data); } catch {
   // A word that will not open means the two sides no longer agree on the key. The phone is not to sit waiting on it
   // with no way of saying so: it gives the pairing up and tells the user to read a new code.
   tone('bad', 'Not allowed');
   notice('OpenGhost could not be read. Ask it for a new QR code.');
   forget();
   ready(false);
   return;
  }
  if (!frame) return;
 }
 await taken(frame);
}

async function taken(frame) {
 switch (frame?.type) {
  case 'welcome':
   tone('wait', 'Waiting for OpenGhost…');
   return;
  case 'waiting':
   talk.waiting = true;
   ready(false);
   tone('wait', 'Answer at the desktop');
   return;
  case 'paired': {
   talk.device = String(frame.device || '');
   // Kept on the phone: the id the desktop gave and the code it was drawn from. The next time this link is opened,
   // they are enough — no scan, and no second answer at the desktop.
   remember({ device: talk.device, token: talk.token || kept().token, name: String(frame.name || 'OpenGhost').slice(0, 60) });
   clear();
   talk.waiting = false;
   talk.tries = 0;
   ready(true);
   tone('good', 'Connected');
   notice(frame.plain ? 'This browser will not seal traffic to a network address, so what you write goes over it as it is. Keep it to a network you trust.' : '');
   row('said', frame.plain ? 'Connected, unsealed' : 'Connected');
   return;
  }
  case 'refused': {
   clear();
   // A code the desktop no longer knows about is not worth sending again.
   if (!code()) forget();
   talk.device = '';
   talk.key = null;
   talk.waiting = false;
   tone('bad', 'Not allowed');
   notice(String(frame.reason || 'OpenGhost did not let this phone in.'));
   ready(false);
   return;
  }
  case 'gone':
   tone('bad', 'OpenGhost let go of this phone.');
   return;
  case 'thinking':
   tone('wait', 'OpenGhost is working…');
   return;
  case 'reply': {
   tone('good', 'Connected');
   const words = String(frame.failure || frame.text || '');
   if (words) row('it', words);
   return;
  }
  case 'screenshot': {
   tone('good', 'Connected');
   if (frame.failure) { row('said', String(frame.failure)); return; }
   const seen = row('it', '');
   const picture = document.createElement('img');
   picture.alt = 'The desktop screen';
   picture.src = String(frame.image || '');
   seen.append(picture);
   $('talk').scrollTop = $('talk').scrollHeight;
   return;
  }
  default: return;
 }
}

// The pairing code is only good for the first hello; after that the phone lives on the id it was given.
function clear() {
 talk.token = '';
 history.replaceState(null, '', location.pathname);
}

function code() {
 const pair = /^p=([^:]+):([^&]+)/.exec(String(location.hash || '').slice(1));
 return pair ? { offer: pair[1], token: pair[2] } : null;
}

// What the desktop is shown for this phone. A machine only ever names itself inside the brackets of a user agent, so
// the words outside them are no use to a person reading a list of devices.
function phoneName() {
 const ua = String(navigator.userAgent);
 if (/iPhone|iPod/.test(ua)) return 'iPhone';
 if (/iPad/.test(ua)) return 'iPad';
 const parts = String(ua.match(/\(([^)]*)\)/)?.[1] || '')
  .split(';').map(part => part.trim().replace(/\s+Build\/.*$/i, '')).filter(Boolean);
 if (/Android/.test(ua)) {
  const model = parts.find(part => !/^(Linux|Android|Mobile|Tablet|WV|KAIOS)/i.test(part) && !/\d+\.\d+/.test(part));
  return String(model || navigator.userAgentData?.model || 'Android phone').slice(0, 40);
 }
 return String(navigator.userAgentData?.model || 'A browser').slice(0, 40);
}

const reopen = () => { dial().catch(() => {}); };

// —— the socket ————————————————————————————————————————————————-------------

async function dial() {
 clearTimeout(talk.timer);
 if (talk.socket && (talk.socket.readyState === 0 || talk.socket.readyState === 1)) return;
 const saved = kept(), pair = code();
 talk.token = pair?.token || saved.token || '';
 if (!saved.device && !pair) {
  ready(false);
  talk.waiting = false;
  tone('bad', 'Not paired');
  notice('Nothing to open until you scan the QR code on OpenGhost with this phone.');
  return;
 }
 // The id the key is drawn with is known before the door opens: the pairing code names the offer, and the offer
 // becomes the device. So the first word after the hello is already sealed.
 const wanted = pair?.offer || saved.device;
 talk.device = saved.device || '';
 talk.key = SEALED && talk.token ? await keyFor(talk.token, wanted).catch(() => null) : null;
 const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
 const socket = new WebSocket(url);
 talk.socket = socket;
 tone('wait', 'Opening…');
 const called = phoneName();
 socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
   type: 'hello', token: talk.token, offer: pair?.offer || '', device: saved.device || '',
   name: String(saved.name || called).slice(0, 60), model: String(navigator.userAgentData?.platform || called).slice(0, 60), sealed: SEALED,
  }));
 });
 socket.addEventListener('message', event => { framed(event).catch(() => {}); });
 socket.addEventListener('close', away);
 socket.addEventListener('error', () => {});
}

function away() {
 talk.socket = null;
 if (!talk.device && !kept().device) {
  tone('bad', 'Not paired');
  ready(false);
  return;
 }
 // A phone that comes and goes on a weak signal is not to knock forever.
 if (talk.tries >= 12) {
  tone('bad', 'OpenGhost cannot be reached');
  return;
 }
 tone('bad', 'Reopening…');
 talk.timer = setTimeout(reopen, RETRY[Math.min(talk.tries++, RETRY.length - 1)]);
}

// A frame leaves sealed when the two sides agreed a key; in the clear when they did not, and the page has said so.
function send(object) {
 if (!talk.socket || talk.socket.readyState !== 1) return false;
 if (!talk.key) {
  talk.socket.send(JSON.stringify(object));
  return true;
 }
 seal(object).then(text => { talk.socket?.readyState === 1 && talk.socket.send(text); }).catch(() => {});
 return true;
}

// —— what is written on the phone ——————————————————————————————————————————

$('send').addEventListener('submit', event => {
 event.preventDefault();
 const words = String($('text').value || '').trim();
 if (!words) return;
 if (!send({ type: 'message', id: `c${talk.id++}`, text: words.slice(0, 8000) })) { away(); return; }
 $('text').value = '';
 row('you', words);
 $('go').disabled = true;
 setTimeout(() => { $('go').disabled = false; }, 600);
});

$('screen').addEventListener('click', () => {
 row('said', 'Asking for the screen…');
 send({ type: 'screenshot', id: `s${talk.id++}` });
});

$('again').addEventListener('click', reopen);

$('forget').addEventListener('click', () => {
 forget();
 clear();
 talk.device = '';
 location.reload();
});

if (!SEALED) notice('This browser cannot seal the traffic, so what is written goes over the network as it is.');
ready(false);
reopen();
})();
