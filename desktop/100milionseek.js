'use strict';

// 100milionseek: a one-model free-tier gateway at 100milionseek.top — deepseek-v4.1-flash-free, a 198,000-token window
// and 65,536 tokens of answer, served from a hundred million tokens a day per account that refills at 00:00 UTC, with
// five requests in flight at once and no paid tier of any kind. Its own pages and its status endpoint state all of it.
//
// The list is not public here: /v1/models answers 401 `missing_api_key` to no key and 401 `invalid_api_key` to a wrong
// one, so reading the list is weighing the key — a reading that spends no token and asks no model anything.
//
// Everything the service sells is free, so every model is marked free. A catalogue that ever grew a positive price
// would not be claimed free by that rule, so the mark stays true to the service rather than to a promise.

const API_URL = 'https://100milionseek.top/v1';
const KEY_HINT = 'A 100milionseek key begins with hms- — make one at 100milionseek.top';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// A level that asks for nothing: the service names no thinking levels for this model, and nothing here guesses at one.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// Rows that are not chats. This service holds one chat model today; the house rule keeps anything else out of the picker.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|flux|sdxl|(?<![a-z])guard|ocr|realtime|translat/i;
// The model's numbers as the service's status endpoint states them, for a list that leaves them out.
const DOCUMENTED = { context: 198000, output: 65536 };

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The service answers as the OpenAI API does and names its reasons in `code`: `invalid_api_key` on
// a key it does not take, `daily_quota_exceeded` when the day's allowance is spent, `session_limit_reached` when five
// requests are already in flight, `context_length_exceeded` when the input is longer than the window.
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
	return error(detail || `100milionseek returned error ${response.status}`, response.status, code);
}

// A block from the protection in front is not the service turning a key down.
const blocked = (status, message) => status === 403 && /cloudflare|challenge|access denied|blocked|sorry/i.test(String(message));

// Everything this service serves is free: its allowance is the only meter and there is no paid tier. A price that ever
// appears with a positive number is not a price of nothing, and such a model is not claimed free.
function freeOf(model) {
	const price = model?.pricing;
	if (price && typeof price === 'object') {
		const sides = ['input_per_m', 'output_per_m', 'cached_input_per_m', 'input', 'output', 'cached_input']
			.map(side => Number(price[side])).filter(Number.isFinite);
		if (sides.some(side => side > 0)) return false;
	}
	return true;
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The maker behind the id. The list names the gateway in owned_by, so the head of the id is where the maker is read —
// the same name the model's own family goes by.
const MAKERS = { deepseek: 'DeepSeek', glm: 'Z.ai', minimax: 'MiniMax', kimi: 'Moonshot AI', qwen: 'Qwen' };
function groupOf(model) {
	const owner = String(model?.owned_by || '').trim();
	if (owner && !/^100milionseek$/i.test(owner)) return owner;
	const head = String(model?.id || '').split(/[-_.]/)[0].toLowerCase();
	return MAKERS[head] || '';
}

function described(model) {
	return {
		id: `100milionseek:${model.id}`,
		provider: '100milionseek',
		api: model.id,
		// The id carries no vendor path; the free mark is on every model here, so the name keeps its own spelling.
		name: String(model.id),
		group: groupOf(model),
		// What the list says, or — where it leaves them out — the numbers the service's status endpoint states.
		context: Number(model.context_length || model.context_window) || DOCUMENTED.context,
		output: Number(model.max_output_tokens || model.max_completion_tokens) || DOCUMENTED.output,
		vision: model.vision !== false && !noPictures.has(model.id),
		tools: model.tools !== false && !noTools.has(model.id),
		free: freeOf(model),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The models the key may chat with, as the service lists them, then the ones the user named that it does not hold.
// The list itself is the weighing: no key, an empty one and a wrong one are all answered 401 here, and a key it takes
// is answered 200 — so no request is ever generated to find out whether a key works.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never checked. A space pasted into the field is turned back here rather than sent as a key.
	if (!secret) throw error('100milionseek wants its key before any model can be read.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	let response;
	try {
		response = await fetch(`${apiUrl}/models`, { headers: headers(secret) });
	} catch {
		if (hand.length) return hand;
		throw error('network', 0, 'network');
	}
	if (!response.ok) {
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('100milionseek’s web protection refused this request. Try again in a little while.', 403);
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('100milionseek sent no list of models');
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

function build(request, asked = { pictures: request.vision === true, tools: !!request.tools?.length, usage: true }) {
	const body = { model: request.model, messages: convert(request.messages, { vision: asked.pictures }), stream: true };
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

// A model that sees no picture, calls no tools or takes no usage word says so only when it is sent one: it is then
// asked again without it, and the list is read anew so the app knows too.
async function asking(request, send) {
	const model = request.model;
	const pictured = request.vision === true && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
	const asked = { pictures: pictured && !noPictures.has(model), tools: !noTools.has(model) && !!request.tools?.length, usage: true };
	let stale = false;
	for (;;) {
		const response = await send(asked);
		if (response.ok) return { response, stale };
		const problem = await failure(response);
		if (blocked(problem.status, problem.message)) throw error('100milionseek’s web protection refused this request. Try again in a little while.', 403);
		const dropped = problem.status !== 400 ? '' : asked.tools && /tool|function/i.test(problem.message) ? 'tools'
			: asked.pictures && /image|vision|multimodal|multi-modal/i.test(problem.message) ? 'pictures'
			: asked.usage && /stream_options|include_usage/i.test(problem.message) ? 'usage' : '';
		if (!dropped) throw problem;
		asked[dropped] = false;
		if (dropped === 'tools') noTools.add(model);
		if (dropped === 'pictures') noPictures.add(model);
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
			if (event.error) throw error(event.error.message || '100milionseek stopped the answer', Number(event.error.status) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('100milionseek disconnected before completing the answer', 0, 'network');
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

module.exports = { models, stream, convert, build, described, freeOf, groupOf, API_URL, KEY_HINT };
