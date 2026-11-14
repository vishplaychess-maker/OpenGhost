'use strict';

// Infron: one gateway to many companies' models, with a key made at infron.ai. The API is the OpenAI Chat Completions
// one, so a request is little more than the chat as it is kept, with the system prompt's parts joined.
// Its list is richer than most: it says each model's window, what it takes in, whether it calls tools, and who made it.
const API_URL = 'https://api.infron.ai/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// No model here says what thinking levels it takes, so the control offers the one level that says nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// The gateway's list is public: it answers 200 with no key, a wrong key, or any key. So the list says nothing about a
// key, and a request the gateway turns away for the key is the only word it gives.
const PROBE = '__openghost_key_probe__';
const PROBE_WAIT = 8000;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The gateway answers as the OpenAI API does, and as its own errors do with `message`.
async function failure(response) {
	let detail = '';
	try {
		const body = await response.json();
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || '';
	} catch {}
	return error(detail || `Infron returned error ${response.status}`, response.status);
}

// Infron's own word on a free model: a variant whose name ends in `:free`, billed at nothing and never drawn from the
// credit balance. Its price fields are left out for many models rather than set to zero, and an absent price is not a
// free one — so the name is trusted, and the prices only confirm it where they are actually said.
function freeOf(model) {
	if (/:free$/i.test(String(model.id))) return true;
	const said = model.min_prompt_price != null && model.min_completion_price != null;
	return said && Number(model.min_prompt_price) === 0 && Number(model.min_completion_price) === 0;
}

// The models this app can chat with. The list carries makers besides: embedders, rerankers, search and picture and
// video makers, each named by its own category. A model shown only for the playground answers no request, and one
// served by another door than the OpenAI one is not reached by these calls.
const chattable = model => typeof model?.id === 'string' && model.id && model.is_display_only !== true
	&& (!model.category_type || model.category_type === 'LLM')
	&& (!Array.isArray(model.supported_endpoint_types) || model.supported_endpoint_types.includes('openai'));

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const authorOf = id => {
	const at = String(id).indexOf('/');
	return at < 1 ? '' : id.slice(0, at);
};

// The name a person reads, and the company under it. Infron writes both in its display name, as "Qwen: Qwen3.8 27B
// Uncensored (Free)"; where it does not, the family it names and the author of the id stand in.
function called(model) {
	const full = String(model.display_name || model.name || ''), at = full.indexOf(': ');
	const family = String(model.model_family || '');
	return {
		name: at > 0 ? full.slice(at + 2).trim() : (full || String(model.id).slice(String(model.id).indexOf('/') + 1)),
		group: at > 0 ? full.slice(0, at).trim() : (family ? titled(family) : titled(authorOf(model.id))),
	};
}

function described(model) {
	const { name, group } = called(model);
	const input = Array.isArray(model.input_modalities) ? model.input_modalities : null;
	return {
		id: `infron:${model.id}`,
		provider: 'infron',
		api: model.id,
		name,
		group,
		context: Number(model.context_length) || Number(model.max_input_tokens) || 0,
		output: Number(model.max_output_tokens) || 0,
		// What a model takes in is said here, so a picture is only offered where the gateway says it is wanted.
		vision: (input ? input.some(kind => /image|vision/i.test(String(kind))) : true) && !noPictures.has(model.id),
		tools: model.supports_function_calling !== false && !noTools.has(model.id),
		free: freeOf(model),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The key's own standing, which the public list cannot tell. The gateway weighs the key before the model, so a request
// for a name that is not there is refused for the key alone and never reaches one whose tokens would be paid for.
const verified = new Set();

async function takes(key, { apiUrl = API_URL } = {}) {
	if (verified.has(key)) return;
	let response;
	try {
		response = await fetch(`${apiUrl}/chat/completions`, {
			method: 'POST', signal: AbortSignal.timeout(PROBE_WAIT),
			headers: { ...headers(key), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: PROBE, messages: [{ role: 'user', content: '.' }], max_tokens: 1 }),
		});
	} catch {
		// Nothing is said of a key whose server could not be reached: the list's own answer stands.
		return;
	}
	if (response.status === 401 || response.status === 403) {
		const problem = await failure(response);
		throw error(problem.message || 'Infron did not take this key', problem.status || 401);
	}
	// A server that is busy or down says nothing about the key, and is not taken as one that works.
	if (response.status === 429 || response.status >= 500) return;
	verified.add(key);
}

// The models the key may chat with, as the gateway lists them, then the ones the user named that it does not hold.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	// A key the gateway does not take is said so before the list, which it answers whatever the key is.
	await takes(key, { apiUrl });
	let response;
	try {
		response = await fetch(`${apiUrl}/models`, { headers: headers(key) });
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
	const body = await response.json();
	if (!Array.isArray(body?.data)) throw error('Infron sent no list of models');
	const listed = body.data.filter(chattable).map(described);
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
 // A temperature is only sent when the model is not thinking: reasoning models reject it, and a profile's temperature
 // is a wish about a plain answer, not about a thought.
 if (typeof request.temperature === 'number' && (!request.effort || request.effort === 'none')) body.temperature = request.temperature;
	// The tokens used come with the answer's last event by themselves, where the model takes the word for it.
	if (asked.usage) body.stream_options = { include_usage: true };
	const room = request.maxTokens ? (request.output ? Math.min(request.maxTokens, request.output) : request.maxTokens) : 0;
	if (room) body.max_tokens = room;
	if (asked.tools && request.tools?.length) body.tools = functions(request.tools);
	// Nothing is said of thinking: the list names no levels, and a word it does not take is not sent to it.
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
			if (event.error) throw error(event.error.message || 'Infron stopped the answer', Number(event.error.code) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('Infron disconnected before completing the answer', 0, 'network');
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

module.exports = { supports_temperature: true, models, stream, convert, build, described, freeOf, chattable, API_URL };
