'use strict';
// The temperature each engine actually puts on the wire, and the list the settings read to decide whether to offer one.
// Fixture transports only: no network, key, model or application profile is used.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log('ok  ' + name); }

const OPENAI_STREAM = 'data: ' + JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', delta: 'OK' }) + '\n\n'
 + 'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n\n';
const CHAT_STREAM = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n';

// One engine with a door that only records what was posted and answers a well-formed stream of its own dialect.
function engine(file, dialect = 'chat') {
 const mod = { exports: {} };
 const posts = [];
 const c = {
  module: mod, exports: mod.exports, require, console, TextDecoder, TextDecoderStream, AbortController, DOMException,
  setTimeout, clearTimeout, Response, URL, Request, Headers, fetch: async (url, init) => {
   posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
   return new Response(dialect === 'openai' ? OPENAI_STREAM : CHAT_STREAM, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  },
  I18n: { t: key => key, has: () => false }, window: {},
 };
 vm.createContext(c);
 vm.runInContext(read(file), c, { filename: file });
 return { api: mod.exports.stream ? mod.exports : c.window.DeepSeek, posts, ctx: c };
}

const request = (over = {}) => ({ model: 'fixture-model', messages: [{ role: 'user', content: 'Say OK' }], signal: new AbortController().signal, effort: 'none', temperature: 0.4, ...over });
async function sent(file, over = {}, dialect = 'chat') {
 const h = engine(file, dialect);
 try { await (h.api.stream ? h.api.stream(request(over), { onEvent: () => { }, chatgpt: async () => ({}), version: 'fixture' }) : h.api.streamChat(request(over))); } catch { /* the answer is not what this checks */ }
 return h;
}
const temperatureOf = post => post?.body?.temperature ?? post?.body?.generationConfig?.temperature;

async function main() {
 // Every engine that says it takes one puts it where its own API expects it — and only when nothing is being thought.
 const chat = ['openrouter', 'nvidia', 'venice', 'iteracompute', 'zro', 'infron', 'tokenharbor', 'yeta', 'wusrouter', 'coarena', 'nararouter', 'crowllm'];
 for (const name of chat) {
  const plain = await sent(`desktop/${name}.js`);
  check(name + ': a temperature reaches the request body when reasoning is off', temperatureOf(plain.posts[0]) === 0.4);
  const thinking = await sent(`desktop/${name}.js`, { effort: 'high' });
  check(name + ': a thinking request carries no temperature', thinking.posts.length > 0 && temperatureOf(thinking.posts[0]) === undefined);
  const none = await sent(`desktop/${name}.js`, { temperature: undefined });
  check(name + ': no temperature is invented when none was set', none.posts.length > 0 && temperatureOf(none.posts[0]) === undefined);
 }
 // These two build the request themselves and hand it to their SDK, so the body is read from build() directly.
 const claude = engine('desktop/anthropic.js');
 check('anthropic: a temperature reaches params when reasoning is off', temperatureOf({ body: claude.api.build(request()) }) === 0.4);
 check('anthropic: thinking and temperature are never sent together', temperatureOf({ body: claude.api.build(request({ effort: 'high' })) }) === undefined);
 const gemini = engine('desktop/gemini.js');
 check('gemini: a temperature reaches generationConfig when reasoning is off', temperatureOf({ body: gemini.api.build(request()) }) === 0.4);
 check('gemini: a thinking request carries no temperature', temperatureOf({ body: gemini.api.build(request({ effort: 'high' })) }) === undefined);
 const gpt = await sent('desktop/openai.js', { provider: 'openai' }, 'openai');
 check('openai: a temperature reaches the Responses body when reasoning is off', temperatureOf(gpt.posts[0]) === 0.4);
 const gptThinking = await sent('desktop/openai.js', { provider: 'openai', effort: 'high' }, 'openai');
 check('openai: a thinking request carries no temperature', gptThinking.posts.length > 0 && temperatureOf(gptThinking.posts[0]) === undefined);
 const deep = await sent('deepseek.js', { provider: 'deepseek' });
 check('deepseek: a temperature reaches its body when thinking is disabled', temperatureOf(deep.posts[0]) === 0.4);
 const deepThinking = await sent('deepseek.js', { provider: 'deepseek', effort: 'high' });
 check('deepseek: an enabled thinking request carries no temperature', deepThinking.posts.length > 0 && temperatureOf(deepThinking.posts[0]) === undefined);

 // The list the settings read agrees with the engines that carry the word, so neither can drift from the other.
 const providers = read('providers.js');
 const listed = [...providers.match(/const TEMPERATURE = new Set\(\[([^\]]*)\]\)/)[1].matchAll(/'([a-z]+)'/g)].map(found => found[1]).sort();
 const declared = Object.entries({
  openai: 'desktop/openai.js', anthropic: 'desktop/anthropic.js', gemini: 'desktop/gemini.js', openrouter: 'desktop/openrouter.js',
  nvidia: 'desktop/nvidia.js', venice: 'desktop/venice.js', iteracompute: 'desktop/iteracompute.js', zro: 'desktop/zro.js',
  infron: 'desktop/infron.js', tokenharbor: 'desktop/tokenharbor.js', yeta: 'desktop/yeta.js', wusrouter: 'desktop/wusrouter.js',
  coarena: 'desktop/coarena.js', nararouter: 'desktop/nararouter.js', crowllm: 'desktop/crowllm.js', deepseek: 'deepseek.js',
 }).filter(([, file]) => /supports_temperature: true/.test(read(file))).map(([name]) => name).sort();
 check('The providers listed for a temperature are exactly the engines that export the word', listed.join() === declared.join());
 check('The engines that do not take one do not claim to', !/supports_temperature/.test(read('desktop/local.js')) && !listed.includes('local') && !listed.includes('custom'));

 // The renderer's answer to "may this provider's model be given a temperature".
 const bridge = { onEvent: () => { }, abort: () => { }, start: () => { } };
 const c = { window: { openghost: { llm: bridge } }, console, I18n: { t: key => key }, Usage: { record: () => { }, parts: () => null }, DeepSeek: {},
  UserContext: { pictures: () => [] }, Skills: { blocks: () => '' }, AbortController, DOMException, CustomEvent: class { }, setTimeout, clearTimeout };
 vm.createContext(c); vm.runInContext(providers, c);
 check('The settings can ask whether a provider takes one', c.window.Providers.takesTemperature('openai') === true && c.window.Providers.takesTemperature('deepseek') === true);
 check('A local or custom server is never promised a temperature', c.window.Providers.takesTemperature('local') === false && c.window.Providers.takesTemperature('custom') === false);
 console.log(`\n${count} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
