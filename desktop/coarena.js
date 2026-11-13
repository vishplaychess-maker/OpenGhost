'use strict';

// Coarena: the computer-use benchmark at coarena.ai (run by Coasty Systems, Inc., backed by Y Combinator) sells the
// models it ranks through an OpenAI-compatible door. Its list is public — /models answers 200 to no key, an empty one
// and a wrong one alike — so the list says nothing about a key, and the badge would have gone green on a paste that
// went wrong. The engine weighs the key with /limits instead: it reads today's use and the plan's ceilings, so a wrong
// key is answered 401 and nothing is ever generated to be paid for.
// The free part is a credit, not an open door: $5 of use a day, and past it a call is answered 429 with the code
// insufficient_quota, which the app reads as a plan that has run out rather than a moment to wait out.
// What the service does not say is left unsaid rather than guessed at: the list names effort levels for its models but
// gives no way to ask for one, so the control offers only the level that says nothing instead of a knob that might be
// wired to nothing, and nothing here promises what it keeps of a chat.

const API_URL = 'https://coarena.ai/api/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// A level that asks for nothing is the only one the service's own words support.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// A limits request that cannot be reached says nothing about the key: the list's own answer stands.
const PROBE_WAIT = 8000;
// Rows that are not chats. The list holds chat models today; this keeps an embedding or a speech row out of the picker
// the day it starts carrying one.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|video|diffusion|guard|ocr|realtime|translat/i;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The door answers as the OpenAI API does, and its word for the code matters: 429 from an empty
// day's credit is a plan that has run out, while 429 from the ceiling of 30 requests a minute is a moment to wait out.
async function failure(response) {
	const text = await response.text().catch(() => '');
	let detail = '', code = '';
	try {
		const body = JSON.parse(text);
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || '';
		code = String(body.error?.code || body.code || '');
	} catch {
		// Not JSON: whatever stood in front answered, and only its title can be read as a sentence.
		const title = /<title[^>]*>([^<]{3,120})</i.exec(text);
		detail = title ? title[1].trim() : '';
	}
	return error(detail || `Coarena returned error ${response.status}`, response.status, code);
}

// The list sends a price on both sides of every model, in dollars per token and written as text: "0" and "0" is the
// daily credit at work. A price that is not there is not a price of nothing, so such a model goes unmarked.
function freeOf(model) {
	const price = model.pricing || model.price || null;
	if (!price) return false;
	const prompt = price.prompt ?? price.prompt_price ?? price.input ?? null;
	const completion = price.completion ?? price.completion_price ?? price.output ?? null;
	return prompt != null && completion != null && Number(prompt) === 0 && Number(completion) === 0;
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The makers the list names in owned_by. A model here is one of theirs, routed and metered by Coarena.
const COMPANIES = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', deepseek: 'DeepSeek', qwen: 'Qwen', tencent: 'Tencent', moonshot: 'Moonshot AI', 'moonshot-ai': 'Moonshot AI', xiaomi: 'Xiaomi', minimax: 'MiniMax', 'z-ai': 'Z.ai', glm: 'Z.ai' };

function groupOf(model) {
	return COMPANIES[String(model.owned_by || '').toLowerCase()] || '';
}

function described(model) {
	const caps = model.capabilities || {};
	return {
		id: `coarena:${model.id}`,
		provider: 'coarena',
		api: model.id,
		name: String(model.display_name || model.id),
		group: groupOf(model),
		// The window and the room to answer in are both said plainly here, so both are taken from the list.
		context: Number(model.max_input_tokens || model.context_length) || 0,
		output: Number(model.max_completion_tokens || model.max_tokens) || 0,
		vision: caps.vision !== false && !noPictures.has(model.id),
		tools: caps.tools !== false && !noTools.has(model.id),
		free: freeOf(model),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The key's standing, which the public list cannot tell. No key, an empty one and a wrong one are all answered 401 at
// this door, and a live one is answered 200 with what is left of the day's credit — a weighing that asks no model
// anything and spends nothing.
const verified = new Set();

async function takes(key, { apiUrl = API_URL } = {}) {
	if (verified.has(key)) return;
	let response;
	try {
		response = await fetch(`${apiUrl}/limits`, { headers: headers(key), signal: AbortSignal.timeout(PROBE_WAIT) });
	} catch {
		// Nothing is said of a key whose server could not be reached: the list's own answer stands.
		return;
	}
	if (response.status === 401 || response.status === 403) throw error('Coarena did not take this key', 401);
	if (response.ok) verified.add(key);
}

// The models the key may chat with, as the service lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const secret = String(key || '').trim();
	// An empty field is never checked. The key is what the weighing below reads, so a space pasted into the field is
	// turned back here rather than sent as a key of its own.
	if (!secret) throw error('Coarena wants its key before any model can be read.', 400, 'key');
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
		// A key the service does not take must be seen as that, even with models named by hand; any other failure
		// leaves them usable.
		if (hand.length && problem.status !== 401 && problem.status !== 403) return hand;
		throw problem;
	}
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body?.data)) throw error('Coarena sent no list of models');
	// The list came for nothing, so it is the weighing after it that says whether the key is one.
	await takes(secret, { apiUrl });
	const listed = body.data
		.filter(model => typeof model?.id === 'string' && model.id
			&& (model.type === undefined || model.type === 'model') && !NOT_CHAT.test(model.id))
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

// A model that sees no picture, or calls no tools, says so only when it is sent some: it is then asked again without
// them, and the list of models is read anew so the app knows it too.
async function asking(request, send) {
	const model = request.model;
	const pictured = request.vision === true && request.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
	const asked = { pictures: pictured && !noPictures.has(model), tools: !noTools.has(model) && !!request.tools?.length, usage: true };
	let stale = false;
	for (;;) {
		const response = await send(asked);
		if (response.ok) return { response, stale };
		const problem = await failure(response);
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
			if (event.error) throw error(event.error.message || 'Coarena stopped the answer', Number(event.error.status) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('Coarena disconnected before completing the answer', 0, 'network');
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

module.exports = { models, stream, convert, build, described, freeOf, API_URL };
