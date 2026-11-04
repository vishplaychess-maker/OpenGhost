'use strict';

// Google Gemini through the Generative Language API, with a key from Google AI Studio. The chat is kept in the Chat
// Completions shape and goes out as Gemini's contents: system prompts as instructions, tool results as function
// responses, pictures as inline data. Google's own list of models is read for the picker, so a model released tomorrow
// is there the next time the list is read; the names of Gemini 1.5, which Google retired on 24 September 2025, are
// still taken when written by hand, for a key that may hold them.
const API_URL = 'https://generativelanguage.googleapis.com/v1beta';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
// What each level of the effort control asks of a model that thinks: no thinking, or a budget in tokens. The budget is
// kept under the answer's room where the app sets one, as Gemini counts its thinking inside the answer.
const BUDGET = { none: 0, low: 1024, high: 8192, max: 24576 };
const FINISH = {
 STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', BLOCKLIST: 'content_filter',
 PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter', MALFORMED_FUNCTION_CALL: 'content_filter', LANGUAGE: 'stop', OTHER: 'stop',
};
// The models that draw, speak, listen or count are not chat models, and Google lists them beside the ones that are.
const NOT_CHAT = /embedding|embed|aqa|imagen|veo|tts|audio|live|image-generation|learnlm/i;
// What is offered when Google answers with no model at all, which a working key does not do. The two Gemini 1.5 names
// are kept here, and in the manual field, for a service that still serves them.
const KNOWN = [
 { api: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1048576, output: 65536, thinking: true },
 { api: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1048576, output: 65536, thinking: true },
 { api: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', context: 1048576, output: 8192, thinking: false },
 { api: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', context: 1048576, output: 8192, thinking: false },
 { api: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', context: 2097152, output: 8192, thinking: false },
];
// A model that turned down the word about thinking is asked without it from then on.
const plain = new Set();

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ 'x-goog-api-key': key });
const titled = id => id.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

// Google's failure: { error: { code, message, status } }.
async function failure(response) {
 let detail = '', code = '';
 try {
  const body = await response.json();
  detail = body.error?.message || body.message || '';
  code = body.error?.status || body.error?.code || '';
 } catch {}
 return error(detail || `Google returned error ${response.status}`, response.status, code);
}

// Whether a model listed by Google can hold a chat.
function chatModel(model) {
 const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
 return typeof model?.name === 'string' && methods.includes('generateContent') && !NOT_CHAT.test(model.name);
}

// The effort levels a model takes: a thinking model has off, less and more; Pro models always think, so they have no
// off. What Google says of a model is enough: it tells its window, its output limit and whether it thinks.
function levels(api, thinking) {
 if (!thinking) return ['none'];
 return /-pro\b/i.test(api) ? ['low', 'high'] : ['none', 'low', 'high'];
}

// Google's list gives a model's window and output limit, but not whether it thinks. That is in its name: the 2.5 and 3
// families think, as a name with "thinking" in it does; 1.5, 2.0 and Gemma do not.
const thinks = api => (/^gemini-(2\.5|3)/i.test(api) || /thinking/i.test(api)) && !plain.has(api);

function described(model) {
 const api = String(model.name || '').replace(/^models\//, '');
 const deep = model.thinking === true || thinks(api);
 const efforts = levels(api, deep);
 return {
  id: `gemini:${api}`,
  provider: 'gemini',
  api,
  name: model.displayName || titled(api),
  // All of Gemini's chat models see pictures and call tools; Gemma 1 and 2 do not see.
  context: Number(model.inputTokenLimit) || 0,
  output: Number(model.outputTokenLimit) || 0,
  vision: !/^gemma-[12]\b/i.test(api),
  tools: true,
  efforts,
  defaultEffort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1],
  thinking: deep ? 'levels' : 'none',
 };
}

const byHand = api => {
 const deep = thinks(api);
 const efforts = levels(api, deep);
 return {
  id: `gemini:${api}`, provider: 'gemini', api, name: titled(api), context: 0, output: 0, vision: true, tools: true,
  efforts, defaultEffort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1], thinking: deep ? 'levels' : 'none',
 };
};

const known = entry => {
 const efforts = levels(entry.api, entry.thinking);
 return {
  id: `gemini:${entry.api}`, provider: 'gemini', api: entry.api, name: entry.name, context: entry.context, output: entry.output,
  vision: true, tools: true, efforts, defaultEffort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1],
  thinking: entry.thinking ? 'levels' : 'none',
 };
};

