'use strict';

// Venice.ai: private, uncensored models of many companies through its OpenAI-compatible Chat Completions API. The chat
// is kept in that same shape, so a request is little more than the history as it is, with the system prompt's parts
// joined. Venice's own list says of each model its window, its output limit, whether it sees pictures, calls tools and
// thinks, so a model added tomorrow is there the next time the list is read.
const API_URL = 'https://api.venice.ai/api/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// The effort levels a model with reasoning_effort takes, from no thinking to the most. A model that thinks but takes no
// level has only off and on.
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const NO_EFFORT = ['none', 'high'];

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });
const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

async function failure(response) {
 let detail = '', code = '';
 try {
  const body = await response.json(), cause = body.error;
  detail = typeof cause === 'string' ? cause : cause?.message || body.detail?.message
   || (typeof body.detail === 'string' ? body.detail : '') || body.message || '';
  code = String(cause?.code || cause?.type || '');
 } catch {}
 return error(detail || `Venice returned error ${response.status}`, response.status, code);
}

// The list of models answers anyone, a wrong key included, so reading it proves nothing of the key. The account's rate
// limits answer only a key, and cost a request of no tokens.
async function check(key, apiUrl) {
 if (!String(key || '').trim()) throw error('A Venice API key is needed.', 401, 'key');
 let response;
 try {
  response = await fetch(`${apiUrl}/api_keys/rate_limits`, { headers: headers(key) });
 } catch {
  throw error('network', 0, 'network');
 }
 if (!response.ok) throw await failure(response);
}

// What a model turned down is remembered while the app runs: a model that called no tools, saw no picture, or would
// take no word about thinking is not asked again.
const noTools = new Set(), noPictures = new Set(), plain = new Set();

function described(entry) {
 const spec = entry.model_spec || {}, caps = spec.capabilities || {};
 const api = String(entry.id);
 const reasoning = caps.supportsReasoning === true && !plain.has(api);
 const levels = reasoning && caps.supportsReasoningEffort === true;
 const efforts = reasoning ? (levels ? LEVELS : NO_EFFORT) : ['none'];
 return {
  id: `venice:${api}`,
  provider: 'venice',
  api,
  name: spec.name || titled(api),
  context: Number(spec.availableContextTokens) || Number(entry.context_length) || 0,
  output: Number(spec.maxCompletionTokens) || 0,
  vision: caps.supportsVision === true && !noPictures.has(api),
  tools: caps.supportsFunctionCalling === true && !noTools.has(api),
  efforts,
  defaultEffort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1],
  thinking: reasoning ? (levels ? 'levels' : 'switch') : 'none',
 };
}

// A model named by hand, which the list does not describe: taken to be a plain chat until it refuses a tool.
const byHand = api => ({
 id: `venice:${api}`, provider: 'venice', api, name: titled(api), context: 0, output: 0,
 vision: false, tools: true, efforts: ['none'], defaultEffort: 'none', thinking: 'none',
});

// Every text model the key may use, as Venice's list has them; the list also holds the models that make pictures, speak
// or listen, which are not for a chat. A model the user names by hand is added for one the list does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
 await check(key, apiUrl);
 let response;
 try {
  response = await fetch(`${apiUrl}/models`, { headers: headers(key) });
 } catch {
  throw error('network', 0, 'network');
 }
 if (!response.ok) throw await failure(response);
 const body = await response.json();
 if (!Array.isArray(body?.data)) throw error('Venice sent no list of models');
 const listed = body.data
  .filter(model => model?.type === 'text' && typeof model.id === 'string' && model.id && !model.model_spec?.offline)
  .map(described);
 const have = new Set(listed.map(model => model.api));
 const hand = [...new Set(names)].filter(api => !have.has(api)).map(byHand);
 return [...listed, ...hand];
}

const text = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

function parts(content, vision) {
 if (!Array.isArray(content)) return content || '';
 return content.map(part => part.type !== 'image_url' ? { type: 'text', text: part.text || '' }
  : vision ? { type: 'image_url', image_url: { url: part.image_url.url } } : { type: 'text', text: NO_VISION });
}

function turn(message, vision) {
 if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content || '' };
 if (message.role !== 'assistant') return { role: message.role === 'system' ? 'system' : 'user', content: parts(message.content, vision) };
 const calls = (message.tool_calls || []).map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments || '{}' } }));
 const out = { role: 'assistant', content: message.content || (calls.length ? null : '') };
 if (calls.length) out.tool_calls = calls;
 return out;
}

// The system prompt's parts open the request as one message.
function convert(messages, { vision = false } = {}) {
 const lead = messages.findIndex(message => message.role !== 'system'), count = lead < 0 ? messages.length : lead;
 const system = messages.slice(0, count).map(message => text(message.content)).filter(Boolean), out = [];
 if (system.length) out.push({ role: 'system', content: system.join('\n\n') });
 for (const message of messages.slice(count)) out.push(turn(message, vision));
 return out;
}

const functions = tools => tools.map(tool => ({ type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } }));

// A word about thinking: off for the first level, a level of its own where the model takes one. Thinking is kept out
// of the answer itself; it comes apart from it as reasoning_content.
function thought(request, asked) {
 if (!asked.thinking) return {};
 if (request.thinking === 'levels') {
  if (request.effort === 'none') return { venice_parameters: { disable_thinking: true } };
  return { reasoning_effort: request.effort, venice_parameters: { strip_thinking_response: true } };
 }
 if (request.thinking === 'switch' && request.effort === 'none') return { venice_parameters: { disable_thinking: true } };
 return {};
}

