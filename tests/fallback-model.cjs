'use strict';
// Actual OpenAI stream parser -> provider fallback policy -> Chat's notice, with fixture transports only.
// No network, application profile, live key, model or agent command is used.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const config = { provider: 'openai', id: 'first', model: 'first-model', key: 'fixture', effort: 'high', efforts: ['none', 'low', 'high'], ready: true };
const other = { provider: 'openai', id: 'second', model: 'second-model', key: 'fixture', effort: 'high', efforts: ['none', 'low', 'high'], ready: true };
const request = { messages: [{ role: 'user', content: 'Answer the fixture question' }], session: 'fixture-session' };
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('ok  ' + name); }
const eventText = events => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
const packets = text => [{ type: 'response.output_text.delta', item_id: 'm1', delta: text }, { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } }];
const QUOTA = ['insufficient_quota', 'billing_error', 'credit_balance_exhausted', 'organization_spend_limit_exceeded'];

// What each attempt answers with. `fail` as an object means the first model fails that way and the second answers;
// as a function of (attempt, model) it decides for itself. A spec with a status is an HTTP failure, one with an
// error is a stream that ends that way, and a prefix is text that reached the screen before it did.
function harness(fail, { fallback = other, waitsReal = false, manual = false } = {}) {
 let posts = 0, next = 0;
 const decide = typeof fail === 'function' ? fail : (n, model) => model === 'first-model' ? fail : null;
 const bodies = [], waits = [], moved = [], timers = new Map();
 const engine = { module: { exports: {} }, exports: {}, require, TextDecoder, fetch: async (_url, init) => {
  const asked = JSON.parse(init.body);
  posts++; bodies.push(asked);
  const way = decide(posts, asked.model);
  if (!way) return { ok: true, body: (async function* () { yield Buffer.from(eventText(packets(asked.model === 'first-model' ? 'FIRST' : 'SECOND'))); })() };
  if (typeof way === 'number') return { ok: false, status: way, json: async () => ({ error: { code: 'server_error', message: 'The server is unable to answer' } }) };
  // Words that reached the screen before the failure: the answer began, and nothing may be said again elsewhere.
  if (way.prefix) return { ok: true, body: (async function* () { yield Buffer.from(eventText([...way.prefix, { type: 'response.failed', response: { error: way } }])); })() };
  if (way.status) return { ok: false, status: way.status, json: async () => ({ error: way }) };
  return { ok: true, body: (async function* () { yield Buffer.from(eventText([{ type: 'response.failed', response: { error: way } }])); })() };
 } };
 vm.createContext(engine); vm.runInContext(read('desktop/openai.js'), engine);
 const bridge = { onEvent: fn => bridge.listener = fn, abort: () => {}, start: (id, asked) => {
  queueMicrotask(async () => {
   try {
    const value = await engine.module.exports.stream(asked, { onEvent: event => bridge.listener({ id, ...event }), chatgpt: async () => ({}), version: 'fixture' });
    bridge.listener({ id, type: 'done', result: value });
   } catch (error) { bridge.listener({ id, type: 'error', status: error.status || 0, code: error.code || '', message: error.message }); }
  });
 } };
 const c = {
  window: { openghost: { llm: bridge } }, console, I18n: { t: key => key }, Usage: { record: () => { }, parts: () => null },
  DeepSeek: {}, UserContext: { pictures: () => [] }, Skills: { blocks: () => '' }, AbortController, DOMException, CustomEvent: class {},
  setTimeout: (fn, ms) => { waits.push(ms); if (waitsReal) return setTimeout(fn, ms); const id = ++next; timers.set(id, fn); if (!manual) queueMicrotask(() => { if (timers.delete(id)) fn(); }); return id; },
  clearTimeout: id => waitsReal ? clearTimeout(id) : timers.delete(id),
 };
 vm.createContext(c); vm.runInContext(read('providers.js'), c);
 const ask = (over = {}) => c.window.Providers.stream(config, { ...request, fallback, onFallback: row => moved.push(row), ...over });
 return { api: c.window.Providers, ask, bodies, waits, timers, moved, get posts() { return posts; } };
}
async function rejected(work) { try { await work; return null; } catch (error) { return error; } }

// Chat's half: the line a switch leaves, with the turn and the record of it.
function noticeOf(reason, { locked = false } = {}) {
 const saved = [], logged = [];
 const c = {
  window: { openghost: { log: row => logged.push(row) } }, console, I18n: { t: (key, at) => `${key} ${at?.name || ''}` },
  document: { createElement: () => ({ className: '', style: {}, dataset: {}, textContent: '', children: [], setAttribute() { }, append(...kids) { this.children.push(...kids); }, before() { }, querySelector: () => null }) },
  AbortController, DOMException, CustomEvent: class {}, setTimeout: fn => { queueMicrotask(fn); return 0; }, clearTimeout: () => { }, fetch: () => { throw Error('no network'); },
  Providers: { NAMES: { openai: 'OpenAI' } },
 };
 vm.createContext(c); vm.runInContext(read('chat.js'), c);
 const chat = Object.create(c.window.Chat.prototype);
 const entry = { role: 'assistant', content: '', steps: [], model: 'first' };
 const conv = { id: 'fixture', messages: [entry], tokens: 0, list: { append() { } } };
 const view = { el: { isConnected: true, before() { } } };
 const turn = { part: { entry, view }, config: { ...config } };
 Object.assign(chat, {
  nodes: new WeakMap(), onChange() { }, viewOf: () => ({ followBottom() { } }),
  library: { chat: () => ({ id: 'fixture' }), saveMessages: (id, messages) => saved.push(messages.map(item => item.role)) },
  settings: { find: id => ({ id, name: 'Second Model' }) },
 });
 chat.fellBack(conv, turn, view, { from: config, to: { ...other, name: 'Second Model' }, reason });
 return { saved, logged, entry, conv, turn, roles: saved[0] || [], notice: conv.messages[0] };
}

