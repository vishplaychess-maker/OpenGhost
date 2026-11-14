'use strict';

// Refuseless: a specialised gateway for abliterated — refusal-removed — open-weight models, at
// api.refuseless.com, with the console at refuseless.com. One OpenAI-compatible door, and an Anthropic one beside it.
// The catalogue is small and unusually honest: every model states the window it works in, whether it sees pictures, the
// thinking levels it takes, and what it charges per million tokens — and what it charges for an abliterated model's
// free twin is the same price as the paid one, so a price of zero is not what marks the free shelf here.
//
// Free is read from two things only: the id's `-free` ending, or a price that is zero on every side the catalogue gives.
// The account's sign-up credits are a wallet allowance, not a per-model flag, and are never consulted: a paid model is
// paid whatever the balance says.
//
// The list is public — /models answers 200 to no key — so it cannot say whether a key is one. The service names
// GET /v1/credits among its own routes, so that is what a key is weighed with: it reads nothing, generates nothing, and
// a key it does not take is answered 401. Where that door is ever gone (404 unknown_endpoint), one request for a model
// that does not exist is the fallback, which generates nothing either.

const API_URL = 'https://api.refuseless.com/v1';
const KEY_HINT = 'A Refuseless key is made in its console at refuseless.com';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// Rows that are not chats. This catalogue holds chat models today; the house rule keeps an embedding or a speech row
// out of the picker the day it starts carrying one.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|flux|sdxl|(?<![a-z])guard|ocr|realtime|translat/i;
const PROBE_WAIT = 8000;
// A defaults to the one level that says nothing, for a model whose catalogue entry is silent.
const PLAIN = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// The protection in front of this service refuses Node's own network stack: the same request curl and Chromium answer
// with 200 is answered 403 when it comes from undici, whatever user agent it carries — measured, not assumed. So every
// request here goes through Electron's network stack, which is the Chromium the person is already using. Outside the
// app there is no Electron, and the ordinary fetch stands — the tests' own transports are what answer there.
let chromium = null;
try { chromium = require('electron')?.net || null; } catch { chromium = null; }
const send = (...args) => (chromium?.fetch ? chromium.fetch(...args) : fetch(...args));

// What a refusal says. The service answers as the OpenAI API does; its code matters, because `invalid_key` on a key
// probe is the key and not the request. Cloudflare answers for it when it blocks a request, and then there is no JSON.
async function failure(response) {
	const text = await response.text().catch(() => '');
	let detail = '', code = '';
	try {
		const body = JSON.parse(text);
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || '';
		code = String(body.error?.code || body.code || '');
	} catch {
		const title = /<title[^>]*>([^<]{3,120})</i.exec(text);
		detail = title ? title[1].trim() : '';
	}
	return error(detail || `Refuseless returned error ${response.status}`, response.status, code);
}

// A block from the protection in front is not the service turning a key down, and must not be said as that.
const blocked = (status, message) => status === 403 && /cloudflare|challenge|access denied|blocked|sorry/i.test(String(message));