function build(request, asked = { pictures: request.vision === true, tools: !!request.tools?.length, usage: true, thinking: request.thinking !== 'none' }) {
 const body = { model: request.model, messages: convert(request.messages, { vision: asked.pictures }), stream: true };
 // The tokens used come with the answer's last event by themselves, where the service takes the word for it.
 if (asked.usage) body.stream_options = { include_usage: true };
 const room = request.maxTokens ? (request.output ? Math.min(request.maxTokens, request.output) : request.maxTokens) : 0;
 if (room) body.max_tokens = room;
 if (asked.tools && request.tools?.length) body.tools = functions(request.tools);
 Object.assign(body, thought(request, asked));
 return body;
}

const STREAM_DONE = Symbol('stream done');
async function* events(body) {
 const decoder = new TextDecoder();
 let buffer = '';
 for await (const chunk of body) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const raw of lines) {
   // Lines that begin with a colon only keep the connection open.
   const line = raw.trimEnd();
   if (!line.startsWith('data:')) continue;
   const data = line.slice(5).trim();
   if (data === '[DONE]') { yield STREAM_DONE; return; }
   if (!data) continue;
   let event;
   try { event = JSON.parse(data); } catch { continue; }
   yield event;
  }
 }
 const line = buffer.trimEnd();
 if (line.startsWith('data:')) {
  const data = line.slice(5).trim();
  if (data === '[DONE]') yield STREAM_DONE;
  else if (data) {
   let event;
   try { event = JSON.parse(data); } catch {}
   if (event) yield event;
  }
 }
}

async function post(request, body, { signal, apiUrl = API_URL } = {}) {
 try {
  return await fetch(`${apiUrl}/chat/completions`, {
   method: 'POST', signal,
   headers: { ...headers(request.key), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
   body: JSON.stringify(body),
  });
 } catch (cause) {
  if (cause.name === 'AbortError') throw cause;
  throw error('network', 0, 'network');
 }
}

// A model that sees no picture, calls no tools or takes no word about thinking says so only when it is sent some: it is
// then asked again without them, and the list is read anew so the app knows it too.
async function asking(request, send) {
 const model = request.model;
 const pictured = request.vision === true && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
 const asked = {
  pictures: pictured && !noPictures.has(model),
  tools: !noTools.has(model) && !!request.tools?.length,
  usage: true,
  thinking: request.thinking !== 'none' && !plain.has(model),
 };
 let stale = false;
 for (;;) {
  const response = await send(asked);
  if (response.ok) return { response, stale };
  const problem = await failure(response);
  const dropped = problem.status !== 400 ? '' :
   asked.tools && /tool|function/i.test(problem.message) ? 'tools' :
   asked.pictures && /image|vision|multimodal|multi-modal/i.test(problem.message) ? 'pictures' :
   asked.usage && /stream_options|include_usage/i.test(problem.message) ? 'usage' :
   asked.thinking && /think|reason|effort|venice_parameters|unsupported|unknown/i.test(problem.message) ? 'thinking' : '';
  if (!dropped) throw problem;
  asked[dropped] = false;
  if (dropped === 'tools') noTools.add(model);
  if (dropped === 'pictures') noPictures.add(model);
  if (dropped === 'thinking') plain.add(model);
  stale = true;
 }
}

const FINISH = new Set(['stop', 'tool_calls', 'length', 'content_filter']);

function usageOf(usage) {
 return {
  prompt_tokens: usage.prompt_tokens || 0,
  completion_tokens: usage.completion_tokens || 0,
  total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
  cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
  written_tokens: 0,
 };
}

async function stream(request, { signal, onEvent = () => {}, apiUrl = API_URL } = {}) {
 const { response, stale } = await asking(request, asked => post(request, build(request, asked), { signal, apiUrl }));
 const calls = [], result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
 let ended = false;
 try {
  for await (const event of events(response.body)) {
   if (event === STREAM_DONE) { ended = true; break; }
   // A model can fail mid-answer: the stream then carries the error instead of an HTTP status.
   if (event.error) throw error(event.error.message || 'Venice stopped the answer', Number(event.error.code) || 0, String(event.error.code || ''));
   if (event.usage) result.usage = usageOf(event.usage);
   const choice = event.choices?.[0];
   if (!choice) continue;
   const delta = choice.delta || {};
   // A reasoning model speaks its thinking apart from its answer.
   const thought = typeof delta.reasoning_content === 'string' && delta.reasoning_content ? delta.reasoning_content
    : typeof delta.reasoning === 'string' ? delta.reasoning : '';
   if (thought) {
    result.reasoning += thought;
    onEvent({ type: 'reasoning', delta: thought });
   }
   if (typeof delta.content === 'string' && delta.content) {
    result.content += delta.content;
    onEvent({ type: 'content', delta: delta.content });
   }
   for (const part of delta.tool_calls || []) {
    onEvent({ type: 'activity' });
    // A piece says which call it belongs to by its index; one that doesn't belongs to the last call, unless it brings
    // a new id.
    const last = calls.length - 1, fresh = part.id && last >= 0 && calls[last].id && calls[last].id !== part.id;
    const call = calls[part.index ?? (fresh ? last + 1 : Math.max(0, last))] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (part.id) call.id = part.id;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
   }
   if (choice.finish_reason) result.finishReason = choice.finish_reason;
  }
  if (!ended && !result.finishReason) throw error('Venice disconnected before completing the answer', 0, 'network');
 } catch (cause) {
  if (cause.name === 'AbortError' || cause.status !== undefined) throw cause;
  if (!result.finishReason) throw error('network', 0, 'network');
 }
 result.toolCalls = calls.filter(call => call?.function.name);
 // A tool call cut off at the length limit is never run.
 if (result.finishReason === 'length') result.toolCalls = [];
 if (!FINISH.has(result.finishReason)) result.finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';
 if (stale) result.stale = true;
 return result;
}

module.exports = { models, stream, convert, build, described, API_URL };