// Every chat model the key may use, as Google's list has them. A model the user names by hand is added for one the
// list does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
 if (!String(key || '').trim()) throw error('A Google AI Studio key is needed.', 401, 'key');
 const live = [];
 let pageToken = '';
 for (let page = 0; page < 10; page++) {
  const url = new URL(`${apiUrl}/models`);
  url.searchParams.set('pageSize', '1000');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  let response;
  try {
   response = await fetch(url, { headers: headers(key) });
  } catch {
   throw error('network', 0, 'network');
  }
  if (!response.ok) throw await failure(response);
  const body = await response.json();
  if (!Array.isArray(body?.models)) throw error('Google sent no list of models');
  const have = new Set(live.map(model => model.api));
  for (const model of body.models) if (chatModel(model)) {
   const model_ = described(model);
   if (!have.has(model_.api)) live.push(model_);
  }
  pageToken = body.nextPageToken || '';
  if (!pageToken) break;
 }
 const listed = live.length ? live : KNOWN.map(known);
 const hand = [...new Set(names)].map(byHand);
 const have = new Set(listed.map(model => model.api));
 return [...listed, ...hand.filter(model => !have.has(model.api))];
}

const text = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

function image(url, vision) {
 const match = /^data:([^;,]+);base64,(.*)$/s.exec(url || '');
 if (!vision || !match || !IMAGE_TYPES.has(match[1])) return { text: NO_VISION };
 return { inlineData: { mimeType: match[1], data: match[2] } };
}

function userParts(content, vision) {
 const parts = typeof content === 'string' ? [{ text: content }]
  : (content || []).map(part => part.type === 'image_url' ? image(part.image_url.url, vision) : { text: part.text || '' });
 const kept = parts.filter(part => part.inlineData || part.text?.trim());
 return kept.length ? kept : [{ text: '…' }];
}

