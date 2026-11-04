'use strict';

// Sign in with Grok: xAI's device-code sign-in (RFC 8628), the one its own Grok CLI uses, so a SuperGrok or X Premium+
// plan pays for the models. The browser is opened at accounts.x.ai and the app waits on the code the plan approves.
// Tokens stay in the main process, encrypted with the OS keychain.
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage, shell } = require('electron');

// xAI's shared device-flow client, the one its CLI is registered with. A client of one's own would need xAI to register it.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
// The scopes that client is allowed. Conversations and workspaces are refused at the token endpoint when asked for.
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const VERIFY = 'https://accounts.x.ai/oauth2/device';
const EARLY_REFRESH = 60 * 1000;
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const SLOW_DOWN = 5;
// A plan's token is good for the CLI door of grok.com. api.x.ai is the billed API, where a plan's token is turned away.
const BASE = 'https://cli-chat-proxy.grok.com/v1';
const VERSION = '1.0.13';
// What the CLI says of itself with every request: the door turns away a client older than 1.0.13.
const CLIENT = {
 'User-Agent': `grok-pager/${VERSION} grok-shell/${VERSION} (linux; x86_64)`,
 'X-XAI-Token-Auth': 'xai-grok-cli',
 'x-authenticateresponse': 'authenticate-response',
 'x-grok-client-identifier': 'grok-pager',
 'x-grok-client-version': VERSION,
};
// The plan's models as the CLI names them. The door's own list is asked first; these stand when it gives none.
const KNOWN = [
 ['grok-4.7', 'Grok 4.7', { efforts: ['low', 'high'], defaultEffort: 'low' }],
 ['grok-4.6', 'Grok 4.6', { efforts: ['low', 'high'], defaultEffort: 'low' }],
 ['grok-4.5', 'Grok 4.5', { efforts: ['low', 'high'], defaultEffort: 'low' }],
 ['grok-4.3', 'Grok 4.3', { efforts: ['low', 'high'], defaultEffort: 'low' }],
 ['grok-4.20-0309-reasoning', 'Grok 4.20 Reasoning', { efforts: ['low', 'high'], defaultEffort: 'low' }],
 ['grok-4.20-0309-non-reasoning', 'Grok 4.20', { efforts: ['none'], defaultEffort: 'none' }],
 ['grok-build-0.1', 'Grok Build 0.1', { efforts: ['low', 'high'], defaultEffort: 'low' }],
];
const CONTEXT = 256000;

let cache;
let refreshing = null;
let attempt = null;

const file = () => path.join(app.getPath('userData'), 'store', 'auth', 'grok.bin');
const failure = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });

function claims(token) {
 try {
  return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
 } catch {
  return {};
 }
}

// The plan a token speaks for: SuperGrok and X Premium+ each come as a tier of their own, and whatever else xAI names is
// shown as it says it. Settings spell the plan out; a token from before that carries only its number.
const TIERS = { 0: 'free', 1: 'supergrok', 2: 'x_basic', 3: 'x_premium', 4: 'x_premium_plus', 5: 'supergrok_heavy', 6: 'supergrok_lite', 7: 'supergrok_plus' };
const PLANS = {
 free: 'Free',
 x_basic: 'X Basic',
 x_premium: 'X Premium',
 x_premium_plus: 'X Premium+',
 supergrok: 'SuperGrok',
 supergrok_plus: 'SuperGrok+',
 supergrok_heavy: 'SuperGrok Heavy',
 supergrok_lite: 'SuperGrok Lite',
};