// Free, and only free: the id says so, or every price the catalogue gives is zero. A price it does not give is not a
// price of nothing, and the wallet is never read.
function freeOf(model) {
	const id = String(model?.id || '');
	if (/-free$/i.test(id)) return true;
	const price = model?.pricing;
	if (!price || typeof price !== 'object') return false;
	const input = price.input_per_m ?? price.input ?? null;
	const output = price.output_per_m ?? price.output ?? null;
	const cached = price.cached_input_per_m ?? price.cached_input ?? null;
	if (input == null || output == null) return false;
	if (Number(input) !== 0 || Number(output) !== 0) return false;
	return cached == null || Number(cached) === 0;
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, one that
// turned down a picture is known not to see, and one that turned down a thinking level is asked plainly after.
const noTools = new Set(), noPictures = new Set(), noEffort = new Set();

// The makers behind the ids. The catalogue's owned_by names the gateway itself for every model, so the maker is read
// from the head of the id — the same names the console groups its list by.
const MAKERS = { glm: 'Z.ai', deepseek: 'DeepSeek', minimax: 'MiniMax', kimi: 'Moonshot AI', qwen: 'Qwen', llama: 'Meta',
	mistral: 'Mistral AI', gemma: 'Google', gemini: 'Google', phi: 'Microsoft', command: 'Cohere', grok: 'xAI' };
function groupOf(model) {
	const owner = String(model?.owned_by || '').trim();
	// A list that names a real maker is believed; the gateway's own name says only that it is the seller.
	if (owner && !/^refuseless$/i.test(owner)) return owner;
	const head = String(model?.id || '').split(/[-_.]/)[0].toLowerCase();
	return MAKERS[head] || '';
}

// The catalogue's thinking levels, in the app's words: its `off` is the app's `none`.
const LEVELS = { off: 'none', none: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'max', max: 'max' };
function effortsOf(model) {
	const listed = (Array.isArray(model?.reasoning_efforts) ? model.reasoning_efforts : []).map(level => LEVELS[String(level).toLowerCase()]).filter(Boolean);
	const efforts = [...new Set(listed)];
	if (!efforts.length) return PLAIN;
	const preferred = LEVELS[String(model?.reasoning_default || '').toLowerCase()];
	return { efforts, defaultEffort: efforts.includes(preferred) ? preferred : efforts[0], thinking: 'reasoning' };
}

function described(model) {
	const levels = effortsOf(model);
	return {
		id: `refuseless:${model.id}`,
		provider: 'refuseless',
		api: model.id,
		// The id carries no vendor path here, so the name is the id itself: the paid and free twins differ only there.
		name: String(model.id),
		group: groupOf(model),
		// What the catalogue says, not what might be assumed: its window, its sight, its room to answer.
		context: Number(model.context_length || model.context_window) || 0,
		output: Number(model.max_output_tokens || model.max_completion_tokens) || 0,
		vision: model.vision !== false && !noPictures.has(model.id),
		tools: model.tools !== false && !noTools.has(model.id),
		free: freeOf(model),
		...levels,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The key's standing, which the public list cannot tell. The service names GET /v1/credits among its own routes, so
// that is asked first: a key it does not take is answered 401 and nothing is generated. A door that no longer serves
// that route (404 unknown_endpoint) falls back to one request for a model that does not exist — the key is weighed
// before the body, so a key it does not take is still 401, and a model that does not exist still generates nothing.
const verified = new Set();

async function weighs(key, { apiUrl = API_URL } = {}) {
	let response;
	try {
		response = await send(`${apiUrl}/credits`, { headers: headers(key), signal: AbortSignal.timeout(PROBE_WAIT) });
	} catch {
		// Nothing is said of a key whose server could not be reached.
		return;
	}
	if (response.status === 401 || response.status === 403) {
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('Refuseless’ web protection refused this request. Try again in a little while.', 403);
		throw error(problem.message || KEY_HINT, 401);
	}
	if (response.ok || (response.status !== 404 && response.status !== 429 && response.status < 500)) return verified.add(key);
	if (response.status === 404) return probe(key, { apiUrl });
}

async function probe(key, { apiUrl = API_URL } = {}) {
	let response, text;
	try {
		response = await send(`${apiUrl}/chat/completions`, {
			method: 'POST', signal: AbortSignal.timeout(PROBE_WAIT),
			headers: { ...headers(key), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: '__openghost_key_probe__', messages: [{ role: 'user', content: 'key check' }], max_tokens: 1 }),
		});
		text = await response.text().catch(() => '');
	} catch {
		return;
	}
	if (blocked(response.status, text)) throw error('Refuseless’ web protection refused this request. Try again in a little while.', 403);
	if (response.status === 401 || response.status === 403) {
		let detail = '';
		try { detail = JSON.parse(text)?.error?.message || ''; } catch {}
		throw error(String(detail).trim() || KEY_HINT, 401);
	}
	if (response.status === 429 || response.status >= 500) return;
	verified.add(key);
}

// The models the key may chat with, as the service lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never checked: the list is public, but a picker with no key would only offer models that cannot
	// be called. A space pasted into the field is turned back here rather than sent as a key of its own.
	if (!secret) throw error('Refuseless wants its key before any model can be read.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	let response;
	try {
		response = await send(`${apiUrl}/models`);
	} catch {
		if (hand.length) return hand;
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('Refuseless’ web protection refused this request. Try again in a little while.', 403);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('Refuseless sent no list of models');
	// The list came for anyone; the weighing after it is what says whether the key is one.
	await weighs(secret, { apiUrl });
	const listed = body.data
		.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id))
		.map(described);
	const have = new Set(listed.map(model => model.api));
	return [...listed, ...hand.filter(model => !have.has(model.api))];
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
	const out = { role: 'assistant', content: message.content || '' };
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

function build(request, asked = { pictures: request.vision === true, tools: !!request.tools?.length, usage: true, effort: true }) {
	const body = { model: request.model, messages: convert(request.messages, { vision: asked.pictures }), stream: true };
	// A temperature is only sent when the model is not thinking: reasoning models reject it, and a profile's temperature
	// is a wish about a plain answer, not about a thought.
	if (typeof request.temperature === 'number' && (!request.effort || request.effort === 'none')) body.temperature = request.temperature;
	// The catalogue names the thinking levels each model takes and the one it starts at; a level other than the plain
	// one is asked for in the OpenAI API's own word, and dropped from then on for a model that turns it down.
	if (asked.effort && request.effort && request.effort !== 'none' && !noEffort.has(request.model)) body.reasoning_effort = request.effort;
	// The tokens used come with the answer's last event by themselves, where the model takes the word for it.
	if (asked.usage) body.stream_options = { include_usage: true };
	const room = request.maxTokens ? (request.output ? Math.min(request.maxTokens, request.output) : request.maxTokens) : 0;
	if (room) body.max_tokens = room;
	if (asked.tools && request.tools?.length) body.tools = functions(request.tools);
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
		return await send(`${apiUrl}/chat/completions`, {
			method: 'POST', signal,
			headers: { ...headers(request.key), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
			body: JSON.stringify(body),
		});
	} catch (cause) {
		if (cause.name === 'AbortError') throw cause;
		throw error('network', 0, 'network');
	}
}

// A model that sees no picture, calls no tools, takes no usage word or no thinking level says so only when it is sent
// one: it is then asked again without it, and the list is read anew so the app knows too.
async function asking(request, send) {
	const model = request.model;
	const pictured = request.vision === true && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
	const asked = { pictures: pictured && !noPictures.has(model), tools: !noTools.has(model) && !!request.tools?.length, usage: true, effort: !noEffort.has(model) };
	let stale = false;
	for (;;) {
		const response = await send(asked);
		if (response.ok) return { response, stale };
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('Refuseless’ web protection refused this request. Try again in a little while.', 403);
		const dropped = problem.status !== 400 ? '' : asked.tools && /tool|function/i.test(problem.message) ? 'tools'
			: asked.pictures && /image|vision|multimodal|multi-modal/i.test(problem.message) ? 'pictures'
			: asked.effort && /reasoning|effort|thinking/i.test(problem.message) ? 'effort'
			: asked.usage && /stream_options|include_usage/i.test(problem.message) ? 'usage' : '';
		if (!dropped) throw problem;
		asked[dropped] = false;
		if (dropped === 'tools') noTools.add(model);
		if (dropped === 'pictures') noPictures.add(model);
		if (dropped === 'effort') noEffort.add(model);
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
			if (event.error) throw error(event.error.message || 'Refuseless stopped the answer', Number(event.error.status) || 0, String(event.error.code || ''));
			if (event.usage) result.usage = usageOf(event.usage);
			const choice = event.choices?.[0];
			if (!choice) continue;
			const delta = choice.delta || {};
			// A reasoning model speaks its thinking apart from its answer.
			const thought = typeof delta.reasoning_content === 'string' && delta.reasoning_content ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
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
				// A piece says which call it belongs to by its index; one that doesn't belongs to the last call, unless it
				// brings a new id.
				const last = calls.length - 1, fresh = part.id && last >= 0 && calls[last].id && calls[last].id !== part.id;
				const call = calls[part.index ?? (fresh ? last + 1 : Math.max(0, last))] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
				if (part.id) call.id = part.id;
				if (part.function?.name) call.function.name += part.function.name;
				if (part.function?.arguments) call.function.arguments += part.function.arguments;
			}
			if (choice.finish_reason) result.finishReason = choice.finish_reason;
		}
		if (!ended && !result.finishReason) throw error('Refuseless disconnected before completing the answer', 0, 'network');
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

module.exports = { supports_temperature: true, models, stream, convert, build, described, freeOf, groupOf, effortsOf, API_URL, KEY_HINT };