function input(value) {
 try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// The history in Gemini's contents. Consecutive turns of one role merge, as tool results and queued messages share the
// user's turn. A tool result names the call it answers, which Gemini reads from the call made just before it.
function convert(messages, { vision = true } = {}) {
 const system = [], contents = [], names = new Map();
 const push = (role, parts) => {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last?.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
 };
 for (const message of messages) {
  if (message.role === 'system') { system.push(text(message.content)); continue; }
  if (message.role === 'tool') {
   // A result whose call is not in this history, as after a switch from another provider, goes as plain text: Gemini
   // would turn down a function response with no call just before it.
   const name = names.get(message.tool_call_id);
   push('user', name ? [{ functionResponse: { name, response: { result: String(message.content ?? '') } } }] : [{ text: String(message.content ?? '') }]);
   continue;
  }
  if (message.role !== 'assistant') { push('user', userParts(message.content, vision)); continue; }
  const parts = [];
  // A reply Gemini itself wrote goes back as it wrote it: a thought signature it returned must ride on the part it
  // came with, or a later turn of a thinking model is not taken.
  const native = message.native?.provider === 'gemini' && Array.isArray(message.native.parts) ? message.native.parts : null;
  if (native) parts.push(...native.filter(part => part && (part.text !== undefined || part.functionCall || part.inlineData)));
  else if (message.content?.trim()) parts.push({ text: message.content });
  for (const call of message.tool_calls || []) {
   names.set(call.id, call.function.name);
   if (!native) parts.push({ functionCall: { name: call.function.name, args: input(call.function.arguments) } });
  }
  push('model', parts);
 }
 return { system: system.filter(Boolean), contents };
}

// JSON Schema as Gemini takes it: no `additionalProperties`, and a nullable type as Gemini writes it.
function schema(value) {
 if (Array.isArray(value)) return value.map(schema);
 if (!value || typeof value !== 'object') return value;
 const out = {};
 for (const [key, item] of Object.entries(value)) {
  if (['additionalProperties', '$schema', '$id', '$defs', 'definitions', 'examples', 'strict'].includes(key)) continue;
  if (key === 'type' && Array.isArray(item)) {
   const types = item.filter(type => type !== 'null');
   out.type = types[0] || 'string';
   if (item.includes('null')) out.nullable = true;
   continue;
  }
  out[key] = schema(item);
 }
 return out;
}

const declarations = tools => tools.map(tool => ({
 name: tool.function.name,
 description: tool.function.description || '',
 parameters: schema(tool.function.parameters || { type: 'object', properties: {} }),
}));

function budgetOf(request, room, asked) {
 if (!asked || request.thinking !== 'levels') return null;
 const budget = BUDGET[request.effort];
 if (budget === undefined) return null;
 const size = budget > 0 && room ? Math.max(0, Math.min(budget, room - 256)) : budget;
 return { thinkingBudget: size, ...(size > 0 ? { includeThoughts: true } : {}) };
}

function build(request, { pictures = request.vision !== false, tools = !!request.tools?.length, thinking = true } = {}) {
 const { system, contents } = convert(request.messages, { vision: pictures });
 const body = { contents };
 if (system.length) body.systemInstruction = { parts: system.map(part => ({ text: part })) };
 const room = request.maxTokens ? (request.output ? Math.min(request.maxTokens, request.output) : request.maxTokens) : 0;
 const config = {};
 if (room) config.maxOutputTokens = room;
 const think = thinking ? budgetOf(request, room, true) : null;
 if (think) config.thinkingConfig = think;
 if (Object.keys(config).length) body.generationConfig = config;
 if (tools && request.tools?.length) body.tools = [{ functionDeclarations: declarations(request.tools) }];
 return body;
}

async function post(request, body, { signal, apiUrl = API_URL } = {}) {
 const url = `${apiUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
 try {
  return await fetch(url, {
   method: 'POST', signal,
   headers: { ...headers(request.key), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
   body: JSON.stringify(body),
  });
 } catch (cause) {
  if (cause.name === 'AbortError') throw cause;
  throw error('network', 0, 'network');
 }
}

// Google speaks of the request's own extras in its refusal: one it does not take (tools it has no schema for, a word
// about thinking on a model that does not think) is left out and the request asked again.
async function asking(request, send) {
 const asked = { tools: !!request.tools?.length, thinking: request.thinking === 'levels' };
 let stale = false;
 for (;;) {
  const response = await send(asked);
  if (response.ok) return { response, stale };
  const problem = await failure(response);
  const drop = problem.status !== 400 ? '' :
   asked.tools && /tool|function|schema|declaration/i.test(problem.message) ? 'tools' :
   asked.thinking && /think|thought|budget/i.test(problem.message) ? 'thinking' : '';
  if (!drop) throw problem;
  asked[drop] = false;
  if (drop === 'thinking') { plain.add(request.model); stale = true; }
 }
}

async function* events(body) {
 const decoder = new TextDecoder();
 let buffer = '';
 const dataOf = block => block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
 try {
  for await (const chunk of body) {
   buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
   let at;
   while ((at = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, at);
    buffer = buffer.slice(at + 2);
    const data = dataOf(block);
    if (data && data !== '[DONE]') yield JSON.parse(data);
   }
  }
  const data = dataOf(buffer + decoder.decode());
  if (data && data !== '[DONE]') yield JSON.parse(data);
 } catch (cause) {
  if (cause.name === 'AbortError' || cause.status !== undefined) throw cause;
  if (cause instanceof SyntaxError) throw error('Google sent an invalid stream event', 0, 'protocol');
  throw error('network', 0, 'network');
 }
}

const usageOf = usage => ({
 prompt_tokens: usage.promptTokenCount || 0,
 completion_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
 total_tokens: usage.totalTokenCount || (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
 cached_tokens: usage.cachedContentTokenCount || 0,
 written_tokens: 0,
});

async function stream(request, { signal, onEvent = () => {}, apiUrl = API_URL } = {}) {
 const { response, stale } = await asking(request, asked => post(request, build(request, asked), { signal, apiUrl }));
 const calls = [], native = [], result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
 try {
  for await (const event of events(response.body)) {
   if (event.error) throw error(event.error.message || 'Google stopped the answer', Number(event.error.code) || 0, event.error.status || '');
   if (event.promptFeedback?.blockReason) throw error(`Google blocked the request: ${event.promptFeedback.blockReason}`, 400, 'content_filter');
   if (event.usageMetadata) result.usage = usageOf(event.usageMetadata);
   for (const candidate of event.candidates || []) {
    for (const part of candidate.content?.parts || []) {
     native.push(part);
     if (typeof part.text === 'string' && part.text) {
      if (part.thought === true) { result.reasoning += part.text; onEvent({ type: 'reasoning', delta: part.text }); }
      else { result.content += part.text; onEvent({ type: 'content', delta: part.text }); }
     }
     if (part.functionCall) {
      onEvent({ type: 'activity' });
      calls.push({
       id: `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
       type: 'function',
       function: { name: part.functionCall.name || '', arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
     }
    }
    if (candidate.finishReason) result.finishReason = FINISH[candidate.finishReason] || 'stop';
   }
  }
 } catch (cause) {
  if (cause.name === 'AbortError' || cause.status !== undefined) throw cause;
  if (!result.finishReason) throw error('network', 0, 'network');
 }
 result.toolCalls = calls.filter(call => call.function.name);
 // A tool call cut off at the length limit is never run, and never goes back in the history.
 if (result.finishReason === 'length') {
  result.toolCalls = [];
  result.native = { provider: 'gemini', parts: native.filter(part => !part.functionCall) };
 } else result.native = { provider: 'gemini', parts: native };
 if (!result.finishReason) {
  if (!result.toolCalls.length && !result.content) throw error('Google disconnected before completing the answer', 0, 'network');
  result.finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';
 } else if (result.finishReason === 'stop' && result.toolCalls.length) result.finishReason = 'tool_calls';
 if (stale) result.stale = true;
 return result;
}

module.exports = { models, stream, convert, build, described, API_URL };
