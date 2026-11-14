'use strict';

// Zro, from MoonMath: the GLM and DeepSeek coding models it serves, with a key made at zro.moonmath.ai. The API is the
// OpenAI Chat Completions one behind a LiteLLM-style proxy, so a request is little more than the chat as it is kept,
// with the system prompt's parts joined.
const API_URL = 'https://zro.moonmath.ai/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// The proxy lists makers besides chat: embedders, rerankers and picture and speech makers are told apart by name.
const NOT_CHAT = /embed|rerank|moderation|whisper|tts|stt|speech|transcri|audio|image|diffusion|flux|sdxl|guard|ocr|realtime|translat/i;
// No model here that says nothing of thinking has a level to choose: the control offers the one level that says nothing.
const NONE = { efforts: ['none'], defaultEffort: 'none', thinking: 'none' };
// The shape of a key made at zro.moonmath.ai. One of another shape is a paste that went wrong or a key of another
// service, and is said before a chat.
const SHAPE = /^sk-\S+$/;
// The two models the service itself names as the ones its free plan covers each day. Its list of models says nothing of
// price, so this is the provider's own word rather than its data: if that offer moves, these names move with it.
const DAILY = new Set(['deepseek-v4.1-flash', 'glm-5.3-flash']);

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

// What a refusal says. The proxy answers as the OpenAI API does, and as FastAPI does with `detail`.
async function failure(response) {
	let detail = '';
	try {
		const body = await response.json();
		detail = typeof body.error === 'string' ? body.error : body.error?.message || body.detail || body.message || body.title || '';
	} catch {}
	return error(detail || `Zro returned error ${response.status}`, response.status);
}

// Which models a key could not use as a chat: one that turned down tools is asked without them from then on, and one
// that turned down a picture is known not to see.
const noTools = new Set(), noPictures = new Set();

// The name a person reads, and the company the model came from: Zro's ids are plain, without the author's slash.
const COMPANIES = { deepseek: 'DeepSeek', glm: 'GLM', kimi: 'Kimi', qwen: 'Qwen', minimax: 'MiniMax' };
const familyOf = id => {
	const first = String(id).toLowerCase().split(/[-/]/)[0];
	return COMPANIES[first] || '';
};

function described(entry) {
	const modalities = Array.isArray(entry.supported_modalities) ? entry.supported_modalities : null;
	return {
		id: `zro:${entry.id}`,
		provider: 'zro',
		api: entry.id,
		name: entry.id,
		group: familyOf(entry.id),
		// The proxy tells nothing of a window unless it is asked of a model it describes; what it does not say is left
		// unsaid rather than guessed at.
		context: Number(entry.context_window) || Number(entry.max_input_tokens) || 0,
		output: Number(entry.max_output_tokens) || 0,
		// A model is taken to see until it turns a picture down, which is remembered and asked without one: a wrong
		// guess costs a turn, where taking it as blind would shut pictures out for good.
		vision: modalities ? modalities.some(kind => /image|vision/i.test(kind)) && !noPictures.has(entry.id) : !noPictures.has(entry.id),
		tools: !noTools.has(entry.id),
		free: DAILY.has(entry.id),
		...NONE,
	};
}

// A model only its name is known of: one the list does not hold, which the user wrote in by hand.
const byHand = api => described({ id: api });

// The models the key may use. The proxy gives its list only to a key it takes, so reading the list is also the check of
// the key: a wrong one is turned away here, with 401, and the settings' badge stays off.
async function models({ key, names = [] }, { apiUrl = API_URL } = {}) {
	if (!SHAPE.test(String(key || ''))) throw error('A Zro key begins with sk-.', 400, 'key');
	const hand = [...new Set(names)].filter(id => typeof id === 'string' && id).map(byHand);
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
	const listed = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
	if (!Array.isArray(body?.data) && !Array.isArray(body?.models)) throw error('Zro sent no list of models');
	const models = listed.filter(model => typeof model?.id === 'string' && model.id && !NOT_CHAT.test(model.id)).map(described);
	const have = new Set(models.map(model => model.api));
	return [...models, ...hand.filter(model => !have.has(model.api))];
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
	// Nothing is said of thinking: the service names no levels, and a word it does not take is not sent to it.
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
			if (event.error) throw error(event.error.message || 'Zro stopped the answer', Number(event.error.code) || 0, String(event.error.code || ''));
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
		if (!ended && !result.finishReason) throw error('Zro disconnected before completing the answer', 0, 'network');
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

module.exports = { supports_temperature: true, models, stream, convert, build, described, API_URL };
