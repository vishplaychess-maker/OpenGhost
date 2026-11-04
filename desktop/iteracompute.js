'use strict';

// IteraCompute: the Qwen models it serves free of a monthly token grant, with a key made at iteracompute.com/free.
// The API is the OpenAI Chat Completions one, so a request is little more than the chat as it is kept, with the system
// prompt's parts joined. Unlike NIM, its list says what a model is: its window, its output limit and the thinking it takes.
const API_URL = 'https://api.iteracompute.com/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// The list holds makers besides chat: picture makers and embedders are told apart by name, since it says nothing else.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|image|banana|diffusion|flux|sdxl|guard|reward|parse|detector|clip|calibration/i;
// No model here that says nothing of thinking has a level to choose: the control offers the one level that says nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// The shape of a key made at iteracompute.com. One of another shape is a paste that went wrong or a key of another
// service, and is said before a chat.
const SHAPE = /^sk-\S+$/;
// A name no model answers to. The gateway weighs the key before the model, so a request for it is refused for the key
// alone and never reaches a model whose tokens would be paid for.
const PROBE = '__openghost_key_probe__';
const PROBE_WAIT = 8000;

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The gateway answers as the OpenAI API does, and as NVIDIA's own does with `detail` and `title`.
async function failure(response) {
	let detail = '';
	try {
		const body = await response.json();
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || body.title || '';
	} catch {}
	return error(detail || `IteraCompute returned error ${response.status}`, response.status);
}

// The company that made a model, under a name a person reads; the id is author/model.
const COMPANIES = { qwen: 'Qwen', deepseek: 'DeepSeek', moonshotai: 'Moonshot AI', zai: 'Z.ai', 'z-ai': 'Z.ai', minimax: 'MiniMax', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const companyOf = id => {
	const at = String(id).indexOf('/');
	if (at < 1) return '';
	return COMPANIES[id.slice(0, at)] || titled(id.slice(0, at));
};
const shortName = id => {
	const at = String(id).indexOf('/');
	return at < 0 ? String(id) : id.slice(at + 1);
};

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The thinking levels a model names, in the order it gives; a model that names none has the one level that says nothing.
function levelsOf(entry) {
	const listed = Array.isArray(entry.reasoning?.supported_efforts) ? entry.reasoning.supported_efforts.filter(level => typeof level === 'string' && level) : [];
	return listed.length ? listed : null;
}

function described(entry) {
	const efforts = levelsOf(entry);
	return {
		id: `iteracompute:${entry.id}`,
		provider: 'iteracompute',
		api: entry.id,
		name: shortName(entry.id),
		group: companyOf(entry.id),
		context: Number(entry.context_window) || 0,
		output: Number(entry.max_output_tokens) || 0,
		// The service says which of its models its free grant covers; one it says nothing of is not taken as free.
		free: entry.is_free === true,
		// The list says nothing of modalities. A model is taken to see until it turns a picture down, which is remembered
		// and asked without one — a wrong guess costs a turn, where taking it as blind would shut pictures out for good.
		vision: !noPictures.has(entry.id),
		tools: !noTools.has(entry.id),
		...(efforts ? { efforts, defaultEffort: efforts.includes(entry.reasoning?.default_effort) ? entry.reasoning.default_effort : efforts[0] } : NONE),
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The service lists its models for anyone, a wrong key included, so the list alone cannot tell a working key from a
// paste. A request it turns away for the key is the only word it gives, and a key taken once is not asked again.
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
		throw error(problem.message || 'IteraCompute did not take this key', problem.status || 401);
	}
	// A server that is busy or down says nothing about the key, and is not taken as one that works.
	if (response.status === 429 || response.status >= 500) return;
	verified.add(key);
}

// The models the key may use, as the service lists them, then the ones the user named that it does not hold. A model
// added tomorrow is in the list the next time it is read.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	if (!SHAPE.test(String(key || ''))) throw error('An IteraCompute key begins with sk-.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
	// A key the service does not take is said so before its list, which it answers whatever the key is.
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
	if (!Array.isArray(body?.data)) throw error('IteraCompute sent no list of models');
	const listed = body.data.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id)).map(described);
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
	// A model that names levels takes the one chosen; 'none' and 'auto' are the app's own words for saying nothing.
	if (request.effort && !['none', 'auto'].includes(request.effort)) body.reasoning_effort = request.effort;
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
			if (event.error) throw error(event.error.message || 'IteraCompute stopped the answer', Number(event.error.code) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('IteraCompute disconnected before completing the answer', 0, 'network');
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
