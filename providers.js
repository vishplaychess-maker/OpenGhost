(() => {
'use strict';

// Every model call goes through here: DeepSeek straight from the page, OpenAI, ChatGPT, Anthropic and OpenRouter through the main process.
// Whatever the provider, a call resolves to the same result: content, reasoning, tool calls, finish reason and usage.
const bridge = window.openghost?.llm || null;
const listeners = new Map();
bridge?.onEvent(data => listeners.get(data.id)?.(data));

// The least window a model needs to hold the agent's instructions and tools (about 12,400 tokens) and still answer.
const NEED = 16000;
const NAMES = { deepseek: 'DeepSeek', openai: 'OpenAI', chatgpt: 'ChatGPT', grok: 'Grok', anthropic: 'Anthropic', openrouter: 'OpenRouter', nvidia: 'NVIDIA', gemini: 'Gemini', venice: 'Venice', iteracompute: 'IteraCompute', zro: 'Zro', infron: 'Infron', tokenharbor: 'Token Harbor', yeta: 'Yeta', wusrouter: 'WusRouter', coarena: 'Coarena', nararouter: 'NaraRouter', crowllm: 'CrowLLM', local: 'Local', custom: 'Custom API' };
// The providers whose engine can carry a temperature: each engine exports the same word, and the test beside this file
// checks the two lists agree, so an engine cannot quietly promise it here and drop it there, or the reverse.
const TEMPERATURE = new Set(['openai', 'anthropic', 'deepseek', 'gemini', 'openrouter', 'nvidia', 'venice', 'iteracompute', 'zro', 'infron', 'tokenharbor', 'yeta', 'wusrouter', 'coarena', 'nararouter', 'crowllm']);

class ProviderError extends Error {
 constructor(message, status = 0, code = '') {
  super(message);
  this.name = 'ProviderError';
  this.status = status;
  this.code = code;
 }
}

function explain(provider, { status = 0, code = '', message = '' }) {
 const name = NAMES[provider] || provider;
 code = String(code || '').trim().toLowerCase();
 // A local server is the user's own program: when it is not there the app says so in plain words, and when it answers
 // with an error, its own words say more than a status would (a model too large for the memory, a name it does not know).
 if (provider === 'local') return code === 'network' ? I18n.t('error.local') : message || I18n.t('error.statusOf', { provider: name, status });
 // A service at the user's own address: the same, but a key it does not take is said as with any other provider.
 if (provider === 'custom' && status !== 401) return code === 'network' ? I18n.t('error.custom') : message || I18n.t('error.statusOf', { provider: name, status });
 if (code === 'network') return I18n.t('error.connect', { provider: name });
 if (status === 401) return I18n.t(provider === 'chatgpt' ? 'error.signin' : provider === 'grok' ? 'error.signinGrok' : 'error.key', { provider: name });
 if (status === 402 || QUOTA.has(code)) return I18n.t('error.quota', { provider: name });
 if (status === 429) return I18n.t('error.rate', { provider: name });
 if (status >= 500) return I18n.t('error.server', { provider: name });
 return message || I18n.t('error.statusOf', { provider: name, status });
}

const aborted = partial => Object.assign(new DOMException('Aborted', 'AbortError'), { partial });

// A blink of the network, a moment of overload. A wrong key, an empty balance or a refusal of the content is not one of
// these: asking again would get the same answer. A local server's own 500 usually means the request itself cannot be
// done (the model does not fit, the name is unknown), so that is not waited out either.
const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const QUOTA = new Set(['insufficient_quota', 'billing_error', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);
const PERMANENT = new Set([...QUOTA, 'content_filter']);
// An HTTP 200 stream may end with an error code, with no numeric status at all. It is still a temporary failure.
const TRANSIENT_CODES = new Set(['server_error', 'internal_server_error', 'server_overloaded', 'server_is_overloaded', 'overloaded_error', 'service_unavailable', 'service_unavailable_error', 'temporarily_unavailable', 'rate_limit_exceeded', 'rate_limit_error', 'slow_down']);
const OVERLOAD_MESSAGE = 'our servers are currently overloaded. please try again later.';
const WAITS = [1000, 2000, 4000, 8000, 16000, 32000];

function transient(error, provider) {
 if (!error || error.name === 'AbortError') return false;
 const code = String(error.code || '').trim().toLowerCase();
 if (PERMANENT.has(code)) return false;
 const status = Number(error.status) || 0;
 // Explicit request/auth errors win over a misleading symbolic code. Preserve local model errors as before.
 if (status >= 400) return !(provider === 'local' && status === 500) && TRANSIENT.has(status);
 if (code === 'network') return true;
 if (provider === 'local') return false;
 if (TRANSIENT_CODES.has(code)) return true;
 // The known GPT overload wording can arrive without either field. Do not infer retries from arbitrary error text.
 return !code && (provider === 'openai' || provider === 'chatgpt')
  && String(error.message || '').replace(/\s+/g, ' ').trim().toLowerCase() === OVERLOAD_MESSAGE;
}

function pause(ms, signal) {
 if (signal?.aborted) return Promise.reject(aborted());
 return new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(aborted()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
 });
}

// One outage budget for both safe request replays and Chat's continuation from saved progress. A partial stream
// must not acquire another six attempts just because the next request contains its retained text.
async function retry(config, error, { signal, onRetry, retryBudget = { used: 0 } } = {}) {
 if (signal?.aborted) throw aborted(error?.partial);
 if (!transient(error, config.provider) || retryBudget.used >= WAITS.length) return false;
 const ms = WAITS[retryBudget.used++];
 onRetry?.();
 await pause(ms, signal);
 return true;
}

// The same request, again, only before any content, reasoning or tool activity. Chat can continue a partial response
// with a different request and retained history, but this layer never blindly replays one that has already begun.
async function endure(config, run, { signal, onRetry, retryBudget = { used: 0 } } = {}) {
 let begun = false;
 const begin = () => { begun = true; };
 for (;;) {
  try {
   return await run(begin);
  } catch (error) {
   if (begun || !await retry(config, error, { signal, onRetry, retryBudget })) throw error;
  }
 }
}

// The other model. A door that is busy, or an account whose share of tokens is spent, is not a model to wait out when
// the user named another one: the same request goes across once, and only while nothing of this answer has been shown.
const FALLBACK_WAIT = 5000;
const FALLBACK_STATUS = new Set([429, 500, 502, 503, 504]);

// Why the first model failed, in the words the switch and the notice both act on: 'quota' when waiting cannot help,
// 'rate' when the door said too many requests, 'server' when it said it cannot answer right now — and nothing at all
// when the failure is the request's own (a wrong key, a refused piece of content) or the user stopped it. A local
// server's 500 is its own answer about the request, as in transient() above.
function why(error, provider) {
 if (!error || error.name === 'AbortError') return '';
 const code = String(error.code || '').trim().toLowerCase();
 if (QUOTA.has(code)) return 'quota';
 const status = Number(error.status) || 0;
 if (status) {
  if (provider === 'local' && status === 500) return '';
  if (status === 429) return 'rate';
  return FALLBACK_STATUS.has(status) ? 'server' : '';
 }
 return TRANSIENT_CODES.has(code) ? 'server' : '';
}

// Only a stream that said nothing may be sent to another model. Half an answer the user is already reading stays
// where it is, and the failure is shown as it is - the same rule endure() holds to when it replays at all.
const silent = error => !error?.partial || !(error.partial.content || error.partial.reasoning || error.partial.toolCalls?.length);

// `once`: a request nothing will follow, so there is no point in paying a provider to keep its start in a cache.
function viaMain(config, { messages, tools, signal, onReasoning, onContent, onActivity, maxTokens, session, once = false, aside = false }) {
 if (!bridge) return Promise.reject(new ProviderError(I18n.t('error.desktop', { provider: NAMES[config.provider] })));
 const id = `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
 const request = {
  provider: config.provider, key: config.key, address: config.address, window: config.window, model: config.model, effort: config.effort, vision: config.vision,
  thinking: config.thinking, output: config.output, fast: config.fast === true, fastBeta: config.fastBeta || '', speed: config.speed || 'standard', messages, tools, maxTokens, session, once, aside,
 };
 return new Promise((resolve, reject) => {
  const partial = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
  if (signal?.aborted) { reject(aborted(partial)); return; }
  const stop = () => bridge.abort(id);
  const finish = () => {
   listeners.delete(id);
   signal?.removeEventListener('abort', stop);
  };
  listeners.set(id, event => {
   if (event.type === 'content') {
    partial.content += event.delta;
    onContent?.(event.delta, partial);
   } else if (event.type === 'reasoning') {
    partial.reasoning += event.delta;
    onReasoning?.(event.delta, partial);
   } else if (event.type === 'activity') {
    onActivity?.();
   } else if (event.type === 'done') {
    finish();
    // The provider learned something about the model on the way: what the picker and the effort control show is out of date.
    if (event.result?.stale) window.dispatchEvent(new CustomEvent('models-stale', { detail: config.provider }));
    resolve({ ...partial, ...event.result });
   } else if (event.type === 'error') {
    finish();
    reject(event.aborted ? aborted(partial) : Object.assign(new ProviderError(explain(config.provider, event), event.status, event.code || ''), { partial }));
   }
  });
  signal?.addEventListener('abort', stop, { once: true });
  bridge.start(id, request);
 });
}

// Every answer's tokens go into the app's own count of usage, whatever the call was for.
function counted(config, result) {
 Usage.record(config, result.usage);
 return result;
}

function heard(begin, onContent, onReasoning) {
 return {
  onActivity: begin,
  onContent: (delta, partial) => { if (delta) begin(); onContent?.(delta, partial); },
  onReasoning: (delta, partial) => { if (delta) begin(); onReasoning?.(delta, partial); },
 };
}

async function stream(config, options) {
 // A model whose window is smaller than the agent's instructions would lose them without a word: said before it is asked.
 if (config.window && config.window < NEED) throw new ProviderError(I18n.t('error.window', { window: config.window.toLocaleString('en-US'), need: NEED.toLocaleString('en-US') }));
 const { messages, tools, signal, onReasoning, onContent, onRetry, onFallback, retryBudget, fallbacks = [] } = options;
 // The models that may answer when this one cannot, in the order the person put them in. A list with nothing in it
 // leaves everything exactly as it was before a fallback was ever named.
 const spare = (Array.isArray(fallbacks) ? fallbacks : []).filter(Boolean);
 let touched = false;
 const send = asked => begin => {
  // Anything of an answer reaching the screen is shared by every attempt: each endure() only guards its own, and a
  // half-written reply must keep the next model from starting another.
  const live = heard(() => { touched = true; begin(); }, onContent, onReasoning);
  if (asked.provider !== 'deepseek') return viaMain(asked, { ...options, ...live });
  return DeepSeek.streamChat({ key: asked.key, model: asked.model, effort: asked.effort, vision: asked.vision, temperature: asked.temperature, messages, tools, signal, ...live });
 };
 // With anywhere to go, the first model gets its short chance and no more: the ladder of waits belongs to a chat that
 // has nowhere else. Without a list, nothing here changes what it did before.
 const budget = spare.length ? { used: WAITS.length } : retryBudget;
 let result = null, problem = null;
 try {
  result = await endure(config, send(config), { signal, onRetry, retryBudget: budget });
 } catch (error) {
  problem = error;
 }
 if (!result) {
  // The reason decides the hurry. A spent quota switches at once, because the day does not refill within a minute of
  // waiting. A door that is busy — rate limited, or unable to answer right now — is asked once more after a short
  // wait first, because a spike that clears in seconds should not cost a switch and a notice the user did not need.
  const reason = spare.length && silent(problem) ? why(problem, config.provider) : '';
  if (!reason) throw problem;
  if (reason !== 'quota') {
   onRetry?.();
   await pause(FALLBACK_WAIT, signal);
   try { result = await endure(config, send(config), { signal, onRetry, retryBudget: budget }); }
   catch (again) { problem = again; }
   // What the second try answered is not always worth moving on for: a refusal the next model would meet the same way
   // is told as it is, in the first model's words.
   if (!result && !why(problem, config.provider)) throw problem;
  }
  if (!result) {
   const moved = why(problem, config.provider) || reason, cause = problem;
   // The list in its order, each tried once and nothing behind it: the first that answers is the one the chat goes on
   // with, and if none does the last failure is what the user is told — with no line, because nothing moved.
   for (const next of spare) {
    if (touched) break;
    try {
     result = await endure(next, send(next), { signal, onRetry, retryBudget: { used: WAITS.length } });
    } catch (error) {
     problem = error;
     continue;
    }
    onFallback?.({ from: config, to: next, reason: moved, error: cause });
    if (retryBudget) retryBudget.used = 0;
    return counted(next, result);
   }
   throw problem;
  }
 }
 if (retryBudget) retryBudget.used = 0;
 return counted(config, result);
}

// Short side jobs, such as naming a chat or compacting it, think as little as the model allows. `onUsage` hears what the job
// cost, for a chat that keeps count of its own tokens.
async function complete(config, { messages, signal, maxTokens = 40, onUsage }) {
 const once = begin => config.provider === 'deepseek'
  ? DeepSeek.complete({ key: config.key, model: config.model, messages, signal, maxTokens, ...heard(begin) })
  : sideComplete(config, { messages, signal, maxTokens, ...heard(begin) });
 const result = counted(config, await endure(config, once, { signal }));
 onUsage?.(result.usage);
 return config.provider === 'deepseek' ? result.content : result.content.trim();
}

function sideComplete(config, { messages, signal, maxTokens, ...live }) {
 const efforts = config.efforts || [];
 const effort = efforts.includes('none') ? 'none' : efforts[0] || 'low';
 // A model that always thinks spends its room on thinking first, so it gets room for both. So does a service's model:
 // its "none" is only offered, and one that turns it down is asked again with nothing said and thinks as it likes.
 const room = config.provider === 'anthropic' || config.provider === 'custom' || config.provider === 'nvidia' || !efforts.includes('none') ? Math.max(maxTokens, 2048) : maxTokens;
 return viaMain({ ...config, effort, speed: 'standard' }, { messages, signal, maxTokens: room, once: true, ...live });
}

// A prediction of the user's next message (predictions.js): the chat's own request with a word from the app at its end,
// so that a provider reads the chat from its cache and is paid for little more than the answer.
// - It thinks as the chat does, not less. Asking for less thinking was tried and costs more: Claude's documentation says
//   a change of thinking or effort always invalidates the cache of the messages, and DeepSeek, measured, keeps a cache
//   apart for every setting of them, so the whole new part of the chat was paid for a second time, where the thinking
//   a one-line answer takes is some tens of tokens. With GPT the cache reads either way, but told to think less it
//   predicted nothing where it otherwise did. Only its two highest levels are brought down to `high`.
// - A model on the user's own computer has no price and no cache to lose, only time: it thinks as little as it can.
// - The answer is a few words: the room for it is small, larger where the model thinks first, and an answer that runs
//   on is cut off.
const PREDICT = { plain: 80, thinking: 2048, most: 400, steep: ['xhigh', 'max'], openai: ['openai', 'chatgpt'] };
async function predict(config, { messages, tools, signal, session }) {
 const efforts = config.efforts || [];
 let effort = config.effort;
 if (config.provider === 'local') effort = efforts.includes('none') ? 'none' : efforts[0] || effort;
 else if (PREDICT.openai.includes(config.provider) && PREDICT.steep.includes(effort) && efforts.includes('high')) effort = 'high';
 const maxTokens = effort === 'none' ? PREDICT.plain : PREDICT.thinking;
 const stop = new AbortController(), cut = () => stop.abort();
 signal?.addEventListener('abort', cut, { once: true });
 let long = false;
 const onContent = (delta, partial) => { if (partial.content.length > PREDICT.most) { long = true; cut(); } };
 const options = { messages, tools, signal: stop.signal, onContent, maxTokens, session, aside: true };
 try {
  if (signal?.aborted) return '';
  const result = counted(config, await endure(config, begin => {
   const live = heard(begin, onContent);
   return config.provider === 'deepseek'
    ? DeepSeek.streamChat({ key: config.key, model: config.model, effort, vision: config.vision, ...options, ...live })
    : viaMain({ ...config, effort }, { ...options, ...live });
  }, { signal: stop.signal }));
  // Told not to call tools, a model that calls one all the same has predicted nothing.
  return result.toolCalls?.length ? '' : result.content;
 } catch (error) {
  if (long || error.name === 'AbortError') return '';
  throw error;
 } finally {
  signal?.removeEventListener('abort', cut);
 }
}

// `extra`: what a provider needs besides its key (see the main process's side).
async function models(provider, key, extra) {
 if (provider === 'deepseek') return (await DeepSeek.listModels(key)).map(model => ({ ...model, provider: 'deepseek', api: model.id }));
 if (!bridge) return [];
 const reply = await bridge.models(provider, key, extra);
 if (reply.error) throw new ProviderError(explain(provider, reply.error), reply.error.status);
 return reply.models;
}

// What a provider tells of the account behind a key, for the providers asked through the main process; null when it
// can't be read.
async function account(provider, key) {
 const reply = await bridge?.account?.(provider, key).catch(() => null);
 return reply?.account || null;
}

async function speed({ provider, key, model }) {
 if (!bridge?.speed) return { fast: false };
 const reply = await bridge.speed(provider, key, model);
 if (reply?.error) throw new ProviderError(reply.error.message, reply.error.status);
 return { fast: reply?.fast === true };
}

window.Providers = { stream, complete, predict, models, account, speed, retry, NAMES, NEED, available: !!bridge, takesTemperature: provider => TEMPERATURE.has(provider) };
})();