function labelled(tier) {
 const raw = String(tier ?? '').trim();
 if (!raw) return '';
 const name = TIERS[raw] || raw.toLowerCase().replace(/[\s-]+/g, '_');
 return PLANS[name] || name.replace(/_+/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

function plan(claims) {
 return labelled(claims.tier || claims.plan || claims.subscription);
}

function describe(tokens, previous = {}) {
 const id = claims(tokens.id_token), access = claims(tokens.access_token);
 return {
  access: tokens.access_token,
  refresh: tokens.refresh_token || previous.refresh,
  expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
  email: id.email || access.email || previous.email || '',
  subscription: plan(access) || plan(id) || previous.subscription || '',
 };
}

async function load() {
 if (cache !== undefined) return cache;
 try {
  const data = await fs.promises.readFile(file());
  cache = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8'));
 } catch {
  cache = null;
 }
 return cache;
}

async function save(value) {
 cache = value;
 if (!value) {
  await fs.promises.rm(file(), { force: true });
  return;
 }
 await fs.promises.mkdir(path.dirname(file()), { recursive: true });
 const text = JSON.stringify(value);
 await fs.promises.writeFile(file(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text);
}

// A form post to the sign-in server, answering with the status whatever it is: the device flow reads its own errors.
async function form(url, params) {
 let response;
 try {
  response = await fetch(url, {
   method: 'POST',
   headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
   body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
  });
 } catch {
  throw failure('Can’t reach the Grok sign-in, check the connection', 0, 'network');
 }
 let body = {};
 try { body = await response.json(); } catch {}
 return { response, body };
}

function cancel() {
 attempt?.fail(failure('Sign-in cancelled'));
}

// Asks for a code, opens the browser on the page that takes it, and tells the app what to show while it waits.
async function start(notify) {
 const { response, body } = await form(`${ISSUER}/oauth2/device/code`, { scope: SCOPE });
 if (!response.ok || !body.device_code) throw failure(body.error_description || `Grok sign-in is unavailable (${response.status})`, response.status);
 const page = body.verification_uri_complete || body.verification_uri || VERIFY;
 notify?.({ code: body.user_code || '', url: body.verification_uri || VERIFY });
 shell.openExternal(page);
 return body;
}

// The browser is where the code is approved; the app asks the token endpoint, at the pace the code sets, until it is.
async function login(notify) {
 cancel();
 const device = await start(notify);
 const life = Math.min((Number(device.expires_in) || 0) * 1000 || LOGIN_TIMEOUT, LOGIN_TIMEOUT);
 return new Promise((resolve, reject) => {
  const current = attempt = {
   fail: error => { finish(); reject(error); },
   done: value => { finish(); resolve(value); },
  };
  const finish = () => { clearTimeout(timer); if (attempt === current) attempt = null; };
  const timer = setTimeout(() => current.fail(failure('Sign-in took too long, try again')), life);
  const wait = ms => new Promise(again => setTimeout(again, ms));
  (async () => {
   let pause = Math.max(Number(device.interval) || 5, 1) * 1000;
   const until = Date.now() + life;
   try {
    while (Date.now() < until && attempt === current) {
     await wait(pause);
     if (attempt !== current) return;
     const { response, body } = await form(`${ISSUER}/oauth2/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
     });
     if (response.ok && body.access_token) {
      await save(describe(body));
      current.done(await status());
      return;
     }
     const code = body.error || '';
     if (code === 'authorization_pending') continue;
     if (code === 'slow_down') { pause += SLOW_DOWN * 1000; continue; }
     if (code === 'access_denied') { current.fail(failure('The sign-in was turned down in the browser')); return; }
     if (code === 'expired_token') { current.fail(failure('The sign-in code has expired, try again')); return; }
     current.fail(failure(body.error_description || `Grok sign-in failed (${response.status})`, response.status));
     return;
    }
    if (attempt === current) current.fail(failure('Sign-in took too long, try again'));
   } catch (error) {
    if (attempt === current) current.fail(error);
   }
  })();
 });
}

async function logout() {
 cancel();
 const account = await load();
 const token = account?.refresh || account?.access;
 // The plan's token is told it is done with; a sign-out that cannot reach xAI still signs out here.
 if (token) {
  await form(`${ISSUER}/oauth2/revoke`, { token, token_type_hint: account.refresh ? 'refresh_token' : 'access_token' }).catch(() => {});
 }
 await save(null);
 return status();
}

async function status() {
 const account = await load();
 if (!account) return { connected: false };
 return { connected: true, email: account.email, subscription: await subscription(account) };
}

// The CLI's settings name the plan for a person, and a token need not. They are read for a plan the tokens left unsaid,
// once, and tried again a while later when xAI gave no answer: a plan is a good to show, not a sign-in.
const PLAN_RETRY = 5 * 60 * 1000;
let plannedAt = 0;
let planning = null;

async function planOf(account) {
 const read = async token => {
  const response = await fetch(`${BASE}/settings`, {
   headers: { ...signed({ access: token }), Accept: 'application/json', 'x-grok-client-mode': 'cli' },
  });
  if (response.status === 401) return { stale: true };
  if (!response.ok) return {};
  const body = await response.json().catch(() => ({}));
  return { tier: labelled(body?.subscription_tier_display) };
 };
 try {
  let answer = await read(account.access);
  if (answer.stale) answer = await read((await credentials()).access);
  return answer.tier || '';
 } catch {
  return '';
 }
}

async function subscription(account) {
 if (account.subscription) return account.subscription;
 if (planning) return planning;
 if (Date.now() - plannedAt < PLAN_RETRY) return '';
 plannedAt = Date.now();
 planning = planOf(account).then(async name => {
  if (!name) return '';
  const latest = await load();
  if (!latest) return '';
  await save({ ...latest, subscription: name });
  return name;
 }).finally(() => { planning = null; });
 return planning;
}

// A valid access token for the plan's door, refreshed a minute before it runs out; one refresh serves every waiting request.
async function credentials() {
 const account = await load();
 if (!account) throw failure('Sign in to Grok in settings first', 401);
 if (account.access && account.expires - EARLY_REFRESH > Date.now()) return account;
 refreshing ||= (async () => {
  const { response, body } = await form(`${ISSUER}/oauth2/token`, { grant_type: 'refresh_token', refresh_token: account.refresh });
  if (!response.ok || !body.access_token) {
   if (response.status === 400 || response.status === 401) await save(null);
   throw failure('The Grok sign-in has expired, sign in again in settings', 401);
  }
  const next = describe(body, account);
  await save(next);
  return next;
 })().finally(() => { refreshing = null; });
 return refreshing;
}

// What the door says of itself with a request: the token, and the CLI it is speaking to.
function signed(account) {
 return { ...CLIENT, Authorization: `Bearer ${account.access}` };
}

function describeModel(id, entry = {}) {
 const known = KNOWN.find(([name]) => name === id);
 const efforts = entry.efforts?.length ? entry.efforts : known?.[2].efforts || ['low', 'high'];
 return {
  id: `grok:${id}`,
  provider: 'grok',
  api: id,
  name: known?.[1] || entry.name || id.replace(/^grok-?/, 'Grok ').trim(),
  context: Number(entry.context) || CONTEXT,
  output: Number(entry.output) || 0,
  vision: entry.vision !== false,
  efforts,
  defaultEffort: known?.[2].defaultEffort || efforts[0],
 };
}

// The models the plan may use: the door's list when it gives one, the CLI's own names otherwise.
async function models() {
 const account = await credentials();
 let ids = [];
 try {
  const response = await fetch(`${BASE}/models`, { headers: signed(account) });
  if (response.ok) {
   const body = await response.json();
   const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
   ids = list.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id.startsWith('grok'));
  }
 } catch {}
 const all = ids.length ? ids : KNOWN.map(([id]) => id);
 return [...new Set(all)].map(id => describeModel(id));
}

module.exports = { login, cancel, logout, status, credentials, models, signed, BASE, CLIENT };