async function main() {
 // A busy door: the first model is asked once more after a short wait, and only then does the answer move on.
 const rate = harness({ status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' });
 const moved = await rate.ask();
 check('A rate limit asks the first model twice and then answers from the fallback', moved.content === 'SECOND' && rate.posts === 3);
 check('The wait before the second try is the short one, not the outage ladder', rate.waits.length === 1 && rate.waits[0] === 5000);
 check('The switch is said once, from the first model to the second, as a rate limit', rate.moved.length === 1 && rate.moved[0].from.id === 'first' && rate.moved[0].to.id === 'second' && rate.moved[0].reason === 'rate');
 check('The fallback is asked with the same messages and the same session', JSON.stringify(rate.bodies[2].input) === JSON.stringify(rate.bodies[0].input) && rate.bodies[2].prompt_cache_key === 'fixture-session');
 // A spike that clears: the second try of the first model answers, and no switch is announced.
 const clears = harness(n => n === 1 ? { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' } : null);
 const lucky = await clears.ask();
 check('A rate limit that clears on the second try keeps its own answer and says nothing', lucky.content === 'FIRST' && clears.posts === 2 && clears.moved.length === 0);
 // A spent account: waiting cannot help, so the answer moves without the short wait at all.
 for (const code of QUOTA) {
  const quota = harness({ status: 429, code, message: 'You exceeded your current quota' });
  const answer = await quota.ask();
  check('A spent ' + code + ' switches at once and answers from the fallback', answer.content === 'SECOND' && quota.posts === 2 && quota.waits.length === 0 && quota.moved[0].reason === 'quota');
 }
 // The server that says it cannot answer right now.
 for (const status of [500, 502, 503, 504]) {
  const busy = harness(status);
  const answer = await busy.ask();
  check('HTTP ' + status + ' is waited out once and then switched', answer.content === 'SECOND' && busy.posts === 3 && busy.moved[0].reason === 'server');
 }
 // A transient code that comes without a status says the same thing.
 const wordless = harness({ code: 'overloaded_error', message: 'Overloaded' });
 check('A stream overload with no status is switched too', (await wordless.ask()).content === 'SECOND' && wordless.moved[0].reason === 'server');
 // What is NOT a reason to move: the request itself being wrong.
 for (const [status, code] of [[401, 'invalid_api_key'], [403, 'content_filter'], [404, 'model_not_found'], [400, 'invalid_request_error'], [422, 'unprocessable']]) {
  const permanent = harness({ status, code, message: 'The request cannot be done' });
  const error = await rejected(permanent.ask());
  check('HTTP ' + status + ' is told as it is rather than answered by the other model', !!error && permanent.posts === 1 && permanent.moved.length === 0);
 }
 // Half an answer the user is already reading is never replayed elsewhere.
 const begun = harness({ status: 429, code: 'rate_limit_exceeded', message: 'Too many requests', prefix: [{ type: 'response.output_text.delta', item_id: 'm', delta: 'HALF' }] });
 const partial = await rejected(begun.ask());
 check('A stream that already said words is not sent to another model', partial?.partial?.content === 'HALF' && begun.posts === 1 && begun.moved.length === 0);
 // One attempt at the other model, and no ladder behind it.
 const both = harness(n => n <= 2 ? { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' } : 503);
 const failed = await rejected(both.ask());
 check('When the fallback fails too its own error is what is said, once', !!failed && both.posts === 3 && both.moved.length === 1 && both.waits.length === 1);
 // Without a named fallback nothing about the old behaviour moved.
 const plain = harness({ status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' });
 const none = await rejected(plain.ask({ fallback: null }));
 check('A chat with no fallback named waits out the outage ladder as it did before', !!none && plain.posts === 7 && plain.moved.length === 0 && plain.waits.length === 6);
 // Stopping the turn during the short wait must not start a third request.
 const stop = new AbortController();
 const stopped = harness({ status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' }, { manual: true });
 const waiting = rejected(stopped.ask({ signal: stop.signal }));
 for (let i = 0; i < 10 && !stopped.timers.size; i++) await new Promise(setImmediate);
 check('The short wait can be cancelled', stopped.timers.size === 1 && stopped.posts === 1);
 stop.abort();
 check('A stop during the wait switches to no model at all', (await waiting)?.name === 'AbortError' && stopped.posts === 1 && stopped.moved.length === 0);
 // The notice, in the chat's own list and in the record.
 for (const reason of ['rate', 'server', 'quota']) {
  const notice = noticeOf(reason);
  check('A ' + reason + ' switch puts one line above the answer it explains and keeps it with the chat',
   notice.roles.join() === 'fallback,assistant' && notice.notice.role === 'fallback' && notice.notice.reason === reason && notice.notice.from === 'first' && notice.notice.to === 'second');
  check('A ' + reason + ' switch marks the answer with the model that wrote it and goes on with it', notice.turn.config.id === 'second' && notice.entry.model === 'second');
  check('A ' + reason + ' switch is written down once, with where it went and why', notice.logged.length === 1 && notice.logged[0].kind === 'fallback' && notice.logged[0].from === 'first' && notice.logged[0].to === 'second' && notice.logged[0].reason === reason);
 }
 // A real timer, so the short wait is not merely a fixture shortcut.
 const clock = harness({ status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' }, { waitsReal: true });
 const started = Date.now();
 await clock.ask();
 check('Actual runtime waits five seconds before the second try', clock.waits.length === 1 && clock.waits[0] === 5000 && Date.now() - started >= 4900);
 console.log(`\n${count} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
